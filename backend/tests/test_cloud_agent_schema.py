"""Schema tests for the Cloud Agent MVP — see docs/cloud-agent-technical-design.md §5."""

import datetime
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

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
    UsageBalance,
    UsageEvent,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
MIGRATION_011 = (
    Path(__file__).resolve().parents[1]
    / "migrations"
    / "011_agent_hosting_kind_openclaw.sql"
)


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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_daemon_instance(db: AsyncSession, *, kind: str = "cloud") -> DaemonInstance:
    daemon = DaemonInstance(
        id=generate_daemon_instance_id(),
        user_id=uuid.uuid4(),
        label=f"{kind}-test",
        kind=kind,
        refresh_token_hash="x" * 64,
    )
    db.add(daemon)
    await db.flush()
    return daemon


async def _make_cloud_daemon(db: AsyncSession, *, daemon: DaemonInstance) -> CloudDaemonInstance:
    cloud_daemon = CloudDaemonInstance(
        id=generate_cloud_daemon_instance_id(),
        user_id=daemon.user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        runtime="deepseek-tui",
        max_agents=3,
    )
    db.add(cloud_daemon)
    await db.flush()
    return cloud_daemon


async def _make_cloud_agent(
    db: AsyncSession,
    *,
    cloud_daemon: CloudDaemonInstance,
    daemon: DaemonInstance,
    pubkey_seed: str,
) -> tuple[Agent, CloudAgentInstance]:
    agent_id = generate_agent_id(pubkey_seed)
    agent = Agent(
        agent_id=agent_id,
        display_name="Cloud Bot",
        bio="cloud agent",
        user_id=cloud_daemon.user_id,
        hosting_kind="cloud",
        runtime="deepseek-tui",
        daemon_instance_id=daemon.id,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db.add(agent)
    await db.flush()
    cloud_agent = CloudAgentInstance(
        id=generate_cloud_agent_instance_id(),
        user_id=cloud_daemon.user_id,
        agent_id=agent_id,
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=daemon.id,
        runtime="deepseek-tui",
        model_profile="deepseek-v4-flash",
    )
    db.add(cloud_agent)
    await db.flush()
    return agent, cloud_agent


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_hosting_kind_openclaw_migration_normalizes_legacy_values_before_check():
    sql = MIGRATION_011.read_text()
    normalize_pos = sql.index("UPDATE agents")
    constraint_pos = sql.index("ADD CONSTRAINT ck_agents_hosting_kind")

    assert normalize_pos < constraint_pos
    assert "hosting_kind NOT IN ('daemon', 'openclaw', 'cli', 'cloud')" in sql
    assert "hosting_kind IN ('daemon', 'openclaw', 'cli', 'cloud')" in sql


@pytest.mark.asyncio
async def test_agent_accepts_hosting_kind_cloud(db_session: AsyncSession):
    """Agent.hosting_kind='cloud' should pass the check constraint (§5.1)."""
    daemon = await _make_daemon_instance(db_session, kind="cloud")
    agent = Agent(
        agent_id=generate_agent_id("seed-cloud"),
        display_name="Cloud",
        bio="bio",
        user_id=daemon.user_id,
        hosting_kind="cloud",
        runtime="deepseek-tui",
        daemon_instance_id=daemon.id,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)
    await db_session.commit()
    assert agent.hosting_kind == "cloud"


@pytest.mark.asyncio
async def test_daemon_instance_kind_defaults_to_local(db_session: AsyncSession):
    """Existing local daemons must default to kind='local' without a migration."""
    daemon = DaemonInstance(
        id=generate_daemon_instance_id(),
        user_id=uuid.uuid4(),
        refresh_token_hash="y" * 64,
    )
    db_session.add(daemon)
    await db_session.commit()
    await db_session.refresh(daemon)
    assert daemon.kind == "local"


@pytest.mark.asyncio
async def test_cloud_daemon_can_host_multiple_cloud_agents(db_session: AsyncSession):
    """Schema must allow one cloud daemon to host >=2 Cloud Agents (§5.2)."""
    daemon = await _make_daemon_instance(db_session)
    cloud_daemon = await _make_cloud_daemon(db_session, daemon=daemon)

    _, ca1 = await _make_cloud_agent(
        db_session, cloud_daemon=cloud_daemon, daemon=daemon, pubkey_seed="seed-1"
    )
    _, ca2 = await _make_cloud_agent(
        db_session, cloud_daemon=cloud_daemon, daemon=daemon, pubkey_seed="seed-2"
    )
    await db_session.commit()

    assert ca1.cloud_daemon_instance_id == ca2.cloud_daemon_instance_id
    assert ca1.id != ca2.id
    assert ca1.id.startswith("cloud_ag_")
    assert cloud_daemon.id.startswith("cloud_dm_")


@pytest.mark.asyncio
async def test_cloud_agent_instance_unique_per_agent(db_session: AsyncSession):
    """A single Agent cannot have two CloudAgentInstance rows (FK + unique on agent_id)."""
    daemon = await _make_daemon_instance(db_session)
    cloud_daemon = await _make_cloud_daemon(db_session, daemon=daemon)
    _, cloud_agent = await _make_cloud_agent(
        db_session, cloud_daemon=cloud_daemon, daemon=daemon, pubkey_seed="seed-unique"
    )
    await db_session.commit()

    duplicate = CloudAgentInstance(
        id=generate_cloud_agent_instance_id(),
        user_id=cloud_agent.user_id,
        agent_id=cloud_agent.agent_id,
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=daemon.id,
        runtime="deepseek-tui",
        model_profile="deepseek-v4-flash",
    )
    db_session.add(duplicate)
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_usage_event_idempotency_key_unique(db_session: AsyncSession):
    """Two usage_events with the same idempotency_key must be rejected (§5.4)."""
    daemon = await _make_daemon_instance(db_session)
    cloud_daemon = await _make_cloud_daemon(db_session, daemon=daemon)
    agent, _ = await _make_cloud_agent(
        db_session, cloud_daemon=cloud_daemon, daemon=daemon, pubkey_seed="seed-usage"
    )
    await db_session.commit()

    key = "run-xyz:settlement"
    db_session.add(
        UsageEvent(
            user_id=agent.user_id,
            agent_id=agent.agent_id,
            run_id="run-xyz",
            provider="deepseek",
            model="deepseek-v4-flash",
            input_cache_miss_tokens=100,
            output_tokens=200,
            sandbox_seconds=42,
            credits_charged=5,
            idempotency_key=key,
        )
    )
    await db_session.commit()

    db_session.add(
        UsageEvent(
            user_id=agent.user_id,
            agent_id=agent.agent_id,
            run_id="run-xyz",
            provider="deepseek",
            model="deepseek-v4-flash",
            credits_charged=999,
            idempotency_key=key,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_usage_balance_unique_per_user_period(db_session: AsyncSession):
    """Only one usage_balances row per (user_id, period_start) (§5.5)."""
    user_id = uuid.uuid4()
    period_start = datetime.datetime(2026, 5, 1, tzinfo=datetime.timezone.utc)
    period_end = datetime.datetime(2026, 6, 1, tzinfo=datetime.timezone.utc)

    db_session.add(
        UsageBalance(
            user_id=user_id,
            period_start=period_start,
            period_end=period_end,
            included_credits=1000,
            included_sandbox_seconds=3600,
        )
    )
    await db_session.commit()

    db_session.add(
        UsageBalance(
            user_id=user_id,
            period_start=period_start,
            period_end=period_end,
            included_credits=500,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


@pytest.mark.asyncio
async def test_usage_balance_rejects_negative_reservation(db_session: AsyncSession):
    """ck_usage_balances_non_negative must reject negative reserved_credits."""
    db_session.add(
        UsageBalance(
            user_id=uuid.uuid4(),
            period_start=datetime.datetime(2026, 5, 1, tzinfo=datetime.timezone.utc),
            period_end=datetime.datetime(2026, 6, 1, tzinfo=datetime.timezone.utc),
            included_credits=1000,
            reserved_credits=-1,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
