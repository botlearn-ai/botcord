"""Tests for Share Room Chat feature (snapshot freeze strategy)."""

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

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_keypair() -> tuple[SigningKey, str]:
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify(
    client: AsyncClient, sk: SigningKey, pubkey_str: str, display_name: str = "test-agent"
):
    resp = await client.post(
        "/registry/agents",
        json={"display_name": display_name, "pubkey": pubkey_str, "bio": "test agent"},
    )
    assert resp.status_code == 201
    data = resp.json()
    agent_id = data["agent_id"]
    key_id = data["key_id"]
    challenge = data["challenge"]

    challenge_bytes = base64.b64decode(challenge)
    sig_b64 = base64.b64encode(sk.sign(challenge_bytes).signature).decode()

    resp = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )
    assert resp.status_code == 200
    token = resp.json()["agent_token"]

    # Set open policy to allow room creation with member_ids
    resp = await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200

    return agent_id, key_id, token


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _build_envelope(
    sk: SigningKey,
    key_id: str,
    from_id: str,
    to_id: str,
    msg_type: str = "message",
    payload: dict | None = None,
    ttl_sec: int = 3600,
) -> dict:
    if payload is None:
        payload = {"text": "hello"}
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()

    parts = [
        "a2a/0.1", msg_id, str(ts), from_id, to_id,
        msg_type, "", str(ttl_sec), payload_hash,
    ]
    signing_input = "\n".join(parts).encode()
    signed = sk.sign(signing_input)
    sig_b64 = base64.b64encode(signed.signature).decode()

    return {
        "v": "a2a/0.1",
        "msg_id": msg_id,
        "ts": ts,
        "from": from_id,
        "to": to_id,
        "type": msg_type,
        "reply_to": None,
        "ttl_sec": ttl_sec,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }


async def _setup_room_with_messages(client, db_session):
    """Create two agents, a room, and send some messages. Returns useful IDs."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()

    agent_a, key_a, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")
    agent_b, key_b, token_b = await _register_and_verify(client, sk_b, pub_b, "Bob")

    # Create a room with both agents
    resp = await client.post(
        "/hub/rooms",
        json={"name": "Test Room", "description": "A test room", "member_ids": [agent_b]},
        headers=_auth_header(token_a),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]

    # Send messages to the room
    env1 = _build_envelope(sk_a, key_a, agent_a, room_id, payload={"text": "Hello from Alice"})
    resp = await client.post("/hub/send", json=env1, headers=_auth_header(token_a))
    assert resp.status_code == 202

    env2 = _build_envelope(sk_b, key_b, agent_b, room_id, payload={"text": "Hello from Bob"})
    resp = await client.post("/hub/send", json=env2, headers=_auth_header(token_b))
    assert resp.status_code == 202

    return {
        "agent_a": agent_a, "token_a": token_a, "sk_a": sk_a, "key_a": key_a,
        "agent_b": agent_b, "token_b": token_b, "sk_b": sk_b, "key_b": key_b,
        "room_id": room_id,
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCreateShare:
    @pytest.mark.asyncio
    async def test_create_share_success(self, client, db_session):
        ctx = await _setup_room_with_messages(client, db_session)

        resp = await client.post(
            f"/dashboard/rooms/{ctx['room_id']}/share",
            headers=_auth_header(ctx["token_a"]),
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["share_id"].startswith("sh_")
        assert data["share_url"] == f"/share/{data['share_id']}"
        assert data["created_at"] is not None
        assert data["expires_at"] is None

    @pytest.mark.asyncio
    async def test_create_share_non_member_forbidden(self, client, db_session):
        ctx = await _setup_room_with_messages(client, db_session)

        # Register a third agent not in the room
        sk_c, pub_c = _make_keypair()
        _, _, token_c = await _register_and_verify(client, sk_c, pub_c, "Charlie")

        resp = await client.post(
            f"/dashboard/rooms/{ctx['room_id']}/share",
            headers=_auth_header(token_c),
        )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_create_share_room_not_found(self, client, db_session):
        sk_a, pub_a = _make_keypair()
        _, _, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")

        resp = await client.post(
            "/dashboard/rooms/rm_nonexistent/share",
            headers=_auth_header(token_a),
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_create_share_requires_auth(self, client, db_session):
        resp = await client.post("/dashboard/rooms/rm_xxx/share")
        assert resp.status_code in (401, 403, 422)


class TestGetSharedRoom:
    @pytest.mark.asyncio
    async def test_get_shared_room_success(self, client, db_session):
        ctx = await _setup_room_with_messages(client, db_session)

        # Create share
        resp = await client.post(
            f"/dashboard/rooms/{ctx['room_id']}/share",
            headers=_auth_header(ctx["token_a"]),
        )
        assert resp.status_code == 201
        share_id = resp.json()["share_id"]

        # Public fetch — no auth needed
        resp = await client.get(f"/share/{share_id}")
        assert resp.status_code == 200
        data = resp.json()

        assert data["share_id"] == share_id
        assert data["room"]["room_id"] == ctx["room_id"]
        assert data["room"]["name"] == "Test Room"
        assert data["room"]["member_count"] == 2
        assert data["shared_by"] == "Alice"
        assert data["shared_at"] is not None

        # Should have 2 messages
        assert len(data["messages"]) == 2
        texts = [m["text"] for m in data["messages"]]
        assert "Hello from Alice" in texts
        assert "Hello from Bob" in texts

    @pytest.mark.asyncio
    async def test_get_shared_room_not_found(self, client, db_session):
        resp = await client.get("/share/sh_nonexistent")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_snapshot_freeze(self, client, db_session):
        """Messages sent after share creation should NOT appear in the share."""
        ctx = await _setup_room_with_messages(client, db_session)

        # Create share (snapshot of 2 messages)
        resp = await client.post(
            f"/dashboard/rooms/{ctx['room_id']}/share",
            headers=_auth_header(ctx["token_a"]),
        )
        assert resp.status_code == 201
        share_id = resp.json()["share_id"]

        # Send a new message after share creation
        env3 = _build_envelope(
            ctx["sk_a"], ctx["key_a"], ctx["agent_a"], ctx["room_id"],
            payload={"text": "New message after share"},
        )
        resp = await client.post(
            "/hub/send", json=env3, headers=_auth_header(ctx["token_a"]),
        )
        assert resp.status_code == 202

        # Verify share still has only 2 messages
        resp = await client.get(f"/share/{share_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["messages"]) == 2
        texts = [m["text"] for m in data["messages"]]
        assert "New message after share" not in texts

    @pytest.mark.asyncio
    async def test_shared_messages_have_sender_names(self, client, db_session):
        ctx = await _setup_room_with_messages(client, db_session)

        resp = await client.post(
            f"/dashboard/rooms/{ctx['room_id']}/share",
            headers=_auth_header(ctx["token_a"]),
        )
        share_id = resp.json()["share_id"]

        resp = await client.get(f"/share/{share_id}")
        data = resp.json()
        sender_names = {m["sender_name"] for m in data["messages"]}
        assert "Alice" in sender_names
        assert "Bob" in sender_names

    @pytest.mark.asyncio
    async def test_empty_room_share(self, client, db_session):
        """Sharing a room with no messages should return empty message list."""
        sk_a, pub_a = _make_keypair()
        agent_a, _, token_a = await _register_and_verify(client, sk_a, pub_a, "Alice")

        # Create room with no messages
        resp = await client.post(
            "/hub/rooms",
            json={"name": "Empty Room", "description": "No messages here"},
            headers=_auth_header(token_a),
        )
        assert resp.status_code == 201
        room_id = resp.json()["room_id"]

        # Create share
        resp = await client.post(
            f"/dashboard/rooms/{room_id}/share",
            headers=_auth_header(token_a),
        )
        assert resp.status_code == 201
        share_id = resp.json()["share_id"]

        # View share
        resp = await client.get(f"/share/{share_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["messages"] == []
        assert data["room"]["name"] == "Empty Room"
