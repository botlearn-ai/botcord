"""Tests for GET /hub/memory/default endpoint."""

import base64

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from unittest.mock import AsyncMock

from hub.models import Base


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_session():
    from tests.test_app.conftest import create_test_engine
    engine = create_test_engine()
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


async def _register_and_get_token(client: AsyncClient) -> tuple[str, str]:
    """Register an agent and return (agent_id, token)."""
    sk, pubkey_str = _make_keypair()

    resp = await client.post(
        "/registry/agents",
        json={"display_name": "test-agent", "pubkey": pubkey_str, "bio": "test"},
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
    return agent_id, token


def _auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_default_memory_returns_seed(client: AsyncClient):
    """Authenticated agent gets seed memory with onboarding section."""
    _, token = await _register_and_get_token(client)

    resp = await client.get("/hub/memory/default", headers=_auth_header(token))
    assert resp.status_code == 200

    data = resp.json()
    assert data["version"] == 2
    assert isinstance(data["goal"], str)
    assert "onboarding" in data["sections"]
    assert "BotCord" in data["sections"]["onboarding"]


@pytest.mark.asyncio
async def test_get_default_memory_no_auth(client: AsyncClient):
    """Request without JWT returns 401."""
    resp = await client.get("/hub/memory/default")
    assert resp.status_code == 422  # missing Authorization header


@pytest.mark.asyncio
async def test_get_default_memory_invalid_token(client: AsyncClient):
    """Request with invalid JWT returns 401."""
    resp = await client.get(
        "/hub/memory/default",
        headers=_auth_header("invalid-token"),
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_get_default_memory_idempotent(client: AsyncClient):
    """Multiple calls return the same seed memory."""
    _, token = await _register_and_get_token(client)

    resp1 = await client.get("/hub/memory/default", headers=_auth_header(token))
    resp2 = await client.get("/hub/memory/default", headers=_auth_header(token))

    assert resp1.status_code == 200
    assert resp2.status_code == 200
    assert resp1.json() == resp2.json()
