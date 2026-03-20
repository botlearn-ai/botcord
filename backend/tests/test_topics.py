"""Tests for Topic entity CRUD, lifecycle, and send-flow integration."""

import base64
import hashlib
import time
import uuid

import jcs
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock, patch

from hub.models import Base

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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
    claim_resp = await client.post(
        f"/registry/agents/{agent_id}/claim",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert claim_resp.status_code == 200
    return agent_id, key_id, token


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_agent(client: AsyncClient, name: str = "agent"):
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub, name)
    # Set open policy
    await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(token),
    )
    return sk, agent_id, key_id, token


def _build_envelope(
    sk: SigningKey,
    key_id: str,
    from_id: str,
    to_id: str,
    msg_type: str = "message",
    reply_to: str | None = None,
    ttl_sec: int = 3600,
    payload: dict | None = None,
    topic: str | None = None,
    goal: str | None = None,
) -> dict:
    if payload is None:
        payload = {"text": "hello"}
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()

    parts = [
        "a2a/0.1", msg_id, str(ts), from_id, to_id,
        msg_type, reply_to or "", str(ttl_sec), payload_hash,
    ]
    signing_input = "\n".join(parts).encode()
    signed = sk.sign(signing_input)
    sig_b64 = base64.b64encode(signed.signature).decode()

    env = {
        "v": "a2a/0.1",
        "msg_id": msg_id,
        "ts": ts,
        "from": from_id,
        "to": to_id,
        "type": msg_type,
        "reply_to": reply_to,
        "ttl_sec": ttl_sec,
        "payload": payload,
        "payload_hash": payload_hash,
        "sig": {"alg": "ed25519", "key_id": key_id, "value": sig_b64},
    }
    if topic is not None:
        env["topic"] = topic
    if goal is not None:
        env["goal"] = goal
    return env


async def _create_room(client: AsyncClient, token: str, name: str = "Test Room", **kwargs):
    body = {"name": name, **kwargs}
    resp = await client.post(
        "/hub/rooms",
        json=body,
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    return resp.json()


# ===========================================================================
# Topic CRUD tests
# ===========================================================================


@pytest.mark.asyncio
async def test_create_topic(client: AsyncClient):
    """Create a topic in a room."""
    _, agent_id, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "My Topic", "description": "A test topic", "goal": "Do something"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["topic_id"].startswith("tp_")
    assert data["title"] == "My Topic"
    assert data["description"] == "A test topic"
    assert data["status"] == "open"
    assert data["creator_id"] == agent_id
    assert data["goal"] == "Do something"
    assert data["message_count"] == 0
    assert data["room_id"] == room_id
    assert data["closed_at"] is None


@pytest.mark.asyncio
async def test_create_topic_duplicate_title(client: AsyncClient):
    """Duplicate title in same room should fail with 409."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Dup Topic"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201

    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Dup Topic"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_create_topic_non_member(client: AsyncClient):
    """Non-member cannot create a topic."""
    _, _, _, token_owner = await _create_agent(client, "owner")
    _, _, _, token_other = await _create_agent(client, "other")
    room = await _create_room(client, token_owner)
    room_id = room["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Forbidden Topic"},
        headers=_auth_header(token_other),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_list_topics(client: AsyncClient):
    """List all topics in a room."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    # Create two topics
    await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Topic A"},
        headers=_auth_header(token),
    )
    await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Topic B"},
        headers=_auth_header(token),
    )

    resp = await client.get(
        f"/hub/rooms/{room_id}/topics",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["topics"]) == 2


@pytest.mark.asyncio
async def test_list_topics_with_status_filter(client: AsyncClient):
    """List topics filtered by status."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    # Create topic A (open)
    resp_a = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Open Topic"},
        headers=_auth_header(token),
    )
    assert resp_a.status_code == 201

    # Create topic B and complete it
    resp_b = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Done Topic"},
        headers=_auth_header(token),
    )
    assert resp_b.status_code == 201
    topic_b_id = resp_b.json()["topic_id"]
    await client.patch(
        f"/hub/rooms/{room_id}/topics/{topic_b_id}",
        json={"status": "completed"},
        headers=_auth_header(token),
    )

    # Filter by open
    resp = await client.get(
        f"/hub/rooms/{room_id}/topics?status=open",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert len(resp.json()["topics"]) == 1
    assert resp.json()["topics"][0]["title"] == "Open Topic"

    # Filter by completed
    resp = await client.get(
        f"/hub/rooms/{room_id}/topics?status=completed",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert len(resp.json()["topics"]) == 1
    assert resp.json()["topics"][0]["title"] == "Done Topic"


@pytest.mark.asyncio
async def test_get_topic(client: AsyncClient):
    """Get a single topic by ID."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    create_resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Detail Topic", "goal": "Check details"},
        headers=_auth_header(token),
    )
    topic_id = create_resp.json()["topic_id"]

    resp = await client.get(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.json()["topic_id"] == topic_id
    assert resp.json()["title"] == "Detail Topic"


@pytest.mark.asyncio
async def test_get_topic_not_found(client: AsyncClient):
    """Get a non-existent topic returns 404."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    resp = await client.get(
        f"/hub/rooms/{room_id}/topics/tp_nonexistent",
        headers=_auth_header(token),
    )
    assert resp.status_code == 404


# ===========================================================================
# Status transition tests
# ===========================================================================


@pytest.mark.asyncio
async def test_update_topic_status_to_completed(client: AsyncClient):
    """Transition topic from open to completed."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Complete Me"},
        headers=_auth_header(token),
    )
    topic_id = resp.json()["topic_id"]

    resp = await client.patch(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        json={"status": "completed"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"
    assert resp.json()["closed_at"] is not None


@pytest.mark.asyncio
async def test_update_topic_status_to_failed(client: AsyncClient):
    """Transition topic from open to failed."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Fail Me"},
        headers=_auth_header(token),
    )
    topic_id = resp.json()["topic_id"]

    resp = await client.patch(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        json={"status": "failed"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "failed"
    assert resp.json()["closed_at"] is not None


@pytest.mark.asyncio
async def test_reactivate_completed_topic_requires_goal(client: AsyncClient):
    """Reactivating a completed topic without goal should fail."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Reactivate Me"},
        headers=_auth_header(token),
    )
    topic_id = resp.json()["topic_id"]

    # Complete it
    await client.patch(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        json={"status": "completed"},
        headers=_auth_header(token),
    )

    # Try to reactivate without goal → 400
    resp = await client.patch(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        json={"status": "open"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_reactivate_completed_topic_with_goal(client: AsyncClient):
    """Reactivating a completed topic with a new goal should succeed."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Reactivate With Goal"},
        headers=_auth_header(token),
    )
    topic_id = resp.json()["topic_id"]

    # Complete it
    await client.patch(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        json={"status": "completed"},
        headers=_auth_header(token),
    )

    # Reactivate with new goal → success
    resp = await client.patch(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        json={"status": "open", "goal": "New task"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "open"
    assert resp.json()["goal"] == "New task"
    assert resp.json()["closed_at"] is None


# ===========================================================================
# Permission tests
# ===========================================================================


@pytest.mark.asyncio
async def test_update_topic_title_by_non_creator_member(client: AsyncClient):
    """Regular member cannot update title if not creator."""
    sk_owner, owner_id, _, token_owner = await _create_agent(client, "owner")
    sk_member, member_id, _, token_member = await _create_agent(client, "member")

    room = await _create_room(client, token_owner, member_ids=[member_id])
    room_id = room["room_id"]

    # Owner creates topic
    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Owner Topic"},
        headers=_auth_header(token_owner),
    )
    topic_id = resp.json()["topic_id"]

    # Member tries to update title → 403
    resp = await client.patch(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        json={"title": "Renamed"},
        headers=_auth_header(token_member),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_update_topic_status_by_member(client: AsyncClient):
    """Any member can update status (not just creator)."""
    sk_owner, owner_id, _, token_owner = await _create_agent(client, "owner")
    sk_member, member_id, _, token_member = await _create_agent(client, "member")

    room = await _create_room(client, token_owner, member_ids=[member_id])
    room_id = room["room_id"]

    # Owner creates topic
    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Status Topic"},
        headers=_auth_header(token_owner),
    )
    topic_id = resp.json()["topic_id"]

    # Member updates status → OK
    resp = await client.patch(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        json={"status": "completed"},
        headers=_auth_header(token_member),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"


@pytest.mark.asyncio
async def test_delete_topic_owner_only(client: AsyncClient):
    """Only owner/admin can delete topics."""
    sk_owner, owner_id, _, token_owner = await _create_agent(client, "owner")
    sk_member, member_id, _, token_member = await _create_agent(client, "member")

    room = await _create_room(client, token_owner, member_ids=[member_id])
    room_id = room["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Delete Me"},
        headers=_auth_header(token_owner),
    )
    topic_id = resp.json()["topic_id"]

    # Member tries to delete → 403
    resp = await client.delete(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        headers=_auth_header(token_member),
    )
    assert resp.status_code == 403

    # Owner deletes → OK
    resp = await client.delete(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        headers=_auth_header(token_owner),
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    # Verify deleted
    resp = await client.get(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        headers=_auth_header(token_owner),
    )
    assert resp.status_code == 404


# ===========================================================================
# Send-flow integration tests
# ===========================================================================


@pytest.mark.asyncio
async def test_send_auto_creates_topic_in_room(client: AsyncClient):
    """Sending a message with topic to a room auto-creates a Topic entity."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    room = await _create_room(client, token_a, member_ids=[agent_b])
    room_id = room["room_id"]

    envelope = _build_envelope(
        sk_a, key_a, agent_a, room_id,
        topic="auto-topic", goal="Do auto things",
    )
    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(token_a),
    )
    assert resp.status_code == 202
    data = resp.json()
    assert data["topic_id"] is not None
    assert data["topic_id"].startswith("tp_")

    # Verify topic was created
    resp = await client.get(
        f"/hub/rooms/{room_id}/topics",
        headers=_auth_header(token_a),
    )
    assert resp.status_code == 200
    topics = resp.json()["topics"]
    assert len(topics) == 1
    assert topics[0]["title"] == "auto-topic"
    assert topics[0]["goal"] == "Do auto things"
    assert topics[0]["status"] == "open"
    assert topics[0]["message_count"] == 1


@pytest.mark.asyncio
async def test_send_reuses_existing_topic(client: AsyncClient):
    """Sending multiple messages with the same topic reuses the Topic entity."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    room = await _create_room(client, token_a, member_ids=[agent_b])
    room_id = room["room_id"]

    env1 = _build_envelope(sk_a, key_a, agent_a, room_id, topic="reuse-topic", goal="First")
    resp1 = await client.post("/hub/send", json=env1, headers=_auth_header(token_a))
    topic_id_1 = resp1.json()["topic_id"]

    env2 = _build_envelope(sk_a, key_a, agent_a, room_id, topic="reuse-topic", payload={"text": "second message"})
    resp2 = await client.post("/hub/send", json=env2, headers=_auth_header(token_a))
    assert resp2.status_code == 202, f"resp2 failed: {resp2.status_code} {resp2.json()}"
    topic_id_2 = resp2.json()["topic_id"]

    assert topic_id_1 == topic_id_2

    # Check message_count is 2 (each send increments once via _resolve_or_create_topic,
    # but auto-created topic starts at count=1 from the race-condition path)
    resp = await client.get(
        f"/hub/rooms/{room_id}/topics",
        headers=_auth_header(token_a),
    )
    topics = resp.json()["topics"]
    assert len(topics) == 1
    assert topics[0]["message_count"] >= 2


@pytest.mark.asyncio
async def test_send_dm_auto_creates_topic(client: AsyncClient):
    """Sending a DM with topic auto-creates a Topic entity in the DM room."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    envelope = _build_envelope(
        sk_a, key_a, agent_a, agent_b,
        topic="dm-topic", goal="DM task",
    )
    resp = await client.post("/hub/send", json=envelope, headers=_auth_header(token_a))
    assert resp.status_code == 202
    data = resp.json()
    assert data["topic_id"] is not None
    assert data["topic_id"].startswith("tp_")


@pytest.mark.asyncio
async def test_send_without_topic_no_topic_id(client: AsyncClient):
    """Sending without topic should not create a Topic entity."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    room = await _create_room(client, token_a, member_ids=[agent_b])
    room_id = room["room_id"]

    envelope = _build_envelope(sk_a, key_a, agent_a, room_id)
    resp = await client.post("/hub/send", json=envelope, headers=_auth_header(token_a))
    assert resp.status_code == 202
    assert resp.json()["topic_id"] is None


@pytest.mark.asyncio
async def test_result_message_completes_topic(client: AsyncClient):
    """Sending a result-type message should mark the topic as completed."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    room = await _create_room(client, token_a, member_ids=[agent_b])
    room_id = room["room_id"]

    # Send initial message with topic
    env1 = _build_envelope(sk_a, key_a, agent_a, room_id, topic="task-topic", goal="Do task")
    resp1 = await client.post("/hub/send", json=env1, headers=_auth_header(token_a))
    topic_id = resp1.json()["topic_id"]

    # Send result message
    env2 = _build_envelope(
        sk_a, key_a, agent_a, room_id,
        msg_type="result", topic="task-topic",
        payload={"text": "Done!"},
    )
    resp2 = await client.post("/hub/send", json=env2, headers=_auth_header(token_a))
    assert resp2.json()["topic_id"] == topic_id

    # Verify topic is completed
    resp = await client.get(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        headers=_auth_header(token_a),
    )
    assert resp.json()["status"] == "completed"
    assert resp.json()["closed_at"] is not None


@pytest.mark.asyncio
async def test_error_message_fails_topic(client: AsyncClient):
    """Sending an error-type message should mark the topic as failed."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    room = await _create_room(client, token_a, member_ids=[agent_b])
    room_id = room["room_id"]

    # Send initial message with topic
    env1 = _build_envelope(sk_a, key_a, agent_a, room_id, topic="error-topic", goal="Will fail")
    await client.post("/hub/send", json=env1, headers=_auth_header(token_a))

    # Send error message
    env2 = _build_envelope(
        sk_a, key_a, agent_a, room_id,
        msg_type="error", topic="error-topic",
        payload={"error": {"code": "TASK_FAILED", "message": "oops"}},
    )
    resp2 = await client.post("/hub/send", json=env2, headers=_auth_header(token_a))
    topic_id = resp2.json()["topic_id"]

    # Verify topic is failed
    resp = await client.get(
        f"/hub/rooms/{room_id}/topics/{topic_id}",
        headers=_auth_header(token_a),
    )
    assert resp.json()["status"] == "failed"


@pytest.mark.asyncio
async def test_send_reactivates_terminated_topic_with_goal(client: AsyncClient):
    """Sending a message with new goal to a terminated topic should reactivate it."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    room = await _create_room(client, token_a, member_ids=[agent_b])
    room_id = room["room_id"]

    # Create and complete topic
    env1 = _build_envelope(sk_a, key_a, agent_a, room_id, topic="reactivate-topic", goal="Initial")
    await client.post("/hub/send", json=env1, headers=_auth_header(token_a))

    env2 = _build_envelope(
        sk_a, key_a, agent_a, room_id,
        msg_type="result", topic="reactivate-topic",
        payload={"text": "Done"},
    )
    resp2 = await client.post("/hub/send", json=env2, headers=_auth_header(token_a))
    topic_id = resp2.json()["topic_id"]

    # Verify completed
    resp = await client.get(f"/hub/rooms/{room_id}/topics/{topic_id}", headers=_auth_header(token_a))
    assert resp.json()["status"] == "completed"

    # Send new message with goal → reactivate
    env3 = _build_envelope(
        sk_a, key_a, agent_a, room_id,
        topic="reactivate-topic", goal="New task",
    )
    resp3 = await client.post("/hub/send", json=env3, headers=_auth_header(token_a))
    assert resp3.json()["topic_id"] == topic_id

    # Verify re-opened
    resp = await client.get(f"/hub/rooms/{room_id}/topics/{topic_id}", headers=_auth_header(token_a))
    assert resp.json()["status"] == "open"
    assert resp.json()["goal"] == "New task"
    assert resp.json()["closed_at"] is None


# ===========================================================================
# Inbox/History integration tests
# ===========================================================================


@pytest.mark.asyncio
async def test_inbox_includes_topic_id(client: AsyncClient):
    """Inbox response should include topic_id."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    room = await _create_room(client, token_a, member_ids=[agent_b])
    room_id = room["room_id"]

    envelope = _build_envelope(
        sk_a, key_a, agent_a, room_id,
        topic="inbox-topic", goal="Check inbox",
    )
    resp = await client.post("/hub/send", json=envelope, headers=_auth_header(token_a))
    send_topic_id = resp.json()["topic_id"]

    # Poll inbox as agent_b
    resp = await client.get(
        "/hub/inbox",
        headers=_auth_header(token_b),
    )
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert len(messages) >= 1
    msg = messages[0]
    assert msg["topic_id"] == send_topic_id
    assert msg["topic"] == "inbox-topic"


@pytest.mark.asyncio
async def test_history_includes_topic_id(client: AsyncClient):
    """History response should include topic_id."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    room = await _create_room(client, token_a, member_ids=[agent_b])
    room_id = room["room_id"]

    envelope = _build_envelope(
        sk_a, key_a, agent_a, room_id,
        topic="history-topic", goal="Check history",
    )
    resp = await client.post("/hub/send", json=envelope, headers=_auth_header(token_a))
    send_topic_id = resp.json()["topic_id"]

    # Query history
    resp = await client.get(
        f"/hub/history?room_id={room_id}",
        headers=_auth_header(token_a),
    )
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert len(messages) >= 1
    # Find our message
    found = [m for m in messages if m["topic_id"] == send_topic_id]
    assert len(found) >= 1


@pytest.mark.asyncio
async def test_history_filter_by_topic_id(client: AsyncClient):
    """History can be filtered by topic_id."""
    sk_a, agent_a, key_a, token_a = await _create_agent(client, "agent-a")
    sk_b, agent_b, key_b, token_b = await _create_agent(client, "agent-b")

    room = await _create_room(client, token_a, member_ids=[agent_b])
    room_id = room["room_id"]

    # Send two messages with different topics
    env1 = _build_envelope(sk_a, key_a, agent_a, room_id, topic="topic-alpha")
    resp1 = await client.post("/hub/send", json=env1, headers=_auth_header(token_a))
    topic_id_1 = resp1.json()["topic_id"]

    env2 = _build_envelope(sk_a, key_a, agent_a, room_id, topic="topic-beta", payload={"text": "beta message"})
    resp2 = await client.post("/hub/send", json=env2, headers=_auth_header(token_a))
    topic_id_2 = resp2.json()["topic_id"]

    assert topic_id_1 != topic_id_2

    # Filter by topic_id_1
    resp = await client.get(
        f"/hub/history?room_id={room_id}&topic_id={topic_id_1}",
        headers=_auth_header(token_a),
    )
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    # All returned messages should have topic_id_1
    for m in messages:
        assert m["topic_id"] == topic_id_1


# ===========================================================================
# Room dissolve cascade test
# ===========================================================================


@pytest.mark.asyncio
async def test_room_dissolve_cascades_topics(client: AsyncClient):
    """Dissolving a room should cascade-delete its topics."""
    _, _, _, token = await _create_agent(client, "owner")
    room = await _create_room(client, token)
    room_id = room["room_id"]

    # Create a topic
    resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Cascade Topic"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201

    # Dissolve room
    resp = await client.delete(
        f"/hub/rooms/{room_id}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200

    # Room is gone, so topic list should 404
    resp = await client.get(
        f"/hub/rooms/{room_id}/topics",
        headers=_auth_header(token),
    )
    assert resp.status_code == 404
