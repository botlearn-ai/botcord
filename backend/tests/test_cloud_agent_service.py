"""CloudAgentService lifecycle tests (PR 3 — fake provider)."""

from __future__ import annotations

import datetime
import logging
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

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
from hub.services.cloud_daemon_provider import (
    CloudDaemonHandle,
    FakeCloudDaemonProvider,
)
from hub.services.new_api import NewApiError
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


class _StaticNewApiService:
    def configured(self):
        return True

    async def ensure_credential(self, db, *, user_id, force_refresh=False):
        return object()

    def runtime_env(self, credential):
        return {
            "OPENAI_API_KEY": "sk-user",
            "OPENAI_BASE_URL": "https://new-api.test/v1",
        }


class _RefreshableNewApiService:
    def __init__(self) -> None:
        self.force_refresh_calls: list[bool] = []

    def configured(self):
        return True

    async def ensure_credential(self, db, *, user_id, force_refresh=False):
        self.force_refresh_calls.append(force_refresh)
        return "fresh" if force_refresh else "stale"

    def runtime_env(self, credential):
        if credential == "stale":
            raise NewApiError(
                "new_api_api_key_decrypt_failed",
                "stored new-api credential cannot be decrypted",
            )
        return {
            "OPENAI_API_KEY": "sk-refreshed",
            "OPENAI_BASE_URL": "https://new-api.test/v1",
        }


class _EnvCapturingProvider(FakeCloudDaemonProvider):
    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.extra_envs: list[dict[str, str]] = []
        self.launch_tokens: list[str | None] = []

    async def create_or_resume(self, **kwargs):
        self.extra_envs.append(dict(kwargs.get("extra_env") or {}))
        self.launch_tokens.append(kwargs.get("launch_token"))
        return await super().create_or_resume(**kwargs)


class _StartingOnResumeProvider(_EnvCapturingProvider):
    def __init__(self) -> None:
        super().__init__()
        self.create_calls = 0

    async def create_or_resume(self, **kwargs):
        self.create_calls += 1
        handle = await super().create_or_resume(**kwargs)
        if self.create_calls >= 2:
            handle.status = "starting"
        return handle


class _FailingCreateAttemptProvider(_EnvCapturingProvider):
    def __init__(self, *, fail_on_call: int, failure_mode: str) -> None:
        super().__init__()
        self._attempts = 0
        self._fail_on_call = fail_on_call
        self._failure_mode = failure_mode

    async def create_or_resume(self, **kwargs):
        self._attempts += 1
        if self._attempts != self._fail_on_call:
            return await super().create_or_resume(**kwargs)

        self.extra_envs.append(dict(kwargs.get("extra_env") or {}))
        self.launch_tokens.append(kwargs.get("launch_token"))
        if self._failure_mode == "exception":
            raise RuntimeError("provider relaunch unavailable")
        return CloudDaemonHandle(
            cloud_daemon_instance_id=kwargs["cloud_daemon_instance_id"],
            daemon_instance_id=kwargs["daemon_instance_id"],
            provider=self.PROVIDER_NAME,
            status="failed",
            runtime=kwargs["runtime"],
            region=kwargs.get("region"),
            provider_sandbox_id=kwargs.get("provider_sandbox_id"),
            error_code="fake_relaunch_failed",
            error_message="fake relaunch failed",
        )


async def _assert_cloud_daemon_ws_accepts_only_launch_token(
    db_session,
    monkeypatch,
    *,
    cloud_daemon: CloudDaemonInstance,
    accepted_launch_token: str,
    rejected_launch_token: str,
) -> None:
    import hub.routers.cloud_daemon_control as cdc
    from hub.database import get_db
    from hub.main import app
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    @asynccontextmanager
    async def _shared_session():
        yield db_session

    monkeypatch.setattr(cdc, "async_session", _shared_session)
    monkeypatch.setattr(cdc, "schedule_provision_drain", lambda *args, **kwargs: None)

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db

    accepted_jwt, _ = cdc._create_cloud_daemon_access_token(
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=cloud_daemon.daemon_instance_id,
        user_id=str(cloud_daemon.user_id),
        launch_token=accepted_launch_token,
    )
    rejected_jwt, _ = cdc._create_cloud_daemon_access_token(
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=cloud_daemon.daemon_instance_id,
        user_id=str(cloud_daemon.user_id),
        launch_token=rejected_launch_token,
    )

    try:
        with TestClient(app) as tc:
            with tc.websocket_connect(
                "/cloud/daemon/ws",
                headers={"Authorization": f"Bearer {accepted_jwt}"},
            ) as ws:
                assert ws.receive_json()["type"] == "hello"
                with pytest.raises(WebSocketDisconnect) as excinfo:
                    with tc.websocket_connect(
                        "/cloud/daemon/ws",
                        headers={"Authorization": f"Bearer {rejected_jwt}"},
                    ):
                        pass
                assert excinfo.value.code == 4401
    finally:
        app.dependency_overrides.pop(get_db, None)


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
async def test_create_cloud_agent_passes_new_api_env_to_provider(db_session):
    provider = _EnvCapturingProvider()
    svc = CloudAgentService(
        provider=provider,
        feature_enabled=True,
        new_api_service=_StaticNewApiService(),
    )

    await svc.create_cloud_agent(
        db_session,
        user_id=uuid.uuid4(),
        body=CreateCloudAgentInput(name="Cloud Bot"),
    )

    assert provider.extra_envs == [
        {
            "OPENAI_API_KEY": "sk-user",
            "OPENAI_BASE_URL": "https://new-api.test/v1",
        }
    ]


@pytest.mark.asyncio
async def test_create_cloud_agent_refreshes_new_api_env_after_decrypt_failure(
    db_session,
):
    provider = _EnvCapturingProvider()
    new_api = _RefreshableNewApiService()
    svc = CloudAgentService(
        provider=provider,
        feature_enabled=True,
        new_api_service=new_api,
    )

    await svc.create_cloud_agent(
        db_session,
        user_id=uuid.uuid4(),
        body=CreateCloudAgentInput(name="Cloud Bot"),
    )

    assert new_api.force_refresh_calls == [False, True]
    assert provider.extra_envs == [
        {
            "OPENAI_API_KEY": "sk-refreshed",
            "OPENAI_BASE_URL": "https://new-api.test/v1",
        }
    ]


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
async def test_create_agent_on_online_cloud_daemon_relaunches_with_runtime_env(
    db_session, monkeypatch
):
    user_id = uuid.uuid4()
    provider = _EnvCapturingProvider()
    svc = CloudAgentService(
        provider=provider,
        feature_enabled=True,
        max_per_user=4,
        max_agents_per_daemon=3,
        new_api_service=_StaticNewApiService(),
    )
    first = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    old_launch_token = "old-relaunch-token"
    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == first.cloud_daemon_instance_id
        )
    )
    assert cloud_row is not None
    cloud_row.metadata_json = {
        **(cloud_row.metadata_json or {}),
        "current_launch_token": old_launch_token,
    }
    await db_session.commit()

    sent_frames: list[tuple[str, str, dict, str | None]] = []

    async def fake_send_cloud_control_frame(
        cloud_daemon_instance_id: str,
        type_: str,
        params: dict | None = None,
        timeout_ms: int | None = None,
        required_launch_token: str | None = None,
    ) -> dict:
        sent_frames.append(
            (cloud_daemon_instance_id, type_, params or {}, required_launch_token)
        )
        if type_ == "list_agents":
            return {"ok": True, "result": {"agents": []}}
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

    assert second.status == "provisioning"
    assert second.cloud_daemon_status == "starting"
    assert second.cloud_daemon_instance_id == first.cloud_daemon_instance_id
    assert provider.calls(first.cloud_daemon_instance_id)["create"] == 2
    assert provider.extra_envs == [
        {
            "OPENAI_API_KEY": "sk-user",
            "OPENAI_BASE_URL": "https://new-api.test/v1",
        },
        {
            "OPENAI_API_KEY": "sk-user",
            "OPENAI_BASE_URL": "https://new-api.test/v1",
        },
    ]
    assert sent_frames == []

    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == second.cloud_daemon_instance_id
        )
    )
    assert cloud_row is not None
    launch_token = cloud_row.metadata_json.get("pending_launch_token")
    assert isinstance(launch_token, str)
    assert launch_token != old_launch_token
    assert cloud_row.metadata_json.get("current_launch_token") == launch_token
    assert provider.launch_tokens == [None, launch_token]

    stale_replayed = await svc.provision_pending_for_cloud_daemon(
        db_session,
        cloud_daemon_instance_id=second.cloud_daemon_instance_id,
    )
    assert stale_replayed == []
    assert sent_frames == []

    replayed = await svc.provision_pending_for_cloud_daemon(
        db_session,
        cloud_daemon_instance_id=second.cloud_daemon_instance_id,
        cloud_daemon_launch_token=launch_token,
    )
    assert {view.agent_id for view in replayed} == {first.agent_id, second.agent_id}
    assert [frame[1] for frame in sent_frames] == [
        "list_agents",
        "provision_agent",
        "provision_agent",
    ]
    assert {frame[3] for frame in sent_frames} == {launch_token}
    provisioned_agent_ids = [
        frame[2]["credentials"]["agentId"]
        for frame in sent_frames
        if frame[1] == "provision_agent"
    ]
    assert provisioned_agent_ids == [first.agent_id, second.agent_id]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_mode", ["exception", "failed"])
async def test_create_agent_online_relaunch_failure_keeps_previous_launch_token(
    db_session, monkeypatch, failure_mode
):
    user_id = uuid.uuid4()
    old_launch_token = "old-relaunch-token"
    provider = _FailingCreateAttemptProvider(
        fail_on_call=2,
        failure_mode=failure_mode,
    )
    svc = CloudAgentService(
        provider=provider,
        feature_enabled=True,
        max_per_user=4,
        max_agents_per_daemon=3,
        new_api_service=_StaticNewApiService(),
    )
    first = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == first.cloud_daemon_instance_id
        )
    )
    assert cloud_row is not None
    first_row = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == first.agent_id)
    )
    assert first_row is not None
    first_row.status = "ready"
    first_row.error_code = "legacy_ready_error"
    first_row.error_message = "legacy error preserved until relaunch recovery"
    first_row.metadata_json = {
        **(first_row.metadata_json or {}),
        "rollback_guard": {"scope": "existing-agent", "value": "preserve"},
    }
    cloud_row.status = "ready"
    cloud_row.error_code = "legacy_daemon_error"
    cloud_row.error_message = "legacy daemon error"
    cloud_row.metadata_json = {
        **(cloud_row.metadata_json or {}),
        "current_launch_token": old_launch_token,
        "rollback_marker": "legacy",
    }
    await db_session.commit()

    monkeypatch.setattr(
        cloud_agent_service,
        "is_cloud_daemon_online",
        lambda cloud_daemon_instance_id: cloud_daemon_instance_id
        == first.cloud_daemon_instance_id,
    )

    with pytest.raises(CloudAgentError) as excinfo:
        await svc.create_cloud_agent(
            db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
        )

    assert excinfo.value.code in {"provider_create_failed", "fake_relaunch_failed"}
    new_launch_token = provider.launch_tokens[-1]
    assert isinstance(new_launch_token, str)
    assert new_launch_token != old_launch_token

    await db_session.refresh(cloud_row)
    await db_session.refresh(first_row)
    assert "pending_launch_token" not in (cloud_row.metadata_json or {})
    assert cloud_row.metadata_json.get("current_launch_token") == old_launch_token
    assert cloud_row.status == "ready"
    assert cloud_row.error_code == "legacy_daemon_error"
    assert cloud_row.error_message == "legacy daemon error"
    assert cloud_row.metadata_json.get("rollback_marker") == "legacy"
    assert first_row.status == "ready"
    assert first_row.error_code == "legacy_ready_error"
    assert first_row.error_message == "legacy error preserved until relaunch recovery"
    assert first_row.metadata_json.get("rollback_guard") == {
        "scope": "existing-agent",
        "value": "preserve",
    }

    await _assert_cloud_daemon_ws_accepts_only_launch_token(
        db_session,
        monkeypatch,
        cloud_daemon=cloud_row,
        accepted_launch_token=old_launch_token,
        rejected_launch_token=new_launch_token,
    )


@pytest.mark.asyncio
async def test_create_agent_on_online_cloud_daemon_starting_waits_for_ready_replay(
    db_session, monkeypatch
):
    user_id = uuid.uuid4()
    provider = _StartingOnResumeProvider()
    svc = CloudAgentService(
        provider=provider,
        feature_enabled=True,
        max_per_user=4,
        max_agents_per_daemon=3,
        new_api_service=_StaticNewApiService(),
    )
    first = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    old_launch_token = "old-relaunch-token"
    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == first.cloud_daemon_instance_id
        )
    )
    assert cloud_row is not None
    cloud_row.metadata_json = {
        **(cloud_row.metadata_json or {}),
        "current_launch_token": old_launch_token,
    }
    await db_session.commit()

    sent_frames: list[tuple[str, str, dict, str | None]] = []

    async def fake_send_cloud_control_frame(
        cloud_daemon_instance_id: str,
        type_: str,
        params: dict | None = None,
        timeout_ms: int | None = None,
        required_launch_token: str | None = None,
    ) -> dict:
        sent_frames.append(
            (cloud_daemon_instance_id, type_, params or {}, required_launch_token)
        )
        if type_ == "list_agents":
            return {"ok": True, "result": {"agents": []}}
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

    assert second.status == "provisioning"
    assert second.cloud_daemon_status == "starting"
    assert second.cloud_daemon_instance_id == first.cloud_daemon_instance_id
    assert provider.calls(first.cloud_daemon_instance_id)["create"] == 2
    assert sent_frames == []

    row = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == second.agent_id
        )
    )
    assert row is not None
    assert row.status == "provisioning"
    assert "provisioning" in (row.metadata_json or {})

    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == second.cloud_daemon_instance_id
        )
    )
    assert cloud_row is not None
    launch_token = cloud_row.metadata_json.get("pending_launch_token")
    assert isinstance(launch_token, str)
    assert launch_token != old_launch_token
    assert cloud_row.metadata_json.get("current_launch_token") == launch_token
    assert provider.launch_tokens == [None, launch_token]

    stale_replayed = await svc.provision_pending_for_cloud_daemon(
        db_session,
        cloud_daemon_instance_id=second.cloud_daemon_instance_id,
    )

    assert stale_replayed == []
    assert sent_frames == []
    await db_session.refresh(row)
    await db_session.refresh(cloud_row)
    assert row.status == "provisioning"
    assert "provisioning" in (row.metadata_json or {})
    assert cloud_row.metadata_json.get("pending_launch_token") == launch_token

    replayed = await svc.provision_pending_for_cloud_daemon(
        db_session,
        cloud_daemon_instance_id=second.cloud_daemon_instance_id,
        cloud_daemon_launch_token=launch_token,
    )

    assert {view.agent_id for view in replayed} == {first.agent_id, second.agent_id}
    assert all(view.status == "ready" for view in replayed)
    assert all(view.cloud_daemon_status == "ready" for view in replayed)
    assert [frame[1] for frame in sent_frames] == [
        "list_agents",
        "provision_agent",
        "provision_agent",
    ]
    assert {frame[3] for frame in sent_frames} == {launch_token}
    provisioned_agent_ids = [
        frame[2]["credentials"]["agentId"]
        for frame in sent_frames
        if frame[1] == "provision_agent"
    ]
    assert provisioned_agent_ids == [first.agent_id, second.agent_id]

    await db_session.refresh(row)
    await db_session.refresh(cloud_row)
    assert row.status == "ready"
    assert "provisioning" not in (row.metadata_json or {})
    assert "pending_launch_token" not in (cloud_row.metadata_json or {})
    assert cloud_row.metadata_json.get("current_launch_token") == launch_token


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
async def test_resume_after_pending_launch_cleanup_reuses_current_launch_token(
    db_session, monkeypatch
):
    user_id = uuid.uuid4()
    provider = _EnvCapturingProvider(force_create_status="starting")
    svc = CloudAgentService(
        provider=provider,
        feature_enabled=True,
        new_api_service=_StaticNewApiService(),
    )
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    launch_token = "retained-launch-token"

    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    agent_row = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == view.agent_id)
    )
    assert cloud_row is not None
    assert agent_row is not None
    cloud_row.metadata_json = {
        **(cloud_row.metadata_json or {}),
        "current_launch_token": launch_token,
        "pending_launch_token": launch_token,
    }
    provisioning = dict((agent_row.metadata_json or {}).get("provisioning") or {})
    provisioning["cloud_daemon_launch_token"] = launch_token
    agent_row.metadata_json = {
        **(agent_row.metadata_json or {}),
        "provisioning": provisioning,
    }
    await db_session.commit()

    sent_frames: list[tuple[str, str | None]] = []

    async def fake_send_cloud_control_frame(
        cloud_daemon_instance_id: str,
        type_: str,
        params: dict | None = None,
        timeout_ms: int | None = None,
        required_launch_token: str | None = None,
    ) -> dict:
        assert cloud_daemon_instance_id == view.cloud_daemon_instance_id
        sent_frames.append((type_, required_launch_token))
        if type_ == "list_agents":
            return {"ok": True, "result": {"agents": []}}
        if type_ == "provision_agent":
            return {
                "ok": True,
                "result": {"agentId": (params or {})["credentials"]["agentId"]},
            }
        raise AssertionError(f"unexpected frame type {type_!r}")

    monkeypatch.setattr(
        cloud_agent_service,
        "send_cloud_control_frame",
        fake_send_cloud_control_frame,
    )

    replayed = await svc.provision_pending_for_cloud_daemon(
        db_session,
        cloud_daemon_instance_id=view.cloud_daemon_instance_id,
        cloud_daemon_launch_token=launch_token,
    )

    assert [r.agent_id for r in replayed] == [view.agent_id]
    assert sent_frames == [
        ("list_agents", launch_token),
        ("provision_agent", launch_token),
    ]
    await db_session.refresh(cloud_row)
    assert "pending_launch_token" not in (cloud_row.metadata_json or {})
    assert cloud_row.metadata_json.get("current_launch_token") == launch_token

    paused = await svc.pause_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )
    assert paused.status == "paused"
    resumed = await svc.resume_cloud_agent(
        db_session, user_id=user_id, agent_id=view.agent_id
    )

    assert resumed.status == "ready"
    assert provider.launch_tokens == [None, launch_token]


@pytest.mark.asyncio
async def test_create_agent_on_paused_daemon_reuses_current_launch_token(db_session):
    user_id = uuid.uuid4()
    provider = _EnvCapturingProvider()
    svc = CloudAgentService(
        provider=provider,
        feature_enabled=True,
        max_per_user=4,
        max_agents_per_daemon=2,
    )
    first = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    await svc.pause_cloud_agent(db_session, user_id=user_id, agent_id=first.agent_id)
    launch_token = "retained-launch-token"
    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == first.cloud_daemon_instance_id
        )
    )
    assert cloud_row is not None
    cloud_row.metadata_json = {
        **(cloud_row.metadata_json or {}),
        "current_launch_token": launch_token,
    }
    await db_session.commit()

    second = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )

    assert second.cloud_daemon_instance_id == first.cloud_daemon_instance_id
    assert second.status == "ready"
    assert provider.launch_tokens == [None, launch_token]


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
    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == a.cloud_daemon_instance_id
        )
    )
    assert cloud_row is not None
    old_launch_token = "old-restart-token"
    cloud_row.metadata_json = {
        **(cloud_row.metadata_json or {}),
        "current_launch_token": old_launch_token,
    }
    await db_session.commit()

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
    assert {row.status for row in rows} == {"provisioning"}
    assert all("provisioning" in (row.metadata_json or {}) for row in rows)
    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == a.cloud_daemon_instance_id
        )
    )
    assert cloud_row is not None
    assert cloud_row.status == "starting"
    launch_token = cloud_row.metadata_json.get("pending_launch_token")
    assert isinstance(launch_token, str)
    assert launch_token != old_launch_token
    assert cloud_row.metadata_json.get("current_launch_token") == launch_token
    assert fake.calls(a.cloud_daemon_instance_id)["create"] == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("state", [MessageState.queued, MessageState.processing])
async def test_restart_cloud_daemon_ignores_owner_chat_inbox_message(
    db_session, state
):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    daemon_instance_id = await db_session.scalar(
        select(CloudDaemonInstance.daemon_instance_id).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    assert daemon_instance_id is not None
    db_session.add(
        MessageRecord(
            hub_msg_id=f"hub_msg_restart_owner_chat_{state.value}",
            msg_id=f"msg_restart_owner_chat_{state.value}",
            sender_id=view.agent_id,
            receiver_id=view.agent_id,
            state=state,
            envelope_json="{}",
            ttl_sec=300,
            source_type="dashboard_user_chat",
            source_session_kind="owner_chat",
        )
    )
    await db_session.commit()

    await svc.restart_cloud_daemon(
        db_session,
        user_id=user_id,
        daemon_instance_id=daemon_instance_id,
    )

    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    assert cdi.status == "starting"
    assert fake.calls(view.cloud_daemon_instance_id)["create"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_mode", ["exception", "failed"])
async def test_restart_cloud_daemon_failure_keeps_previous_launch_token(
    db_session, monkeypatch, failure_mode
):
    user_id = uuid.uuid4()
    old_launch_token = "old-restart-token"
    provider = _FailingCreateAttemptProvider(
        fail_on_call=3,
        failure_mode=failure_mode,
    )
    svc, _ = _make_service(
        max_per_user=4,
        max_agents_per_daemon=2,
        provider=provider,
    )
    a = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    b = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="B")
    )
    cloud_row = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == a.cloud_daemon_instance_id
        )
    )
    assert cloud_row is not None
    a_row = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == a.agent_id)
    )
    b_row = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == b.agent_id)
    )
    assert a_row is not None and b_row is not None
    a_row.status = "ready"
    a_row.error_code = "legacy_a_error"
    a_row.error_message = "a should be restored"
    a_row.metadata_json = {
        **(a_row.metadata_json or {}),
        "rollback_guard": {"name": a_row.agent_id},
    }
    b_row.status = "paused"
    b_row.error_code = "legacy_b_error"
    b_row.error_message = "b should be restored"
    b_row.metadata_json = {
        **(b_row.metadata_json or {}),
        "rollback_guard": {"name": b_row.agent_id},
    }
    cloud_row.metadata_json = {
        **(cloud_row.metadata_json or {}),
        "current_launch_token": old_launch_token,
        "rollback_marker": "legacy",
    }
    cloud_row.status = "ready"
    cloud_row.error_code = "legacy_daemon_error"
    cloud_row.error_message = "legacy daemon error"
    await db_session.commit()

    with pytest.raises(CloudAgentError) as excinfo:
        await svc.restart_cloud_daemon(
            db_session,
            user_id=user_id,
            daemon_instance_id=cloud_row.daemon_instance_id,
        )

    assert excinfo.value.code in {"provider_restart_failed", "fake_relaunch_failed"}
    new_launch_token = provider.launch_tokens[-1]
    assert isinstance(new_launch_token, str)
    assert new_launch_token != old_launch_token

    await db_session.refresh(cloud_row)
    await db_session.refresh(a_row)
    await db_session.refresh(b_row)
    assert "pending_launch_token" not in (cloud_row.metadata_json or {})
    assert cloud_row.metadata_json.get("current_launch_token") == old_launch_token
    assert cloud_row.status == "ready"
    assert cloud_row.error_code == "legacy_daemon_error"
    assert cloud_row.error_message == "legacy daemon error"
    assert cloud_row.metadata_json.get("rollback_marker") == "legacy"
    assert a_row.status == "ready"
    assert a_row.error_code == "legacy_a_error"
    assert a_row.error_message == "a should be restored"
    assert a_row.metadata_json.get("rollback_guard") == {"name": a_row.agent_id}
    assert "cloud_daemon_launch_token" not in (
        a_row.metadata_json.get("provisioning") or {}
    )
    assert b_row.status == "paused"
    assert b_row.error_code == "legacy_b_error"
    assert b_row.error_message == "b should be restored"
    assert b_row.metadata_json.get("rollback_guard") == {"name": b_row.agent_id}
    assert "cloud_daemon_launch_token" not in (
        b_row.metadata_json.get("provisioning") or {}
    )

    await _assert_cloud_daemon_ws_accepts_only_launch_token(
        db_session,
        monkeypatch,
        cloud_daemon=cloud_row,
        accepted_launch_token=old_launch_token,
        rejected_launch_token=new_launch_token,
    )


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
async def test_manual_pause_invalidates_control_connection(db_session, monkeypatch):
    user_id = uuid.uuid4()
    svc, _fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    disconnect = AsyncMock(return_value=True)
    monkeypatch.setattr(
        cloud_agent_service,
        "disconnect_cloud_daemon_control",
        disconnect,
    )

    paused = await svc.pause_cloud_agent(
        db_session,
        user_id=user_id,
        agent_id=view.agent_id,
    )

    assert paused.status == "paused"
    disconnect.assert_awaited_once_with(
        view.cloud_daemon_instance_id,
        reason="cloud daemon manually paused",
    )


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
async def test_idle_pause_does_not_persist_or_report_failed_provider_pause(db_session):
    class FailedPauseProvider(FakeCloudDaemonProvider):
        async def pause(self, **kwargs):
            handle = await super().pause(**kwargs)
            handle.status = "failed"
            handle.error_code = "e2b_pause_failed"
            handle.error_message = "Response 409"
            return handle

    user_id = uuid.uuid4()
    svc, _fake = _make_service(provider=FailedPauseProvider())
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )

    paused_count = await svc.pause_idle_cloud_daemons(
        db_session,
        idle_seconds=300,
        now=datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc),
    )

    cai = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == view.agent_id)
    )
    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    assert paused_count == 0
    assert cai.status == "ready"
    assert cdi.status == "ready"
    assert cdi.last_paused_at is None
    assert "last_pause_reason" not in (cdi.metadata_json or {})


@pytest.mark.asyncio
async def test_idle_pause_continues_after_first_provider_pause_fails(
    db_session, caplog
):
    class FirstPauseFailsProvider(FakeCloudDaemonProvider):
        def __init__(self):
            super().__init__()
            self.pause_attempts: list[str] = []

        async def pause(self, **kwargs):
            handle = await super().pause(**kwargs)
            self.pause_attempts.append(kwargs["cloud_daemon_instance_id"])
            if len(self.pause_attempts) == 1:
                handle.status = "failed"
                handle.error_code = "e2b_pause_failed"
                handle.error_message = "Response 409"
            return handle

    first_user_id = uuid.uuid4()
    second_user_id = uuid.uuid4()
    provider = FirstPauseFailsProvider()
    svc, _fake = _make_service(provider=provider)
    first = await svc.create_cloud_agent(
        db_session,
        user_id=first_user_id,
        body=CreateCloudAgentInput(name="First"),
    )
    second = await svc.create_cloud_agent(
        db_session,
        user_id=second_user_id,
        body=CreateCloudAgentInput(name="Second"),
    )

    with caplog.at_level(logging.INFO, logger=cloud_agent_service.__name__):
        paused_count = await svc.pause_idle_cloud_daemons(
            db_session,
            idle_seconds=300,
            now=datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc),
        )

    failed_cdi = await db_session.get(
        CloudDaemonInstance, provider.pause_attempts[0]
    )
    succeeded_cdi = await db_session.get(
        CloudDaemonInstance, provider.pause_attempts[1]
    )
    failed_cai = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.cloud_daemon_instance_id == failed_cdi.id
        )
    )
    succeeded_cai = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.cloud_daemon_instance_id == succeeded_cdi.id
        )
    )

    assert paused_count == 1
    assert len(provider.pause_attempts) == 2
    assert set(provider.pause_attempts) == {
        first.cloud_daemon_instance_id,
        second.cloud_daemon_instance_id,
    }
    assert failed_cdi.status == "ready"
    assert failed_cai.status == "ready"
    assert failed_cdi.last_paused_at is None
    assert succeeded_cdi.status == "paused"
    assert succeeded_cai.status == "paused"
    assert succeeded_cdi.last_paused_at is not None
    assert "idle pause failed" in caplog.text
    assert "idle-paused cloud daemon" in caplog.text


@pytest.mark.asyncio
async def test_idle_pause_invalidates_control_connection(db_session, monkeypatch):
    user_id = uuid.uuid4()
    svc, _fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    disconnect = AsyncMock(return_value=True)
    monkeypatch.setattr(
        cloud_agent_service,
        "disconnect_cloud_daemon_control",
        disconnect,
    )

    paused_count = await svc.pause_idle_cloud_daemons(
        db_session,
        idle_seconds=300,
        now=datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc),
    )

    assert paused_count == 1
    disconnect.assert_awaited_once_with(
        view.cloud_daemon_instance_id,
        reason="cloud daemon idle-paused",
    )


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


@pytest.mark.asyncio
@pytest.mark.parametrize("state", [MessageState.queued, MessageState.processing])
async def test_idle_pause_skips_unacked_owner_chat_message(db_session, state):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    db_session.add(
        MessageRecord(
            hub_msg_id=f"hub_msg_owner_chat_{state.value}",
            msg_id=f"msg_owner_chat_{state.value}",
            sender_id=view.agent_id,
            receiver_id=view.agent_id,
            state=state,
            envelope_json="{}",
            ttl_sec=300,
            source_type="dashboard_user_chat",
            source_session_kind="owner_chat",
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
@pytest.mark.parametrize("state", [MessageState.delivered, MessageState.acked])
async def test_idle_pause_skips_recent_claimed_owner_chat_turn(db_session, state):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    now = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)
    claimed_at = now - datetime.timedelta(seconds=600)
    db_session.add(
        MessageRecord(
            hub_msg_id=f"hub_msg_owner_chat_{state.value}",
            msg_id=f"msg_owner_chat_{state.value}",
            sender_id=view.agent_id,
            receiver_id=view.agent_id,
            state=state,
            envelope_json="{}",
            ttl_sec=300,
            source_type="dashboard_user_chat",
            source_session_kind="owner_chat",
            delivered_at=claimed_at,
            acked_at=claimed_at if state == MessageState.acked else None,
        )
    )
    await db_session.commit()

    paused_count = await svc.pause_idle_cloud_daemons(
        db_session,
        idle_seconds=300,
        now=now,
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
async def test_idle_pause_ignores_expired_owner_chat_turn_lease(db_session):
    user_id = uuid.uuid4()
    svc, fake = _make_service()
    view = await svc.create_cloud_agent(
        db_session, user_id=user_id, body=CreateCloudAgentInput(name="A")
    )
    now = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)
    db_session.add(
        MessageRecord(
            hub_msg_id="hub_msg_owner_chat_expired",
            msg_id="msg_owner_chat_expired",
            sender_id=view.agent_id,
            receiver_id=view.agent_id,
            state=MessageState.delivered,
            envelope_json="{}",
            ttl_sec=300,
            source_type="dashboard_user_chat",
            source_session_kind="owner_chat",
            delivered_at=now - datetime.timedelta(hours=2),
        )
    )
    await db_session.commit()

    paused_count = await svc.pause_idle_cloud_daemons(
        db_session,
        idle_seconds=300,
        now=now,
    )

    cdi = await db_session.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == view.cloud_daemon_instance_id
        )
    )
    assert paused_count == 1
    assert cdi.status == "paused"
    assert fake.calls(view.cloud_daemon_instance_id)["pause"] == 1


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
