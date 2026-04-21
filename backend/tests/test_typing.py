"""Tests for POST /hub/typing — ephemeral typing indicator broadcast."""

import base64

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
    await client.patch(
        f"/registry/agents/{agent_id}/policy",
        json={"message_policy": "open"},
        headers={"Authorization": f"Bearer {token}"},
    )
    return agent_id, key_id, token


async def _create_room_with_members(
    client: AsyncClient,
    owner_token: str,
    member_ids: list[str],
    name: str = "test-room",
):
    """Create a room and add members."""
    resp = await client.post(
        "/hub/rooms",
        json={"name": name, "member_ids": member_ids},
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert resp.status_code == 201
    return resp.json()["room_id"]


@pytest.mark.asyncio
async def test_typing_returns_204(client: AsyncClient):
    """POST /hub/typing should return 204 No Content for a valid member."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, _, token_a = await _register_and_verify(client, sk_a, pub_a, "Agent A")
    agent_b, _, token_b = await _register_and_verify(client, sk_b, pub_b, "Agent B")

    room_id = await _create_room_with_members(client, token_a, [agent_b])

    resp = await client.post(
        "/hub/typing",
        json={"room_id": room_id},
        headers={"Authorization": f"Bearer {token_a}"},
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_typing_non_member_403(client: AsyncClient):
    """POST /hub/typing should return 403 for non-members."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    sk_c, pub_c = _make_keypair()
    agent_a, _, token_a = await _register_and_verify(client, sk_a, pub_a, "Agent A")
    agent_b, _, token_b = await _register_and_verify(client, sk_b, pub_b, "Agent B")
    agent_c, _, token_c = await _register_and_verify(client, sk_c, pub_c, "Agent C")

    room_id = await _create_room_with_members(client, token_a, [agent_b])

    # Agent C is not a member
    resp = await client.post(
        "/hub/typing",
        json={"room_id": room_id},
        headers={"Authorization": f"Bearer {token_c}"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_typing_unknown_room_404(client: AsyncClient):
    """POST /hub/typing should return 404 for non-existent rooms."""
    sk, pub = _make_keypair()
    _, _, token = await _register_and_verify(client, sk, pub)

    resp = await client.post(
        "/hub/typing",
        json={"room_id": "rm_nonexistent"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_typing_dedup(client: AsyncClient):
    """Rapid consecutive typing requests should be deduped (still return 204)."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, _, token_a = await _register_and_verify(client, sk_a, pub_a, "Agent A")
    agent_b, _, token_b = await _register_and_verify(client, sk_b, pub_b, "Agent B")

    room_id = await _create_room_with_members(client, token_a, [agent_b])

    # Both should return 204 — dedup just prevents redundant fan-out
    resp1 = await client.post(
        "/hub/typing",
        json={"room_id": room_id},
        headers={"Authorization": f"Bearer {token_a}"},
    )
    resp2 = await client.post(
        "/hub/typing",
        json={"room_id": room_id},
        headers={"Authorization": f"Bearer {token_a}"},
    )
    assert resp1.status_code == 204
    assert resp2.status_code == 204


@pytest.mark.asyncio
async def test_typing_rate_limit_429(client: AsyncClient):
    """Exceeding typing rate limit should return 429."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, _, token_a = await _register_and_verify(client, sk_a, pub_a, "Agent A")
    agent_b, _, token_b = await _register_and_verify(client, sk_b, pub_b, "Agent B")

    room_id = await _create_room_with_members(client, token_a, [agent_b])

    # Patch the rate limit to a low value for testing
    from hub.routers import hub as hub_mod
    original = hub_mod._TYPING_RATE_LIMIT_PER_MINUTE
    hub_mod._TYPING_RATE_LIMIT_PER_MINUTE = 2
    try:
        # First two should succeed (204)
        for _ in range(2):
            # Clear dedup so each request actually counts
            hub_mod._typing_dedup.clear()
            resp = await client.post(
                "/hub/typing",
                json={"room_id": room_id},
                headers={"Authorization": f"Bearer {token_a}"},
            )
            assert resp.status_code == 204

        # Third should be rate-limited (429)
        hub_mod._typing_dedup.clear()
        resp = await client.post(
            "/hub/typing",
            json={"room_id": room_id},
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert resp.status_code == 429
    finally:
        hub_mod._TYPING_RATE_LIMIT_PER_MINUTE = original


@pytest.mark.asyncio
async def test_typing_ws_fanout(client: AsyncClient):
    """Typing should push a WS message to the other agent's connection."""
    sk_a, pub_a = _make_keypair()
    sk_b, pub_b = _make_keypair()
    agent_a, _, token_a = await _register_and_verify(client, sk_a, pub_a, "Agent A")
    agent_b, _, token_b = await _register_and_verify(client, sk_b, pub_b, "Agent B")

    room_id = await _create_room_with_members(client, token_a, [agent_b])

    from starlette.testclient import TestClient
    from hub.main import app

    with TestClient(app) as tc:
        # Connect Agent B's WS
        with tc.websocket_connect("/hub/ws") as ws_b:
            ws_b.send_json({"type": "auth", "token": token_b})
            auth_msg = ws_b.receive_json()
            assert auth_msg["type"] == "auth_ok"

            # Agent A sends typing
            resp = await client.post(
                "/hub/typing",
                json={"room_id": room_id},
                headers={"Authorization": f"Bearer {token_a}"},
            )
            assert resp.status_code == 204

            # Agent B should receive typing event on WS
            typing_msg = ws_b.receive_json()
            assert typing_msg["type"] == "typing"
            assert typing_msg["agent_id"] == agent_a
            assert typing_msg["room_id"] == room_id
