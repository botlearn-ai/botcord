"""Reproduce: messages disappear from dashboard after adding 4th member to room."""

import base64
import hashlib
import json
import time
import uuid

import jcs
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import Base

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession):
    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock(spec=AsyncClient)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


def _make_keypair():
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


async def _register(client, sk, pub, name):
    resp = await client.post(
        "/registry/agents",
        json={"display_name": name, "pubkey": pub, "bio": "test"},
    )
    assert resp.status_code == 201
    d = resp.json()
    agent_id, key_id, challenge = d["agent_id"], d["key_id"], d["challenge"]

    sig = base64.b64encode(sk.sign(base64.b64decode(challenge)).signature).decode()
    resp = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig},
    )
    assert resp.status_code == 200
    token = resp.json()["agent_token"]

    resp = await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth(token),
    )
    assert resp.status_code == 200
    return agent_id, key_id, token


def _envelope(sk, key_id, from_id, to_id, text="hello"):
    payload = {"text": text}
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()
    parts = ["a2a/0.1", msg_id, str(ts), from_id, to_id, "message", "", "3600", payload_hash]
    signing_input = "\n".join(parts).encode()
    sig_b64 = base64.b64encode(sk.sign(signing_input).signature).decode()
    return {
        "v": "a2a/0.1", "msg_id": msg_id, "ts": ts, "from": from_id, "to": to_id,
        "type": "message", "reply_to": None, "ttl_sec": 3600,
        "payload": payload, "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }


class TestDashboardMessagesAfterMemberAdd:
    """Ensure all room messages remain visible after adding a new member."""

    @pytest.mark.asyncio
    async def test_messages_visible_after_adding_4th_member(self, client, db_session):
        # Register 4 agents
        sk_a, pub_a = _make_keypair()
        sk_b, pub_b = _make_keypair()
        sk_c, pub_c = _make_keypair()
        sk_d, pub_d = _make_keypair()

        a_id, a_key, a_tok = await _register(client, sk_a, pub_a, "Alice")
        b_id, b_key, b_tok = await _register(client, sk_b, pub_b, "Bob")
        c_id, c_key, c_tok = await _register(client, sk_c, pub_c, "Charlie")
        d_id, d_key, d_tok = await _register(client, sk_d, pub_d, "Dave")

        # Create 3-person room (Alice owner, Bob and Charlie members)
        resp = await client.post(
            "/hub/rooms",
            json={"name": "Test Group", "member_ids": [b_id, c_id]},
            headers=_auth(a_tok),
        )
        assert resp.status_code == 201
        room_id = resp.json()["room_id"]

        # Send 5 messages from different agents
        messages_sent = []
        for i, (sk, key, agent_id, tok, name) in enumerate([
            (sk_a, a_key, a_id, a_tok, "Alice"),
            (sk_b, b_key, b_id, b_tok, "Bob"),
            (sk_a, a_key, a_id, a_tok, "Alice"),
            (sk_c, c_key, c_id, c_tok, "Charlie"),
            (sk_b, b_key, b_id, b_tok, "Bob"),
        ]):
            env = _envelope(sk, key, agent_id, room_id, text=f"msg {i} from {name}")
            resp = await client.post("/hub/send", json=env, headers=_auth(tok))
            assert resp.status_code == 202, f"Failed to send msg {i}: {resp.text}"
            messages_sent.append(env["msg_id"])

        # Verify: dashboard shows all 5 messages BEFORE adding 4th member
        resp = await client.get(
            f"/dashboard/rooms/{room_id}/messages?limit=50",
            headers=_auth(a_tok),
        )
        assert resp.status_code == 200
        data = resp.json()
        before_msg_ids = {m["msg_id"] for m in data["messages"]}
        assert len(before_msg_ids) == 5, (
            f"Expected 5 messages before adding member, got {len(before_msg_ids)}: "
            f"{[m['text'] for m in data['messages']]}"
        )

        # Add Dave as 4th member
        resp = await client.post(
            f"/hub/rooms/{room_id}/members",
            json={"agent_id": d_id},
            headers=_auth(a_tok),
        )
        assert resp.status_code == 201

        # Verify: dashboard STILL shows all 5 messages AFTER adding 4th member
        # Check from Alice's perspective (original member)
        resp = await client.get(
            f"/dashboard/rooms/{room_id}/messages?limit=50",
            headers=_auth(a_tok),
        )
        assert resp.status_code == 200
        data = resp.json()
        after_msg_ids = {m["msg_id"] for m in data["messages"]}
        assert before_msg_ids.issubset(after_msg_ids), (
            f"Existing messages disappeared after adding member! "
            f"Before: {len(before_msg_ids)}, After: {len(after_msg_ids)}, "
            f"Missing: {before_msg_ids - after_msg_ids}"
        )

        # Check from Dave's perspective (newly added member)
        resp = await client.get(
            f"/dashboard/rooms/{room_id}/messages?limit=50",
            headers=_auth(d_tok),
        )
        assert resp.status_code == 200
        data = resp.json()
        dave_msg_ids = {m["msg_id"] for m in data["messages"]}
        assert before_msg_ids.issubset(dave_msg_ids), (
            f"New member is missing existing messages! "
            f"Expected at least: {len(before_msg_ids)}, Got: {len(dave_msg_ids)}, "
            f"Missing: {before_msg_ids - dave_msg_ids}"
        )

    @pytest.mark.asyncio
    async def test_new_messages_after_member_add_visible_to_all(self, client, db_session):
        """After adding 4th member, new messages should also be visible."""
        sk_a, pub_a = _make_keypair()
        sk_b, pub_b = _make_keypair()
        sk_c, pub_c = _make_keypair()
        sk_d, pub_d = _make_keypair()

        a_id, a_key, a_tok = await _register(client, sk_a, pub_a, "Alice")
        b_id, b_key, b_tok = await _register(client, sk_b, pub_b, "Bob")
        c_id, c_key, c_tok = await _register(client, sk_c, pub_c, "Charlie")
        d_id, d_key, d_tok = await _register(client, sk_d, pub_d, "Dave")

        # Create room
        resp = await client.post(
            "/hub/rooms",
            json={"name": "Test Group", "member_ids": [b_id, c_id]},
            headers=_auth(a_tok),
        )
        assert resp.status_code == 201
        room_id = resp.json()["room_id"]

        # Send 3 messages before adding Dave
        for i in range(3):
            env = _envelope(sk_a, a_key, a_id, room_id, text=f"before-{i}")
            resp = await client.post("/hub/send", json=env, headers=_auth(a_tok))
            assert resp.status_code == 202

        # Add Dave
        resp = await client.post(
            f"/hub/rooms/{room_id}/members",
            json={"agent_id": d_id},
            headers=_auth(a_tok),
        )
        assert resp.status_code == 201

        # Send 3 more messages after adding Dave
        for i in range(3):
            env = _envelope(sk_a, a_key, a_id, room_id, text=f"after-{i}")
            resp = await client.post("/hub/send", json=env, headers=_auth(a_tok))
            assert resp.status_code == 202

        # All members should see all 6 messages
        for tok, name in [(a_tok, "Alice"), (b_tok, "Bob"), (c_tok, "Charlie"), (d_tok, "Dave")]:
            resp = await client.get(
                f"/dashboard/rooms/{room_id}/messages?limit=50",
                headers=_auth(tok),
            )
            assert resp.status_code == 200
            data = resp.json()
            texts = [m["text"] for m in data["messages"]]
            user_messages = [t for t in texts if t.startswith("before-") or t.startswith("after-")]
            assert len(user_messages) == 6, (
                f"{name} sees {len(user_messages)} user messages instead of 6: {texts}"
            )

    @pytest.mark.asyncio
    async def test_overview_preserves_room_after_member_add(self, client, db_session):
        """Overview should still list the room correctly after adding a member."""
        sk_a, pub_a = _make_keypair()
        sk_b, pub_b = _make_keypair()
        sk_c, pub_c = _make_keypair()
        sk_d, pub_d = _make_keypair()

        a_id, a_key, a_tok = await _register(client, sk_a, pub_a, "Alice")
        b_id, b_key, b_tok = await _register(client, sk_b, pub_b, "Bob")
        c_id, c_key, c_tok = await _register(client, sk_c, pub_c, "Charlie")
        d_id, d_key, d_tok = await _register(client, sk_d, pub_d, "Dave")

        # Create room and send messages
        resp = await client.post(
            "/hub/rooms",
            json={"name": "Test Group", "member_ids": [b_id, c_id]},
            headers=_auth(a_tok),
        )
        assert resp.status_code == 201
        room_id = resp.json()["room_id"]

        env = _envelope(sk_a, a_key, a_id, room_id, text="test message")
        resp = await client.post("/hub/send", json=env, headers=_auth(a_tok))
        assert resp.status_code == 202

        # Add Dave
        resp = await client.post(
            f"/hub/rooms/{room_id}/members",
            json={"agent_id": d_id},
            headers=_auth(a_tok),
        )
        assert resp.status_code == 201

        # Check overview for Alice - room should still be there with updated member count
        resp = await client.get("/dashboard/overview", headers=_auth(a_tok))
        assert resp.status_code == 200
        rooms = resp.json()["rooms"]
        room = next((r for r in rooms if r["room_id"] == room_id), None)
        assert room is not None, "Room missing from overview after adding member"
        assert room["member_count"] == 4
        assert room["last_message_preview"] is not None
