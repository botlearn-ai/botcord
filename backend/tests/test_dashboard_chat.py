"""Tests for Dashboard Chat API (owner-agent user chat)."""

import base64
import datetime
import hashlib
import time
import uuid

import jcs
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import Agent, Base, MessagePolicy, MessageRecord

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


async def _register_and_verify(client: AsyncClient, display_name: str = "TestAgent"):
    """Register an agent and return (agent_id, token, signing_key, key_id)."""
    sk, pubkey = _make_keypair()

    # Register
    resp = await client.post("/registry/agents", json={
        "display_name": display_name,
        "pubkey": pubkey,
        "bio": "test agent",
    })
    assert resp.status_code == 201
    data = resp.json()
    agent_id = data["agent_id"]
    key_id = data["key_id"]
    challenge = data["challenge"]

    # Verify (sign challenge)
    challenge_bytes = base64.b64decode(challenge)
    signed = sk.sign(challenge_bytes)
    sig_b64 = base64.b64encode(signed.signature).decode()

    resp = await client.post(f"/registry/agents/{agent_id}/verify", json={
        "key_id": key_id,
        "challenge": challenge,
        "sig": sig_b64,
    })
    assert resp.status_code == 200
    token = resp.json()["agent_token"]

    return agent_id, token, sk, key_id


def _build_envelope(
    sk: SigningKey,
    key_id: str,
    from_id: str,
    to_id: str,
    msg_type: str = "message",
    payload: dict | None = None,
) -> dict:
    if payload is None:
        payload = {"text": "hello"}
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()

    parts = [
        "a2a/0.1", msg_id, str(ts), from_id, to_id,
        msg_type, "", str(3600), payload_hash,
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
        "ttl_sec": 3600,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_dashboard_chat_send_requires_auth(client: AsyncClient):
    """Chat send requires valid auth."""
    resp = await client.post("/dashboard/chat/send", json={"text": "hello"})
    assert resp.status_code == 422 or resp.status_code == 401


@pytest.mark.asyncio
async def test_dashboard_chat_send_and_room_creation(
    client: AsyncClient,
    db_session: AsyncSession,
):
    """Test that sending a chat message creates the owner-chat room and message record."""
    agent_id, token, _sk, _kid = await _register_and_verify(client, "ChatAgent")

    # Claim the agent (set user_id + claimed_at)
    from sqlalchemy import select, update
    import uuid as _uuid

    user_id = str(_uuid.uuid4())
    await db_session.execute(
        update(Agent)
        .where(Agent.agent_id == agent_id)
        .values(
            user_id=_uuid.UUID(user_id),
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    headers = _auth_header(token)

    # Get or create chat room
    resp = await client.get("/dashboard/chat/room", headers=headers)
    assert resp.status_code == 200
    room_data = resp.json()
    assert room_data["room_id"].startswith("rm_oc_")
    assert room_data["agent_id"] == agent_id
    room_id = room_data["room_id"]

    # Send a message
    resp = await client.post(
        "/dashboard/chat/send",
        json={"text": "Hello, my agent!"},
        headers=headers,
    )
    assert resp.status_code == 202
    send_data = resp.json()
    assert send_data["room_id"] == room_id
    assert send_data["status"] == "queued"
    assert send_data["hub_msg_id"].startswith("h_")

    # Verify the message record was created with correct source_type
    from sqlalchemy import select
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.hub_msg_id == send_data["hub_msg_id"]
        )
    )
    record = result.scalar_one()
    assert record.source_type == "dashboard_user_chat"
    assert record.source_user_id == user_id
    assert record.source_session_kind == "owner_chat"
    assert record.receiver_id == agent_id
    assert record.room_id == room_id
    assert record.state.value == "queued"
    # Audit fields should be populated for dashboard chat messages
    assert record.source_ip is not None
    assert record.source_user_agent is not None


@pytest.mark.asyncio
async def test_dashboard_chat_room_is_stable(
    client: AsyncClient,
    db_session: AsyncSession,
):
    """Calling GET /room twice returns the same room_id."""
    agent_id, token, _sk, _kid = await _register_and_verify(client, "StableAgent")

    import uuid as _uuid
    from sqlalchemy import update

    user_id = str(_uuid.uuid4())
    await db_session.execute(
        update(Agent)
        .where(Agent.agent_id == agent_id)
        .values(
            user_id=_uuid.UUID(user_id),
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    headers = _auth_header(token)

    resp1 = await client.get("/dashboard/chat/room", headers=headers)
    assert resp1.status_code == 200
    room_id_1 = resp1.json()["room_id"]

    resp2 = await client.get("/dashboard/chat/room", headers=headers)
    assert resp2.status_code == 200
    room_id_2 = resp2.json()["room_id"]

    assert room_id_1 == room_id_2


@pytest.mark.asyncio
async def test_dashboard_chat_inbox_includes_source_type(
    client: AsyncClient,
    db_session: AsyncSession,
):
    """Inbox messages for user chat should include source_type fields."""
    agent_id, token, _sk, _kid = await _register_and_verify(client, "InboxAgent")

    import uuid as _uuid
    from sqlalchemy import update

    user_id = str(_uuid.uuid4())
    await db_session.execute(
        update(Agent)
        .where(Agent.agent_id == agent_id)
        .values(
            user_id=_uuid.UUID(user_id),
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    headers = _auth_header(token)

    # Send a chat message
    resp = await client.post(
        "/dashboard/chat/send",
        json={"text": "Check inbox source"},
        headers=headers,
    )
    assert resp.status_code == 202

    # Poll inbox — the message should be there with source_type
    resp = await client.get("/hub/inbox?ack=false&limit=10", headers=headers)
    assert resp.status_code == 200
    inbox_data = resp.json()
    assert inbox_data["count"] >= 1

    user_chat_msgs = [
        m for m in inbox_data["messages"]
        if m.get("source_type") == "dashboard_user_chat"
    ]
    assert len(user_chat_msgs) >= 1
    msg = user_chat_msgs[0]
    assert msg["source_user_id"] == user_id
    assert msg["source_session_kind"] == "owner_chat"


@pytest.mark.asyncio
async def test_agent_reply_to_owner_chat_creates_record(
    client: AsyncClient,
    db_session: AsyncSession,
):
    """When an agent sends a reply to its owner-chat room (rm_oc_*), a self-delivery
    MessageRecord is created so the dashboard can display the reply."""
    agent_id, token, sk, key_id = await _register_and_verify(client, "ReplyAgent")

    import uuid as _uuid
    from sqlalchemy import select, update

    user_id = str(_uuid.uuid4())
    await db_session.execute(
        update(Agent)
        .where(Agent.agent_id == agent_id)
        .values(
            user_id=_uuid.UUID(user_id),
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    headers = _auth_header(token)

    # Create the owner-chat room
    resp = await client.get("/dashboard/chat/room", headers=headers)
    assert resp.status_code == 200
    room_id = resp.json()["room_id"]
    assert room_id.startswith("rm_oc_")

    # Agent sends a reply back to this room via /hub/send (simulating plugin reply)
    envelope = _build_envelope(
        sk=sk,
        key_id=key_id,
        from_id=agent_id,
        to_id=room_id,
        payload={"text": "Hello, owner!"},
    )

    resp = await client.post("/hub/send", json=envelope, headers=headers)
    assert resp.status_code == 202
    send_data = resp.json()
    # Should NOT be "no_receivers" — self-delivery record should be created
    assert send_data["status"] == "queued"
    assert send_data["hub_msg_id"].startswith("h_")

    # Verify a MessageRecord exists in this room for the reply
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.hub_msg_id == send_data["hub_msg_id"]
        )
    )
    record = result.scalar_one()
    assert record.room_id == room_id
    assert record.sender_id == agent_id
    # Self-delivery: receiver is the sender
    assert record.receiver_id == agent_id
    # Crucially: state is 'delivered' (not 'queued') so it never appears in
    # inbox polling — the plugin must not re-process its own reply.
    assert record.state.value == "delivered"

    # Verify the message does NOT appear in inbox (polling mode safety)
    inbox_resp = await client.get("/hub/inbox?ack=false&limit=50", headers=headers)
    assert inbox_resp.status_code == 200
    inbox_msgs = inbox_resp.json()["messages"]
    self_reply_ids = [m["hub_msg_id"] for m in inbox_msgs if m["hub_msg_id"] == send_data["hub_msg_id"]]
    assert len(self_reply_ids) == 0, "Self-delivery record must not appear in inbox"
