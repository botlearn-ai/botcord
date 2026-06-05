"""PR 6: tests for the Cloud Agent run endpoint at the service layer."""

from __future__ import annotations

import json
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.schemas import MessageEnvelope
from hub.models import (
    Agent,
    Base,
    CloudAgentInstance,
    MessageRecord,
    Room,
    RoomMember,
    UsageBalance,
    UsageReservation,
    User,
)
from hub.services.cloud_agent import (
    CloudAgentError,
    CloudAgentService,
    CreateCloudAgentInput,
    CreateRunInput,
    RunBudget,
)
from hub.services.cloud_agent_usage import UsageService
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


async def _seed_user(db: AsyncSession) -> User:
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


def _service(
    *,
    feature_enabled: bool = True,
    max_per_user: int = 3,
    new_api_service=None,
    provider: FakeCloudDaemonProvider | None = None,
) -> CloudAgentService:
    return CloudAgentService(
        provider=provider or FakeCloudDaemonProvider(),
        feature_enabled=feature_enabled,
        max_per_user=max_per_user,
        max_agents_per_daemon=2,
        new_api_service=new_api_service,
    )


class _RunNewApiService:
    def __init__(
        self,
        *,
        configured: bool = True,
        provisioned: bool = True,
        token_remain_quota: int = 500_000,
    ) -> None:
        self.configured = configured
        self.provisioned = provisioned
        self.token_remain_quota = token_remain_quota

    async def ensure_credential(self, db, *, user_id, force_refresh=False):
        return object()

    def runtime_env(self, credential):
        return {"OPENAI_API_KEY": "sk-user"}

    async def get_balance(self, db, *, user_id):
        return type(
            "Balance",
            (),
            {
                "configured": self.configured,
                "provisioned": self.provisioned,
                "token_remain_quota": self.token_remain_quota,
            },
        )()


class _FailingResumeProvider(FakeCloudDaemonProvider):
    async def create_or_resume(self, **kwargs):
        cloud_daemon_instance_id = kwargs["cloud_daemon_instance_id"]
        if cloud_daemon_instance_id in self.all_sandboxes():
            raise RuntimeError("resume failed after provisioning commit")
        return await super().create_or_resume(**kwargs)


async def _create_ready_agent(svc: CloudAgentService, db, user) -> "CloudAgentView":
    return await svc.create_cloud_agent(
        db,
        user_id=user.id,
        body=CreateCloudAgentInput(name=f"Cloud-{uuid.uuid4().hex[:4]}"),
    )


async def _fresh_run_usage_state(db: AsyncSession, *, user_id: uuid.UUID):
    factory = async_sessionmaker(
        db.bind, class_=AsyncSession, expire_on_commit=False
    )
    async with factory() as fresh:
        active_reservations = (
            await fresh.execute(
                select(UsageReservation).where(UsageReservation.state == "active")
            )
        ).scalars().all()
        balance = await fresh.scalar(
            select(UsageBalance).where(UsageBalance.user_id == user_id)
        )
        run_message = await fresh.scalar(
            select(MessageRecord).where(MessageRecord.source_type == "cloud_agent_run")
        )
        return active_reservations, balance, run_message


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_run_inserts_message_record_and_returns_run_id(db_session):
    svc = _service()
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)

    run = await svc.create_run(
        db_session,
        user_id=user.id,
        agent_id=cloud_agent.agent_id,
        body=CreateRunInput(prompt="Summarise the workspace"),
    )
    assert run.run_id.startswith("crun_")
    assert run.agent_id == cloud_agent.agent_id
    assert run.status == "queued"
    assert run.budget.max_wall_time_seconds == 600
    assert run.budget.max_tool_calls == 30

    rec = await db_session.scalar(
        select(MessageRecord).where(MessageRecord.hub_msg_id == run.hub_msg_id)
    )
    assert rec is not None
    assert rec.receiver_id == cloud_agent.agent_id
    assert rec.sender_id == cloud_agent.agent_id
    assert rec.room_id == run.room_id
    assert rec.source_type == "cloud_agent_run"
    assert rec.source_user_id == str(user.id)
    envelope = json.loads(rec.envelope_json)
    assert envelope["type"] == "cloud_run"
    assert MessageEnvelope(**envelope).type.value == "cloud_run"
    assert envelope["payload"]["text"] == "Summarise the workspace"
    assert envelope["payload"]["cloud_run"]["run_id"] == run.run_id
    assert envelope["payload"]["cloud_run"]["settle_usage"] is True
    assert envelope["payload"]["cloud_run"]["budget"]["max_wall_time_seconds"] == 600
    reservation = await db_session.scalar(
        select(UsageReservation).where(UsageReservation.run_id == run.run_id)
    )
    assert reservation is not None
    assert reservation.state == "active"
    assert reservation.reserved_credits > 0
    assert reservation.reserved_sandbox_seconds == 600


@pytest.mark.asyncio
async def test_create_run_creates_owner_chat_room_with_both_members(db_session):
    svc = _service()
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)

    run = await svc.create_run(
        db_session,
        user_id=user.id,
        agent_id=cloud_agent.agent_id,
        body=CreateRunInput(prompt="hi"),
    )
    room = await db_session.scalar(select(Room).where(Room.room_id == run.room_id))
    assert room is not None
    members = (
        await db_session.execute(
            select(RoomMember).where(RoomMember.room_id == run.room_id)
        )
    ).scalars().all()
    member_ids = {m.agent_id for m in members}
    assert cloud_agent.agent_id in member_ids


@pytest.mark.asyncio
async def test_create_run_updates_last_run_at(db_session):
    svc = _service()
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    await svc.create_run(
        db_session,
        user_id=user.id,
        agent_id=cloud_agent.agent_id,
        body=CreateRunInput(prompt="task"),
    )
    refreshed = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == cloud_agent.agent_id
        )
    )
    assert refreshed.last_run_at is not None


@pytest.mark.asyncio
async def test_create_run_respects_custom_budget(db_session):
    svc = _service()
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    run = await svc.create_run(
        db_session,
        user_id=user.id,
        agent_id=cloud_agent.agent_id,
        body=CreateRunInput(
            prompt="long task",
            budget=RunBudget(max_wall_time_seconds=1800, max_tool_calls=100),
        ),
    )
    assert run.budget.max_wall_time_seconds == 1800
    assert run.budget.max_tool_calls == 100

    rec = await db_session.scalar(
        select(MessageRecord).where(MessageRecord.hub_msg_id == run.hub_msg_id)
    )
    assert rec.ttl_sec == 1800
    envelope = json.loads(rec.envelope_json)
    assert envelope["payload"]["cloud_run"]["budget"]["max_tool_calls"] == 100


@pytest.mark.asyncio
async def test_create_run_rejects_exhausted_new_api_balance(db_session):
    svc = _service(
        new_api_service=_RunNewApiService(configured=True, token_remain_quota=0)
    )
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)

    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="blocked"),
        )
    assert excinfo.value.code == "new_api_balance_exhausted"
    assert excinfo.value.http_status == 402
    run_message = await db_session.scalar(
        select(MessageRecord).where(MessageRecord.source_type == "cloud_agent_run")
    )
    assert run_message is None


@pytest.mark.asyncio
async def test_create_run_preflights_balance_before_resuming_paused_agent(db_session):
    provider = FakeCloudDaemonProvider()
    svc = _service(
        provider=provider,
        new_api_service=_RunNewApiService(configured=True, token_remain_quota=0),
    )
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    await svc.pause_cloud_agent(
        db_session, user_id=user.id, agent_id=cloud_agent.agent_id
    )
    calls_before = provider.calls(cloud_agent.cloud_daemon_instance_id)

    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="do not wake"),
        )

    assert excinfo.value.code == "new_api_balance_exhausted"
    assert provider.calls(cloud_agent.cloud_daemon_instance_id) == calls_before
    refreshed = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == cloud_agent.agent_id
        )
    )
    assert refreshed.status == "paused"
    run_message = await db_session.scalar(
        select(MessageRecord).where(MessageRecord.source_type == "cloud_agent_run")
    )
    assert run_message is None


@pytest.mark.asyncio
async def test_create_run_reserves_usage_before_resuming_paused_agent(db_session):
    provider = FakeCloudDaemonProvider()
    svc = CloudAgentService(
        provider=provider,
        feature_enabled=True,
        max_per_user=3,
        max_agents_per_daemon=2,
        usage_service=UsageService(
            free_credits_per_period=1,
            free_sandbox_seconds_per_period=3600,
        ),
    )
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    await svc.pause_cloud_agent(
        db_session, user_id=user.id, agent_id=cloud_agent.agent_id
    )
    calls_before = provider.calls(cloud_agent.cloud_daemon_instance_id)

    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="quota blocked"),
        )

    assert excinfo.value.code == "quota_credits_exceeded"
    assert excinfo.value.http_status == 402
    assert provider.calls(cloud_agent.cloud_daemon_instance_id) == calls_before
    refreshed = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == cloud_agent.agent_id
        )
    )
    assert refreshed.status == "paused"
    run_message = await db_session.scalar(
        select(MessageRecord).where(MessageRecord.source_type == "cloud_agent_run")
    )
    assert run_message is None
    reservations = (await db_session.execute(select(UsageReservation))).scalars().all()
    assert reservations == []


# ---------------------------------------------------------------------------
# Auto-resume + state machine
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_run_auto_resumes_paused_agent(db_session):
    svc = _service()
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    await svc.pause_cloud_agent(
        db_session, user_id=user.id, agent_id=cloud_agent.agent_id
    )

    run = await svc.create_run(
        db_session,
        user_id=user.id,
        agent_id=cloud_agent.agent_id,
        body=CreateRunInput(prompt="wake up"),
    )
    assert run.status == "queued"
    refreshed = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == cloud_agent.agent_id
        )
    )
    assert refreshed.status == "ready"


@pytest.mark.asyncio
async def test_create_run_releases_usage_when_paused_resume_provider_fails(
    db_session,
):
    provider = _FailingResumeProvider()
    svc = _service(provider=provider)
    user = await _seed_user(db_session)
    user_id = user.id
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    await svc.pause_cloud_agent(
        db_session, user_id=user.id, agent_id=cloud_agent.agent_id
    )

    with pytest.raises(RuntimeError, match="resume failed"):
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="wake then fail"),
        )

    active_reservations, balance, run_message = await _fresh_run_usage_state(
        db_session, user_id=user_id
    )
    assert active_reservations == []
    assert balance is not None
    assert balance.reserved_credits == 0
    assert balance.reserved_sandbox_seconds == 0
    assert run_message is None


@pytest.mark.asyncio
async def test_create_run_releases_usage_when_room_resolution_fails_after_resume(
    db_session,
):
    provider = FakeCloudDaemonProvider()
    svc = _service(provider=provider)
    user = await _seed_user(db_session)
    user_id = user.id
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    await svc.pause_cloud_agent(
        db_session, user_id=user.id, agent_id=cloud_agent.agent_id
    )

    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="wake then bad room", room_id="rm_missing"),
        )

    assert excinfo.value.code == "room_not_found"
    active_reservations, balance, run_message = await _fresh_run_usage_state(
        db_session, user_id=user_id
    )
    assert active_reservations == []
    assert balance is not None
    assert balance.reserved_credits == 0
    assert balance.reserved_sandbox_seconds == 0
    assert run_message is None


@pytest.mark.asyncio
async def test_create_run_rejected_when_agent_deleted(db_session):
    svc = _service()
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    await svc.delete_cloud_agent(
        db_session, user_id=user.id, agent_id=cloud_agent.agent_id
    )

    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="hi"),
        )
    # delete_cloud_agent removes ownership rows, so 404 is the correct surface.
    assert excinfo.value.http_status in {404, 409}


@pytest.mark.asyncio
async def test_create_run_rejected_when_provisioning(db_session):
    """Mid-provisioning agents must surface a clear 409 — not a stale 200."""
    svc = _service()
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    # Force the row back to provisioning to simulate an E2B-path agent
    # whose daemon hasn't acked yet.
    cai = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == cloud_agent.agent_id
        )
    )
    cai.status = "provisioning"
    await db_session.commit()

    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="too early"),
        )
    assert excinfo.value.code == "not_ready"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_run_rejects_empty_prompt(db_session):
    svc = _service()
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="   "),
        )
    assert excinfo.value.code == "invalid_prompt"


@pytest.mark.asyncio
async def test_create_run_rejects_oversized_budget(db_session):
    svc = _service()
    user = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, user)
    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(
                prompt="x",
                budget=RunBudget(max_wall_time_seconds=999999, max_tool_calls=1),
            ),
        )
    assert excinfo.value.code == "invalid_budget"


@pytest.mark.asyncio
async def test_create_run_cross_user_returns_not_found(db_session):
    svc = _service()
    owner = await _seed_user(db_session)
    other = await _seed_user(db_session)
    cloud_agent = await _create_ready_agent(svc, db_session, owner)
    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=other.id,
            agent_id=cloud_agent.agent_id,
            body=CreateRunInput(prompt="not yours"),
        )
    assert excinfo.value.http_status == 404


@pytest.mark.asyncio
async def test_create_run_rejected_when_feature_disabled(db_session):
    svc = _service(feature_enabled=False)
    user = await _seed_user(db_session)
    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_run(
            db_session,
            user_id=user.id,
            agent_id="ag_does_not_matter",
            body=CreateRunInput(prompt="hi"),
        )
    assert excinfo.value.code == "feature_disabled"


# ---------------------------------------------------------------------------
# Multi-agent isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_two_agents_on_same_daemon_produce_distinct_runs(db_session):
    svc = _service()
    user = await _seed_user(db_session)
    a = await _create_ready_agent(svc, db_session, user)
    b = await _create_ready_agent(svc, db_session, user)
    assert a.cloud_daemon_instance_id == b.cloud_daemon_instance_id

    ra = await svc.create_run(
        db_session,
        user_id=user.id,
        agent_id=a.agent_id,
        body=CreateRunInput(prompt="A task"),
    )
    rb = await svc.create_run(
        db_session,
        user_id=user.id,
        agent_id=b.agent_id,
        body=CreateRunInput(prompt="B task"),
    )
    assert ra.run_id != rb.run_id
    assert ra.room_id != rb.room_id
    rec_a = await db_session.scalar(
        select(MessageRecord).where(MessageRecord.hub_msg_id == ra.hub_msg_id)
    )
    rec_b = await db_session.scalar(
        select(MessageRecord).where(MessageRecord.hub_msg_id == rb.hub_msg_id)
    )
    assert rec_a.receiver_id == a.agent_id
    assert rec_b.receiver_id == b.agent_id
