"""Tests for /api/dashboard room routes: discover, join, messages, share."""

import datetime
import json
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import (
    Agent,
    Base,
    MessagePolicy,
    MessageRecord,
    MessageState,
    Role,
    Room,
    RoomJoinPolicy,
    RoomMember,
    RoomRole,
    RoomVisibility,
    User,
    UserRole,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


@pytest_asyncio.fixture
async def db_session():
    from tests.test_app.conftest import create_test_engine; engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch):
    import hub.config
    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    import app.auth
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.main import app
    from hub.database import get_db

    async def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def seed(db_session: AsyncSession):
    uid1 = uuid.uuid4()
    supa1 = uuid.uuid4()
    uid2 = uuid.uuid4()
    supa2 = uuid.uuid4()

    db_session.add(User(id=uid1, display_name="Owner", email="o@x.com", status="active", supabase_user_id=supa1))
    db_session.add(User(id=uid2, display_name="Joiner", email="j@x.com", status="active", supabase_user_id=supa2))

    role = Role(id=uuid.uuid4(), name="member", display_name="Member", is_system=True, priority=0)
    db_session.add(role)
    await db_session.flush()
    db_session.add(UserRole(id=uuid.uuid4(), user_id=uid1, role_id=role.id))
    db_session.add(UserRole(id=uuid.uuid4(), user_id=uid2, role_id=role.id))

    a1 = Agent(agent_id="ag_owner001", display_name="Owner Agent", message_policy=MessagePolicy.open,
               user_id=uid1, is_default=True, claimed_at=datetime.datetime.now(datetime.timezone.utc))
    a2 = Agent(agent_id="ag_joiner01", display_name="Joiner Agent", message_policy=MessagePolicy.open,
               user_id=uid2, is_default=True, claimed_at=datetime.datetime.now(datetime.timezone.utc))
    db_session.add_all([a1, a2])
    await db_session.flush()

    # Public open room
    pub = Room(
        room_id="rm_pubopen01", name="Public Open", description="open",
        owner_id="ag_owner001", visibility=RoomVisibility.public, join_policy=RoomJoinPolicy.open,
    )
    db_session.add(pub)
    await db_session.flush()
    db_session.add(RoomMember(room_id="rm_pubopen01", agent_id="ag_owner001", role=RoomRole.owner))

    # Public invite-only room
    pub_inv = Room(
        room_id="rm_pubinv01", name="Public Invite", description="invite only",
        owner_id="ag_owner001", visibility=RoomVisibility.public, join_policy=RoomJoinPolicy.invite_only,
    )
    db_session.add(pub_inv)
    await db_session.flush()
    db_session.add(RoomMember(room_id="rm_pubinv01", agent_id="ag_owner001", role=RoomRole.owner))

    # Private room
    priv = Room(
        room_id="rm_priv0001", name="Private", description="private",
        owner_id="ag_owner001", visibility=RoomVisibility.private, join_policy=RoomJoinPolicy.invite_only,
    )
    db_session.add(priv)
    await db_session.flush()
    db_session.add(RoomMember(room_id="rm_priv0001", agent_id="ag_owner001", role=RoomRole.owner))

    # Messages in public room
    for i in range(3):
        envelope = json.dumps({"from": "ag_owner001", "type": "message", "payload": {"text": f"msg {i}"}})
        db_session.add(MessageRecord(
            hub_msg_id=f"h_rm_msg{i:03d}", msg_id=f"m_rm_msg{i:03d}", sender_id="ag_owner001",
            receiver_id="ag_owner001", room_id="rm_pubopen01", envelope_json=envelope,
            state=MessageState.delivered, ttl_sec=3600,
        ))

    await db_session.commit()
    return {
        "token1": _make_token(str(supa1)),
        "token2": _make_token(str(supa2)),
        "agent1": "ag_owner001",
        "agent2": "ag_joiner01",
    }


def _h(token: str, agent_id: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Active-Agent": agent_id}


@pytest.mark.asyncio
async def test_discover_rooms(client: AsyncClient, seed: dict):
    """Joiner sees public rooms they're not in."""
    resp = await client.get(
        "/api/dashboard/rooms/discover",
        headers=_h(seed["token2"], seed["agent2"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "rooms" in data
    assert "total" in data
    room_ids = [r["room_id"] for r in data["rooms"]]
    assert "rm_pubopen01" in room_ids
    assert "rm_pubinv01" in room_ids
    assert "rm_priv0001" not in room_ids


@pytest.mark.asyncio
async def test_join_public_open_room(client: AsyncClient, seed: dict):
    resp = await client.post(
        "/api/dashboard/rooms/rm_pubopen01/join",
        headers=_h(seed["token2"], seed["agent2"]),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["room_id"] == "rm_pubopen01"
    assert data["my_role"] == "member"
    assert data["name"] == "Public Open"
    assert "member_count" in data


@pytest.mark.asyncio
async def test_join_already_member(client: AsyncClient, seed: dict):
    h = _h(seed["token2"], seed["agent2"])
    await client.post("/api/dashboard/rooms/rm_pubopen01/join", headers=h)
    resp = await client.post("/api/dashboard/rooms/rm_pubopen01/join", headers=h)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_join_invite_only_fails(client: AsyncClient, seed: dict):
    resp = await client.post(
        "/api/dashboard/rooms/rm_pubinv01/join",
        headers=_h(seed["token2"], seed["agent2"]),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_join_private_room_fails(client: AsyncClient, seed: dict):
    resp = await client.post(
        "/api/dashboard/rooms/rm_priv0001/join",
        headers=_h(seed["token2"], seed["agent2"]),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_room_messages_as_member(client: AsyncClient, seed: dict):
    resp = await client.get(
        "/api/dashboard/rooms/rm_pubopen01/messages",
        headers=_h(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 3
    # Members see mentioned field
    assert "mentioned" in data["messages"][0]


@pytest.mark.asyncio
async def test_room_messages_public_no_auth(client: AsyncClient, seed: dict):
    resp = await client.get("/api/dashboard/rooms/rm_pubopen01/messages")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 3
    # Non-members don't see mentioned field
    assert "mentioned" not in data["messages"][0]


@pytest.mark.asyncio
async def test_room_messages_private_no_auth(client: AsyncClient, seed: dict):
    resp = await client.get("/api/dashboard/rooms/rm_priv0001/messages")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_share(client: AsyncClient, seed: dict):
    resp = await client.post(
        "/api/dashboard/rooms/rm_pubopen01/share",
        headers=_h(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["share_id"].startswith("sh_")
    assert data["share_url"].startswith("/share/sh_")
    assert "created_at" in data

    # Now read it via share endpoint
    share_resp = await client.get(f"/api/share/{data['share_id']}")
    assert share_resp.status_code == 200
    share_data = share_resp.json()
    assert len(share_data["messages"]) == 3
    assert share_data["room"]["name"] == "Public Open"


@pytest.mark.asyncio
async def test_share_not_found(client: AsyncClient, seed: dict):
    resp = await client.get("/api/share/sh_nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_search_agents(client: AsyncClient, seed: dict):
    resp = await client.get(
        "/api/dashboard/agents/search?q=Owner",
        headers=_h(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["agents"]) >= 1
    assert data["agents"][0]["display_name"] == "Owner Agent"


@pytest.mark.asyncio
async def test_agent_detail(client: AsyncClient, seed: dict):
    resp = await client.get(
        "/api/dashboard/agents/ag_joiner01",
        headers=_h(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 200
    assert resp.json()["display_name"] == "Joiner Agent"


@pytest.mark.asyncio
async def test_shared_conversations(client: AsyncClient, seed: dict):
    # First join so both are in the room
    await client.post(
        "/api/dashboard/rooms/rm_pubopen01/join",
        headers=_h(seed["token2"], seed["agent2"]),
    )

    resp = await client.get(
        f"/api/dashboard/agents/{seed['agent2']}/conversations",
        headers=_h(seed["token1"], seed["agent1"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "conversations" in data
    assert len(data["conversations"]) >= 1
    conv = data["conversations"][0]
    assert conv["room_id"] == "rm_pubopen01"
    assert "name" in conv


@pytest.mark.asyncio
async def test_inbox_basic(client: AsyncClient, seed: dict, db_session: AsyncSession):
    """GET /api/dashboard/inbox returns queued messages and ack consumes them."""
    # Seed a queued message for agent1
    envelope = json.dumps({"from": "ag_joiner01", "type": "message", "payload": {"text": "inbox msg"}})
    db_session.add(MessageRecord(
        hub_msg_id="h_inbox_msg01",
        msg_id="m_inbox_msg01",
        sender_id="ag_joiner01",
        receiver_id="ag_owner001",
        room_id="rm_pubopen01",
        envelope_json=envelope,
        state=MessageState.queued,
        ttl_sec=3600,
    ))
    await db_session.commit()

    headers = _h(seed["token1"], seed["agent1"])

    # First call with ack=false — should return the message without consuming
    resp = await client.get(
        "/api/dashboard/inbox?ack=false",
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "messages" in data
    assert "count" in data
    assert "has_more" in data
    assert data["count"] >= 1
    assert any(m["hub_msg_id"] == "h_inbox_msg01" for m in data["messages"])

    # Second call with ack=true — should consume the message
    resp2 = await client.get(
        "/api/dashboard/inbox?ack=true",
        headers=headers,
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["count"] >= 1

    # Third call — message should be consumed (delivered), so no more queued messages
    resp3 = await client.get(
        "/api/dashboard/inbox?ack=false",
        headers=headers,
    )
    assert resp3.status_code == 200
    assert resp3.json()["count"] == 0
