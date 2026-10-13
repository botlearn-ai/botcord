"""Tests for Expo push token registry + push fan-out on Human-bound messages."""

from __future__ import annotations

import datetime
import json
import uuid
from unittest.mock import AsyncMock

import httpx
import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import ParticipantType, RoomJoinPolicy, RoomVisibility
from hub.models import Agent, Base, PushToken, Room, RoomMember, RoomRole, User
from hub.services import expo_push
from tests.test_dashboard_chat import _auth_header, _build_envelope, _register_and_verify

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"
TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"
TOKEN_B = "ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]"


def _jwt(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


@pytest_asyncio.fixture
async def session_factory():
    from tests.test_app.conftest import create_test_engine

    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(session_factory):
    async with session_factory() as session:
        yield session


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch):
    import app.auth
    import hub.config

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock(spec=AsyncClient)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


async def _make_user(db: AsyncSession, name: str) -> dict:
    supa = uuid.uuid4()
    user = User(display_name=name, email=f"{name.lower()}@x.com", status="active", supabase_user_id=supa)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return {
        "user_id": user.id,
        "human_id": user.human_id,
        "headers": {"Authorization": f"Bearer {_jwt(str(supa))}"},
    }


@pytest_asyncio.fixture
async def alice(db_session):
    return await _make_user(db_session, "Alice")


@pytest_asyncio.fixture
async def bob(db_session):
    return await _make_user(db_session, "Bob")


@pytest.fixture
def push_capture(monkeypatch, session_factory):
    """Enable pushes; record scheduled events and mock the Expo HTTP call."""
    import hub.config

    monkeypatch.setattr(hub.config, "EXPO_PUSH_ENABLED", True)
    monkeypatch.setattr(expo_push, "async_session", session_factory)

    scheduled: list[dict] = []
    real_push_for_event = expo_push._push_for_event

    async def _record(event):
        scheduled.append(event)

    monkeypatch.setattr(expo_push, "_push_for_event", _record)

    sent: list[list[dict]] = []
    dead_tokens: list[str] = []

    async def _fake_send(messages, **_kw):
        sent.append(messages)
        return [m["to"] for m in messages if m["to"] in dead_tokens]

    monkeypatch.setattr(expo_push, "send_expo_push", _fake_send)

    async def _drain():
        # Let the recorder tasks run, then run the real push logic in order.
        for task in list(expo_push._background_tasks):
            await task
        for event in scheduled:
            await real_push_for_event(event)

    return {"scheduled": scheduled, "sent": sent, "dead": dead_tokens, "drain": _drain}


# ---------------------------------------------------------------------------
# Registry endpoints
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_register_requires_auth(client):
    r = await client.post("/api/users/me/push-tokens", json={"token": TOKEN_A, "platform": "ios"})
    assert r.status_code == 401
    r = await client.delete("/api/users/me/push-tokens", params={"token": TOKEN_A})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_register_rejects_bad_token_and_platform(client, alice):
    r = await client.post(
        "/api/users/me/push-tokens", headers=alice["headers"],
        json={"token": "not-a-token", "platform": "ios"},
    )
    assert r.status_code == 422
    r = await client.post(
        "/api/users/me/push-tokens", headers=alice["headers"],
        json={"token": TOKEN_A, "platform": "blackberry"},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_register_is_idempotent_upsert(client, alice, db_session):
    for platform in ("ios", "android"):
        r = await client.post(
            "/api/users/me/push-tokens", headers=alice["headers"],
            json={"token": TOKEN_A, "platform": platform},
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}

    rows = (await db_session.execute(select(PushToken))).scalars().all()
    assert len(rows) == 1
    await db_session.refresh(rows[0])
    assert rows[0].user_id == alice["user_id"]
    assert rows[0].platform == "android"


@pytest.mark.asyncio
async def test_register_reassigns_token_to_new_user(client, alice, bob, db_session):
    await client.post(
        "/api/users/me/push-tokens", headers=alice["headers"],
        json={"token": TOKEN_A, "platform": "ios"},
    )
    r = await client.post(
        "/api/users/me/push-tokens", headers=bob["headers"],
        json={"token": TOKEN_A, "platform": "ios"},
    )
    assert r.status_code == 200
    rows = (await db_session.execute(select(PushToken))).scalars().all()
    assert len(rows) == 1
    await db_session.refresh(rows[0])
    assert rows[0].user_id == bob["user_id"]


@pytest.mark.asyncio
async def test_delete_only_own_token(client, alice, bob, db_session):
    await client.post(
        "/api/users/me/push-tokens", headers=alice["headers"],
        json={"token": TOKEN_A, "platform": "ios"},
    )
    # Bob cannot delete Alice's token.
    r = await client.delete("/api/users/me/push-tokens", headers=bob["headers"], params={"token": TOKEN_A})
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert (await db_session.execute(select(PushToken))).scalars().first() is not None

    r = await client.delete("/api/users/me/push-tokens", headers=alice["headers"], params={"token": TOKEN_A})
    assert r.status_code == 200
    assert (await db_session.execute(select(PushToken))).scalars().first() is None


# ---------------------------------------------------------------------------
# Push fan-out
# ---------------------------------------------------------------------------


async def _seed_human_room(db: AsyncSession, *humans: dict) -> str:
    room = Room(
        room_id="rm_pushroom_", name="Push Room", description="",
        owner_id=humans[0]["human_id"], owner_type=ParticipantType.human,
        visibility=RoomVisibility.private, join_policy=RoomJoinPolicy.invite_only,
        default_send=True,
    )
    db.add(room)
    await db.flush()
    for i, h in enumerate(humans):
        db.add(RoomMember(
            room_id=room.room_id, agent_id=h["human_id"],
            participant_type=ParticipantType.human,
            role=RoomRole.owner if i == 0 else RoomRole.member,
        ))
    await db.commit()
    return room.room_id


@pytest.mark.asyncio
async def test_human_room_message_pushes_recipient_not_sender(
    client, alice, bob, db_session, push_capture,
):
    db_session.add_all([
        PushToken(user_id=alice["user_id"], token=TOKEN_A, platform="ios"),
        PushToken(user_id=bob["user_id"], token=TOKEN_B, platform="android"),
    ])
    await db_session.commit()
    room_id = await _seed_human_room(db_session, alice, bob)

    long_text = "hello bob " * 30
    r = await client.post(
        f"/api/dashboard/rooms/{room_id}/send",
        headers=alice["headers"], json={"text": long_text},
    )
    assert r.status_code == 202, r.text
    await push_capture["drain"]()

    # Only Bob's event is scheduled (Alice's self-copy is filtered synchronously).
    assert [e["agent_id"] for e in push_capture["scheduled"]] == [bob["human_id"]]
    assert len(push_capture["sent"]) == 1
    [msg] = push_capture["sent"][0]
    assert msg["to"] == TOKEN_B
    assert msg["title"] == "Alice"
    assert msg["sound"] == "default"
    assert len(msg["body"]) <= 140
    assert msg["body"].startswith("hello bob")
    assert msg["data"] == {
        "room_id": room_id,
        "hub_msg_id": push_capture["scheduled"][0]["hub_msg_id"],
    }


@pytest.mark.asyncio
async def test_disabled_flag_skips_push(client, alice, bob, db_session, push_capture, monkeypatch):
    import hub.config

    monkeypatch.setattr(hub.config, "EXPO_PUSH_ENABLED", False)
    db_session.add(PushToken(user_id=bob["user_id"], token=TOKEN_B, platform="ios"))
    await db_session.commit()
    room_id = await _seed_human_room(db_session, alice, bob)
    r = await client.post(
        f"/api/dashboard/rooms/{room_id}/send", headers=alice["headers"], json={"text": "hi"},
    )
    assert r.status_code == 202
    await push_capture["drain"]()
    assert push_capture["scheduled"] == []


@pytest.mark.asyncio
async def test_non_message_and_self_events_are_ignored(push_capture):
    from hub.routers.hub import build_agent_realtime_event, build_message_realtime_event

    expo_push.schedule_message_push(
        build_agent_realtime_event(type="typing", agent_id="hu_aaaaaaaaaaaa", room_id="rm_x")
    )
    expo_push.schedule_message_push(
        build_message_realtime_event(
            type="message", agent_id="hu_aaaaaaaaaaaa", sender_id="hu_aaaaaaaaaaaa",
            room_id="rm_x", hub_msg_id="h_1", payload={"text": "me"},
        )
    )
    expo_push.schedule_message_push(
        build_message_realtime_event(
            type="message", agent_id="ag_aaaaaaaaaaaa", sender_id="hu_bbbbbbbbbbbb",
            room_id="rm_x", hub_msg_id="h_2", payload={"text": "agent recipient"},
        )
    )
    await push_capture["drain"]()
    assert push_capture["scheduled"] == []


@pytest.mark.asyncio
async def test_device_not_registered_token_is_deleted(alice, db_session, push_capture):
    from hub.routers.hub import build_message_realtime_event

    db_session.add(PushToken(user_id=alice["user_id"], token=TOKEN_A, platform="ios"))
    await db_session.commit()
    push_capture["dead"].append(TOKEN_A)

    expo_push.schedule_message_push(
        build_message_realtime_event(
            type="message", agent_id=alice["human_id"], sender_id="ag_someone___",
            room_id="rm_x", hub_msg_id="h_1", payload={"text": "ping"}, sender_name="Bot",
        )
    )
    await push_capture["drain"]()
    assert len(push_capture["sent"]) == 1
    db_session.expire_all()
    assert (await db_session.execute(select(PushToken))).scalars().first() is None


@pytest.mark.asyncio
async def test_owner_chat_agent_reply_pushes_owner(client, db_session, push_capture, monkeypatch):
    agent_id, token, sk, key_id = await _register_and_verify(client, "Helper Bot")
    owner = await _make_user(db_session, "Owner")
    await db_session.execute(
        update(Agent).where(Agent.agent_id == agent_id).values(
            user_id=owner["user_id"],
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    db_session.add(PushToken(user_id=owner["user_id"], token=TOKEN_A, platform="ios"))
    await db_session.commit()

    resp = await client.get("/dashboard/chat/room", headers=_auth_header(token))
    assert resp.status_code == 200
    room_id = resp.json()["room_id"]

    monkeypatch.setattr("hub.routers.owner_chat_ws.notify_oc_ws_message", AsyncMock())
    envelope = _build_envelope(
        sk=sk, key_id=key_id, from_id=agent_id, to_id=room_id,
        payload={"text": "Done, here is your report."},
    )
    resp = await client.post("/hub/send", json=envelope, headers=_auth_header(token))
    assert resp.status_code == 202, resp.text
    await push_capture["drain"]()

    assert [e["agent_id"] for e in push_capture["scheduled"]] == [owner["human_id"]]
    [msg] = push_capture["sent"][0]
    assert msg["to"] == TOKEN_A
    assert msg["title"] == "Helper Bot"
    assert msg["body"] == "Done, here is your report."
    assert msg["data"]["room_id"] == room_id


# ---------------------------------------------------------------------------
# Expo HTTP client
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_expo_push_batches_and_reports_dead_tokens(monkeypatch):
    import hub.config

    monkeypatch.setattr(hub.config, "EXPO_ACCESS_TOKEN", "secret-token")
    calls: list[httpx.Request] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        batch = json.loads(request.content)
        tickets = [
            {"status": "error", "details": {"error": "DeviceNotRegistered"}}
            if m["to"].endswith("dead]") else {"status": "ok", "id": "x"}
            for m in batch
        ]
        return httpx.Response(200, json={"data": tickets})

    messages = [
        {"to": f"ExponentPushToken[{i}{'dead' if i == 150 else ''}]", "title": "t", "body": "b"}
        for i in range(205)
    ]
    async with httpx.AsyncClient(transport=httpx.MockTransport(_handler)) as c:
        dead = await expo_push.send_expo_push(messages, client=c)

    assert [len(json.loads(r.content)) for r in calls] == [100, 100, 5]
    assert all(str(r.url) == expo_push.EXPO_PUSH_URL for r in calls)
    assert calls[0].headers["Authorization"] == "Bearer secret-token"
    assert dead == ["ExponentPushToken[150dead]"]
