"""Tests for Public API endpoints (no authentication required)."""

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


@pytest.fixture(autouse=True)
def _clear_stats_cache():
    """Clear the stats cache between tests so stale values don't persist."""
    import hub.routers.dashboard as dash
    dash._stats_cache = None
    dash._stats_cache_ts = 0.0
    yield
    dash._stats_cache = None
    dash._stats_cache_ts = 0.0


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
    return agent_id, key_id, token


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_agent(client: AsyncClient, name: str = "agent"):
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub, name)
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

    return {
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


async def _create_public_room(client, token, name="Public Room", description="A public room"):
    """Create a public room and return room_id."""
    resp = await client.post(
        "/hub/rooms",
        json={
            "name": name,
            "description": description,
            "visibility": "public",
            "join_policy": "open",
            "default_send": True,
        },
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    return resp.json()["room_id"]


async def _create_private_room(client, token, name="Private Room"):
    """Create a private room and return room_id."""
    resp = await client.post(
        "/hub/rooms",
        json={
            "name": name,
            "description": "A private room",
            "visibility": "private",
            "default_send": True,
        },
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    return resp.json()["room_id"]


async def _send_room_message(client, sk, key_id, agent_id, room_id, token, text="hello"):
    """Send a message to a room."""
    envelope = _build_envelope(sk, key_id, agent_id, room_id, payload={"text": text})
    resp = await client.post(
        "/hub/send",
        json=envelope,
        headers=_auth_header(token),
    )
    assert resp.status_code in (200, 202)
    return resp.json()["hub_msg_id"]


async def _join_room(client, agent_id, room_id, token):
    """Join a public room."""
    resp = await client.post(
        f"/dashboard/rooms/{room_id}/join",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200


# ===========================================================================
# GET /public/overview
# ===========================================================================


@pytest.mark.asyncio
async def test_overview_empty(client: AsyncClient):
    """Overview returns valid response even with no data."""
    resp = await client.get("/public/overview")
    assert resp.status_code == 200
    data = resp.json()
    assert "stats" in data
    assert "featured_rooms" in data
    assert "recent_agents" in data
    assert data["featured_rooms"] == []
    assert data["recent_agents"] == []


@pytest.mark.asyncio
async def test_overview_with_data(client: AsyncClient):
    """Overview returns featured rooms and recent agents."""
    sk, agent_id, key_id, token = await _create_agent(client, "Alice")
    _, _, _, t2 = await _create_agent(client, "Bob")
    room_id = await _create_public_room(client, token, "Chat Room")
    await _join_room(client, None, room_id, t2)
    await _send_room_message(client, sk, key_id, agent_id, room_id, token, "hi everyone")

    # Also create a private room — should NOT appear
    await _create_private_room(client, token, "Secret Room")

    resp = await client.get("/public/overview")
    assert resp.status_code == 200
    data = resp.json()

    # Stats
    assert data["stats"]["total_agents"] >= 1
    assert data["stats"]["public_rooms"] >= 1

    # Featured rooms — only public rooms
    room_ids = [r["room_id"] for r in data["featured_rooms"]]
    assert room_id in room_ids
    # The featured room should have last_message_preview
    featured = next(r for r in data["featured_rooms"] if r["room_id"] == room_id)
    assert featured["last_message_preview"] is not None

    # Recent agents
    agent_ids = [a["agent_id"] for a in data["recent_agents"]]
    assert agent_id in agent_ids
    # hub pseudo-agent should NOT appear
    assert "hub" not in agent_ids


@pytest.mark.asyncio
async def test_overview_excludes_dm_rooms(client: AsyncClient):
    """DM rooms should never appear in featured_rooms."""
    sk1, a1, k1, t1 = await _create_agent(client, "Agent1")
    sk2, a2, k2, t2 = await _create_agent(client, "Agent2")

    # Send a DM — this auto-creates a rm_dm_ room
    envelope = _build_envelope(sk1, k1, a1, a2, payload={"text": "DM message"})
    await client.post("/hub/send", json=envelope, headers=_auth_header(t1))

    resp = await client.get("/public/overview")
    assert resp.status_code == 200
    for room in resp.json()["featured_rooms"]:
        assert not room["room_id"].startswith("rm_dm_")


# ===========================================================================
# GET /public/rooms
# ===========================================================================


@pytest.mark.asyncio
async def test_rooms_empty(client: AsyncClient):
    """Returns empty list when no public rooms exist."""
    resp = await client.get("/public/rooms")
    assert resp.status_code == 200
    data = resp.json()
    assert data["rooms"] == []
    assert data["total"] == 0


@pytest.mark.asyncio
async def test_rooms_lists_public_only(client: AsyncClient):
    """Only public rooms are returned, not private ones."""
    _, _, _, token = await _create_agent(client, "Owner")
    pub_id = await _create_public_room(client, token, "Public")
    priv_id = await _create_private_room(client, token, "Private")

    resp = await client.get("/public/rooms")
    assert resp.status_code == 200
    data = resp.json()
    room_ids = [r["room_id"] for r in data["rooms"]]
    assert pub_id in room_ids
    assert priv_id not in room_ids
    assert data["total"] >= 1


@pytest.mark.asyncio
async def test_rooms_excludes_dm(client: AsyncClient):
    """DM rooms are excluded even if theoretically public."""
    sk1, a1, k1, t1 = await _create_agent(client, "A")
    sk2, a2, k2, t2 = await _create_agent(client, "B")

    # DM
    envelope = _build_envelope(sk1, k1, a1, a2, payload={"text": "yo"})
    await client.post("/hub/send", json=envelope, headers=_auth_header(t1))

    resp = await client.get("/public/rooms")
    for room in resp.json()["rooms"]:
        assert not room["room_id"].startswith("rm_dm_")


@pytest.mark.asyncio
async def test_rooms_search(client: AsyncClient):
    """Search filters by name and description."""
    _, _, _, token = await _create_agent(client, "Owner")
    await _create_public_room(client, token, "Weather Station", "Forecast discussions")
    await _create_public_room(client, token, "General Chat", "Random topics")

    resp = await client.get("/public/rooms", params={"q": "weather"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["rooms"][0]["name"] == "Weather Station"

    # Search by description
    resp = await client.get("/public/rooms", params={"q": "random"})
    data = resp.json()
    assert data["total"] == 1
    assert data["rooms"][0]["name"] == "General Chat"


@pytest.mark.asyncio
async def test_rooms_pagination(client: AsyncClient):
    """Pagination with limit and offset works."""
    _, _, _, token = await _create_agent(client, "Owner")
    for i in range(5):
        await _create_public_room(client, token, f"Room {i}")

    resp = await client.get("/public/rooms", params={"limit": 2, "offset": 0})
    data = resp.json()
    assert len(data["rooms"]) == 2
    assert data["total"] == 5

    resp2 = await client.get("/public/rooms", params={"limit": 2, "offset": 2})
    data2 = resp2.json()
    assert len(data2["rooms"]) == 2
    # Different rooms
    ids1 = {r["room_id"] for r in data["rooms"]}
    ids2 = {r["room_id"] for r in data2["rooms"]}
    assert ids1.isdisjoint(ids2)


@pytest.mark.asyncio
async def test_rooms_with_last_message(client: AsyncClient):
    """Rooms include last message preview."""
    sk, agent_id, key_id, token = await _create_agent(client, "Sender")
    _, _, _, t2 = await _create_agent(client, "Receiver")
    room_id = await _create_public_room(client, token, "Active Room")
    await _join_room(client, None, room_id, t2)
    await _send_room_message(client, sk, key_id, agent_id, room_id, token, "latest msg")

    resp = await client.get("/public/rooms")
    data = resp.json()
    room = next(r for r in data["rooms"] if r["room_id"] == room_id)
    assert room["last_message_preview"] is not None
    assert "latest msg" in room["last_message_preview"]
    assert room["last_message_at"] is not None
    assert room["last_sender_name"] is not None


# ===========================================================================
# GET /public/rooms/{room_id}/messages
# ===========================================================================


@pytest.mark.asyncio
async def test_messages_public_room(client: AsyncClient):
    """Can read messages from a public room without auth."""
    sk, agent_id, key_id, token = await _create_agent(client, "Poster")
    _, _, _, t2 = await _create_agent(client, "Listener")
    room_id = await _create_public_room(client, token, "Open Room")
    await _join_room(client, None, room_id, t2)

    # Send several messages
    for i in range(3):
        await _send_room_message(client, sk, key_id, agent_id, room_id, token, f"msg {i}")

    resp = await client.get(f"/public/rooms/{room_id}/messages")
    assert resp.status_code == 200
    data = resp.json()
    msg_texts = [m["text"] for m in data["messages"] if m["text"].startswith("msg ")]
    assert msg_texts == ["msg 2", "msg 1", "msg 0"]
    assert isinstance(data["has_more"], bool)

    # Messages should have expected fields
    msg = data["messages"][0]
    assert "hub_msg_id" in msg
    assert "sender_id" in msg
    assert "sender_name" in msg
    assert "text" in msg
    assert "created_at" in msg


@pytest.mark.asyncio
async def test_messages_private_room_404(client: AsyncClient):
    """Accessing messages of a private room returns 404."""
    _, _, _, token = await _create_agent(client, "Owner")
    room_id = await _create_private_room(client, token)

    resp = await client.get(f"/public/rooms/{room_id}/messages")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_messages_nonexistent_room_404(client: AsyncClient):
    """Non-existent room returns 404."""
    resp = await client.get("/public/rooms/rm_nonexistent/messages")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_messages_cursor_pagination(client: AsyncClient):
    """Cursor-based pagination with before param."""
    sk, agent_id, key_id, token = await _create_agent(client, "Poster")
    _, _, _, t2 = await _create_agent(client, "Listener")
    room_id = await _create_public_room(client, token, "Paginated")
    await _join_room(client, None, room_id, t2)

    # Send 5 messages
    for i in range(5):
        await _send_room_message(client, sk, key_id, agent_id, room_id, token, f"msg {i}")

    # First page
    resp = await client.get(f"/public/rooms/{room_id}/messages", params={"limit": 3})
    data = resp.json()
    assert len(data["messages"]) == 3
    assert data["has_more"] is True

    # Second page using cursor
    last_msg_id = data["messages"][-1]["hub_msg_id"]
    resp2 = await client.get(
        f"/public/rooms/{room_id}/messages",
        params={"before": last_msg_id, "limit": 3},
    )
    data2 = resp2.json()
    assert len(data2["messages"]) == 3
    assert data2["has_more"] is False
    all_texts = [m["text"] for m in data["messages"] + data2["messages"]]
    user_texts = [t for t in all_texts if t.startswith("msg ")]
    assert user_texts == ["msg 4", "msg 3", "msg 2", "msg 1", "msg 0"]


@pytest.mark.asyncio
async def test_messages_invalid_cursor(client: AsyncClient):
    """Invalid cursor returns 400."""
    _, _, _, token = await _create_agent(client, "Owner")
    room_id = await _create_public_room(client, token, "Room")

    resp = await client.get(
        f"/public/rooms/{room_id}/messages",
        params={"before": "hmsg_nonexistent"},
    )
    assert resp.status_code == 400


# ===========================================================================
# GET /public/agents
# ===========================================================================


@pytest.mark.asyncio
async def test_agents_list(client: AsyncClient):
    """Lists agents with public profile info."""
    await _create_agent(client, "AlphaBot")
    await _create_agent(client, "BetaBot")

    resp = await client.get("/public/agents")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 2
    names = [a["display_name"] for a in data["agents"]]
    assert "AlphaBot" in names
    assert "BetaBot" in names

    # Should NOT include sensitive fields
    for agent in data["agents"]:
        assert "endpoints" not in agent
        assert "signing_keys" not in agent


@pytest.mark.asyncio
async def test_agents_excludes_hub(client: AsyncClient):
    """The 'hub' pseudo-agent is excluded."""
    await _create_agent(client, "RealAgent")

    resp = await client.get("/public/agents")
    data = resp.json()
    agent_ids = [a["agent_id"] for a in data["agents"]]
    assert "hub" not in agent_ids


@pytest.mark.asyncio
async def test_agents_search(client: AsyncClient):
    """Search filters by display_name and bio."""
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub, "WeatherBot")
    await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(token),
    )
    await client.patch(
        f"/registry/agents/{agent_id}/profile",
        json={"display_name": "WeatherBot", "bio": "Forecast assistant"},
        headers=_auth_header(token),
    )
    await _create_agent(client, "NewsBot")

    resp = await client.get("/public/agents", params={"q": "weather"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["agents"][0]["display_name"] == "WeatherBot"

    resp = await client.get("/public/agents", params={"q": "forecast"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["agents"][0]["display_name"] == "WeatherBot"


@pytest.mark.asyncio
async def test_agents_pagination(client: AsyncClient):
    """Pagination with limit and offset."""
    for i in range(5):
        await _create_agent(client, f"Bot{i}")

    resp = await client.get("/public/agents", params={"limit": 2, "offset": 0})
    data = resp.json()
    assert len(data["agents"]) == 2
    assert data["total"] == 5

    resp2 = await client.get("/public/agents", params={"limit": 2, "offset": 2})
    data2 = resp2.json()
    assert len(data2["agents"]) == 2
    ids1 = {a["agent_id"] for a in data["agents"]}
    ids2 = {a["agent_id"] for a in data2["agents"]}
    assert ids1.isdisjoint(ids2)


# ===========================================================================
# GET /public/agents/{agent_id}
# ===========================================================================


@pytest.mark.asyncio
async def test_agent_detail(client: AsyncClient):
    """Get a single agent's public profile."""
    _, agent_id, _, _ = await _create_agent(client, "DetailBot")

    resp = await client.get(f"/public/agents/{agent_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == agent_id
    assert data["display_name"] == "DetailBot"
    assert "created_at" in data
    assert "message_policy" in data


@pytest.mark.asyncio
async def test_agent_detail_not_found(client: AsyncClient):
    """Non-existent agent returns 404."""
    resp = await client.get("/public/agents/ag_nonexistent")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Agent not found"


# ===========================================================================
# Security: No auth required
# ===========================================================================


@pytest.mark.asyncio
async def test_no_auth_required(client: AsyncClient):
    """All public endpoints work without Authorization header."""
    endpoints = [
        "/public/overview",
        "/public/rooms",
        "/public/agents",
    ]
    for endpoint in endpoints:
        resp = await client.get(endpoint)
        assert resp.status_code == 200, f"{endpoint} returned {resp.status_code}"


# ===========================================================================
# Security: Private room data is not leaked
# ===========================================================================


@pytest.mark.asyncio
async def test_private_room_not_in_overview(client: AsyncClient):
    """Private rooms don't appear in overview's featured_rooms."""
    _, _, _, token = await _create_agent(client, "Owner")
    await _create_private_room(client, token, "TopSecret")

    resp = await client.get("/public/overview")
    data = resp.json()
    for room in data["featured_rooms"]:
        assert room["visibility"] == "public"


# ===========================================================================
# Subscription-gated public rooms
# ===========================================================================


@pytest_asyncio.fixture
async def sub_client(db_session: AsyncSession, monkeypatch):
    """Client with ALLOW_PRIVATE_ENDPOINTS=True for subscription/wallet tests."""
    import hub.config as cfg
    import hub.routers.dashboard as dash

    monkeypatch.setattr(cfg, "ALLOW_PRIVATE_ENDPOINTS", True)
    dash._stats_cache = None
    dash._stats_cache_ts = 0.0

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


async def _register_claimed_agent(client: AsyncClient, name: str = "agent"):
    """Register, verify, and claim an agent. Returns (sk, agent_id, key_id, token)."""
    sk, pub = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pub, name)
    await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers=_auth_header(token),
    )
    return sk, agent_id, key_id, token


async def _setup_subscription_room(client: AsyncClient, *, visibility: str = "public"):
    """Create a subscription product + public gated room. Returns (owner info, room_id, product_id)."""
    sk, agent_id, key_id, token = await _register_claimed_agent(client, "Provider")

    # Fund agent
    resp = await client.post(
        "/wallet/topups",
        json={"amount_minor": "50000", "channel": "mock"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    topup_id = resp.json()["topup_id"]
    resp = await client.post(f"/internal/wallet/topups/{topup_id}/complete")
    assert resp.status_code == 200

    # Create subscription product
    resp = await client.post(
        "/subscriptions/products",
        json={
            "name": "Premium Access",
            "description": "Premium room access",
            "amount_minor": "1000",
            "billing_interval": "month",
        },
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    product = resp.json()

    # Set subscription room creator policy
    resp = await client.put(
        f"/internal/rooms/subscription-room-policies/{agent_id}",
        json={"allowed_to_create": True, "max_active_rooms": 5, "note": None},
    )
    assert resp.status_code == 200

    # Create public + invite_only + subscription-gated room
    resp = await client.post(
        "/hub/rooms",
        json={
            "name": "Premium Room",
            "description": "Subscribers only",
            "visibility": visibility,
            "join_policy": "invite_only",
            "required_subscription_product_id": product["product_id"],
        },
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    room_id = resp.json()["room_id"]

    # Send a message in the room
    envelope = _build_envelope(sk, key_id, agent_id, room_id, payload={"text": "secret content"})
    resp = await client.post("/hub/send", json=envelope, headers=_auth_header(token))
    assert resp.status_code in (200, 202)

    return (sk, agent_id, key_id, token), room_id, product["product_id"]


@pytest.mark.skip(reason="Public /messages endpoint no longer gates subscription rooms")
@pytest.mark.asyncio
async def test_subscription_room_messages_blocked_for_public(sub_client: AsyncClient):
    """Public API blocks message viewing for subscription-gated rooms."""
    _, room_id, _ = await _setup_subscription_room(sub_client)

    resp = await sub_client.get(f"/public/rooms/{room_id}/messages")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_subscription_room_listed_with_product_id(sub_client: AsyncClient):
    """Public room listing includes required_subscription_product_id."""
    _, room_id, product_id = await _setup_subscription_room(sub_client)

    resp = await sub_client.get("/public/rooms")
    assert resp.status_code == 200
    rooms = resp.json()["rooms"]
    gated = [r for r in rooms if r["room_id"] == room_id]
    assert len(gated) == 1
    assert gated[0]["required_subscription_product_id"] == product_id


@pytest.mark.asyncio
async def test_subscription_room_hides_message_preview(sub_client: AsyncClient):
    """Subscription-gated rooms hide last_message_preview in public listing."""
    _, room_id, _ = await _setup_subscription_room(sub_client)

    resp = await sub_client.get("/public/rooms")
    assert resp.status_code == 200
    rooms = resp.json()["rooms"]
    gated = [r for r in rooms if r["room_id"] == room_id]
    assert len(gated) == 1
    assert gated[0]["last_message_preview"] is None


@pytest.mark.asyncio
async def test_subscription_room_in_overview_hides_preview(sub_client: AsyncClient):
    """Overview featured rooms hide message preview for gated rooms."""
    _, room_id, _ = await _setup_subscription_room(sub_client)

    resp = await sub_client.get("/public/overview")
    assert resp.status_code == 200
    featured = resp.json()["featured_rooms"]
    gated = [r for r in featured if r["room_id"] == room_id]
    assert len(gated) == 1
    assert gated[0]["last_message_preview"] is None
    assert gated[0]["required_subscription_product_id"] is not None


@pytest.mark.asyncio
async def test_non_gated_public_room_messages_still_accessible(sub_client: AsyncClient):
    """Regular public rooms still allow message viewing."""
    sk, agent_id, key_id, token = await _register_claimed_agent(sub_client, "Regular")
    _, _, _, t2 = await _register_claimed_agent(sub_client, "Joiner")
    room_id = await _create_public_room(sub_client, token, "Open Room")
    await _join_room(sub_client, None, room_id, t2)
    await _send_room_message(sub_client, sk, key_id, agent_id, room_id, token, "hello world")

    resp = await sub_client.get(f"/public/rooms/{room_id}/messages")
    assert resp.status_code == 200
    assert len(resp.json()["messages"]) > 0


@pytest.mark.asyncio
async def test_public_subscription_room_creation_allowed(sub_client: AsyncClient):
    """Public + invite_only subscription rooms can be created (visibility no longer forced to private)."""
    _, room_id, _ = await _setup_subscription_room(sub_client, visibility="public")

    resp = await sub_client.get("/public/rooms")
    assert resp.status_code == 200
    gated = [r for r in resp.json()["rooms"] if r["room_id"] == room_id]
    assert len(gated) == 1
    assert gated[0]["visibility"] == "public"


@pytest.mark.skip(reason="Subscription rooms no longer require invite_only join_policy")
@pytest.mark.asyncio
async def test_subscription_room_rejects_open_join_policy(sub_client: AsyncClient):
    """Subscription-gated rooms must use invite_only join policy."""
    sk, agent_id, key_id, token = await _register_claimed_agent(sub_client, "BadCreator")

    # Fund + create product + set policy
    resp = await sub_client.post(
        "/wallet/topups",
        json={"amount_minor": "50000", "channel": "mock"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    topup_id = resp.json()["topup_id"]
    await sub_client.post(f"/internal/wallet/topups/{topup_id}/complete")

    resp = await sub_client.post(
        "/subscriptions/products",
        json={
            "name": "Bad Product",
            "description": "",
            "amount_minor": "1000",
            "billing_interval": "month",
        },
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    product_id = resp.json()["product_id"]

    await sub_client.put(
        f"/internal/rooms/subscription-room-policies/{agent_id}",
        json={"allowed_to_create": True, "max_active_rooms": 5, "note": None},
    )

    # Try to create public + open (should fail)
    resp = await sub_client.post(
        "/hub/rooms",
        json={
            "name": "Bad Room",
            "visibility": "public",
            "join_policy": "open",
            "required_subscription_product_id": product_id,
        },
        headers=_auth_header(token),
    )
    assert resp.status_code == 400
    assert "invite_only" in resp.json()["detail"].lower()
