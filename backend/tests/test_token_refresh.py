"""Tests for POST /registry/agents/{agent_id}/token/refresh."""

import base64
import datetime

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.models import Agent, Base, KeyState

# ---------------------------------------------------------------------------
# Fixtures — in-memory SQLite database + ASGI test client
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
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_keypair() -> tuple[SigningKey, str]:
    """Return (nacl SigningKey, pubkey string in 'ed25519:<b64>' format)."""
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


async def _register_and_verify(client: AsyncClient, sk: SigningKey, pubkey_str: str):
    """Register agent, sign challenge, verify — return (agent_id, key_id)."""
    resp = await client.post(
        "/registry/agents",
        json={"display_name": "test-agent", "pubkey": pubkey_str, "bio": "test agent"},
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
    return agent_id, key_id


def _sign_nonce(sk: SigningKey, nonce_b64: str) -> str:
    """Sign a base64-encoded nonce and return the base64 signature."""
    nonce_bytes = base64.b64decode(nonce_b64)
    return base64.b64encode(sk.sign(nonce_bytes).signature).decode()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_token_refresh_success(client: AsyncClient, db_session: AsyncSession):
    """Normal refresh round-trip should return and persist a usable new token."""
    sk, pubkey_str = _make_keypair()
    agent_id, key_id = await _register_and_verify(client, sk, pubkey_str)

    agent = await db_session.scalar(select(Agent).where(Agent.agent_id == agent_id))
    assert agent is not None
    agent.claimed_at = datetime.datetime.now(datetime.timezone.utc)
    agent.agent_token = "old-token"
    agent.token_expires_at = datetime.datetime.now(
        datetime.timezone.utc
    ) + datetime.timedelta(hours=1)
    await db_session.commit()

    nonce = base64.b64encode(b"random-nonce-bytes-32-chars-long").decode()
    sig = _sign_nonce(sk, nonce)

    resp = await client.post(
        f"/registry/agents/{agent_id}/token/refresh",
        json={"key_id": key_id, "nonce": nonce, "sig": sig},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "agent_token" in data
    assert "expires_at" in data

    await db_session.refresh(agent)
    assert agent.agent_token == data["agent_token"]
    assert agent.token_expires_at is not None
    persisted_expires_at = agent.token_expires_at
    if persisted_expires_at.tzinfo is None:
        persisted_expires_at = persisted_expires_at.replace(tzinfo=datetime.timezone.utc)
    assert int(persisted_expires_at.timestamp()) == data["expires_at"]

    inbox = await client.get(
        "/hub/inbox?limit=1",
        headers={"Authorization": f"Bearer {data['agent_token']}"},
    )
    assert inbox.status_code == 200


@pytest.mark.asyncio
async def test_nonce_replay_rejected(client: AsyncClient):
    """Using the same nonce twice should be rejected (anti-replay)."""
    sk, pubkey_str = _make_keypair()
    agent_id, key_id = await _register_and_verify(client, sk, pubkey_str)

    nonce = base64.b64encode(b"unique-nonce-value-here-1234567").decode()
    sig = _sign_nonce(sk, nonce)

    resp = await client.post(
        f"/registry/agents/{agent_id}/token/refresh",
        json={"key_id": key_id, "nonce": nonce, "sig": sig},
    )
    assert resp.status_code == 200

    # Same nonce again → 409
    resp = await client.post(
        f"/registry/agents/{agent_id}/token/refresh",
        json={"key_id": key_id, "nonce": nonce, "sig": sig},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_wrong_key_id_rejected(client: AsyncClient):
    """Using a non-existent key_id should return 404."""
    sk, pubkey_str = _make_keypair()
    agent_id, key_id = await _register_and_verify(client, sk, pubkey_str)

    nonce = base64.b64encode(b"nonce-for-wrong-key-id-test-1234").decode()
    sig = _sign_nonce(sk, nonce)

    resp = await client.post(
        f"/registry/agents/{agent_id}/token/refresh",
        json={"key_id": "k_nonexistent", "nonce": nonce, "sig": sig},
    )
    assert resp.status_code == 404
    assert resp.headers.get("X-BotCord-Access-Log") is None


@pytest.mark.asyncio
async def test_missing_agent_refresh_is_terminal_quiet_stale_credentials(
    client: AsyncClient,
):
    """Missing agents use the released daemon's terminal stale-credential shape."""
    sk, _ = _make_keypair()
    nonce = base64.b64encode(b"nonce-for-missing-agent-test-123").decode()
    sig = _sign_nonce(sk, nonce)

    resp = await client.post(
        "/registry/agents/ag_missing/token/refresh",
        json={"key_id": "k_missing", "nonce": nonce, "sig": sig},
    )

    assert resp.status_code == 404
    assert resp.headers["X-BotCord-Access-Log"] == "quiet"
    assert resp.headers["X-BotCord-Refresh-Status"] == "stale-agent"
    assert resp.json()["code"] == "agent_not_found"
    assert resp.json()["retryable"] is False


@pytest.mark.asyncio
async def test_deleted_agent_refresh_is_terminal_quiet_stale_credentials(
    client: AsyncClient, db_session: AsyncSession
):
    """Soft-deleted agents should be compatible terminal refresh failures."""
    sk, pubkey_str = _make_keypair()
    agent_id, key_id = await _register_and_verify(client, sk, pubkey_str)

    agent = await db_session.scalar(select(Agent).where(Agent.agent_id == agent_id))
    assert agent is not None
    agent.status = "deleted"
    agent.deleted_at = datetime.datetime.now(datetime.timezone.utc)
    await db_session.commit()

    nonce = base64.b64encode(b"nonce-for-deleted-agent-test-123").decode()
    sig = _sign_nonce(sk, nonce)

    resp = await client.post(
        f"/registry/agents/{agent_id}/token/refresh",
        json={"key_id": key_id, "nonce": nonce, "sig": sig},
    )

    assert resp.status_code == 404
    assert resp.headers["X-BotCord-Access-Log"] == "quiet"
    assert resp.headers["X-BotCord-Refresh-Status"] == "stale-agent"
    data = resp.json()
    assert data["code"] == "agent_not_found"
    assert "agent_token" not in data


@pytest.mark.asyncio
async def test_pending_key_rejected(client: AsyncClient):
    """A key in 'pending' state should be rejected with 403."""
    sk, pubkey_str = _make_keypair()

    # Register but do NOT verify — key stays pending
    resp = await client.post(
        "/registry/agents",
        json={"display_name": "pending-agent", "pubkey": pubkey_str, "bio": "test agent"},
    )
    assert resp.status_code == 201
    data = resp.json()
    agent_id = data["agent_id"]
    key_id = data["key_id"]

    nonce = base64.b64encode(b"nonce-for-pending-key-test-12345").decode()
    sig = _sign_nonce(sk, nonce)

    resp = await client.post(
        f"/registry/agents/{agent_id}/token/refresh",
        json={"key_id": key_id, "nonce": nonce, "sig": sig},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_revoked_key_rejected(client: AsyncClient, db_session: AsyncSession):
    """A key in 'revoked' state should be rejected with 403."""
    from sqlalchemy import select, update
    from hub.models import SigningKey as SigningKeyModel

    sk, pubkey_str = _make_keypair()
    agent_id, key_id = await _register_and_verify(client, sk, pubkey_str)

    # Revoke the key directly in DB
    await db_session.execute(
        update(SigningKeyModel)
        .where(SigningKeyModel.key_id == key_id)
        .values(state=KeyState.revoked)
    )
    await db_session.commit()

    nonce = base64.b64encode(b"nonce-for-revoked-key-test-12345").decode()
    sig = _sign_nonce(sk, nonce)

    resp = await client.post(
        f"/registry/agents/{agent_id}/token/refresh",
        json={"key_id": key_id, "nonce": nonce, "sig": sig},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_bad_signature_rejected(client: AsyncClient):
    """An invalid signature should be rejected with 401."""
    sk, pubkey_str = _make_keypair()
    agent_id, key_id = await _register_and_verify(client, sk, pubkey_str)

    nonce = base64.b64encode(b"nonce-for-bad-sig-test-123456789").decode()
    # Sign with a different key
    wrong_sk = SigningKey.generate()
    bad_sig = _sign_nonce(wrong_sk, nonce)

    resp = await client.post(
        f"/registry/agents/{agent_id}/token/refresh",
        json={"key_id": key_id, "nonce": nonce, "sig": bad_sig},
    )
    assert resp.status_code == 401
