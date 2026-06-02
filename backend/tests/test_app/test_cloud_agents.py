"""Tests for /api/cloud-agents — PR 3 API skeleton + fake provider."""

from __future__ import annotations

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth import (
    MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE,
    MANAGEMENT_SCOPE_DAEMON_AGENTS_PROVISION,
)
from hub.auth import create_agent_token
from hub.models import Agent, AgentManagementGrant, Base, CloudAgentInstance, Role, User, UserRole
from hub.services.cloud_agent import CloudAgentService, CreateCloudAgentInput
from hub.services.cloud_daemon_provider import FakeCloudDaemonProvider
from tests.test_app.conftest import create_test_engine

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-cloud-agents"


def _make_supabase_token(sub: str, secret: str = TEST_SUPABASE_SECRET) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, secret, algorithm="HS256")


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
async def seed_user(db_session: AsyncSession):
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        display_name="Test User",
        email="test@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
        max_agents=30,
    )
    db_session.add(user)
    role = Role(
        id=uuid.uuid4(),
        name="member",
        display_name="Member",
        is_system=True,
        priority=0,
    )
    db_session.add(role)
    await db_session.flush()
    db_session.add(UserRole(user_id=user_id, role_id=role.id))
    await db_session.commit()
    return {
        "user_id": user_id,
        "supabase_uid": str(supabase_uuid),
        "token": _make_supabase_token(str(supabase_uuid)),
    }


@pytest_asyncio.fixture
async def seed_manager_agent(db_session: AsyncSession, seed_user: dict):
    agent_id = "ag_manager0001"
    token, expires_at = create_agent_token(agent_id)
    db_session.add(
        Agent(
            agent_id=agent_id,
            display_name="Manager Agent",
            user_id=seed_user["user_id"],
            agent_token=token,
            token_expires_at=datetime.datetime.fromtimestamp(
                expires_at, tz=datetime.timezone.utc
            ),
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
            status="active",
        )
    )
    await db_session.commit()
    return {"agent_id": agent_id, "token": token}


@pytest_asyncio.fixture
async def other_user(db_session: AsyncSession):
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        display_name="Other User",
        email="other@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
        max_agents=30,
    )
    db_session.add(user)
    await db_session.commit()
    return {
        "user_id": user_id,
        "token": _make_supabase_token(str(supabase_uuid)),
    }


@pytest_asyncio.fixture
async def client_factory(db_session: AsyncSession, monkeypatch):
    """Return a callable that builds an AsyncClient with a configured service.

    Tests choose whether the Cloud Agent feature is enabled and what
    provider behavior to inject.
    """
    import hub.config
    import app.auth
    import app.routers.cloud_agents as cloud_agents_router

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db

    transports: list[ASGITransport] = []
    clients: list[AsyncClient] = []
    fake_providers: list[FakeCloudDaemonProvider] = []

    async def _make(
        *,
        feature_enabled: bool = True,
        max_per_user: int = 3,
        max_agents_per_daemon: int = 2,
        force_create_failure: bool = False,
    ) -> tuple[AsyncClient, FakeCloudDaemonProvider]:
        provider = FakeCloudDaemonProvider(force_create_failure=force_create_failure)
        service = CloudAgentService(
            provider=provider,
            feature_enabled=feature_enabled,
            max_per_user=max_per_user,
            max_agents_per_daemon=max_agents_per_daemon,
        )
        app.dependency_overrides[cloud_agents_router.get_cloud_agent_service] = (
            lambda: service
        )
        transport = ASGITransport(app=app)
        client = AsyncClient(transport=transport, base_url="http://test")
        await client.__aenter__()
        transports.append(transport)
        clients.append(client)
        fake_providers.append(provider)
        return client, provider

    try:
        yield _make
    finally:
        for c in clients:
            await c.__aexit__(None, None, None)
        app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Auth + feature flag
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_requires_auth(client_factory):
    client, _ = await client_factory()
    r = await client.post("/api/cloud-agents", json={"name": "Bot"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_api_token_recharge_route_is_not_exposed(client_factory, seed_user):
    client, _ = await client_factory()
    r = await client.post(
        "/api/cloud-agents/api-token/recharge",
        json={"amount_usd": 10000},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_with_agent_token_requires_management_grant(
    client_factory,
    seed_manager_agent,
):
    client, _ = await client_factory()
    r = await client.post(
        "/api/cloud-agents",
        json={"name": "Bot"},
        headers={"Authorization": f"Bearer {seed_manager_agent['token']}"},
    )
    assert r.status_code == 403
    body = r.json()
    assert body["detail"]["code"] == "management_permission_required"
    assert body["detail"]["required_scopes"] == [MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE]
    assert "/cli-permissions" in body["detail"]["authorize_url"]


@pytest.mark.asyncio
async def test_create_accepts_agent_token_with_management_grant(
    client_factory,
    seed_user,
    seed_manager_agent,
    db_session: AsyncSession,
):
    db_session.add(
        AgentManagementGrant(
            user_id=seed_user["user_id"],
            agent_id=seed_manager_agent["agent_id"],
            scope=MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE,
            expires_at=datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(days=1),
        )
    )
    await db_session.commit()
    client, _ = await client_factory()

    r = await client.post(
        "/api/cloud-agents",
        json={"name": "Agent-Created Bot", "runtime": "deepseek-tui"},
        headers={"Authorization": f"Bearer {seed_manager_agent['token']}"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "Agent-Created Bot"
    assert body["hosting_kind"] == "cloud"


@pytest.mark.asyncio
async def test_user_can_create_list_and_revoke_management_grant(
    client_factory,
    seed_user,
    seed_manager_agent,
):
    client, _ = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}

    r = await client.post(
        "/api/agent-management/grants",
        json={
            "agent_id": seed_manager_agent["agent_id"],
            "scopes": [MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE],
            "expires_in_days": 7,
        },
        headers=headers,
    )
    assert r.status_code == 201, r.text
    grant = r.json()["grants"][0]
    assert grant["agent_id"] == seed_manager_agent["agent_id"]
    assert grant["scope"] == MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE
    assert grant["revoked_at"] is None

    r = await client.get(
        f"/api/agent-management/grants?agent_id={seed_manager_agent['agent_id']}",
        headers=headers,
    )
    assert r.status_code == 200
    assert [item["id"] for item in r.json()["grants"]] == [grant["id"]]

    r = await client.delete(f"/api/agent-management/grants/{grant['id']}", headers=headers)
    assert r.status_code == 200
    assert r.json()["revoked_at"] is not None


@pytest.mark.asyncio
async def test_reapproving_management_grant_resets_use_count(
    client_factory,
    seed_user,
    seed_manager_agent,
    db_session: AsyncSession,
):
    client, _ = await client_factory()
    user_headers = {"Authorization": f"Bearer {seed_user['token']}"}
    agent_headers = {"Authorization": f"Bearer {seed_manager_agent['token']}"}
    grant_body = {
        "agent_id": seed_manager_agent["agent_id"],
        "scopes": [MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE],
        "expires_in_days": 7,
        "limits": {"max_uses": 1},
    }

    r = await client.post(
        "/api/agent-management/grants",
        json=grant_body,
        headers=user_headers,
    )
    assert r.status_code == 201, r.text
    grant_id = r.json()["grants"][0]["id"]

    r = await client.post(
        "/api/cloud-agents",
        json={"name": "First Bot"},
        headers=agent_headers,
    )
    assert r.status_code == 201, r.text

    grant = await db_session.get(AgentManagementGrant, uuid.UUID(grant_id))
    assert grant is not None
    assert grant.use_count == 1

    r = await client.post(
        "/api/cloud-agents",
        json={"name": "Blocked Bot"},
        headers=agent_headers,
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "management_permission_required"

    r = await client.post(
        "/api/agent-management/grants",
        json=grant_body,
        headers=user_headers,
    )
    assert r.status_code == 201, r.text
    assert r.json()["grants"][0]["use_count"] == 0
    await db_session.refresh(grant)
    assert grant.use_count == 0

    r = await client.post(
        "/api/cloud-agents",
        json={"name": "Second Bot"},
        headers=agent_headers,
    )
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_agent_management_grant_use_is_refunded_when_cloud_create_fails(
    client_factory,
    seed_user,
    seed_manager_agent,
    db_session: AsyncSession,
):
    grant = AgentManagementGrant(
        user_id=seed_user["user_id"],
        agent_id=seed_manager_agent["agent_id"],
        scope=MANAGEMENT_SCOPE_CLOUD_AGENTS_CREATE,
        limits_json={"max_uses": 1},
        expires_at=datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(days=1),
    )
    db_session.add(grant)
    await db_session.commit()
    client, _ = await client_factory(force_create_failure=True)

    r = await client.post(
        "/api/cloud-agents",
        json={"name": "Failing Bot"},
        headers={"Authorization": f"Bearer {seed_manager_agent['token']}"},
    )
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "fake_create_failed"
    await db_session.refresh(grant)
    assert grant.use_count == 0


@pytest.mark.asyncio
async def test_daemon_provision_grant_requires_daemon_scope(
    client_factory,
    seed_user,
    seed_manager_agent,
):
    client, _ = await client_factory()
    r = await client.post(
        "/api/agent-management/grants",
        json={
            "agent_id": seed_manager_agent["agent_id"],
            "scopes": [MANAGEMENT_SCOPE_DAEMON_AGENTS_PROVISION],
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "daemon_agents:provision requires daemon_instance_id"


@pytest.mark.asyncio
async def test_create_blocked_when_feature_disabled(client_factory, seed_user):
    client, _ = await client_factory(feature_enabled=False)
    r = await client.post(
        "/api/cloud-agents",
        json={"name": "Bot"},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert r.status_code == 403
    body = r.json()
    assert body["detail"]["code"] == "feature_disabled"


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_then_list_then_get(client_factory, seed_user):
    client, provider = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}

    r = await client.post(
        "/api/cloud-agents",
        json={"name": "Research Bot", "bio": "summarizes papers"},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["status"] == "ready"
    assert created["hosting_kind"] == "cloud"
    assert created["runtime"] == "deepseek-tui"
    assert created["model_profile"] == "deepseek-v4-flash"
    assert created["cloud_agent_instance_id"].startswith("cloud_ag_")
    assert created["cloud_daemon_instance_id"].startswith("cloud_dm_")
    assert created["provider"] == "fake"
    agent_id = created["agent_id"]

    r = await client.get("/api/cloud-agents", headers=headers)
    assert r.status_code == 200
    listed = r.json()["cloud_agents"]
    assert len(listed) == 1
    assert listed[0]["agent_id"] == agent_id

    r = await client.get(f"/api/cloud-agents/{agent_id}", headers=headers)
    assert r.status_code == 200
    assert r.json()["agent_id"] == agent_id


@pytest.mark.asyncio
async def test_create_accepts_runtime_model_options(
    client_factory, seed_user, db_session
):
    client, _ = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}

    r = await client.post(
        "/api/cloud-agents",
        json={
            "name": "Research Bot",
            "runtime": "codex",
            "runtime_model": "gpt-5.2",
            "reasoning_effort": "high",
        },
        headers=headers,
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["runtime"] == "codex"
    assert created["model_profile"] == "gpt-5.2"
    assert created["runtime_model"] == "gpt-5.2"
    assert created["reasoning_effort"] == "high"

    row = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == created["agent_id"]
        )
    )
    assert row is not None
    assert row.metadata_json["runtime_options"] == {
        "runtime_model": "gpt-5.2",
        "reasoning_effort": "high",
    }


@pytest.mark.asyncio
async def test_pause_resume_round_trip(client_factory, seed_user):
    client, _ = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    r = await client.post(
        "/api/cloud-agents",
        json={"name": "Bot"},
        headers=headers,
    )
    agent_id = r.json()["agent_id"]

    r = await client.post(
        f"/api/cloud-agents/{agent_id}/pause", headers=headers
    )
    assert r.status_code == 200
    assert r.json()["status"] == "paused"

    r = await client.post(
        f"/api/cloud-agents/{agent_id}/resume", headers=headers
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ready"
    assert body["cloud_daemon_status"] == "ready"


@pytest.mark.asyncio
async def test_inbox_notification_resumes_paused_cloud_agent(
    client_factory, seed_user, db_session, monkeypatch
):
    import hub.services.cloud_agent as cloud_agent_mod
    from hub.routers.hub import notify_inbox

    client, provider = await client_factory()
    monkeypatch.setattr(cloud_agent_mod, "get_provider", lambda _name: provider)
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    r = await client.post(
        "/api/cloud-agents",
        json={"name": "Bot"},
        headers=headers,
    )
    agent_id = r.json()["agent_id"]
    cloud_daemon_instance_id = r.json()["cloud_daemon_instance_id"]

    r = await client.post(
        f"/api/cloud-agents/{agent_id}/pause", headers=headers
    )
    assert r.status_code == 200
    assert r.json()["status"] == "paused"

    await notify_inbox(agent_id, db=db_session)

    row = await db_session.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == agent_id)
    )
    assert row is not None
    assert row.status == "ready"
    assert provider.calls(cloud_daemon_instance_id)["create"] == 2


@pytest.mark.asyncio
async def test_cloud_daemon_reconnect_reprovisions_missing_ready_agent(
    db_session, seed_user, monkeypatch
):
    import hub.services.cloud_agent as cloud_agent_mod

    provider = FakeCloudDaemonProvider()
    service = CloudAgentService(provider=provider, feature_enabled=True)
    created = await service.create_cloud_agent(
        db_session,
        user_id=seed_user["user_id"],
        body=CreateCloudAgentInput(name="Bot"),
    )

    calls: list[tuple[str, dict | None]] = []

    async def fake_send_cloud_control_frame(
        _cloud_daemon_instance_id: str,
        type_: str,
        params: dict | None = None,
        timeout_ms: int | None = None,
    ) -> dict:
        calls.append((type_, params))
        if type_ == "list_agents":
            return {"ok": True, "result": {"agents": []}}
        if type_ == "provision_agent":
            assert params is not None
            assert params["credentials"]["agentId"] == created.agent_id
            assert params["credentials"]["privateKey"]
            return {"ok": True, "result": {"agentId": created.agent_id}}
        raise AssertionError(f"unexpected frame {type_}")

    monkeypatch.setattr(
        cloud_agent_mod,
        "send_cloud_control_frame",
        fake_send_cloud_control_frame,
    )

    restored = await service.provision_pending_for_cloud_daemon(
        db_session,
        cloud_daemon_instance_id=created.cloud_daemon_instance_id,
    )

    assert [call[0] for call in calls] == ["list_agents", "provision_agent"]
    assert [view.agent_id for view in restored] == [created.agent_id]
    row = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == created.agent_id
        )
    )
    assert row is not None
    assert row.status == "ready"
    assert "provisioning" not in (row.metadata_json or {})


@pytest.mark.asyncio
async def test_cloud_daemon_reconnect_skips_agent_already_loaded(
    db_session, seed_user, monkeypatch
):
    import hub.services.cloud_agent as cloud_agent_mod

    provider = FakeCloudDaemonProvider()
    service = CloudAgentService(provider=provider, feature_enabled=True)
    created = await service.create_cloud_agent(
        db_session,
        user_id=seed_user["user_id"],
        body=CreateCloudAgentInput(name="Bot"),
    )

    calls: list[str] = []

    async def fake_send_cloud_control_frame(
        _cloud_daemon_instance_id: str,
        type_: str,
        params: dict | None = None,
        timeout_ms: int | None = None,
    ) -> dict:
        calls.append(type_)
        if type_ == "list_agents":
            return {"ok": True, "result": {"agents": [{"id": created.agent_id}]}}
        if type_ == "provision_agent":
            raise AssertionError("already-loaded agent must not be provisioned again")
        raise AssertionError(f"unexpected frame {type_}")

    monkeypatch.setattr(
        cloud_agent_mod,
        "send_cloud_control_frame",
        fake_send_cloud_control_frame,
    )

    restored = await service.provision_pending_for_cloud_daemon(
        db_session,
        cloud_daemon_instance_id=created.cloud_daemon_instance_id,
    )

    assert calls == ["list_agents"]
    assert [view.agent_id for view in restored] == [created.agent_id]


@pytest.mark.asyncio
async def test_resume_ready_online_agent_reprovisions_missing_daemon_channel(
    db_session, seed_user, monkeypatch
):
    import hub.services.cloud_agent as cloud_agent_mod

    provider = FakeCloudDaemonProvider()
    service = CloudAgentService(provider=provider, feature_enabled=True)
    created = await service.create_cloud_agent(
        db_session,
        user_id=seed_user["user_id"],
        body=CreateCloudAgentInput(name="Bot"),
    )

    monkeypatch.setattr(
        cloud_agent_mod,
        "is_cloud_daemon_online",
        lambda cloud_daemon_instance_id: (
            cloud_daemon_instance_id == created.cloud_daemon_instance_id
        ),
    )
    calls: list[tuple[str, dict | None]] = []

    async def fake_send_cloud_control_frame(
        _cloud_daemon_instance_id: str,
        type_: str,
        params: dict | None = None,
        timeout_ms: int | None = None,
    ) -> dict:
        calls.append((type_, params))
        if type_ == "list_agents":
            return {"ok": True, "result": {"agents": []}}
        if type_ == "provision_agent":
            assert params is not None
            assert params["credentials"]["agentId"] == created.agent_id
            assert params["credentials"]["privateKey"]
            return {"ok": True, "result": {"agentId": created.agent_id}}
        raise AssertionError(f"unexpected frame {type_}")

    monkeypatch.setattr(
        cloud_agent_mod,
        "send_cloud_control_frame",
        fake_send_cloud_control_frame,
    )

    resumed = await service.resume_cloud_agent(
        db_session,
        user_id=seed_user["user_id"],
        agent_id=created.agent_id,
    )

    assert [call[0] for call in calls] == ["list_agents", "provision_agent"]
    assert resumed.status == "ready"
    row = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == created.agent_id
        )
    )
    assert row is not None
    assert row.status == "ready"
    assert "provisioning" not in (row.metadata_json or {})


@pytest.mark.asyncio
async def test_resume_paused_online_agent_reprovisions_missing_daemon_channel(
    db_session, seed_user, monkeypatch
):
    import hub.services.cloud_agent as cloud_agent_mod

    provider = FakeCloudDaemonProvider()
    service = CloudAgentService(provider=provider, feature_enabled=True)
    created = await service.create_cloud_agent(
        db_session,
        user_id=seed_user["user_id"],
        body=CreateCloudAgentInput(name="Bot"),
    )

    row = await db_session.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == created.agent_id
        )
    )
    assert row is not None
    row.status = "paused"
    await db_session.commit()

    monkeypatch.setattr(
        cloud_agent_mod,
        "is_cloud_daemon_online",
        lambda cloud_daemon_instance_id: (
            cloud_daemon_instance_id == created.cloud_daemon_instance_id
        ),
    )
    calls: list[tuple[str, dict | None]] = []

    async def fake_send_cloud_control_frame(
        _cloud_daemon_instance_id: str,
        type_: str,
        params: dict | None = None,
        timeout_ms: int | None = None,
    ) -> dict:
        calls.append((type_, params))
        if type_ == "list_agents":
            return {"ok": True, "result": {"agents": []}}
        if type_ == "provision_agent":
            assert params is not None
            assert params["credentials"]["agentId"] == created.agent_id
            assert params["credentials"]["privateKey"]
            return {"ok": True, "result": {"agentId": created.agent_id}}
        raise AssertionError(f"unexpected frame {type_}")

    monkeypatch.setattr(
        cloud_agent_mod,
        "send_cloud_control_frame",
        fake_send_cloud_control_frame,
    )

    resumed = await service.resume_cloud_agent(
        db_session,
        user_id=seed_user["user_id"],
        agent_id=created.agent_id,
    )

    assert [call[0] for call in calls] == ["list_agents", "provision_agent"]
    assert resumed.status == "ready"
    assert provider.calls(created.cloud_daemon_instance_id)["create"] == 1


@pytest.mark.asyncio
async def test_delete_removes_from_list(client_factory, seed_user):
    client, provider = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}

    r = await client.post(
        "/api/cloud-agents", json={"name": "Bot"}, headers=headers
    )
    agent_id = r.json()["agent_id"]
    cloud_daemon_instance_id = r.json()["cloud_daemon_instance_id"]

    r = await client.delete(
        f"/api/cloud-agents/{agent_id}", headers=headers
    )
    assert r.status_code == 200
    assert r.json()["status"] == "deleted"

    r = await client.get("/api/cloud-agents", headers=headers)
    assert r.json()["cloud_agents"] == []
    # Fake provider observed cleanup of the orphaned sandbox.
    assert provider.calls(cloud_daemon_instance_id)["cleanup"] == 1


# ---------------------------------------------------------------------------
# Authorization edges
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cross_user_get_returns_404(client_factory, seed_user, other_user):
    client, _ = await client_factory()
    create = await client.post(
        "/api/cloud-agents",
        json={"name": "Bot"},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    agent_id = create.json()["agent_id"]

    r = await client.get(
        f"/api/cloud-agents/{agent_id}",
        headers={"Authorization": f"Bearer {other_user['token']}"},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"


@pytest.mark.asyncio
async def test_quota_returns_400(client_factory, seed_user):
    client, _ = await client_factory(max_per_user=1)
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    r = await client.post(
        "/api/cloud-agents", json={"name": "A"}, headers=headers
    )
    assert r.status_code == 201
    r = await client.post(
        "/api/cloud-agents", json={"name": "B"}, headers=headers
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "quota_exceeded"


@pytest.mark.asyncio
async def test_provider_failure_returns_502(client_factory, seed_user):
    client, _ = await client_factory(force_create_failure=True)
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    r = await client.post(
        "/api/cloud-agents", json={"name": "Bot"}, headers=headers
    )
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "fake_create_failed"


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_requires_auth(client_factory, seed_user):
    client, _ = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    create = await client.post(
        "/api/cloud-agents", json={"name": "Bot"}, headers=headers
    )
    agent_id = create.json()["agent_id"]

    r = await client.post(
        f"/api/cloud-agents/{agent_id}/runs", json={"prompt": "hi"}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_run_happy_path_returns_201_with_run_id(client_factory, seed_user):
    client, _ = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    create = await client.post(
        "/api/cloud-agents", json={"name": "Bot"}, headers=headers
    )
    agent_id = create.json()["agent_id"]

    r = await client.post(
        f"/api/cloud-agents/{agent_id}/runs",
        json={"prompt": "Summarise"},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["run_id"].startswith("crun_")
    assert body["agent_id"] == agent_id
    assert body["status"] == "queued"
    assert body["budget"]["max_wall_time_seconds"] == 600
    assert body["budget"]["max_tool_calls"] == 30
    assert body["room_id"].startswith("rm_oc_")


@pytest.mark.asyncio
async def test_run_with_custom_budget(client_factory, seed_user):
    client, _ = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    create = await client.post(
        "/api/cloud-agents", json={"name": "Bot"}, headers=headers
    )
    agent_id = create.json()["agent_id"]
    r = await client.post(
        f"/api/cloud-agents/{agent_id}/runs",
        json={
            "prompt": "long run",
            "budget": {"max_wall_time_seconds": 1200, "max_tool_calls": 50},
        },
        headers=headers,
    )
    assert r.status_code == 201
    assert r.json()["budget"]["max_wall_time_seconds"] == 1200
    assert r.json()["budget"]["max_tool_calls"] == 50


@pytest.mark.asyncio
async def test_run_does_not_reserve_botcord_usage(client_factory, seed_user):
    client, _ = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    create = await client.post(
        "/api/cloud-agents", json={"name": "Bot"}, headers=headers
    )
    agent_id = create.json()["agent_id"]
    run = await client.post(
        f"/api/cloud-agents/{agent_id}/runs",
        json={"prompt": "measure"},
        headers=headers,
    )
    assert run.status_code == 201

    usage = await client.get(f"/api/cloud-agents/{agent_id}/usage", headers=headers)
    assert usage.status_code == 200, usage.text
    body = usage.json()
    assert body["agent_id"] == agent_id
    assert body["included_credits"] >= body["reserved_credits"]
    assert body["reserved_credits"] == 0
    assert body["reserved_sandbox_seconds"] == 0
    assert body["events"] == []


@pytest.mark.asyncio
async def test_run_blocked_when_feature_disabled(client_factory, seed_user):
    client, _ = await client_factory(feature_enabled=False)
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    r = await client.post(
        "/api/cloud-agents/ag_doesnotexist/runs",
        json={"prompt": "hi"},
        headers=headers,
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "feature_disabled"


@pytest.mark.asyncio
async def test_run_cross_user_returns_404(client_factory, seed_user, other_user):
    client, _ = await client_factory()
    create = await client.post(
        "/api/cloud-agents",
        json={"name": "Bot"},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    agent_id = create.json()["agent_id"]
    r = await client.post(
        f"/api/cloud-agents/{agent_id}/runs",
        json={"prompt": "intrude"},
        headers={"Authorization": f"Bearer {other_user['token']}"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_run_rejects_oversized_wall_time(client_factory, seed_user):
    """Pydantic 422 — bound is at the DTO layer."""
    client, _ = await client_factory()
    headers = {"Authorization": f"Bearer {seed_user['token']}"}
    create = await client.post(
        "/api/cloud-agents", json={"name": "Bot"}, headers=headers
    )
    agent_id = create.json()["agent_id"]
    r = await client.post(
        f"/api/cloud-agents/{agent_id}/runs",
        json={
            "prompt": "x",
            "budget": {"max_wall_time_seconds": 9999999, "max_tool_calls": 1},
        },
        headers=headers,
    )
    assert r.status_code == 422
