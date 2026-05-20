"""Tests for /internal/cloud-agents/runs/{run_id}/settle.

Exercises the auth guard, the happy path through ``UsageService.settle``,
idempotent retries, and the missing-reservation 404.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.id_generators import (
    generate_agent_id,
    generate_cloud_agent_instance_id,
    generate_cloud_daemon_instance_id,
    generate_daemon_instance_id,
)
from hub.models import (
    Agent,
    Base,
    CloudAgentInstance,
    CloudDaemonInstance,
    DaemonInstance,
    UsageReservation,
)
from hub.routers.cloud_daemon_control import _create_cloud_daemon_access_token
from hub.services.cloud_agent_usage import UsageService
from tests.test_app.conftest import create_test_engine


INTERNAL_SECRET = "test-internal-secret"


@pytest_asyncio.fixture
async def db_session():
    engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch):
    """ASGI client with overridable DB + a configured ``UsageService``.

    The fixture also enables internal endpoints and sets an internal
    secret so the auth guard is exercised end-to-end.
    """
    import hub.config as cfg
    import hub.routers.cloud_agent_internal as internal_module

    monkeypatch.setattr(cfg, "ALLOW_PRIVATE_ENDPOINTS", True)
    monkeypatch.setattr(cfg, "INTERNAL_API_SECRET", INTERNAL_SECRET)

    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db

    # Fresh in-memory usage service per test — quotas big enough that
    # preflight never trips during these tests.
    usage = UsageService(
        free_credits_per_period=100_000,
        free_sandbox_seconds_per_period=100_000,
    )
    app.dependency_overrides[internal_module.get_usage_service] = lambda: usage

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c, usage
    app.dependency_overrides.clear()


async def _seed_reservation(
    db: AsyncSession,
    usage: UsageService,
    *,
    run_id: str,
    user_id: uuid.UUID,
    agent_id: str,
    credits: int = 50,
    sandbox_seconds: int = 60,
) -> UsageReservation:
    """Insert an ``active`` reservation row that settle can target."""
    res = await usage.reserve(
        db,
        user_id=user_id,
        agent_id=agent_id,
        run_id=run_id,
        credits=credits,
        sandbox_seconds=sandbox_seconds,
    )
    await db.commit()
    return res


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_settle_requires_internal_secret(client):
    """No Authorization header → 401."""
    c, _ = client
    r = await c.post(
        "/internal/cloud-agents/runs/run-x/settle",
        json={"model": "deepseek-v4-flash"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_settle_rejects_wrong_secret(client):
    """Wrong bearer → 401, not 403."""
    c, _ = client
    r = await c.post(
        "/internal/cloud-agents/runs/run-x/settle",
        json={"model": "deepseek-v4-flash"},
        headers={"Authorization": "Bearer wrong"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_settle_blocked_when_private_endpoints_disabled(client, monkeypatch):
    """Even a valid secret should be rejected when the flag is off."""
    import hub.config as cfg

    monkeypatch.setattr(cfg, "ALLOW_PRIVATE_ENDPOINTS", False)
    c, _ = client
    r = await c.post(
        "/internal/cloud-agents/runs/run-x/settle",
        json={"model": "deepseek-v4-flash"},
        headers={"Authorization": f"Bearer {INTERNAL_SECRET}"},
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Happy path + idempotency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_settle_happy_path_charges_credits(client, db_session):
    """Settle posts token + sandbox numbers; UsageService writes the event."""
    c, usage = client
    user_id = uuid.uuid4()
    await _seed_reservation(
        db_session,
        usage,
        run_id="run-happy",
        user_id=user_id,
        agent_id="ag_happy",
    )

    r = await c.post(
        "/internal/cloud-agents/runs/run-happy/settle",
        json={
            "model": "deepseek-v4-flash",
            "input_cache_miss_tokens": 1000,
            "output_tokens": 2000,
            "sandbox_seconds": 80,
        },
        headers={"Authorization": f"Bearer {INTERNAL_SECRET}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["run_id"] == "run-happy"
    assert body["deduplicated"] is False
    # Same expectation as the service-level test: 1 + 2 + 1 = 4 credits.
    assert body["credits_charged"] == 4
    assert body["sandbox_seconds"] == 80
    assert body["idempotency_key"] == "run-happy:settle"
    assert isinstance(body["usage_event_id"], int)


@pytest.mark.asyncio
async def test_settle_is_idempotent_on_retry(client, db_session):
    """Same idempotency_key → second call returns the existing event."""
    c, usage = client
    user_id = uuid.uuid4()
    await _seed_reservation(
        db_session,
        usage,
        run_id="run-retry",
        user_id=user_id,
        agent_id="ag_retry",
    )

    payload = {
        "model": "deepseek-v4-flash",
        "output_tokens": 1500,
        "sandbox_seconds": 40,
        "idempotency_key": "daemon-key-7",
    }
    headers = {"Authorization": f"Bearer {INTERNAL_SECRET}"}

    first = await c.post(
        "/internal/cloud-agents/runs/run-retry/settle", json=payload, headers=headers
    )
    assert first.status_code == 200
    assert first.json()["deduplicated"] is False
    first_event_id = first.json()["usage_event_id"]

    # Same key, different numbers — the dedup should ignore the body.
    payload2 = {
        **payload,
        "output_tokens": 9999,
        "sandbox_seconds": 9999,
    }
    second = await c.post(
        "/internal/cloud-agents/runs/run-retry/settle", json=payload2, headers=headers
    )
    assert second.status_code == 200
    body = second.json()
    assert body["deduplicated"] is True
    assert body["usage_event_id"] == first_event_id
    # Charged amount comes from the first call, not the retry payload.
    assert body["credits_charged"] == first.json()["credits_charged"]


# ---------------------------------------------------------------------------
# Failure mapping
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_settle_returns_404_when_reservation_missing(client):
    """No reservation → 404 so the daemon stops retrying."""
    c, _ = client
    r = await c.post(
        "/internal/cloud-agents/runs/run-ghost/settle",
        json={"model": "deepseek-v4-flash", "output_tokens": 100},
        headers={"Authorization": f"Bearer {INTERNAL_SECRET}"},
    )
    assert r.status_code == 404, r.text
    assert r.json()["code"] == "cloud_run_reservation_not_found"


@pytest.mark.asyncio
async def test_settle_returns_409_when_reservation_already_settled(client, db_session):
    """A second non-idempotent settle on an already-settled reservation → 409."""
    c, usage = client
    user_id = uuid.uuid4()
    await _seed_reservation(
        db_session,
        usage,
        run_id="run-twice",
        user_id=user_id,
        agent_id="ag_twice",
    )

    headers = {"Authorization": f"Bearer {INTERNAL_SECRET}"}
    r1 = await c.post(
        "/internal/cloud-agents/runs/run-twice/settle",
        json={
            "model": "deepseek-v4-flash",
            "output_tokens": 100,
            "idempotency_key": "first",
        },
        headers=headers,
    )
    assert r1.status_code == 200

    # Different idempotency_key — bypasses dedup and exercises the
    # "reservation already settled" branch.
    r2 = await c.post(
        "/internal/cloud-agents/runs/run-twice/settle",
        json={
            "model": "deepseek-v4-flash",
            "output_tokens": 100,
            "idempotency_key": "second",
        },
        headers=headers,
    )
    assert r2.status_code == 409, r2.text
    assert r2.json()["code"] == "cloud_run_reservation_not_active"


# ---------------------------------------------------------------------------
# Cloud-daemon JWT auth path (in addition to INTERNAL_API_SECRET)
# ---------------------------------------------------------------------------


async def _seed_cloud_daemon_hosting_agent(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    pubkey_seed: str = "settle-jwt-seed",
) -> tuple[str, str, str]:
    """Insert daemon + cloud_daemon + cloud_agent + Agent so JWT scoping
    has real rows to walk. Returns (cloud_daemon_id, daemon_id, agent_id).
    """
    daemon = DaemonInstance(
        id=generate_daemon_instance_id(),
        user_id=user_id,
        kind="cloud",
        refresh_token_hash="z" * 64,
    )
    db.add(daemon)
    await db.flush()

    cloud_daemon = CloudDaemonInstance(
        id=generate_cloud_daemon_instance_id(),
        user_id=user_id,
        daemon_instance_id=daemon.id,
        provider="fake",
        runtime="deepseek-tui",
        status="ready",
        max_agents=3,
    )
    db.add(cloud_daemon)
    await db.flush()

    agent_id = generate_agent_id(pubkey_seed)
    import datetime as _dt

    agent = Agent(
        agent_id=agent_id,
        display_name="Cloud Bot",
        bio="bot",
        user_id=user_id,
        hosting_kind="cloud",
        runtime="deepseek-tui",
        daemon_instance_id=daemon.id,
        claimed_at=_dt.datetime.now(_dt.timezone.utc),
    )
    db.add(agent)
    db.add(
        CloudAgentInstance(
            id=generate_cloud_agent_instance_id(),
            user_id=user_id,
            agent_id=agent_id,
            cloud_daemon_instance_id=cloud_daemon.id,
            daemon_instance_id=daemon.id,
            runtime="deepseek-tui",
            model_profile="deepseek-v4-flash",
            status="ready",
        )
    )
    await db.commit()
    return cloud_daemon.id, daemon.id, agent_id


@pytest.mark.asyncio
async def test_settle_accepts_cloud_daemon_jwt(client, db_session):
    """A valid cloud-daemon-access JWT for the run's host can settle."""
    c, usage = client
    user_id = uuid.uuid4()
    cloud_daemon_id, daemon_id, agent_id = await _seed_cloud_daemon_hosting_agent(
        db_session, user_id=user_id
    )
    await _seed_reservation(
        db_session,
        usage,
        run_id="run-jwt-happy",
        user_id=user_id,
        agent_id=agent_id,
    )
    token, _ = _create_cloud_daemon_access_token(
        cloud_daemon_instance_id=cloud_daemon_id,
        daemon_instance_id=daemon_id,
        user_id=str(user_id),
    )

    r = await c.post(
        "/internal/cloud-agents/runs/run-jwt-happy/settle",
        json={
            "model": "deepseek-v4-flash",
            "output_tokens": 500,
            "sandbox_seconds": 30,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["run_id"] == "run-jwt-happy"
    assert body["deduplicated"] is False


@pytest.mark.asyncio
async def test_settle_rejects_cross_daemon_jwt(client, db_session):
    """A daemon's JWT must not settle a run that belongs to a different daemon."""
    c, usage = client
    user_id = uuid.uuid4()

    # daemon A hosts the actual run.
    cloud_a_id, _, agent_a_id = await _seed_cloud_daemon_hosting_agent(
        db_session, user_id=user_id, pubkey_seed="settle-jwt-A"
    )
    await _seed_reservation(
        db_session,
        usage,
        run_id="run-cross",
        user_id=user_id,
        agent_id=agent_a_id,
    )

    # daemon B is unrelated; its JWT must be rejected for run-cross.
    cloud_b_id, daemon_b_id, _ = await _seed_cloud_daemon_hosting_agent(
        db_session, user_id=user_id, pubkey_seed="settle-jwt-B"
    )
    token_b, _ = _create_cloud_daemon_access_token(
        cloud_daemon_instance_id=cloud_b_id,
        daemon_instance_id=daemon_b_id,
        user_id=str(user_id),
    )
    assert cloud_a_id != cloud_b_id

    r = await c.post(
        "/internal/cloud-agents/runs/run-cross/settle",
        json={"model": "deepseek-v4-flash"},
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert r.status_code == 403, r.text
    assert r.json()["code"] == "cloud_run_settle_wrong_daemon"
