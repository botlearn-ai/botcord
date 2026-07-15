"""Tests for POST /api/integrations/botlearn/session — PR 9 session exchange.

Covers the no-backend-secret flow: BotLearn login token in, short-lived
BotCord session token out, with JIT user + default Cloud Agent creation and
the security gates (origin allowlist, issuer/audience, email_verified, expiry,
quota failure → no token).
"""

from __future__ import annotations

import base64
import datetime
import json
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from jwt.exceptions import PyJWKClientError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.botlearn_auth import (
    BOTLEARN_SESSION_AUDIENCE,
    BOTLEARN_SESSION_ISSUER,
    BOTLEARN_SESSION_TOKEN_KIND,
    botcord_supabase_id_for_botlearn,
)
from hub.config import JWT_ALGORITHM, JWT_SECRET
from hub.models import Base, BotlearnInstallation, CloudAgentInstance, Role, User
from hub.services.cloud_agent import CloudAgentService
from hub.services.cloud_daemon_provider import FakeCloudDaemonProvider
from tests.test_app.conftest import create_test_engine

BOTLEARN_SECRET = "test-botlearn-shared-secret"
BOTLEARN_ISSUER = "https://botlearn.example"
ALLOWED_ORIGIN = "https://app.botlearn.ai"
RUNTIME_PROFILE_SECRET = "trusted-course-service-secret"


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


def _unsigned_token(header: dict, payload: dict | None = None) -> str:
    def enc(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    return f"{enc(header)}.{enc(payload or {})}.sig"


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
    monkeypatch.setattr(br, "BOTLEARN_RUNTIME_PROFILE_SECRET", RUNTIME_PROFILE_SECRET)
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


def _runtime_profile() -> dict:
    return {
        "schema_version": "botlearn-course-runtime-profile/0.1",
        "profile_id": "crp_test_profile",
        "profile_hash": "sha256:" + "1" * 64,
        "course_version_id": str(uuid.uuid4()),
        "prompt_pack": {
            "id": "botlearn.executor.ai-creator",
            "version": "1.0.0",
            "digest": "sha256:" + "2" * 64,
            "system_instructions": "Use course-scoped instructions.",
        },
        "skill_packages": [
            {
                "id": "botlearn.plan-ai-creator-strategy",
                "version": "0.1.0",
                "digest": "sha256:" + "3" * 64,
                "archive_manifest": {
                    "name": "botlearn.plan-ai-creator-strategy",
                    "skillMd": "# Skill",
                    "files": [],
                },
            }
        ],
        "required_capabilities": ["web.search", "workspace.write"],
    }


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
async def test_session_exchange_signs_explicit_session_key(
    client_factory, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()

    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("botlearn-user-scoped")),
        json={"session_key": "course_run:run-123"},
    )
    assert r.status_code == 200, r.text

    claims = jwt.decode(
        r.json()["access_token"],
        JWT_SECRET,
        algorithms=[JWT_ALGORITHM],
        audience=BOTLEARN_SESSION_AUDIENCE,
        issuer=BOTLEARN_SESSION_ISSUER,
    )
    assert claims["session_key"] == "course_run:run-123"


@pytest.mark.asyncio
async def test_session_exchange_derives_session_key_from_course_run_metadata(
    client_factory, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()

    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("botlearn-user-metadata-scope")),
        json={"metadata": {"course_run_id": "run-456"}},
    )
    assert r.status_code == 200, r.text

    claims = jwt.decode(
        r.json()["access_token"],
        JWT_SECRET,
        algorithms=[JWT_ALGORITHM],
        audience=BOTLEARN_SESSION_AUDIENCE,
        issuer=BOTLEARN_SESSION_ISSUER,
    )
    assert claims["session_key"] == "course_run:run-456"


@pytest.mark.asyncio
async def test_session_exchange_applies_trusted_runtime_profile_before_issuing_token(
    client_factory, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()
    captured: dict = {}

    async def fake_apply(db, **kwargs):
        captured.update(kwargs)
        profile = kwargs["runtime_profile"]
        return {
            "profileId": profile["profileId"],
            "profileHash": profile["profileHash"],
            "status": "applied",
            "appliedSkillRefs": ["botlearn.plan-ai-creator-strategy@0.1.0"],
            "availableCapabilities": ["web.search", "workspace.write"],
            "missingSkills": [],
            "missingCapabilities": [],
            "runtime": "deepseek-tui",
            "expiresAt": (_now() + datetime.timedelta(minutes=15)).isoformat(),
        }

    import app.routers.botlearn as br

    monkeypatch.setattr(br, "apply_botlearn_session_profile", fake_apply)
    headers = _headers(_botlearn_token("botlearn-user-profile"))
    headers["X-BotLearn-Runtime-Profile-Secret"] = RUNTIME_PROFILE_SECRET
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=headers,
        json={
            "session_key": "course_run:profile-123",
            "runtime_profile": _runtime_profile(),
        },
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["runtime_profile_status"]["status"] == "applied"
    assert captured["session_key"] == "course_run:profile-123"
    assert captured["room_id"].startswith("rm_oc_")
    assert captured["runtime_profile"]["schemaVersion"] == (
        "botlearn-course-runtime-profile/0.1"
    )
    assert captured["runtime_profile"]["promptPack"]["systemInstructions"] == (
        "Use course-scoped instructions."
    )

    claims = jwt.decode(
        body["access_token"],
        JWT_SECRET,
        algorithms=[JWT_ALGORITHM],
        audience=BOTLEARN_SESSION_AUDIENCE,
        issuer=BOTLEARN_SESSION_ISSUER,
    )
    assert claims["session_profile_required"] is True
    assert "profile_id" not in claims
    assert "profile_hash" not in claims


@pytest.mark.asyncio
async def test_session_exchange_cannot_downgrade_existing_profile_binding(
    client_factory, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()

    async def fake_apply(db, **kwargs):
        profile = kwargs["runtime_profile"]
        return {
            "profileId": profile["profileId"],
            "profileHash": profile["profileHash"],
            "status": "applied",
            "appliedSkillRefs": ["botlearn.plan-ai-creator-strategy@0.1.0"],
            "availableCapabilities": ["web.search", "workspace.write"],
            "missingSkills": [],
            "missingCapabilities": [],
            "runtime": "deepseek-tui",
            "expiresAt": (_now() + datetime.timedelta(minutes=15)).isoformat(),
        }

    import app.routers.botlearn as br

    monkeypatch.setattr(br, "apply_botlearn_session_profile", fake_apply)
    token = _botlearn_token("botlearn-user-profile-downgrade")
    session_key = "course_run:profile-no-downgrade"
    trusted_headers = _headers(token)
    trusted_headers["X-BotLearn-Runtime-Profile-Secret"] = RUNTIME_PROFILE_SECRET
    first = await client.post(
        "/api/integrations/botlearn/session",
        headers=trusted_headers,
        json={"session_key": session_key, "runtime_profile": _runtime_profile()},
    )
    assert first.status_code == 200, first.text

    second = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(token),
        json={"session_key": session_key},
    )
    assert second.status_code == 200, second.text
    claims = jwt.decode(
        second.json()["access_token"],
        JWT_SECRET,
        algorithms=[JWT_ALGORITHM],
        audience=BOTLEARN_SESSION_AUDIENCE,
        issuer=BOTLEARN_SESSION_ISSUER,
    )
    assert claims["session_profile_required"] is True


@pytest.mark.asyncio
async def test_session_exchange_rejects_browser_forged_runtime_profile(
    client_factory, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("botlearn-user-forged-profile")),
        json={
            "session_key": "course_run:forged",
            "runtime_profile": _runtime_profile(),
        },
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "profile_permission_denied"


@pytest.mark.asyncio
async def test_session_exchange_returns_daemon_requirement_status(
    client_factory, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()

    async def fake_apply(db, **kwargs):
        profile = kwargs["runtime_profile"]
        return {
            "profileId": profile["profileId"],
            "profileHash": profile["profileHash"],
            "status": "requirements_unmet",
            "appliedSkillRefs": ["botlearn.plan-ai-creator-strategy@0.1.0"],
            "availableCapabilities": ["workspace.write"],
            "missingSkills": [],
            "missingCapabilities": ["web.search"],
            "runtime": "codex",
            "expiresAt": (_now() + datetime.timedelta(minutes=15)).isoformat(),
        }

    import app.routers.botlearn as br

    monkeypatch.setattr(br, "apply_botlearn_session_profile", fake_apply)
    headers = _headers(_botlearn_token("botlearn-user-profile-unmet"))
    headers["X-BotLearn-Runtime-Profile-Secret"] = RUNTIME_PROFILE_SECRET
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=headers,
        json={
            "session_key": "course_run:profile-unmet",
            "runtime_profile": _runtime_profile(),
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["runtime_profile_status"]["status"] == "requirements_unmet"
    assert r.json()["runtime_profile_status"]["missingCapabilities"] == ["web.search"]


@pytest.mark.asyncio
async def test_session_exchange_rejects_invalid_session_key(
    client_factory, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()

    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token("botlearn-user-bad-scope")),
        json={"session_key": "../bad"},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_session_key"


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


@pytest.mark.asyncio
async def test_session_exchange_rejects_revoked_installation(
    client_factory, db_session, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()
    token = _botlearn_token("botlearn-user-revoked")

    r1 = await client.post(
        "/api/integrations/botlearn/session", headers=_headers(token)
    )
    assert r1.status_code == 200, r1.text
    installation_id = r1.json()["installation_id"]

    inst = await db_session.scalar(
        select(BotlearnInstallation).where(BotlearnInstallation.id == installation_id)
    )
    assert inst is not None
    revoked_at = _now()
    inst.revoked_at = revoked_at
    await db_session.commit()

    r2 = await client.post(
        "/api/integrations/botlearn/session", headers=_headers(token)
    )
    assert r2.status_code == 403
    assert r2.json()["detail"]["code"] == "installation_revoked"
    assert "access_token" not in r2.json()

    await db_session.refresh(inst)
    assert inst.revoked_at is not None
    assert inst.revoked_at.replace(tzinfo=datetime.timezone.utc) == revoked_at


@pytest.mark.asyncio
async def test_session_exchange_rejects_revoked_subject_before_default_agent_selection(
    client_factory, db_session, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()
    token = _botlearn_token("botlearn-user-revoked-stale-agent")

    r1 = await client.post(
        "/api/integrations/botlearn/session", headers=_headers(token)
    )
    assert r1.status_code == 200, r1.text
    body = r1.json()

    inst = await db_session.scalar(
        select(BotlearnInstallation).where(
            BotlearnInstallation.id == body["installation_id"]
        )
    )
    assert inst is not None
    user_id = inst.user_id
    revoked_at = _now()
    inst.revoked_at = revoked_at

    cloud_agent = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == body["agent_id"]
        )
    )
    assert cloud_agent is not None
    cloud_agent.status = "deleted"
    await db_session.commit()

    r2 = await client.post(
        "/api/integrations/botlearn/session", headers=_headers(token)
    )
    assert r2.status_code == 403
    assert r2.json()["detail"]["code"] == "installation_revoked"
    assert "access_token" not in r2.json()

    installations = (
        await db_session.execute(
            select(BotlearnInstallation).where(
                BotlearnInstallation.botlearn_subject
                == "botlearn-user-revoked-stale-agent"
            )
        )
    ).scalars().all()
    assert [row.id for row in installations] == [body["installation_id"]]

    cloud_agents = (
        await db_session.execute(
            select(CloudAgentInstance).where(CloudAgentInstance.user_id == user_id)
        )
    ).scalars().all()
    assert [row.agent_id for row in cloud_agents] == [body["agent_id"]]

    await db_session.refresh(inst)
    assert inst.revoked_at is not None
    assert inst.revoked_at.replace(tzinfo=datetime.timezone.utc) == revoked_at


@pytest.mark.asyncio
async def test_session_exchange_rejects_stale_revoked_subject_before_user_creation(
    client_factory, db_session, monkeypatch
):
    _configure_botlearn(monkeypatch)
    client, _service = await client_factory()
    subject = "botlearn-user-revoked-orphan"
    stale_installation = BotlearnInstallation(
        id="bli_revoked_orphan",
        user_id=uuid.uuid4(),
        botlearn_subject=subject,
        botlearn_email="orphan@botlearn.ai",
        agent_id="ag_revoked_orphan",
        scopes_json=["cloud_runs:create"],
        limits_json={},
        last_used_at=_now(),
        revoked_at=_now(),
    )
    db_session.add(stale_installation)
    await db_session.commit()

    derived_supabase_id = botcord_supabase_id_for_botlearn(subject)
    assert await db_session.scalar(
        select(User).where(User.supabase_user_id == derived_supabase_id)
    ) is None

    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(_botlearn_token(subject, email="orphan@botlearn.ai")),
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "installation_revoked"
    assert "access_token" not in r.json()

    assert await db_session.scalar(
        select(User).where(User.supabase_user_id == derived_supabase_id)
    ) is None
    assert (await db_session.execute(select(User))).scalars().all() == []
    assert (await db_session.execute(select(CloudAgentInstance))).scalars().all() == []

    installations = (
        await db_session.execute(
            select(BotlearnInstallation).where(
                BotlearnInstallation.botlearn_subject == subject
            )
        )
    ).scalars().all()
    assert [row.id for row in installations] == [stale_installation.id]

    await db_session.refresh(stale_installation)
    assert stale_installation.revoked_at is not None


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
async def test_session_rejected_when_jwks_kid_is_unknown(client_factory, monkeypatch):
    class MissingKidJwksClient:
        def get_signing_key_from_jwt(self, token: str):
            raise PyJWKClientError(
                "Unable to find a signing key that matches: "
                "a5d8f98e-fbd2-40f4-9317-ba02ebaf3e3b"
            )

    _configure_botlearn(monkeypatch)

    import app.botlearn_auth as ba

    monkeypatch.setattr(ba, "BOTLEARN_JWKS_URL", "https://botlearn.example/jwks.json")
    monkeypatch.setattr(ba, "_get_jwks_client", lambda jwks_url: MissingKidJwksClient())
    token = _unsigned_token(
        {"alg": "RS256", "kid": "a5d8f98e-fbd2-40f4-9317-ba02ebaf3e3b"},
        {
            "sub": "u",
            "email_verified": True,
            "iss": BOTLEARN_ISSUER,
            "exp": int((_now() + datetime.timedelta(hours=1)).timestamp()),
            "iat": int(_now().timestamp()),
        },
    )

    client, _ = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(token),
    )

    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "invalid_token"


@pytest.mark.asyncio
async def test_session_jwks_provider_failure_is_service_error(
    client_factory, monkeypatch
):
    class FailingJwksClient:
        def get_signing_key_from_jwt(self, token: str):
            raise PyJWKClientError(
                'Fail to fetch data from the url, err: "timed out"'
            )

    _configure_botlearn(monkeypatch)

    import app.botlearn_auth as ba

    monkeypatch.setattr(ba, "BOTLEARN_JWKS_URL", "https://botlearn.example/jwks.json")
    monkeypatch.setattr(ba, "_get_jwks_client", lambda jwks_url: FailingJwksClient())
    token = _unsigned_token(
        {"alg": "RS256", "kid": "botlearn-key-1"},
        {
            "sub": "u",
            "email_verified": True,
            "iss": BOTLEARN_ISSUER,
            "exp": int((_now() + datetime.timedelta(hours=1)).timestamp()),
            "iat": int(_now().timestamp()),
        },
    )

    client, _ = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(token),
    )

    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "botlearn_jwks_unavailable"


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
async def test_session_accepts_supabase_user_metadata_email_verified(
    client_factory, db_session, monkeypatch
):
    # Supabase access tokens have no top-level email_verified claim — it lives
    # in user_metadata. The gate must honor it for shared-tenant logins.
    _configure_botlearn(monkeypatch)
    payload = {
        "sub": "d83f47b0-ce25-439d-ab9b-1d54de6586b7",
        "email": "person@botlearn.ai",
        "user_metadata": {"email_verified": True},
        "iss": BOTLEARN_ISSUER,
        "exp": _now() + datetime.timedelta(seconds=3600),
        "iat": _now(),
    }
    token = jwt.encode(payload, BOTLEARN_SECRET, algorithm="HS256")
    client, _ = await client_factory()
    r = await client.post(
        "/api/integrations/botlearn/session",
        headers=_headers(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]


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
