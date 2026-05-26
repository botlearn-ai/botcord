"""CloudAgentService lifecycle tests (PR 3 — fake provider)."""

from __future__ import annotations

import datetime
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import hub.services.cloud_agent as cloud_agent_service
from hub.auth import assert_current_agent_token
from hub.enums import KeyState, MessageState
from hub.i18n import I18nHTTPException
from hub.models import (
    Agent,
    Base,
    CloudAgentInstance,
    CloudDaemonInstance,
    DaemonInstance,
    MessageRecord,
    SigningKey,
    UsageReservation,
)
from hub.services.cloud_agent import (
    CloudAgentError,
    CloudAgentService,
    CreateCloudAgentInput,
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


def _make_service(
    *,
    feature_enabled: bool = True,
    max_per_user: int = 3,
    max_agents_per_daemon: int = 2,
    provider: FakeCloudDaemonProvider | None = None,
) -> tuple[CloudAgentService, FakeCloudDaemonProvider]:
    fake = provider or FakeCloudDaemonProvider()
    svc = CloudAgentService(
        provider=fake,
        feature_enabled=feature_enabled,
        max_per_user=max_per_user,
        max_agents_per_daemon=max_agents_per_daemon,
    )
    return svc, fake


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_returns_ready_with_fake_provider(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session,
        user_id=user_id,
        body=CreateCloudAgentInput(name="Cloud Bot"),
    )
    assert view.status == "ready"
    assert view.runtime == "deepseek-tui"
    assert view.model_profile == "deepseek-v4-flash"
    assert view.provider == "fake"
    assert view.provider_sandbox_id is not None
    assert view.hosting_kind == "cloud"
    assert view.cloud_agent_instance_id.startswith("cloud_ag_")
    assert view.cloud_daemon_instance_id.startswith("cloud_dm_")

    # Underlying rows exist and are consistent.
    agent = await db_session.scalar(
        select(Agent).where(Agent.agent_id == view.agent_id)
    )
    assert agent is not None
    assert agent.hosting_kind == "cloud"
    assert agent.user_id == user_id
    assert agent.claimed_at is not None
    assert agent.agent_token is not None

    signing_keys = (
        await db_session.execute(
            select(SigningKey).where(SigningKey.agent_id == view.agent_id)
        )
    ).scalars().all()
    assert len(signing_keys) == 1
    assert signing_keys[0].state.value == "active"
    assert signing_keys[0].pubkey.startswith("ed25519:")

    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    assert cdi is not None
    assert cdi.active_agent_count == 1
    assert cdi.status == "ready"
    assert cdi.provider == "fake"

    # Provider was called exactly once for create.
    calls = fake.calls(view.cloud_daemon_instance_id)
    assert calls["create"] == 1


@pytest.mark.asyncio
async def test_create_rejected_when_feature_disabled(db_session):
    svc, _ = _make_service(feature_enabled=False)
    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_cloud_agent(
            db_session,
            user_id=uuid.uuid4(),
            body=CreateCloudAgentInput(name="Bot"),
        )
    assert excinfo.value.code == "feature_disabled"
    assert excinfo.value.http_status == 403


@pytest.mark.asyncio
async def test_create_rejected_when_quota_exceeded(db_session):
    user_id = uuid.uuid4()
    svc, _ = _make_service(max_per_user=1, max_agents_per_daemon=2)
    await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_cloud_agent(
            db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
        )
    assert excinfo.value.code == "quota_exceeded"


@pytest.mark.asyncio
async def test_two_agents_share_a_cloud_daemon(db_session):
    """§6.1 / §11: a cloud daemon must host >=2 Cloud Agents."""
    user_id = uuid.uuid4()
    svc, fake = _make_service(max_per_user=4, max_agents_per_daemon=3)
    a = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    b = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )
    assert a.cloud_daemon_instance_id == b.cloud_daemon_instance_id
    assert a.agent_id != b.agent_id

    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == a.cloud_daemon_instance_id
        )
    )
    assert cdi.active_agent_count == 2

    # Provider was called for each agent (resume on the second; fake
    # treats it as a no-op create).
    calls = fake.calls(a.cloud_daemon_instance_id)
    assert calls["create"] == 2


@pytest.mark.asyncio
async def test_create_agent_on_online_cloud_daemon_provisions_without_restart(
    db_session, monkeypatch
):
    user_id = uuid.uuid4()
    svc, fake = _make_service(max_per_user=4, max_agents_per_daemon=3)
    first = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    sent_frames: list[tuple[str, str, dict]] = []

    async def fake_send_cloud_control_frame(
        cloud_daemon_instance_id: str,
        type_: str,
        params: dict | None = None,
        timeout_ms: int | None = None,
    ) -> dict:
        sent_frames.append((cloud_daemon_instance_id, type_, params or {}))
        agent_id = (params or {}).get("credentials", {}).get("agentId")
        return {"ok": True, "result": {"agentId": agent_id}}

    monkeypatch.setattr(
        cloud_agent_service,
        "is_cloud_daemon_online",
        lambda cloud_daemon_instance_id: cloud_daemon_instance_id
        == first.cloud_daemon_instance_id,
    )
    monkeypatch.setattr(
        cloud_agent_service,
        "send_cloud_control_frame",
        fake_send_cloud_control_frame,
    )

    second = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )

    assert second.status == "ready"
    assert second.cloud_daemon_instance_id == first.cloud_daemon_instance_id
    assert fake.calls(first.cloud_daemon_instance_id)["create"] == 1
    assert [frame[1] for frame in sent_frames] == ["provision_agent"]
    assert sent_frames[0][0] == first.cloud_daemon_instance_id
    assert sent_frames[0][2]["credentials"]["agentId"] == second.agent_id


@pytest.mark.asyncio
async def test_create_rejects_when_single_user_sandbox_is_full(db_session):
    user_id = uuid.uuid4()
    svc, _ = _make_service(max_per_user=3, max_agents_per_daemon=1)
    a = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_cloud_agent(
            db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
        )
    assert excinfo.value.code == "sandbox_capacity_exceeded"

    rows = (
        await db_session.execute(
            select(CloudDaemonInstance).where(CloudDaemonInstance.user_id == user_id)
        )
    ).scalars().all()
    assert [row.id for row in rows] == [a.cloud_daemon_instance_id]


@pytest.mark.asyncio
async def test_different_runtimes_share_single_user_sandbox(db_session):
    user_id = uuid.uuid4()
    svc, _ = _make_service(max_per_user=3, max_agents_per_daemon=3)
    a = await svc.create_cloud_agent(
        db_session,
        user_id=user_id,
        body=CreateCloudAgentInput(name="A", runtime="deepseek-tui"),
    )
    b = await svc.create_cloud_agent(
        db_session,
        user_id=user_id,
        body=CreateCloudAgentInput(name="B", runtime="codex"),
    )
    assert a.cloud_daemon_instance_id == b.cloud_daemon_instance_id
    assert b.runtime == "codex"


@pytest.mark.asyncio
async def test_create_persists_runtime_model_options(db_session):
    user_id = uuid.uuid4()
    svc, _ = _make_service(max_per_user=3, max_agents_per_daemon=3)
    view = await svc.create_cloud_agent(
        db_session,
        user_id=user_id,
        body=CreateCloudAgentInput(
            name="A",
            runtime="codex",
            runtime_model="gpt-5.2",
            reasoning_effort="high",
        ),
    )
    assert view.runtime == "codex"
    assert view.model_profile == "gpt-5.2"
    assert view.runtime_model == "gpt-5.2"
    assert view.reasoning_effort == "high"

    row = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == view.agent_id)
    )
    assert row is not None
    assert row.metadata_json["runtime_options"] == {
        "runtime_model": "gpt-5.2",
        "reasoning_effort": "high",
    }
    assert "provisioning" not in row.metadata_json


@pytest.mark.asyncio
async def test_create_rejects_reasoning_effort_not_in_cloud_snapshot(db_session):
    user_id = uuid.uuid4()
    svc, _ = _make_service(max_per_user=3, max_agents_per_daemon=3)
    first = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == first.cloud_daemon_instance_id
        )
    )
    assert cdi is not None
    daemon = await db_session.scalar(
        select(DaemonInstance).where(DaemonInstance.id == cdi.daemon_instance_id)
    )
    assert daemon is not None
    daemon.runtimes_json = [
        {
            "id": "codex",
            "available": True,
            "models": [
                {
                    "id": "gpt-5.2",
                    "parameters": [
                        {
                            "id": "reasoning_effort",
                            "type": "enum",
                            "values": ["low", "medium", "high"],
                        }
                    ],
                }
            ],
        }
    ]
    await db_session.commit()

    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_cloud_agent(
            db_session,
            user_id=user_id,
            body=CreateCloudAgentInput(
                name="B",
                runtime="codex",
                runtime_model="gpt-5.2",
                reasoning_effort="xhigh",
            ),
        )
    assert excinfo.value.code == "runtime_unavailable"
    assert excinfo.value.http_status == 409


@pytest.mark.asyncio
async def test_create_provider_failure_marks_state_failed(db_session):
    user_id = uuid.uuid4()
    fake = FakeCloudDaemonProvider(force_create_failure=True)
    svc, _ = _make_service(provider=fake)
    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_cloud_agent(
            db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
        )
    assert excinfo.value.code == "fake_create_failed"
    assert excinfo.value.http_status == 502

    # Row was persisted in a 'failed' state; no orphaned half-committed work.
    cai = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.user_id == user_id)
    )
    assert cai is not None
    assert cai.status == "failed"
    assert cai.error_code == "fake_create_failed"
    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(CloudDaemonInstance.user_id == user_id)
    )
    assert cdi.status == "failed"


# ---------------------------------------------------------------------------
# Pause / resume
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pause_then_resume_round_trip(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    paused = await svc.pause_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert paused.status == "paused"
    assert paused.cloud_daemon_status == "paused"
    assert fake.calls(view.cloud_daemon_instance_id)["pause"] == 1

    resumed = await svc.resume_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert resumed.status == "ready"
    assert resumed.cloud_daemon_status == "ready"
    # Resume re-enters create_or_resume on the provider.
    assert fake.calls(view.cloud_daemon_instance_id)["create"] == 2


@pytest.mark.asyncio
async def test_restart_cloud_daemon_restarts_shared_sandbox(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service(max_per_user=4, max_agents_per_daemon=2)
    a = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    b = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )
    assert a.cloud_daemon_instance_id == b.cloud_daemon_instance_id
    assert fake.calls(a.cloud_daemon_instance_id)["create"] == 2
    daemon_instance_id = await db_session.scalar(
        select(CloudDaemonInstance.daemon_instance_id).where(
            CloudDaemonInstance.id == a.cloud_daemon_instance_id
        )
    )
    assert daemon_instance_id is not None

    await svc.restart_cloud_daemon(
        db_session,
        user_id=user_id,
        daemon_instance_id=daemon_instance_id,
    )

    rows = (
        await db_session.execute(
            select(CloudAgentInstance).where(
                CloudAgentInstance.cloud_daemon_instance_id == a.cloud_daemon_instance_id
            )
        )
    ).scalars().all()
    assert {row.agent_id for row in rows} == {a.agent_id, b.agent_id}
    assert {row.status for row in rows} == {"ready"}
    assert fake.calls(a.cloud_daemon_instance_id)["create"] == 3


@pytest.mark.asyncio
async def test_pause_idempotent(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    await svc.pause_cloud_agent(db_session, user_id=user_id, agent_id=view.agent_id)
    second = await svc.pause_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert second.status == "paused"
    # Provider pause is only called once even though we requested pause twice.
    assert fake.calls(view.cloud_daemon_instance_id)["pause"] == 1


@pytest.mark.asyncio
async def test_pause_only_pauses_daemon_when_last_agent_paused(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service(max_per_user=4, max_agents_per_daemon=2)
    a = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    b = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )
    assert a.cloud_daemon_instance_id == b.cloud_daemon_instance_id

    # Pause one of two — sandbox stays ready (the other agent is active).
    await svc.pause_cloud_agent(db_session, user_id=user_id, agent_id=a.agent_id)
    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == a.cloud_daemon_instance_id
        )
    )
    assert cdi.status == "ready"
    assert fake.calls(a.cloud_daemon_instance_id)["pause"] == 0

    # Pause the remaining active agent — now the shared sandbox can pause.
    await svc.pause_cloud_agent(db_session, user_id=user_id, agent_id=b.agent_id)
    await db_session.refresh(cdi)
    assert cdi.status == "paused"
    assert fake.calls(a.cloud_daemon_instance_id)["pause"] == 1


@pytest.mark.asyncio
async def test_idle_pause_pauses_ready_daemon_and_agents(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    future_now = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)

    paused_count = await svc.pause_idle_cloud_daemons(
        db_session, idle_seconds=300, now=future_now
    )

    cai = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == view.agent_id)
    )
    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    assert paused_count == 1
    assert cai.status == "paused"
    assert cdi.status == "paused"
    assert cdi.last_paused_at.replace(tzinfo=datetime.timezone.utc) == future_now
    assert cdi.metadata_json["last_pause_reason"] == "idle_timeout"
    assert fake.calls(view.cloud_daemon_instance_id)["pause"] == 1


@pytest.mark.asyncio
async def test_idle_pause_waits_for_all_agents_on_daemon(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service(max_per_user=4, max_agents_per_daemon=2)
    a = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    b = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )
    assert a.cloud_daemon_instance_id == b.cloud_daemon_instance_id

    now = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)
    recent = now - datetime.timedelta(seconds=30)
    b_row = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == b.agent_id)
    )
    b_row.last_run_at = recent
    await db_session.commit()

    paused_count = await svc.pause_idle_cloud_daemons(
        db_session, idle_seconds=300, now=now
    )

    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == a.cloud_daemon_instance_id
        )
    )
    assert paused_count == 0
    assert cdi.status == "ready"
    assert fake.calls(a.cloud_daemon_instance_id)["pause"] == 0


@pytest.mark.asyncio
async def test_idle_pause_skips_active_reservation(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    db_session.add(
        UsageReservation(
            user_id=user_id,
            agent_id=view.agent_id,
            run_id="run_active",
            reserved_credits=10,
            reserved_sandbox_seconds=60,
            state="active",
        )
    )
    await db_session.commit()

    paused_count = await svc.pause_idle_cloud_daemons(
        db_session,
        idle_seconds=300,
        now=datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc),
    )

    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    assert paused_count == 0
    assert cdi.status == "ready"
    assert fake.calls(view.cloud_daemon_instance_id)["pause"] == 0


@pytest.mark.asyncio
async def test_idle_pause_skips_active_cloud_run_message(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    db_session.add(
        MessageRecord(
            hub_msg_id="hub_msg_idle_active",
            msg_id="msg_idle_active",
            sender_id=view.agent_id,
            receiver_id=view.agent_id,
            state=MessageState.queued,
            envelope_json="{}",
            ttl_sec=300,
            source_type="cloud_agent_run",
        )
    )
    await db_session.commit()

    paused_count = await svc.pause_idle_cloud_daemons(
        db_session,
        idle_seconds=300,
        now=datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc),
    )

    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    assert paused_count == 0
    assert cdi.status == "ready"
    assert fake.calls(view.cloud_daemon_instance_id)["pause"] == 0


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_marks_agent_deleted_and_cleans_up_daemon(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    agent = await db_session.scalar(
        select(Agent).where(Agent.agent_id == view.agent_id)
    )
    assert agent is not None
    token = agent.agent_token
    assert token is not None

    deleted = await svc.delete_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert deleted.status == "deleted"
    assert deleted.cloud_daemon_status == "deleted"
    assert fake.calls(view.cloud_daemon_instance_id)["cleanup"] == 1

    agent = await db_session.scalar(
        select(Agent).where(Agent.agent_id == view.agent_id)
    )
    assert agent is not None
    assert agent.status == "deleted"
    assert agent.deleted_at is not None
    assert agent.agent_token is None
    with pytest.raises(I18nHTTPException):
        assert_current_agent_token(agent, token)
    keys = (
        await db_session.execute(
            select(SigningKey).where(SigningKey.agent_id == view.agent_id)
        )
    ).scalars().all()
    assert keys
    assert all(key.state == KeyState.revoked for key in keys)


@pytest.mark.asyncio
async def test_delete_one_agent_does_not_clean_up_shared_daemon(db_session):
    """§11: deleting one Cloud Agent must not tear down peers on same daemon."""
    user_id = uuid.uuid4()
    svc, fake = _make_service(max_per_user=4, max_agents_per_daemon=2)
    a = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    b = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )
    assert a.cloud_daemon_instance_id == b.cloud_daemon_instance_id

    await svc.delete_cloud_agent(db_session, user_id=user_id, agent_id=a.agent_id)
    # Provider cleanup was NOT called — there's still one active agent.
    assert fake.calls(a.cloud_daemon_instance_id)["cleanup"] == 0

    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == a.cloud_daemon_instance_id
        )
    )
    assert cdi.status == "ready"
    assert cdi.active_agent_count == 1

    # B is still usable.
    refreshed = await svc.get_cloud_agent(
        db_session, user_id=user_id, agent_id=b.agent_id
    )
    assert refreshed.status == "ready"


@pytest.mark.asyncio
async def test_delete_then_delete_is_idempotent(db_session):
    user_id = uuid.uuid4()
    svc, _ = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    first = await svc.delete_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    second = await svc.delete_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert first.status == "deleted"
    assert second.status == "deleted"


# ---------------------------------------------------------------------------
# List / get
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_omits_deleted(db_session):
    user_id = uuid.uuid4()
    svc, _ = _make_service(max_per_user=4)
    a = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    b = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )
    await svc.delete_cloud_agent(db_session, user_id=user_id, agent_id=a.agent_id)

    out = await svc.list_cloud_agents(db_session, user_id=user_id)
    assert [v.agent_id for v in out] == [b.agent_id]


@pytest.mark.asyncio
async def test_get_cross_user_returns_not_found(db_session):
    owner = uuid.uuid4()
    other = uuid.uuid4()
    svc, _ = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=owner, body=CreateCloudAgentInput(name="A")
    )
    with pytest.raises(CloudAgentError) as excinfo:
        await svc.get_cloud_agent(db_session, user_id=other, agent_id=view.agent_id)
    assert excinfo.value.code == "not_found"
    assert excinfo.value.http_status == 404


# ---------------------------------------------------------------------------
# Schema invariants
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_underlying_daemon_instance_marked_as_cloud_kind(db_session):
    user_id = uuid.uuid4()
    svc, _ = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    daemon = await db_session.scalar(
        select(DaemonInstance).where(DaemonInstance.id == cdi.daemon_instance_id)
    )
    assert daemon is not None
    assert daemon.kind == "cloud"
