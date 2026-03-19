"""Tests for M2 Registry: endpoints, keys, resolve, discovery."""

import base64
import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.models import Base, Endpoint, MessageRecord

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


async def _register_and_verify(client: AsyncClient, sk: SigningKey, pubkey_str: str, display_name: str = "test-agent"):
    """Register agent, sign challenge, verify — return (agent_id, key_id, token)."""
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


def _mock_probe_response(status_code: int = 200):
    """Return an AsyncMock that simulates httpx.AsyncClient.post with given status."""
    mock_resp = AsyncMock()
    mock_resp.status_code = status_code

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


def _mock_probe_dual(agent_status: int = 200, wake_status: int = 200):
    """Return an AsyncMock whose .post returns different status codes per path.

    First call (agent path) → agent_status, second call (wake path) → wake_status.
    """
    agent_resp = AsyncMock()
    agent_resp.status_code = agent_status
    wake_resp = AsyncMock()
    wake_resp.status_code = wake_status

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(side_effect=[agent_resp, wake_resp])
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


def _mock_probe_error(exc):
    """Return an AsyncMock whose .post raises the given exception."""
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(side_effect=exc)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


# ===========================================================================
# Endpoint registration tests
# ===========================================================================


@pytest.mark.asyncio
async def test_register_endpoint_success(client: AsyncClient):
    sk, pubkey_str = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["url"] == "https://example.com/inbox"
    assert data["state"] == "active"
    assert data["endpoint_id"].startswith("ep_")
    assert data["webhook_token_set"] is True


@pytest.mark.asyncio
async def test_register_endpoint_updates_existing(client: AsyncClient):
    sk, pubkey_str = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    ep_id = resp.json()["endpoint_id"]

    # Register again — should update (200), not create new (201)
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox-v2", "webhook_token": "tok2"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["endpoint_id"] == ep_id  # same endpoint updated
    assert data["url"] == "https://example.com/inbox-v2"


@pytest.mark.asyncio
async def test_register_endpoint_no_auth(client: AsyncClient):
    sk, pubkey_str = _make_keypair()
    agent_id, _, _ = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
    )
    assert resp.status_code == 422  # missing Authorization header


@pytest.mark.asyncio
async def test_register_endpoint_wrong_agent(client: AsyncClient):
    sk1, pubkey1 = _make_keypair()
    agent_id_1, _, token_1 = await _register_and_verify(client, sk1, pubkey1)

    sk2, pubkey2 = _make_keypair()
    agent_id_2, _, token_2 = await _register_and_verify(client, sk2, pubkey2)

    # Use token_1 to register endpoint for agent_2 → 403
    resp = await client.post(
        f"/registry/agents/{agent_id_2}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token_1),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_register_endpoint_invalid_scheme(client: AsyncClient):
    """Non-http(s) schemes are always rejected regardless of ALLOW_PRIVATE_ENDPOINTS."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "ftp://example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_register_endpoint_private_ip_blocked(client: AsyncClient, monkeypatch):
    """Private/loopback IPs are blocked when ALLOW_PRIVATE_ENDPOINTS=False."""
    import hub.validators as validators_mod

    monkeypatch.setattr(validators_mod, "ALLOW_PRIVATE_ENDPOINTS", False)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    # Private IP
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "http://192.168.1.1/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 400

    # Loopback
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "http://127.0.0.1/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_register_endpoint_ssrf_bypass_vectors(client: AsyncClient, monkeypatch):
    """SSRF bypass vectors: IPv6 loopback, mapped IPv4, 0.0.0.0, ULA, link-local."""
    import hub.validators as validators_mod

    monkeypatch.setattr(validators_mod, "ALLOW_PRIVATE_ENDPOINTS", False)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    bypass_urls = [
        "http://[::1]/inbox",                   # IPv6 loopback
        "http://[::ffff:127.0.0.1]/inbox",      # IPv4-mapped IPv6 loopback
        "http://0.0.0.0/inbox",                 # unspecified / all-interfaces
        "http://[::ffff:10.0.0.1]/inbox",       # IPv4-mapped private
        "http://[fc00::1]/inbox",               # IPv6 ULA (private)
        "http://[fe80::1]/inbox",               # IPv6 link-local
        "http://10.255.255.1/inbox",            # 10/8 private
        "http://172.16.0.1/inbox",              # 172.16/12 private
        "http://169.254.169.254/inbox",         # cloud metadata endpoint
    ]
    for url in bypass_urls:
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": url, "webhook_token": "tok"},
            headers=_auth_header(token),
        )
        assert resp.status_code == 400, f"Expected 400 for SSRF bypass URL: {url}"


@pytest.mark.asyncio
async def test_register_endpoint_localhost_blocked(client: AsyncClient, monkeypatch):
    """localhost and internal hostnames are blocked when ALLOW_PRIVATE_ENDPOINTS=False."""
    import hub.validators as validators_mod

    monkeypatch.setattr(validators_mod, "ALLOW_PRIVATE_ENDPOINTS", False)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    blocked_urls = [
        "http://localhost/inbox",
        "http://localhost:8080/inbox",
        "http://myhost.local/inbox",
        "http://service.internal/inbox",
        "http://app.localhost/inbox",
    ]
    for url in blocked_urls:
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": url, "webhook_token": "tok"},
            headers=_auth_header(token),
        )
        assert resp.status_code == 400, f"Expected 400 for internal hostname URL: {url}"


@pytest.mark.asyncio
async def test_register_endpoint_private_allowed_in_dev(client: AsyncClient, monkeypatch):
    """Private IPs and localhost are allowed when ALLOW_PRIVATE_ENDPOINTS=True (default)."""
    import hub.validators as validators_mod

    monkeypatch.setattr(validators_mod, "ALLOW_PRIVATE_ENDPOINTS", True)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    # localhost should be allowed
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "http://localhost:8080/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201

    # Private IP should be allowed (updates existing since only one active endpoint)
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "http://192.168.1.1/inbox", "webhook_token": "tok2"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200


# ===========================================================================
# Key query tests
# ===========================================================================


@pytest.mark.asyncio
async def test_get_key_success(client: AsyncClient):
    sk, pubkey_str = _make_keypair()
    agent_id, key_id, _ = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.get(f"/registry/agents/{agent_id}/keys/{key_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["key_id"] == key_id
    assert data["pubkey"] == pubkey_str
    assert data["state"] == "active"


@pytest.mark.asyncio
async def test_get_key_not_found(client: AsyncClient):
    sk, pubkey_str = _make_keypair()
    agent_id, _, _ = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.get(f"/registry/agents/{agent_id}/keys/k_nonexistent")
    assert resp.status_code == 404


# ===========================================================================
# Resolve tests
# ===========================================================================


@pytest.mark.asyncio
async def test_resolve_success(client: AsyncClient):
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str, display_name="alice")

    # Register an endpoint first
    await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://alice.example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )

    resp = await client.get(f"/registry/resolve/{agent_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == agent_id
    assert data["display_name"] == "alice"
    assert data["has_endpoint"] is True
    # Verify endpoints array
    assert isinstance(data["endpoints"], list)
    assert len(data["endpoints"]) == 1
    ep = data["endpoints"][0]
    assert ep["url"] == "https://alice.example.com/inbox"
    assert ep["state"] == "active"
    assert ep["endpoint_id"].startswith("ep_")
    assert "webhook_token" not in ep


@pytest.mark.asyncio
async def test_resolve_no_endpoint(client: AsyncClient):
    """Resolve agent without any endpoint returns empty endpoints list."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, _ = await _register_and_verify(client, sk, pubkey_str, display_name="bob")

    resp = await client.get(f"/registry/resolve/{agent_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == agent_id
    assert data["display_name"] == "bob"
    assert data["has_endpoint"] is False
    assert data["endpoints"] == []


@pytest.mark.asyncio
async def test_resolve_not_found(client: AsyncClient):
    resp = await client.get("/registry/resolve/ag_nonexistent")
    assert resp.status_code == 404


# ===========================================================================
# Agent discovery tests
# ===========================================================================


@pytest.mark.asyncio
async def test_discover_agents_with_match(client: AsyncClient):
    """Agent discovery is currently disabled — expect 403."""
    sk, pubkey_str = _make_keypair()
    await _register_and_verify(client, sk, pubkey_str, display_name="discoverable-agent")

    resp = await client.get("/registry/agents", params={"name": "discoverable-agent"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_discover_agents_no_match(client: AsyncClient):
    """Agent discovery is currently disabled — expect 403."""
    resp = await client.get("/registry/agents", params={"name": "nobody"})
    assert resp.status_code == 403


# ===========================================================================
# Key rotation tests (add key → verify → active)
# ===========================================================================


@pytest.mark.asyncio
async def test_add_key_and_verify(client: AsyncClient):
    sk1, pubkey1 = _make_keypair()
    agent_id, key_id_1, token = await _register_and_verify(client, sk1, pubkey1)

    # Add a second key
    sk2, pubkey2 = _make_keypair()
    resp = await client.post(
        f"/registry/agents/{agent_id}/keys",
        json={"pubkey": pubkey2},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    key_id_2 = data["key_id"]
    challenge = data["challenge"]

    # New key should be pending
    resp = await client.get(f"/registry/agents/{agent_id}/keys/{key_id_2}")
    assert resp.status_code == 200
    assert resp.json()["state"] == "pending"

    # Verify the new key
    challenge_bytes = base64.b64decode(challenge)
    sig_b64 = base64.b64encode(sk2.sign(challenge_bytes).signature).decode()

    resp = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id_2, "challenge": challenge, "sig": sig_b64},
    )
    assert resp.status_code == 200

    # New key should now be active
    resp = await client.get(f"/registry/agents/{agent_id}/keys/{key_id_2}")
    assert resp.status_code == 200
    assert resp.json()["state"] == "active"


@pytest.mark.asyncio
async def test_add_key_wrong_agent(client: AsyncClient):
    sk1, pubkey1 = _make_keypair()
    agent_id_1, _, token_1 = await _register_and_verify(client, sk1, pubkey1)

    sk2, pubkey2 = _make_keypair()
    agent_id_2, _, token_2 = await _register_and_verify(client, sk2, pubkey2)

    # Use token_1 to add key for agent_2 → 403
    sk3, pubkey3 = _make_keypair()
    resp = await client.post(
        f"/registry/agents/{agent_id_2}/keys",
        json={"pubkey": pubkey3},
        headers=_auth_header(token_1),
    )
    assert resp.status_code == 403


# ===========================================================================
# Key revocation tests
# ===========================================================================


@pytest.mark.asyncio
async def test_revoke_key_success(client: AsyncClient):
    sk1, pubkey1 = _make_keypair()
    agent_id, key_id_1, token = await _register_and_verify(client, sk1, pubkey1)

    # Add and verify a second key so we have 2 active keys
    sk2, pubkey2 = _make_keypair()
    resp = await client.post(
        f"/registry/agents/{agent_id}/keys",
        json={"pubkey": pubkey2},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    key_id_2 = resp.json()["key_id"]
    challenge = resp.json()["challenge"]

    challenge_bytes = base64.b64decode(challenge)
    sig_b64 = base64.b64encode(sk2.sign(challenge_bytes).signature).decode()
    resp = await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id_2, "challenge": challenge, "sig": sig_b64},
    )
    assert resp.status_code == 200

    # Now revoke the first key
    resp = await client.delete(
        f"/registry/agents/{agent_id}/keys/{key_id_1}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["key_id"] == key_id_1
    assert data["state"] == "revoked"


@pytest.mark.asyncio
async def test_revoke_last_active_key_rejected(client: AsyncClient):
    sk, pubkey_str = _make_keypair()
    agent_id, key_id, token = await _register_and_verify(client, sk, pubkey_str)

    # Only 1 active key — should fail
    resp = await client.delete(
        f"/registry/agents/{agent_id}/keys/{key_id}",
        headers=_auth_header(token),
    )
    assert resp.status_code == 400
    assert "last active key" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_revoke_key_wrong_agent(client: AsyncClient):
    sk1, pubkey1 = _make_keypair()
    agent_id_1, key_id_1, token_1 = await _register_and_verify(client, sk1, pubkey1)

    sk2, pubkey2 = _make_keypair()
    agent_id_2, _, token_2 = await _register_and_verify(client, sk2, pubkey2)

    # Use token_2 to revoke key belonging to agent_1 → 403
    resp = await client.delete(
        f"/registry/agents/{agent_id_1}/keys/{key_id_1}",
        headers=_auth_header(token_2),
    )
    assert resp.status_code == 403


# ===========================================================================
# Webhook token tests
# ===========================================================================


@pytest.mark.asyncio
async def test_register_endpoint_with_webhook_token(client: AsyncClient):
    """Registering with webhook_token returns webhook_token_set=true."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "secret-token"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["webhook_token_set"] is True


@pytest.mark.asyncio
async def test_register_endpoint_missing_webhook_token(client: AsyncClient):
    """Registering without webhook_token → 422 (required field)."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_update_webhook_token(client: AsyncClient):
    """Updating endpoint changes webhook_token."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    # Create with token
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "old-token"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    assert resp.json()["webhook_token_set"] is True

    # Update with new token
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "new-token"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.json()["webhook_token_set"] is True


# ===========================================================================
# Endpoint probe verification tests (updated for relaxed registration)
# ===========================================================================


@pytest.mark.asyncio
async def test_probe_success(client: AsyncClient, monkeypatch):
    """Probe returns 200 on both paths — endpoint registration succeeds with state=active."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_client = _mock_probe_response(200)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 201
    assert resp.json()["state"] == "active"


@pytest.mark.asyncio
async def test_probe_connection_refused_relaxed(client: AsyncClient, monkeypatch):
    """Probe gets ConnectError — registration succeeds with state=unverified (relaxed)."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_client = _mock_probe_error(httpx.ConnectError("Connection refused"))

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://unreachable.example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 201
    assert resp.json()["state"] == "unverified"


@pytest.mark.asyncio
async def test_probe_timeout_relaxed(client: AsyncClient, monkeypatch):
    """Probe times out — registration succeeds with state=unverified (relaxed)."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_client = _mock_probe_error(httpx.ReadTimeout("Timed out"))

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://slow.example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 201
    assert resp.json()["state"] == "unverified"


@pytest.mark.asyncio
async def test_probe_non_2xx_relaxed(client: AsyncClient, monkeypatch):
    """Probe returns 401 on both paths — registration succeeds with state=unverified."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_client = _mock_probe_response(401)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "bad-tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 201
    assert resp.json()["state"] == "unverified"


@pytest.mark.asyncio
async def test_probe_disabled_via_config(client: AsyncClient, monkeypatch):
    """Probe disabled — registration succeeds without any HTTP call."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", False)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    # No mock needed — if probe tried to make a real HTTP call it would fail
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_probe_runs_on_update_too(client: AsyncClient, monkeypatch):
    """Probe runs on both initial registration and subsequent updates."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_client = _mock_probe_response(200)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        # First registration
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
        assert resp.status_code == 201

        # Update (second call)
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox-v2", "webhook_token": "tok2"},
            headers=_auth_header(token),
        )
        assert resp.status_code == 200

    # Both calls should have triggered probes (2 paths each = 4 total)
    assert mock_client.post.call_count == 4


@pytest.mark.asyncio
async def test_probe_verifies_auth_header(client: AsyncClient, monkeypatch):
    """Probe sends correct Authorization header and POSTs to both paths."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_client = _mock_probe_response(200)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "my-secret"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 201

    # Verify the probe call arguments — both paths probed
    assert mock_client.post.call_count == 2
    calls = mock_client.post.call_args_list
    # First call: /botcord_inbox/agent
    assert calls[0][0][0] == "https://example.com/inbox/botcord_inbox/agent"
    assert calls[0][1]["headers"]["Authorization"] == "Bearer my-secret"
    assert calls[0][1]["json"] == {"probe": True}
    # Second call: /botcord_inbox/wake
    assert calls[1][0][0] == "https://example.com/inbox/botcord_inbox/wake"
    assert calls[1][1]["headers"]["Authorization"] == "Bearer my-secret"


# ===========================================================================
# Probe diagnostics tests (hints and structured errors)
# ===========================================================================


@pytest.mark.asyncio
async def test_probe_hint_on_401(client: AsyncClient, monkeypatch):
    """Probe returning 401 includes hint about webhook_token."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_client = _mock_probe_response(401)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    # Use test endpoint to get the structured report
    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints/test",
            json={"url": "https://example.com/inbox", "webhook_token": "bad-tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["all_ok"] is False
    assert "webhook_token" in data["agent_path"]["hint"].lower()


@pytest.mark.asyncio
async def test_probe_hint_on_404(client: AsyncClient, monkeypatch):
    """Probe returning 404 includes hint about hooks.mappings."""
    import hub.validators as v

    mock_client = _mock_probe_response(404)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints/test",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["all_ok"] is False
    assert "mappings" in data["agent_path"]["hint"].lower()


@pytest.mark.asyncio
async def test_probe_both_paths_probed(client: AsyncClient, monkeypatch):
    """Both /agent and /wake paths are probed and reported separately."""
    import hub.validators as v

    mock_client = _mock_probe_response(200)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints/test",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_path"]["path"] == "/botcord_inbox/agent"
    assert data["wake_path"]["path"] == "/botcord_inbox/wake"
    assert data["agent_path"]["ok"] is True
    assert data["wake_path"]["ok"] is True
    assert data["all_ok"] is True


@pytest.mark.asyncio
async def test_probe_partial_failure(client: AsyncClient, monkeypatch):
    """Agent path OK + wake path fails → all_ok=False, both results present."""
    import hub.validators as v

    mock_client = _mock_probe_dual(agent_status=200, wake_status=404)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints/test",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["all_ok"] is False
    assert data["agent_path"]["ok"] is True
    assert data["wake_path"]["ok"] is False
    assert "404" in data["wake_path"]["error"]
    assert "/botcord_inbox/agent OK" in data["summary"]


# ===========================================================================
# Test endpoint (POST /endpoints/test) — dry-run probe
# ===========================================================================


@pytest.mark.asyncio
async def test_test_endpoint_returns_structured_report(client: AsyncClient, monkeypatch):
    """Test endpoint returns structured probe report with both path results."""
    mock_client = _mock_probe_response(200)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints/test",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 200
    data = resp.json()
    assert "agent_path" in data
    assert "wake_path" in data
    assert "all_ok" in data
    assert "summary" in data
    assert "url" in data


@pytest.mark.asyncio
async def test_test_endpoint_no_db_write(client: AsyncClient, db_session: AsyncSession):
    """Test endpoint does NOT write to DB."""
    mock_client = _mock_probe_response(200)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    # Count endpoints before
    result = await db_session.execute(select(Endpoint))
    before_count = len(result.scalars().all())

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints/test",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 200

    # Count endpoints after — should be same
    result = await db_session.execute(select(Endpoint))
    after_count = len(result.scalars().all())
    assert after_count == before_count


@pytest.mark.asyncio
async def test_test_endpoint_auth_required(client: AsyncClient):
    """Test endpoint requires JWT auth."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, _ = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints/test",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
    )
    assert resp.status_code == 422  # missing auth header


@pytest.mark.asyncio
async def test_test_endpoint_ignores_probe_disabled(client: AsyncClient, monkeypatch):
    """Test endpoint always probes even when ENDPOINT_PROBE_ENABLED=False."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", False)

    mock_client = _mock_probe_response(200)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints/test",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["all_ok"] is True
    # Confirm probe was actually made
    assert mock_client.post.call_count == 2


# ===========================================================================
# Relaxed registration tests
# ===========================================================================


@pytest.mark.asyncio
async def test_relaxed_probe_fail_creates_unverified(client: AsyncClient, monkeypatch):
    """Probe failure → 201 with state=unverified (not 422)."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_client = _mock_probe_response(500)

    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_client):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 201
    assert resp.json()["state"] == "unverified"


@pytest.mark.asyncio
async def test_relaxed_reregister_with_good_probe_becomes_active(client: AsyncClient, monkeypatch):
    """Re-register with passing probe transitions unverified → active."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    # First registration — probe fails → unverified
    mock_fail = _mock_probe_response(500)
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_fail):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 201
    assert resp.json()["state"] == "unverified"
    ep_id = resp.json()["endpoint_id"]

    # Second registration — probe succeeds → active
    mock_ok = _mock_probe_response(200)
    with patch("hub.validators.httpx.AsyncClient", return_value=mock_ok):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 200
    assert resp.json()["state"] == "active"
    assert resp.json()["endpoint_id"] == ep_id  # same endpoint updated


@pytest.mark.asyncio
async def test_unverified_endpoint_not_resolved(client: AsyncClient, monkeypatch):
    """Unverified endpoint should NOT appear in resolve response."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_fail = _mock_probe_response(500)
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_fail):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 201
    assert resp.json()["state"] == "unverified"

    # Resolve — should show no active endpoint
    resp = await client.get(f"/registry/resolve/{agent_id}")
    assert resp.status_code == 200
    assert resp.json()["has_endpoint"] is False
    assert resp.json()["endpoints"] == []


@pytest.mark.asyncio
async def test_transition_to_active_restarts_stalled_messages(client: AsyncClient, db_session: AsyncSession, monkeypatch):
    """Transitioning from unverified to active restarts stalled messages."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    # Register with failed probe → unverified
    mock_fail = _mock_probe_response(500)
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_fail):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.json()["state"] == "unverified"

    # Manually insert a stalled message
    from hub.models import MessageRecord, MessageState
    from hub.id_generators import generate_hub_msg_id
    import datetime

    stalled_msg = MessageRecord(
        hub_msg_id=generate_hub_msg_id(),
        msg_id="test-stalled-msg",
        sender_id="ag_sender",
        receiver_id=agent_id,
        state=MessageState.queued,
        envelope_json="{}",
        ttl_sec=3600,
        last_error="ENDPOINT_UNREACHABLE",
        next_retry_at=None,
    )
    db_session.add(stalled_msg)
    await db_session.commit()
    await db_session.refresh(stalled_msg)
    assert stalled_msg.next_retry_at is None

    # Re-register with good probe → active
    mock_ok = _mock_probe_response(200)
    with patch("hub.validators.httpx.AsyncClient", return_value=mock_ok):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.json()["state"] == "active"

    # Stalled message should now have next_retry_at set
    await db_session.refresh(stalled_msg)
    assert stalled_msg.next_retry_at is not None


# ===========================================================================
# Endpoint status dashboard tests
# ===========================================================================


@pytest.mark.asyncio
async def test_endpoint_status_active(client: AsyncClient):
    """Status endpoint returns health info for an active endpoint."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    # Register endpoint
    await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )

    resp = await client.get(
        f"/registry/agents/{agent_id}/endpoints/status",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["state"] == "active"
    assert data["url"] == "https://example.com/inbox"
    assert data["webhook_token_set"] is True
    assert "queued_message_count" in data
    assert "failed_message_count" in data
    assert "recent_errors" in data


@pytest.mark.asyncio
async def test_endpoint_status_queued_count(client: AsyncClient, db_session: AsyncSession):
    """Status endpoint shows correct queued message count."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )

    # Insert some queued messages
    from hub.models import MessageRecord, MessageState
    from hub.id_generators import generate_hub_msg_id

    for i in range(3):
        msg = MessageRecord(
            hub_msg_id=generate_hub_msg_id(),
            msg_id=f"queued-msg-{i}",
            sender_id="ag_other",
            receiver_id=agent_id,
            state=MessageState.queued,
            envelope_json="{}",
            ttl_sec=3600,
        )
        db_session.add(msg)
    await db_session.commit()

    resp = await client.get(
        f"/registry/agents/{agent_id}/endpoints/status",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    # At least 3 queued (there may be a welcome message too)
    assert data["queued_message_count"] >= 3


@pytest.mark.asyncio
async def test_endpoint_status_no_endpoint(client: AsyncClient):
    """Status endpoint returns 404 when no endpoint registered."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.get(
        f"/registry/agents/{agent_id}/endpoints/status",
        headers=_auth_header(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_endpoint_status_auth_required(client: AsyncClient):
    """Status endpoint requires JWT auth."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, _ = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.get(
        f"/registry/agents/{agent_id}/endpoints/status",
    )
    assert resp.status_code == 422  # missing auth header


# ===========================================================================
# Welcome message tests
# ===========================================================================


@pytest.mark.asyncio
async def test_welcome_message_on_new_registration(client: AsyncClient, db_session: AsyncSession):
    """Welcome system message is queued on new active endpoint registration."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201
    assert resp.json()["state"] == "active"

    # Check for welcome message in DB
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.sender_id == "hub",
        )
    )
    welcome_msgs = result.scalars().all()
    assert len(welcome_msgs) == 1
    env = json.loads(welcome_msgs[0].envelope_json)
    assert env["type"] == "system"
    assert "Welcome" in env["payload"]["text"]


@pytest.mark.asyncio
async def test_no_welcome_message_on_update(client: AsyncClient, db_session: AsyncSession):
    """Welcome message is NOT queued on endpoint update (200)."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    # First registration
    await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox", "webhook_token": "tok"},
        headers=_auth_header(token),
    )

    # Count welcome messages after first registration
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.sender_id == "hub",
        )
    )
    count_after_first = len(result.scalars().all())

    # Update endpoint
    await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/inbox-v2", "webhook_token": "tok2"},
        headers=_auth_header(token),
    )

    # Count should not increase
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.sender_id == "hub",
        )
    )
    count_after_update = len(result.scalars().all())
    assert count_after_update == count_after_first


@pytest.mark.asyncio
async def test_no_welcome_message_when_unverified(client: AsyncClient, db_session: AsyncSession, monkeypatch):
    """Welcome message is NOT queued when endpoint state is unverified."""
    import hub.validators as v

    monkeypatch.setattr(v, "ENDPOINT_PROBE_ENABLED", True)

    mock_fail = _mock_probe_response(500)
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)

    with patch("hub.validators.httpx.AsyncClient", return_value=mock_fail):
        resp = await client.post(
            f"/registry/agents/{agent_id}/endpoints",
            json={"url": "https://example.com/inbox", "webhook_token": "tok"},
            headers=_auth_header(token),
        )
    assert resp.status_code == 201
    assert resp.json()["state"] == "unverified"

    # No welcome message should exist
    result = await db_session.execute(
        select(MessageRecord).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.sender_id == "hub",
        )
    )
    assert len(result.scalars().all()) == 0


# ===========================================================================
# Agent bio tests
# ===========================================================================


@pytest.mark.asyncio
async def test_register_agent_with_bio(client: AsyncClient):
    """Registering with bio stores and returns it via resolve."""
    sk, pubkey_str = _make_keypair()
    resp = await client.post(
        "/registry/agents",
        json={"display_name": "bio-agent", "pubkey": pubkey_str, "bio": "I can translate languages"},
    )
    assert resp.status_code == 201
    agent_id = resp.json()["agent_id"]

    # Verify so the agent exists fully
    key_id = resp.json()["key_id"]
    challenge = resp.json()["challenge"]
    challenge_bytes = base64.b64decode(challenge)
    sig_b64 = base64.b64encode(sk.sign(challenge_bytes).signature).decode()
    await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )

    resolve = await client.get(f"/registry/resolve/{agent_id}")
    assert resolve.status_code == 200
    assert resolve.json()["bio"] == "I can translate languages"


@pytest.mark.asyncio
async def test_register_agent_without_bio(client: AsyncClient):
    """Registering without bio should return 422 since bio is now required."""
    sk, pubkey_str = _make_keypair()
    resp = await client.post(
        "/registry/agents",
        json={"display_name": "no-bio", "pubkey": pubkey_str},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_update_profile_bio(client: AsyncClient):
    """PATCH /registry/agents/{agent_id}/profile updates bio."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str, display_name="updater")

    resp = await client.patch(
        f"/registry/agents/{agent_id}/profile",
        json={"bio": "I am a helpful assistant"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["bio"] == "I am a helpful assistant"
    assert data["display_name"] == "updater"

    # Verify via resolve
    resolve = await client.get(f"/registry/resolve/{agent_id}")
    assert resolve.json()["bio"] == "I am a helpful assistant"


@pytest.mark.asyncio
async def test_update_profile_display_name_and_bio(client: AsyncClient):
    """PATCH profile can update both display_name and bio."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str, display_name="old-name")

    resp = await client.patch(
        f"/registry/agents/{agent_id}/profile",
        json={"display_name": "new-name", "bio": "new bio"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["display_name"] == "new-name"
    assert data["bio"] == "new bio"


@pytest.mark.asyncio
async def test_update_profile_requires_auth(client: AsyncClient):
    """PATCH profile without token returns 401 or 422."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, _ = await _register_and_verify(client, sk, pubkey_str)

    resp = await client.patch(
        f"/registry/agents/{agent_id}/profile",
        json={"bio": "should fail"},
    )
    assert resp.status_code in (401, 422)


@pytest.mark.asyncio
async def test_update_profile_wrong_agent(client: AsyncClient):
    """PATCH profile with another agent's token returns 403."""
    sk1, pub1 = _make_keypair()
    sk2, pub2 = _make_keypair()
    agent_id1, _, _ = await _register_and_verify(client, sk1, pub1)
    _, _, token2 = await _register_and_verify(client, sk2, pub2)

    resp = await client.patch(
        f"/registry/agents/{agent_id1}/profile",
        json={"bio": "hacked"},
        headers=_auth_header(token2),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_reregister_updates_bio(client: AsyncClient):
    """Re-registering with the same pubkey updates bio."""
    sk, pubkey_str = _make_keypair()
    resp1 = await client.post(
        "/registry/agents",
        json={"display_name": "agent", "pubkey": pubkey_str, "bio": "original bio"},
    )
    assert resp1.status_code == 201
    agent_id = resp1.json()["agent_id"]

    # Verify
    key_id = resp1.json()["key_id"]
    challenge = resp1.json()["challenge"]
    challenge_bytes = base64.b64decode(challenge)
    sig_b64 = base64.b64encode(sk.sign(challenge_bytes).signature).decode()
    await client.post(
        f"/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )

    # Re-register with updated bio
    resp2 = await client.post(
        "/registry/agents",
        json={"display_name": "agent", "pubkey": pubkey_str, "bio": "updated bio"},
    )
    assert resp2.status_code == 201

    resolve = await client.get(f"/registry/resolve/{agent_id}")
    assert resolve.json()["bio"] == "updated bio"


# ===========================================================================
# Endpoint deprecation header tests
# ===========================================================================


@pytest.mark.asyncio
async def test_endpoint_register_deprecation_headers(client: AsyncClient, db_session: AsyncSession):
    """POST /registry/agents/{id}/endpoints should return Deprecation headers."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/hook", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    assert resp.status_code in (200, 201)
    assert resp.headers.get("Deprecation") == "true"
    assert "deprecated" in resp.headers.get("Warning", "").lower()


@pytest.mark.asyncio
async def test_endpoint_update_deprecation_headers(client: AsyncClient, db_session: AsyncSession):
    """Re-registering an endpoint (update path) should also return Deprecation headers."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)
    # First registration
    await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/hook", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    # Second registration (update)
    resp = await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/hook-v2", "webhook_token": "tok2"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.headers.get("Deprecation") == "true"
    assert "deprecated" in resp.headers.get("Warning", "").lower()


@pytest.mark.asyncio
async def test_endpoint_status_deprecation_headers(client: AsyncClient, db_session: AsyncSession):
    """GET /registry/agents/{id}/endpoints/status should return Deprecation headers."""
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str)
    # Register an endpoint first so status has something to report
    await client.post(
        f"/registry/agents/{agent_id}/endpoints",
        json={"url": "https://example.com/hook", "webhook_token": "tok"},
        headers=_auth_header(token),
    )
    resp = await client.get(
        f"/registry/agents/{agent_id}/endpoints/status",
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    assert resp.headers.get("Deprecation") == "true"


# ===========================================================================
# Claim link tests
# ===========================================================================


@pytest.mark.asyncio
async def test_create_claim_link_success(client: AsyncClient):
    sk, pubkey_str = _make_keypair()
    agent_id, _, token = await _register_and_verify(client, sk, pubkey_str, display_name="claimable")

    resp = await client.post(
        f"/registry/agents/{agent_id}/claim-link",
        json={"display_name": "Claim Agent"},
        headers=_auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == agent_id
    assert data["display_name"] == "Claim Agent"
    assert data["claim_token"]
    assert data["claim_url"].endswith(f"/agents/claim?token={data['claim_token']}")

    resolve = await client.post(
        "/registry/claim-links/resolve",
        json={"token": data["claim_token"]},
    )
    assert resolve.status_code == 200
    resolved = resolve.json()
    assert resolved["agent_id"] == agent_id
    assert resolved["display_name"] == "Claim Agent"


@pytest.mark.asyncio
async def test_create_claim_link_wrong_agent_forbidden(client: AsyncClient):
    sk1, pub1 = _make_keypair()
    sk2, pub2 = _make_keypair()
    agent_id_1, _, _ = await _register_and_verify(client, sk1, pub1)
    _, _, token_2 = await _register_and_verify(client, sk2, pub2)

    resp = await client.post(
        f"/registry/agents/{agent_id_1}/claim-link",
        json={},
        headers=_auth_header(token_2),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_resolve_claim_link_rejects_invalid_token(client: AsyncClient):
    resp = await client.post(
        "/registry/claim-links/resolve",
        json={"token": "bad.token.value"},
    )
    assert resp.status_code == 403
