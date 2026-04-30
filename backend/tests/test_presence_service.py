"""Tests for hub.services.presence."""

from __future__ import annotations

import datetime

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.models import Agent, AgentPresence, AgentPresenceConnection, AgentStatusSettings, Base
from hub.services import presence as presence_service
from hub.services.presence import resolve_effective_status


TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


# ---------------------------------------------------------------------------
# Pure resolver
# ---------------------------------------------------------------------------


def test_resolver_invisible_overrides_everything():
    assert (
        resolve_effective_status(
            manual_status="invisible", connected=True, activity={"processing": True}
        )
        == "offline"
    )


def test_resolver_disconnected_is_offline():
    assert (
        resolve_effective_status(
            manual_status="available", connected=False, activity={}
        )
        == "offline"
    )


def test_resolver_processing_beats_busy():
    assert (
        resolve_effective_status(
            manual_status="busy", connected=True, activity={"processing": True}
        )
        == "working"
    )


def test_resolver_busy_when_no_processing():
    assert (
        resolve_effective_status(
            manual_status="busy", connected=True, activity={}
        )
        == "busy"
    )


def test_resolver_idle_maps_to_away():
    assert (
        resolve_effective_status(
            manual_status="available", connected=True, activity={"idle": True}
        )
        == "away"
    )


def test_resolver_manual_away_maps_to_away():
    assert (
        resolve_effective_status(
            manual_status="away", connected=True, activity={}
        )
        == "away"
    )


def test_resolver_default_online():
    assert (
        resolve_effective_status(
            manual_status="available", connected=True, activity={}
        )
        == "online"
    )


# ---------------------------------------------------------------------------
# Service-level fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        # Seed an agent so the FK on agent_presence_connections / agent_presence
        # is satisfied.
        session.add(Agent(agent_id="ag_test", display_name="Test"))
        await session.commit()
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


# ---------------------------------------------------------------------------
# Connection lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_connected_sets_online(db_session: AsyncSession):
    snapshot, changed = await presence_service.mark_connected(
        db_session, "ag_test", "conn_1"
    )
    assert snapshot.effective_status == "online"
    assert snapshot.connected is True
    assert snapshot.connection_count == 1
    assert snapshot.version == 1
    assert changed is True


@pytest.mark.asyncio
async def test_mark_disconnected_returns_offline(db_session: AsyncSession):
    await presence_service.mark_connected(db_session, "ag_test", "conn_1")
    snapshot, _ = await presence_service.mark_disconnected(
        db_session, "ag_test", "conn_1"
    )
    assert snapshot.effective_status == "offline"
    assert snapshot.connected is False
    assert snapshot.connection_count == 0
    assert snapshot.version == 2


@pytest.mark.asyncio
async def test_multiple_connections_keep_online(db_session: AsyncSession):
    await presence_service.mark_connected(db_session, "ag_test", "conn_1")
    await presence_service.mark_connected(db_session, "ag_test", "conn_2")
    snapshot, _ = await presence_service.mark_disconnected(
        db_session, "ag_test", "conn_1"
    )
    assert snapshot.connected is True
    assert snapshot.connection_count == 1
    assert snapshot.effective_status == "online"


# ---------------------------------------------------------------------------
# Manual status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_manual_busy_updates_status(db_session: AsyncSession):
    await presence_service.mark_connected(db_session, "ag_test", "conn_1")
    snapshot, _ = await presence_service.set_manual_status(
        db_session, "ag_test", "busy", status_message="In a meeting"
    )
    assert snapshot.effective_status == "busy"
    assert snapshot.manual_status == "busy"
    assert snapshot.status_message == "In a meeting"


@pytest.mark.asyncio
async def test_invisible_hides_online(db_session: AsyncSession):
    await presence_service.mark_connected(db_session, "ag_test", "conn_1")
    snapshot, _ = await presence_service.set_manual_status(
        db_session, "ag_test", "invisible"
    )
    assert snapshot.effective_status == "offline"
    assert snapshot.connected is True


@pytest.mark.asyncio
async def test_set_manual_invalid_raises(db_session: AsyncSession):
    with pytest.raises(ValueError):
        await presence_service.set_manual_status(
            db_session, "ag_test", "bogus"
        )


# ---------------------------------------------------------------------------
# Processing signal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_processing_true_marks_working(db_session: AsyncSession):
    await presence_service.mark_connected(db_session, "ag_test", "conn_1")
    snapshot, _ = await presence_service.set_processing(
        db_session, "ag_test", True, current_task="replying"
    )
    assert snapshot.effective_status == "working"
    assert snapshot.activity["processing"] is True
    assert snapshot.attributes["current_task"] == "replying"


@pytest.mark.asyncio
async def test_set_processing_false_clears(db_session: AsyncSession):
    await presence_service.mark_connected(db_session, "ag_test", "conn_1")
    await presence_service.set_processing(
        db_session, "ag_test", True, current_task="replying"
    )
    snapshot, _ = await presence_service.set_processing(
        db_session, "ag_test", False
    )
    assert snapshot.effective_status == "online"
    assert snapshot.activity.get("processing") is False
    assert "current_task" not in snapshot.attributes


# ---------------------------------------------------------------------------
# Snapshots and observer projection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_snapshots_for_unknown_agent_is_empty(db_session: AsyncSession):
    out = await presence_service.get_snapshots(db_session, ["ag_missing"])
    assert out == []


@pytest.mark.asyncio
async def test_get_snapshots_returns_connected(db_session: AsyncSession):
    await presence_service.mark_connected(db_session, "ag_test", "conn_1")
    out = await presence_service.get_snapshots(db_session, ["ag_test"])
    assert len(out) == 1
    assert out[0].agent_id == "ag_test"
    assert out[0].effective_status == "online"


@pytest.mark.asyncio
async def test_invisible_observer_view_hides_status(db_session: AsyncSession):
    await presence_service.mark_connected(db_session, "ag_test", "conn_1")
    snapshot, _ = await presence_service.set_manual_status(
        db_session, "ag_test", "invisible"
    )
    observer = snapshot.for_observer(is_owner=False)
    assert observer["effective_status"] == "offline"
    assert observer["manual_status"] == "available"
    owner = snapshot.for_observer(is_owner=True)
    assert owner["manual_status"] == "invisible"


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cleanup_drops_stale_connections(
    db_session: AsyncSession, monkeypatch
):
    # Force online_timeout to 1 second for the test
    from hub import config as hub_config

    monkeypatch.setattr(hub_config, "PRESENCE_ONLINE_TIMEOUT_SECONDS", 1.0)

    past = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        seconds=120
    )
    await presence_service.mark_connected(
        db_session, "ag_test", "conn_old", now=past
    )
    # Force last_seen back into the past after _recompute_and_persist set it.
    await db_session.execute(
        AgentPresenceConnection.__table__.update()
        .where(AgentPresenceConnection.connection_id == "conn_old")
        .values(last_seen_at=past)
    )
    await db_session.flush()

    changed = await presence_service.cleanup_stale(db_session)
    assert any(s.agent_id == "ag_test" for s in changed)

    snap = (await presence_service.get_snapshots(db_session, ["ag_test"]))[0]
    assert snap.connected is False
    assert snap.effective_status == "offline"
