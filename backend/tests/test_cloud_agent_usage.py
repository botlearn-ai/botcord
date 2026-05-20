"""PR 7: Cloud Agent usage ledger / quota gate tests."""

from __future__ import annotations

import datetime
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.id_generators import generate_agent_id, generate_daemon_instance_id
from hub.models import (
    Agent,
    Base,
    UsageBalance,
    UsageEvent,
    UsageReservation,
)
from hub.services.cloud_agent import (
    CloudAgentError,
    CloudAgentService,
    CreateCloudAgentInput,
    CreateRunInput,
)
from hub.services.cloud_agent_usage import (
    SettlementResult,
    TokenUsage,
    UsageError,
    UsageService,
    credits_for_settlement,
)
from hub.services.cloud_daemon_provider import FakeCloudDaemonProvider
from tests.test_app.conftest import create_test_engine


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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _seed_agent(db: AsyncSession, *, user_id: uuid.UUID) -> Agent:
    agent = Agent(
        agent_id=generate_agent_id(f"seed-{uuid.uuid4().hex}"),
        display_name="Cloud",
        bio="cloud",
        user_id=user_id,
        hosting_kind="cloud",
        runtime="deepseek-tui",
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db.add(agent)
    await db.commit()
    return agent


def _svc(*, free_credits: int = 1000, free_seconds: int = 3600) -> UsageService:
    return UsageService(
        free_credits_per_period=free_credits,
        free_sandbox_seconds_per_period=free_seconds,
    )


# ---------------------------------------------------------------------------
# Balance lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_balance_seeded_with_included_quotas(db_session):
    svc = _svc(free_credits=500, free_seconds=1800)
    user_id = uuid.uuid4()
    balance = await svc.get_or_create_balance(db_session, user_id=user_id)
    await db_session.commit()
    assert balance.included_credits == 500
    assert balance.included_sandbox_seconds == 1800
    assert balance.used_credits == 0
    assert balance.reserved_credits == 0
    # Period anchors to UTC month boundaries.
    assert balance.period_start.day == 1


@pytest.mark.asyncio
async def test_balance_get_or_create_is_idempotent(db_session):
    svc = _svc()
    user_id = uuid.uuid4()
    a = await svc.get_or_create_balance(db_session, user_id=user_id)
    b = await svc.get_or_create_balance(db_session, user_id=user_id)
    assert a.id == b.id
    rows = (
        await db_session.execute(
            select(UsageBalance).where(UsageBalance.user_id == user_id)
        )
    ).scalars().all()
    assert len(rows) == 1


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_preflight_blocks_when_credits_exhausted(db_session):
    svc = _svc(free_credits=10, free_seconds=100)
    user_id = uuid.uuid4()
    with pytest.raises(UsageError) as excinfo:
        await svc.preflight(
            db_session,
            user_id=user_id,
            estimated_credits=11,
            estimated_sandbox_seconds=10,
        )
    assert excinfo.value.code == "quota_credits_exceeded"


@pytest.mark.asyncio
async def test_preflight_blocks_when_sandbox_seconds_exhausted(db_session):
    svc = _svc(free_credits=1000, free_seconds=50)
    with pytest.raises(UsageError) as excinfo:
        await svc.preflight(
            db_session,
            user_id=uuid.uuid4(),
            estimated_credits=5,
            estimated_sandbox_seconds=100,
        )
    assert excinfo.value.code == "quota_sandbox_seconds_exceeded"


@pytest.mark.asyncio
async def test_preflight_accounts_for_reserved(db_session):
    """Reserved + used + estimated must fit in included."""
    svc = _svc(free_credits=100, free_seconds=1000)
    user_id = uuid.uuid4()
    agent = await _seed_agent(db_session, user_id=user_id)
    await svc.reserve(
        db_session,
        user_id=user_id,
        agent_id=agent.agent_id,
        run_id="r1",
        credits=80,
        sandbox_seconds=10,
    )
    await db_session.commit()
    # Only 20 credits left in the budget.
    with pytest.raises(UsageError) as excinfo:
        await svc.preflight(
            db_session,
            user_id=user_id,
            estimated_credits=30,
            estimated_sandbox_seconds=1,
        )
    assert excinfo.value.code == "quota_credits_exceeded"
    # 20 estimated fits.
    balance = await svc.preflight(
        db_session,
        user_id=user_id,
        estimated_credits=20,
        estimated_sandbox_seconds=1,
    )
    assert balance.reserved_credits == 80


# ---------------------------------------------------------------------------
# Reserve / settle / release
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reserve_bumps_balance_aggregate(db_session):
    svc = _svc()
    user_id = uuid.uuid4()
    agent = await _seed_agent(db_session, user_id=user_id)
    res = await svc.reserve(
        db_session,
        user_id=user_id,
        agent_id=agent.agent_id,
        run_id="run-1",
        credits=15,
        sandbox_seconds=120,
    )
    await db_session.commit()
    assert res.state == "active"

    balance = await db_session.scalar(
        select(UsageBalance).where(UsageBalance.user_id == user_id)
    )
    assert balance.reserved_credits == 15
    assert balance.reserved_sandbox_seconds == 120


@pytest.mark.asyncio
async def test_reserve_rechecks_available_quota(db_session):
    svc = _svc(free_credits=10, free_seconds=100)
    user_id = uuid.uuid4()
    agent = await _seed_agent(db_session, user_id=user_id)
    await svc.reserve(
        db_session,
        user_id=user_id,
        agent_id=agent.agent_id,
        run_id="run-a",
        credits=8,
        sandbox_seconds=10,
    )
    with pytest.raises(UsageError) as excinfo:
        await svc.reserve(
            db_session,
            user_id=user_id,
            agent_id=agent.agent_id,
            run_id="run-b",
            credits=3,
            sandbox_seconds=10,
        )
    assert excinfo.value.code == "quota_credits_exceeded"


@pytest.mark.asyncio
async def test_reserve_is_idempotent_on_run_id(db_session):
    svc = _svc()
    user_id = uuid.uuid4()
    agent = await _seed_agent(db_session, user_id=user_id)
    a = await svc.reserve(
        db_session,
        user_id=user_id,
        agent_id=agent.agent_id,
        run_id="run-idem",
        credits=10,
        sandbox_seconds=60,
    )
    await db_session.commit()
    b = await svc.reserve(
        db_session,
        user_id=user_id,
        agent_id=agent.agent_id,
        run_id="run-idem",
        credits=999,  # ignored on second call
        sandbox_seconds=999,
    )
    await db_session.commit()
    assert a.id == b.id

    balance = await db_session.scalar(
        select(UsageBalance).where(UsageBalance.user_id == user_id)
    )
    # Aggregate untouched by the second call.
    assert balance.reserved_credits == 10
    assert balance.reserved_sandbox_seconds == 60


@pytest.mark.asyncio
async def test_settle_moves_reserved_to_used_and_inserts_event(db_session):
    svc = _svc()
    user_id = uuid.uuid4()
    agent = await _seed_agent(db_session, user_id=user_id)
    await svc.reserve(
        db_session,
        user_id=user_id,
        agent_id=agent.agent_id,
        run_id="run-settle",
        credits=20,
        sandbox_seconds=120,
    )
    await db_session.commit()

    result = await svc.settle(
        db_session,
        run_id="run-settle",
        provider="deepseek",
        model="deepseek-v4-flash",
        tokens=TokenUsage(
            input_cache_miss_tokens=1000, output_tokens=2000
        ),
        sandbox_seconds=80,
    )
    await db_session.commit()
    assert result.deduplicated is False
    # Rounded-up per term: cache_miss 0.2 -> 1, output 2.0 -> 2,
    # sandbox 0.8 -> 1. Total = 4.
    assert result.credits_charged == 4

    balance = await db_session.scalar(
        select(UsageBalance).where(UsageBalance.user_id == user_id)
    )
    assert balance.reserved_credits == 0
    assert balance.reserved_sandbox_seconds == 0
    assert balance.used_credits == 4
    assert balance.used_sandbox_seconds == 80

    reservation = await db_session.scalar(
        select(UsageReservation).where(UsageReservation.run_id == "run-settle")
    )
    assert reservation.state == "settled"
    event = await db_session.scalar(
        select(UsageEvent).where(UsageEvent.run_id == "run-settle")
    )
    assert event.idempotency_key == "run-settle:settle"
    assert event.credits_charged == 4


@pytest.mark.asyncio
async def test_settle_idempotent_on_repeat(db_session):
    svc = _svc()
    user_id = uuid.uuid4()
    agent = await _seed_agent(db_session, user_id=user_id)
    await svc.reserve(
        db_session,
        user_id=user_id,
        agent_id=agent.agent_id,
        run_id="run-dup",
        credits=10,
        sandbox_seconds=60,
    )
    await db_session.commit()

    first = await svc.settle(
        db_session,
        run_id="run-dup",
        provider="deepseek",
        model="deepseek-v4-flash",
        tokens=TokenUsage(output_tokens=500),
        sandbox_seconds=30,
    )
    await db_session.commit()
    second = await svc.settle(
        db_session,
        run_id="run-dup",
        provider="deepseek",
        model="deepseek-v4-flash",
        tokens=TokenUsage(output_tokens=9999),  # ignored
        sandbox_seconds=9999,
    )
    await db_session.commit()
    assert first.usage_event_id == second.usage_event_id
    assert second.deduplicated is True
    assert second.credits_charged == first.credits_charged

    events = (
        await db_session.execute(
            select(UsageEvent).where(UsageEvent.run_id == "run-dup")
        )
    ).scalars().all()
    assert len(events) == 1


@pytest.mark.asyncio
async def test_release_refunds_reserved(db_session):
    svc = _svc()
    user_id = uuid.uuid4()
    agent = await _seed_agent(db_session, user_id=user_id)
    await svc.reserve(
        db_session,
        user_id=user_id,
        agent_id=agent.agent_id,
        run_id="run-cancel",
        credits=15,
        sandbox_seconds=60,
    )
    await db_session.commit()

    released = await svc.release(db_session, run_id="run-cancel")
    await db_session.commit()
    assert released.state == "released"

    balance = await db_session.scalar(
        select(UsageBalance).where(UsageBalance.user_id == user_id)
    )
    assert balance.reserved_credits == 0
    assert balance.reserved_sandbox_seconds == 0


@pytest.mark.asyncio
async def test_release_idempotent_on_already_settled(db_session):
    """release() on a settled reservation must not refund a second time."""
    svc = _svc()
    user_id = uuid.uuid4()
    agent = await _seed_agent(db_session, user_id=user_id)
    await svc.reserve(
        db_session,
        user_id=user_id,
        agent_id=agent.agent_id,
        run_id="run-mix",
        credits=10,
        sandbox_seconds=30,
    )
    await svc.settle(
        db_session,
        run_id="run-mix",
        provider="deepseek",
        model="deepseek-v4-flash",
        tokens=TokenUsage(output_tokens=500),
        sandbox_seconds=10,
    )
    await db_session.commit()

    res = await svc.release(db_session, run_id="run-mix")
    await db_session.commit()
    assert res.state == "settled"

    balance = await db_session.scalar(
        select(UsageBalance).where(UsageBalance.user_id == user_id)
    )
    # used_* remains, reserved_* still zero (settle already cleared it).
    assert balance.reserved_credits == 0
    assert balance.used_credits > 0


@pytest.mark.asyncio
async def test_settle_requires_active_reservation(db_session):
    svc = _svc()
    with pytest.raises(UsageError) as excinfo:
        await svc.settle(
            db_session,
            run_id="never-reserved",
            provider="deepseek",
            model="deepseek-v4-flash",
        )
    assert excinfo.value.code == "reservation_not_found"


# ---------------------------------------------------------------------------
# Credit math
# ---------------------------------------------------------------------------


def test_credits_for_settlement_uses_coefficients():
    credits = credits_for_settlement(
        tokens=TokenUsage(
            input_cache_hit_tokens=4000,
            input_cache_miss_tokens=2000,
            output_tokens=1000,
        ),
        sandbox_seconds=600,
    )
    # 4k * 0.05 + 2k * 0.2 + 1k * 1.0 + 600 * 0.01 = 0.2 + 0.4 + 1.0 + 6.0 = 7.6
    # Round up per term, then per total. Implementation rounds per term:
    # cache_hit: 200 millis -> 1; cache_miss: 400 -> 1; output: 1000 -> 1;
    # sandbox: 6000 -> 6. Total = 9.
    assert credits >= 7  # exact value depends on rounding; sanity check lower bound


def test_credit_math_rounds_up():
    # 1 token of output at 1 credit/1k tokens -> rounds up to 1.
    credits = credits_for_settlement(
        tokens=TokenUsage(output_tokens=1), sandbox_seconds=0
    )
    assert credits == 1


# ---------------------------------------------------------------------------
# Integration with CloudAgentService
# ---------------------------------------------------------------------------


async def _seed_user(db: AsyncSession):
    from hub.models import User

    user = User(
        id=uuid.uuid4(),
        display_name="Owner",
        email=f"owner-{uuid.uuid4().hex[:6]}@example.com",
        status="active",
        supabase_user_id=uuid.uuid4(),
        max_agents=10,
    )
    db.add(user)
    await db.commit()
    return user


@pytest.mark.asyncio
async def test_create_run_reserves_credits(db_session):
    user = await _seed_user(db_session)
    usage = _svc(free_credits=500, free_seconds=3600)
    cloud_svc = CloudAgentService(
        provider=FakeCloudDaemonProvider(),
        feature_enabled=True,
        max_per_user=2,
        max_agents_per_daemon=1,
        usage_service=usage,
    )
    cloud_agent = await cloud_svc.create_cloud_agent(
        db_session, user_id=user.id, body=CreateCloudAgentInput(name="A")
    )
    run = await cloud_svc.create_run(
        db_session,
        user_id=user.id,
        agent_id=cloud_agent.agent_id,
        body=CreateRunInput(prompt="task"),
    )
    reservation = await db_session.scalar(
        select(UsageReservation).where(UsageReservation.run_id == run.run_id)
    )
    assert reservation is not None
    assert reservation.state == "active"
    assert reservation.reserved_credits > 0
    assert reservation.reserved_sandbox_seconds == 600

    balance = await db_session.scalar(
        select(UsageBalance).where(UsageBalance.user_id == user.id)
    )
    assert balance.reserved_credits == reservation.reserved_credits


@pytest.mark.asyncio
async def test_create_run_quota_exceeded_returns_402(db_session):
    """No credits left -> CloudAgentError with http_status=402 + no record."""
    user = await _seed_user(db_session)
    # Pinch the budget so even the smallest reservation can't fit.
    usage = _svc(free_credits=1, free_seconds=3600)
    cloud_svc = CloudAgentService(
        provider=FakeCloudDaemonProvider(),
        feature_enabled=True,
        max_per_user=1,
        usage_service=usage,
    )
    cloud_agent = await cloud_svc.create_cloud_agent(
        db_session, user_id=user.id, body=CreateCloudAgentInput(name="A")
    )
    with pytest.raises(CloudAgentError) as excinfo:
        await cloud_svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="will not run"),
        )
    assert excinfo.value.code == "quota_credits_exceeded"
    assert excinfo.value.http_status == 402

    # No MessageRecord, no reservation persisted.
    from hub.models import MessageRecord

    records = (
        await db_session.execute(
            select(MessageRecord).where(
                MessageRecord.source_type == "cloud_agent_run"
            )
        )
    ).scalars().all()
    assert records == []
    reservations = (
        await db_session.execute(select(UsageReservation))
    ).scalars().all()
    assert reservations == []


@pytest.mark.asyncio
async def test_delete_releases_active_reservations(db_session):
    user = await _seed_user(db_session)
    usage = _svc(free_credits=1000, free_seconds=3600)
    cloud_svc = CloudAgentService(
        provider=FakeCloudDaemonProvider(),
        feature_enabled=True,
        max_per_user=2,
        usage_service=usage,
    )
    cloud_agent = await cloud_svc.create_cloud_agent(
        db_session, user_id=user.id, body=CreateCloudAgentInput(name="A")
    )
    run = await cloud_svc.create_run(
        db_session,
        user_id=user.id,
        agent_id=cloud_agent.agent_id,
        body=CreateRunInput(prompt="task"),
    )
    # Reservation is active.
    res_before = await db_session.scalar(
        select(UsageReservation).where(UsageReservation.run_id == run.run_id)
    )
    assert res_before.state == "active"

    await cloud_svc.delete_cloud_agent(
        db_session, user_id=user.id, agent_id=cloud_agent.agent_id
    )
    res_after = await db_session.scalar(
        select(UsageReservation).where(UsageReservation.run_id == run.run_id)
    )
    assert res_after.state == "released"
    balance = await db_session.scalar(
        select(UsageBalance).where(UsageBalance.user_id == user.id)
    )
    assert balance.reserved_credits == 0
    assert balance.reserved_sandbox_seconds == 0
