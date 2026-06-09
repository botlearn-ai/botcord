"""Tests for POST /api/integrations/botlearn/session — PR 9 session exchange.

Covers the no-backend-secret flow: BotLearn login token in, short-lived
BotCord session token out, with JIT user + default Cloud Agent creation and
the security gates (origin allowlist, issuer/audience, email_verified, expiry,
quota failure → no token).
"""

from __future__ import annotations

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.botlearn_auth import (
    BOTLEARN_SESSION_AUDIENCE,
    BOTLEARN_SESSION_ISSUER,
    BOTLEARN_SESSION_TOKEN_KIND,
    botcord_supabase_id_for_botlearn,
)
from hub.config import JWT_ALGORITHM, JWT_SECRET
from hub.models import Base, BotlearnInstallation, Role, User
from hub.services.cloud_agent import CloudAgentService
from hub.services.cloud_daemon_provider import FakeCloudDaemonProvider
from tests.test_app.conftest import create_test_engine

BOTLEARN_SECRET = "test-botlearn-shared-secret"
BOTLEARN_ISSUER = "https://botlearn.example"
ALLOWED_ORIGIN = "https://app.botlearn.ai"


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _botlearn_token(
    sub: str,
    *,
    email: str | None = "person@botlearn.ai",
    email_verified: bool = True,
    secret: str = BOTLEARN_SECRET,
    issuer: str = BOTLEARN_ISSUER,
    audience: str | None = None,
    exp_delta_seconds: int = 3600,
) -> str:
    payload: dict = {
        "sub": sub,
        "email_verified": email_verified,
        "iss": issuer,
        "exp": _now() + datetime.timedelta(seconds=exp_delta_seconds),
        "iat": _now(),
    }
    if email is not None:
        payload["email"] = email
    if audience is not None:
        payload["aud"] = audience
    return jwt.encode(payload, secret, algorithm="HS256")


def _configure_botlearn(
    monkeypatch,
    *,
    enabled: bool = True,
    origins: list[str] | None = None,
    audience: str | None = None,
    require_email_verified: bool = True,
    issuer: str | None = BOTLEARN_ISSUER,
) -> None:
    import app.botlearn_auth as ba
    import app.routers.botlearn as br

    monkeypatch.setattr(ba, "BOTLEARN_INTEGRATION_ENABLED", enabled)
    monkeypatch.setattr(br, "BOTLEARN_INTEGRATION_ENABLED", enabled)
    monkeypatch.setattr(ba, "BOTLEARN_JWT_SECRET", BOTLEARN_SECRET)
    monkeypatch.setattr(ba, "BOTLEARN_ISSUER", issuer)
    monkeypatch.setattr(ba, "BOTLEARN_AUDIENCE", audience)
    monkeypatch.setattr(ba, "BOTLEARN_REQUIRE_EMAIL_VERIFIED", require_email_verified)
    monkeypatch.setattr(
        ba,
        "BOTLEARN_ALLOWED_ORIGINS",
        origins if origins is not None else [ALLOWED_ORIGIN],
    )


@pytest_asyncio.fixture
async def db_session():
    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        # The member role is optional but mirrors production seeding.
        session.add(
            Role(id=uuid.uuid4(), name="member", display_name="Member", is_system=True)
        )
        await session.commit()
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client_factory(db_session: AsyncSession):
    """Build an AsyncClient with an injected (fake-provider) CloudAgentService."""
    import app.routers.cloud_agents as cloud_agents_router

    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    original_service = cloud_agents_router.get_cloud_agent_service()

    clients: list[AsyncClient] = []

    async def _make(*, feature_enabled: bool = True) -> tuple[AsyncClient, CloudAgentService]:
        provider = FakeCloudDaemonProvider()
        service = CloudAgentService(
            provider=provider,
            feature_enabled=feature_enabled,
            max_per_user=3,
            max_agents_per_daemon=2,
        )
        cloud_agents_router._set_default_service_for_tests(service)
        transport = ASGITransport(app=app)
        client = AsyncClient(transport=transport, base_url="http://test")
        await client.__aenter__()
        clients.append(client)
        return client, service

    try:
        yield _make
    finally:
        for c in clients:
            await c.__aexit__(None, None, None)
        cloud_agents_router._set_default_service_for_tests(original_service)
        app.dependency_overrides.clear()


def _headers(token: str, *, origin: str | None = ALLOWED_ORIGIN) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    if origin is not None:
        headers["Origin"] = origin
    return headers


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_session_exchange_creates_user_agent_and_token(
    client_factory, db_session, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()

    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("botlearn-user-1")),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agent_id"].startswith("ag_")
    assert body["installation_id"].startswith("bli_")
    assert body["expires_in"] == 900
    assert body["ws_url"].endswith("/api/integrations/botlearn/ws")

    # Session token is a verifiable, short-lived BotCord token of the right kind.
    claims = jwt.decode(
        body["access_token"],
        JWT_SECRET,
        algorithms=[JWT_ALGORITHM],
        audience=BOTLEARN_SESSION_AUDIENCE,
        issuer=BOTLEARN_SESSION_ISSUER,
    )
    assert claims["kind"] == BOTLEARN_SESSION_TOKEN_KIND
    assert claims["agent_id"] == body["agent_id"]
    assert claims["botlearn_sub"] == "botlearn-user-1"
    assert "cloud_runs:create" in claims["scopes"]

    # JIT user + installation persisted.
    derived = botcord_supabase_id_for_botlearn("botlearn-user-1")
    user = await db_session.scalar(
        select(User).where(User.supabase_user_id == derived)
    )
    assert user is not None
    inst = await db_session.scalar(
        select(BotlearnInstallation).where(BotlearnInstallation.id == body["installation_id"])
    )
    assert inst is not None
    assert inst.agent_id == body["agent_id"]
    assert inst.revoked_at is None


@pytest.mark.asyncio
async def test_session_exchange_is_idempotent_reuses_agent_and_installation(
    client_factory, db_session, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()
    token = _botlearn_token("botlearn-user-2")

    r1 = await client.post(
        "/api/integrations/botlearn/session", headers=_headers(token)
    )
    r2 = await client.post(
        "/api/integrations/botlearn/session", headers=_headers(token)
    )
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["agent_id"] == r2.json()["agent_id"]
    assert r1.json()["installation_id"] == r2.json()["installation_id"]

    rows = (
        await db_session.execute(
            select(BotlearnInstallation).where(
                BotlearnInstallation.botlearn_subject == "botlearn-user-2"
            )
        )
    ).scalars().all()
    assert len(rows) == 1


# ---------------------------------------------------------------------------
# Security gates
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_session_rejected_when_disabled(client_factory, monkeypatch):
    _configure_botlearn(monkeypatch, enabled=False)
    client, _ = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("u")),
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "botlearn_disabled"


@pytest.mark.asyncio
async def test_session_rejected_for_disallowed_origin(client_factory, monkeypatch):
    _configure_botlearn(monkeypatch)
    client, _ = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("u"), origin="https://evil.example"),
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "origin_not_allowed"


@pytest.mark.asyncio
async def test_session_rejected_for_missing_origin(client_factory, monkeypatch):
    _configure_botlearn(monkeypatch)
    client, _ = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("u"), origin=None),
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "origin_not_allowed"


@pytest.mark.asyncio
async def test_session_rejected_for_bad_issuer(client_factory, monkeypatch):
    _configure_botlearn(monkeypatch)
    client, _ = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("u", issuer="https://attacker.example")),
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "invalid_issuer"


@pytest.mark.asyncio
async def test_session_rejected_for_audience_mismatch(client_factory, monkeypatch):
    _configure_botlearn(monkeypatch, audience="botcord-cloud")
    client, _ = await client_factory()
    # Token carries the wrong audience.
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("u", audience="someone-else")),
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "invalid_audience"


@pytest.mark.asyncio
async def test_session_rejected_for_expired_token(client_factory, monkeypatch):
    _configure_botlearn(monkeypatch)
    client, _ = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("u", exp_delta_seconds=-10)),
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "token_expired"


@pytest.mark.asyncio
async def test_session_rejected_for_unverified_email(client_factory, monkeypatch):
    _configure_botlearn(monkeypatch)
    client, _ = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("u", email_verified=False)),
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "email_not_verified"


@pytest.mark.asyncio
async def test_session_no_token_when_cloud_agent_feature_disabled(
    client_factory, db_session, monkeypatch
):
    _configure_botlearn(monkeypatch)
    # Cloud Agent feature off → default-agent creation fails → no session token.
    client, _ = await client_factory(feature_enabled=False)
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("botlearn-user-3")),
    )
    assert r.status_code >= 400
    assert "access_token" not in r.json()
    # No installation persisted on the failed path.
    rows = (
        await db_session.execute(
            select(BotlearnInstallation).where(
                BotlearnInstallation.botlearn_subject == "botlearn-user-3"
            )
        )
    ).scalars().all()
    assert rows == []
