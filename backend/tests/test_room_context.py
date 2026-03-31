"""Tests for room context endpoints (summary, messages, search, overview, global search)."""

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
from unittest.mock import AsyncMock

from sqlalchemy import select

from hub.models import Base

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(
        TEST_DB_URL,
        execution_options={"schema_translate_map": {"public": None}},
    )
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
    return agent_id, key_id, token


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_agent(client: AsyncClient, name: str = "agent", db_session: AsyncSession | None = None):
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub, name)
    await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(token),
    )
    # Mark agent as claimed (required by get_current_claimed_agent).
    # Use flush (not commit) to avoid greenlet-context issues when the
    # same session is shared with the ASGI app via dependency override.
    if db_session:
        from sqlalchemy import text as sql_text
        await db_session.execute(
            sql_text("UPDATE agents SET claimed_at = CURRENT_TIMESTAMP WHERE agent_id = :aid"),
            {"aid": agent_id},
        )
        await db_session.flush()
    return sk, agent_id, key_id, token


def _build_envelope(
    sk: SigningKey,
    key_id: str,
    from_id: str,
    to_id: str,
    msg_type: str = "message",
    payload: dict | None = None,
    topic: str | None = None,
) -> dict:
    if payload is None:
        payload = {"text": "hello"}
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    canonical = jcs.canonicalize(payload)
    payload_hash = "sha256:" + hashlib.sha256(canonical).hexdigest()

    parts = [
        "a2a/0.1", msg_id, str(ts), from_id, to_id,
        msg_type, "", "3600", payload_hash,
    ]
    signing_input = "\n".join(parts).encode()
    signed = sk.sign(signing_input)
    sig_b64 = base64.b64encode(signed.signature).decode()

    envelope = {
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
    if topic:
        envelope["topic"] = topic
    return envelope


async def _create_room(client: AsyncClient, token: str, name: str = "Test Room", **kwargs):
    resp = await client.post(
        "/hub/rooms",
        json={"name": name, "visibility": "public", "join_policy": "open", **kwargs},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    return resp.json()


async def _send_msg(client: AsyncClient, sk, key_id, from_id, to_id, text="hello", topic=None):
    envelope = _build_envelope(sk, key_id, from_id, to_id, payload={"text": text}, topic=topic)
    q = f"?topic={topic}" if topic else ""
    resp = await client.post(
        f"/hub/send{q}",
        json=envelope,
        headers=_auth_header("dummy"),  # will be overridden by agent auth
    )
    # We need the agent's token, but in this test we just use the sending agent's token
    return resp


async def _send_msg_with_token(client, sk, key_id, from_id, to_id, token, text="hello", topic=None):
    envelope = _build_envelope(sk, key_id, from_id, to_id, payload={"text": text}, topic=topic)
    q = f"?topic={topic}" if topic else ""
    resp = await client.post(
        f"/hub/send{q}",
        json=envelope,
        headers=_auth_header(token),
    )
    return resp


# ===========================================================================
# Tests
# ===========================================================================


@pytest.mark.asyncio
async def test_rooms_overview_empty(client: AsyncClient, db_session: AsyncSession):
    """Overview returns empty when agent has no rooms."""
    sk, agent_id, key_id, token = await _create_agent(client, "loner", db_session)
    resp = await client.get("/hub/rooms/overview", headers=_auth_header(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["rooms"] == []


@pytest.mark.asyncio
async def test_rooms_overview_with_rooms(client: AsyncClient, db_session: AsyncSession):
    """Overview lists rooms the agent has joined."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room = await _create_room(client, token, "Alpha Room")

    resp = await client.get("/hub/rooms/overview", headers=_auth_header(token))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["rooms"]) == 1
    assert data["rooms"][0]["room_id"] == room["room_id"]
    assert data["rooms"][0]["name"] == "Alpha Room"


@pytest.mark.asyncio
async def test_room_summary(client: AsyncClient, db_session: AsyncSession):
    """Summary returns room info, members, stats."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room = await _create_room(client, token, "Summary Room")
    room_id = room["room_id"]

    resp = await client.get(f"/hub/rooms/{room_id}/summary", headers=_auth_header(token))
    assert resp.status_code == 200
    data = resp.json()

    assert data["room"]["room_id"] == room_id
    assert data["room"]["name"] == "Summary Room"
    assert data["room"]["visibility"] == "public"
    assert len(data["members"]) == 1
    assert data["members"][0]["agent_id"] == agent_id
    assert data["stats"]["total_messages"] == 0
    assert data["stats"]["open_topic_count"] == 0


@pytest.mark.asyncio
async def test_room_summary_non_member_forbidden(client: AsyncClient, db_session: AsyncSession):
    """Non-member cannot access room summary."""
    sk1, agent1, key1, token1 = await _create_agent(client, "owner", db_session)
    sk2, agent2, key2, token2 = await _create_agent(client, "stranger", db_session)
    room = await _create_room(client, token1, "Private Club", visibility="private", join_policy="invite_only")

    resp = await client.get(f"/hub/rooms/{room['room_id']}/summary", headers=_auth_header(token2))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_room_messages_empty(client: AsyncClient, db_session: AsyncSession):
    """Messages endpoint returns empty for room with no messages."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room = await _create_room(client, token, "Empty Room")

    resp = await client.get(f"/hub/rooms/{room['room_id']}/messages", headers=_auth_header(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["messages"] == []
    assert data["has_more"] is False


@pytest.mark.asyncio
async def test_room_messages_with_messages(client: AsyncClient, db_session: AsyncSession):
    """Messages endpoint returns deduped messages."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room = await _create_room(client, token, "Chat Room")
    room_id = room["room_id"]

    # Send some messages
    for i in range(3):
        await _send_msg_with_token(
            client, sk, key_id, agent_id, room_id, token,
            text=f"message {i}",
        )

    resp = await client.get(f"/hub/rooms/{room_id}/messages", headers=_auth_header(token))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 3
    # Newest first
    assert "message 2" in data["messages"][0]["text"]


@pytest.mark.asyncio
async def test_room_messages_pagination(client: AsyncClient, db_session: AsyncSession):
    """Messages endpoint supports cursor pagination."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room = await _create_room(client, token, "Paginated Room")
    room_id = room["room_id"]

    for i in range(5):
        await _send_msg_with_token(
            client, sk, key_id, agent_id, room_id, token,
            text=f"msg {i}",
        )

    # First page
    resp = await client.get(
        f"/hub/rooms/{room_id}/messages?limit=2",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 2
    assert data["has_more"] is True

    # Second page using before cursor
    cursor = data["messages"][-1]["hub_msg_id"]
    resp = await client.get(
        f"/hub/rooms/{room_id}/messages?limit=2&before={cursor}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data2 = resp.json()
    assert len(data2["messages"]) == 2


@pytest.mark.asyncio
async def test_room_search(client: AsyncClient, db_session: AsyncSession):
    """Search finds messages containing the query text."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room = await _create_room(client, token, "Search Room")
    room_id = room["room_id"]

    await _send_msg_with_token(client, sk, key_id, agent_id, room_id, token, text="the quick brown fox")
    await _send_msg_with_token(client, sk, key_id, agent_id, room_id, token, text="lazy dog")
    await _send_msg_with_token(client, sk, key_id, agent_id, room_id, token, text="fox jumped over")

    resp = await client.get(
        f"/hub/rooms/{room_id}/search?q=fox",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["query"] == "fox"
    assert len(data["results"]) == 2
    for r in data["results"]:
        assert "fox" in r["snippet"].lower()


@pytest.mark.asyncio
async def test_room_search_no_results(client: AsyncClient, db_session: AsyncSession):
    """Search returns empty when no messages match."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room = await _create_room(client, token, "Search Room 2")
    room_id = room["room_id"]

    await _send_msg_with_token(client, sk, key_id, agent_id, room_id, token, text="hello world")

    resp = await client.get(
        f"/hub/rooms/{room_id}/search?q=nonexistent",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["results"]) == 0


@pytest.mark.asyncio
async def test_global_search(client: AsyncClient, db_session: AsyncSession):
    """Global search finds messages across multiple rooms."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room1 = await _create_room(client, token, "Room Alpha")
    room2 = await _create_room(client, token, "Room Beta")

    await _send_msg_with_token(client, sk, key_id, agent_id, room1["room_id"], token, text="deploy plan v1")
    await _send_msg_with_token(client, sk, key_id, agent_id, room2["room_id"], token, text="deploy plan v2")
    await _send_msg_with_token(client, sk, key_id, agent_id, room1["room_id"], token, text="unrelated chat")

    resp = await client.get(
        "/hub/search?q=deploy",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["query"] == "deploy"
    assert len(data["results"]) == 2
    room_ids_found = {r["room_id"] for r in data["results"]}
    assert room1["room_id"] in room_ids_found
    assert room2["room_id"] in room_ids_found


@pytest.mark.asyncio
async def test_global_search_room_filter(client: AsyncClient, db_session: AsyncSession):
    """Global search can be filtered to a specific room."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room1 = await _create_room(client, token, "Room A")
    room2 = await _create_room(client, token, "Room B")

    await _send_msg_with_token(client, sk, key_id, agent_id, room1["room_id"], token, text="keyword here")
    await _send_msg_with_token(client, sk, key_id, agent_id, room2["room_id"], token, text="keyword there")

    resp = await client.get(
        f"/hub/search?q=keyword&room_id={room1['room_id']}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["results"]) == 1
    assert data["results"][0]["room_id"] == room1["room_id"]


@pytest.mark.asyncio
async def test_room_summary_with_messages_and_topics(client: AsyncClient, db_session: AsyncSession):
    """Summary includes recent messages and active topics."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room = await _create_room(client, token, "Full Room")
    room_id = room["room_id"]

    # Create a topic
    topic_resp = await client.post(
        f"/hub/rooms/{room_id}/topics",
        json={"title": "Planning", "description": "Sprint planning", "goal": "Plan Q2"},
        headers=_auth_header(token),
    )
    assert topic_resp.status_code == 201

    # Send messages
    await _send_msg_with_token(client, sk, key_id, agent_id, room_id, token, text="first msg")
    await _send_msg_with_token(client, sk, key_id, agent_id, room_id, token, text="second msg")

    resp = await client.get(f"/hub/rooms/{room_id}/summary", headers=_auth_header(token))
    assert resp.status_code == 200
    data = resp.json()

    assert data["stats"]["total_messages"] == 2
    assert data["stats"]["open_topic_count"] == 1
    assert len(data["active_topics"]) == 1
    assert data["active_topics"][0]["title"] == "Planning"
    assert len(data["recent_messages"]) == 2


@pytest.mark.asyncio
async def test_room_messages_sender_filter(client: AsyncClient, db_session: AsyncSession):
    """Messages endpoint supports sender_id filter."""
    sk, agent_id, key_id, token = await _create_agent(client, "owner", db_session)
    room = await _create_room(client, token, "Filter Room")
    room_id = room["room_id"]

    # Send multiple messages (all from same owner, filter by sender_id = owner)
    await _send_msg_with_token(client, sk, key_id, agent_id, room_id, token, text="msg one")
    await _send_msg_with_token(client, sk, key_id, agent_id, room_id, token, text="msg two")

    # Filter by this agent's messages
    resp = await client.get(
        f"/hub/rooms/{room_id}/messages?sender_id={agent_id}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 2
    for m in data["messages"]:
        assert m["from"] == agent_id

    # Filter by non-existent sender returns empty
    resp = await client.get(
        f"/hub/rooms/{room_id}/messages?sender_id=ag_nonexistent",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 0
