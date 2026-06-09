"""Tests for CloudAgentService.get_run / cancel_run — PR 9 best-effort run state.

There is no dedicated run-state table; status is inferred from the per-run
UsageReservation and any settled UsageEvent. These tests exercise that
inference plus the cancellation path (release reservation + fail the queued
trigger message).
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.enums import MessageState
from hub.models import (
    Base,
    MessageRecord,
    UsageEvent,
    UsageReservation,
    User,
)
from hub.services.cloud_agent import CloudAgentError, CloudAgentService, CreateCloudAgentInput
from hub.services.cloud_daemon_provider import FakeCloudDaemonProvider

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def service():
    return CloudAgentService(
        provider=FakeCloudDaemonProvider(),
        feature_enabled=True,
        max_per_user=3,
        max_agents_per_daemon=2,
    )


async def _seed_agent(db: AsyncSession, service: CloudAgentService) -> dict:
    user = User(
        id=uuid.uuid4(),
        display_name="Run User",
        email="run@example.com",
        status="active",
        supabase_user_id=uuid.uuid4(),
        max_agents=30,
    )
    db.add(user)
    await db.commit()
    view = await service.create_cloud_agent(
        db, user_id=user.id, body=CreateCloudAgentInput(name="Run Agent")
    )
    await db.commit()
    return {"user_id": user.id, "agent_id": view.agent_id}


@pytest.mark.asyncio
async def test_get_run_reports_running_then_cancelled(db_session, service):
    from hub.services.cloud_agent import CreateRunInput

    seeded = await _seed_agent(db_session, service)
    run = await service.create_run(
        db_session,
        user_id=seeded["user_id"],
        agent_id=seeded["agent_id"],
        body=CreateRunInput(prompt="do the thing"),
    )

    status = await service.get_run(
        db_session,
        user_id=seeded["user_id"],
        agent_id=seeded["agent_id"],
        run_id=run.run_id,
    )
    assert status.status == "running"
    assert status.reserved_credits > 0

    cancelled = await service.cancel_run(
        db_session,
        user_id=seeded["user_id"],
        agent_id=seeded["agent_id"],
        run_id=run.run_id,
    )
    assert cancelled.status == "cancelled"

    # The queued trigger message was marked failed.
    record = await db_session.scalar(
        select(MessageRecord).where(MessageRecord.hub_msg_id == run.hub_msg_id)
    )
    assert record is not None
    assert record.state == MessageState.failed

    # Idempotent: cancelling again stays cancelled.
    again = await service.cancel_run(
        db_session,
        user_id=seeded["user_id"],
        agent_id=seeded["agent_id"],
        run_id=run.run_id,
    )
    assert again.status == "cancelled"


@pytest.mark.asyncio
async def test_get_run_reports_completed_when_usage_event_exists(db_session, service):
    seeded = await _seed_agent(db_session, service)
    run_id = "crun_completed01"
    db_session.add(
        UsageEvent(
            user_id=seeded["user_id"],
            agent_id=seeded["agent_id"],
            run_id=run_id,
            provider="fake",
            model="deepseek-v4-flash",
            output_tokens=100,
            credits_charged=42,
            idempotency_key=f"{run_id}:settle",
        )
    )
    await db_session.commit()

    status = await service.get_run(
        db_session,
        user_id=seeded["user_id"],
        agent_id=seeded["agent_id"],
        run_id=run_id,
    )
    assert status.status == "completed"
    assert status.credits_charged == 42


@pytest.mark.asyncio
async def test_get_run_unknown_run_raises_404(db_session, service):
    seeded = await _seed_agent(db_session, service)
    with pytest.raises(CloudAgentError) as exc:
        await service.get_run(
            db_session,
            user_id=seeded["user_id"],
            agent_id=seeded["agent_id"],
            run_id="crun_doesnotexist",
        )
    assert exc.value.http_status == 404


@pytest.mark.asyncio
async def test_get_run_rejects_run_of_other_agent(db_session, service):
    seeded = await _seed_agent(db_session, service)
    # Reservation owned by a different agent id.
    db_session.add(
        UsageReservation(
            user_id=seeded["user_id"],
            agent_id="ag_someoneelse",
            run_id="crun_foreign01",
            reserved_credits=5,
            reserved_sandbox_seconds=60,
            state="active",
        )
    )
    await db_session.commit()
    with pytest.raises(CloudAgentError) as exc:
        await service.get_run(
            db_session,
            user_id=seeded["user_id"],
            agent_id=seeded["agent_id"],
            run_id="crun_foreign01",
        )
    assert exc.value.http_status == 404


@pytest.mark.asyncio
async def test_cancel_run_rejects_settled_run_of_other_agent(db_session, service):
    seeded = await _seed_agent(db_session, service)
    # Settled runs may only have a UsageEvent left; cancellation must still
    # apply the same agent ownership gate as get_run.
    db_session.add(
        UsageEvent(
            user_id=seeded["user_id"],
            agent_id="ag_someoneelse",
            run_id="crun_foreign_settled",
            provider="fake",
            model="deepseek-v4-flash",
            output_tokens=100,
            credits_charged=42,
            idempotency_key="crun_foreign_settled:settle",
        )
    )
    await db_session.commit()
    with pytest.raises(CloudAgentError) as exc:
        await service.cancel_run(
            db_session,
            user_id=seeded["user_id"],
            agent_id=seeded["agent_id"],
            run_id="crun_foreign_settled",
        )
    assert exc.value.http_status == 404
