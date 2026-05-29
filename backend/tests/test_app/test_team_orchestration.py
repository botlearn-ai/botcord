"""Tests for /api/team-orchestration."""

from __future__ import annotations

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth import MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION
from hub.auth import create_agent_token
from hub.enums import ParticipantType
from hub.models import (
    Agent,
    AgentManagementGrant,
    Base,
    CloudAgentInstance,
    CloudDaemonInstance,
    MessageRecord,
    Role,
    Room,
    RoomMember,
    Topic,
    User,
    UserRole,
)
from hub.services.cloud_agent import CloudAgentError, CloudAgentService
from hub.services.cloud_daemon_provider import FakeCloudDaemonProvider
from tests.test_app.conftest import create_test_engine

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-team-orchestration"


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
        display_name="Team Owner",
        email="team@example.com",
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
    agent_id = "ag_teammanager"
    token, expires_at = create_agent_token(agent_id)
    db_session.add(
        Agent(
            agent_id=agent_id,
            display_name="Team Manager",
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
async def client_factory(db_session: AsyncSession, monkeypatch):
    import app.auth
    import app.routers.cloud_agents as cloud_agents_router
    import hub.config

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.database import get_db
    from hub.main import app

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db

    clients: list[AsyncClient] = []

    async def _make(
        *,
        feature_enabled: bool = True,
        force_create_failure: bool = False,
    ) -> AsyncClient:
        service = CloudAgentService(
            provider=FakeCloudDaemonProvider(force_create_failure=force_create_failure),
            feature_enabled=feature_enabled,
            max_per_user=5,
            max_agents_per_daemon=3,
        )
        app.dependency_overrides[cloud_agents_router.get_cloud_agent_service] = (
            lambda: service
        )
        client = AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        )
        await client.__aenter__()
        clients.append(client)
        return client

    try:
        yield _make
    finally:
        for client in clients:
            await client.__aexit__(None, None, None)
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_plan_requires_auth(client_factory):
    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/plan",
        json={"goal": "Ship the billing dashboard"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_provision_with_agent_token_requires_management_grant(
    client_factory,
    seed_manager_agent,
):
    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={"goal": "Build an agent-token team", "role_count": 1},
        headers={"Authorization": f"Bearer {seed_manager_agent['token']}"},
    )
    assert response.status_code == 403
    body = response.json()
    assert body["detail"]["code"] == "management_permission_required"
    assert body["detail"]["required_scopes"] == [
        MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION
    ]


@pytest.mark.asyncio
async def test_provision_accepts_agent_token_with_management_grant(
    client_factory,
    seed_user,
    seed_manager_agent,
    db_session: AsyncSession,
):
    db_session.add(
        AgentManagementGrant(
            user_id=seed_user["user_id"],
            agent_id=seed_manager_agent["agent_id"],
            scope=MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION,
            expires_at=datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(days=1),
        )
    )
    await db_session.commit()
    client = await client_factory()

    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Build an agent-token team",
            "role_count": 1,
            "start_runs": False,
        },
        headers={"Authorization": f"Bearer {seed_manager_agent['token']}"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["room"]["owner_type"] == "human"
    assert len(body["roles"]) == 1
    assert body["roles"][0]["cloud_agent"]["hosting_kind"] == "cloud"


@pytest.mark.asyncio
async def test_provision_enforces_agent_management_role_count_limit(
    client_factory,
    seed_user,
    seed_manager_agent,
    db_session: AsyncSession,
):
    grant = AgentManagementGrant(
        user_id=seed_user["user_id"],
        agent_id=seed_manager_agent["agent_id"],
        scope=MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION,
        limits_json={"max_role_count": 1},
        expires_at=datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(days=1),
    )
    db_session.add(grant)
    await db_session.commit()
    client = await client_factory()

    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Build an oversized team",
            "role_count": 2,
            "start_runs": False,
        },
        headers={"Authorization": f"Bearer {seed_manager_agent['token']}"},
    )
    assert response.status_code == 403
    body = response.json()
    assert body["detail"]["code"] == "management_limit_exceeded"
    assert body["detail"]["limit"] == "max_role_count"
    await db_session.refresh(grant)
    assert grant.use_count == 0


@pytest.mark.asyncio
async def test_provision_checks_role_limit_against_normalized_plan(
    client_factory,
    seed_user,
    seed_manager_agent,
    db_session: AsyncSession,
):
    grant = AgentManagementGrant(
        user_id=seed_user["user_id"],
        agent_id=seed_manager_agent["agent_id"],
        scope=MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION,
        limits_json={"max_role_count": 1},
        expires_at=datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(days=1),
    )
    db_session.add(grant)
    await db_session.commit()
    client = await client_factory()

    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Build a bounded team",
            "role_count": 1,
            "roles": [
                {"key": "one", "name": "One", "brief": "First role."},
                {"key": "two", "name": "Two", "brief": "Second role."},
            ],
            "start_runs": False,
        },
        headers={"Authorization": f"Bearer {seed_manager_agent['token']}"},
    )
    assert response.status_code == 201, response.text
    assert len(response.json()["roles"]) == 1
    await db_session.refresh(grant)
    assert grant.use_count == 1


@pytest.mark.asyncio
async def test_team_management_grant_use_is_refunded_when_provision_fails(
    client_factory,
    seed_user,
    seed_manager_agent,
    db_session: AsyncSession,
):
    grant = AgentManagementGrant(
        user_id=seed_user["user_id"],
        agent_id=seed_manager_agent["agent_id"],
        scope=MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION,
        limits_json={"max_uses": 1},
        expires_at=datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(days=1),
    )
    db_session.add(grant)
    await db_session.commit()
    client = await client_factory(force_create_failure=True)

    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Fail after reserving permission",
            "role_count": 1,
            "start_runs": False,
        },
        headers={"Authorization": f"Bearer {seed_manager_agent['token']}"},
    )
    assert response.status_code == 502, response.text
    assert response.json()["detail"]["code"] == "fake_create_failed"
    await db_session.refresh(grant)
    assert grant.use_count == 0


@pytest.mark.asyncio
async def test_provision_enforces_agent_management_start_runs_limit(
    client_factory,
    seed_user,
    seed_manager_agent,
    db_session: AsyncSession,
):
    db_session.add(
        AgentManagementGrant(
            user_id=seed_user["user_id"],
            agent_id=seed_manager_agent["agent_id"],
            scope=MANAGEMENT_SCOPE_TEAM_ORCHESTRATION_PROVISION,
            limits_json={"allow_start_runs": False},
            expires_at=datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(days=1),
        )
    )
    await db_session.commit()
    client = await client_factory()

    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Build a team without starting runs",
            "role_count": 1,
            "start_runs": True,
        },
        headers={"Authorization": f"Bearer {seed_manager_agent['token']}"},
    )
    assert response.status_code == 403
    body = response.json()
    assert body["detail"]["code"] == "management_limit_exceeded"
    assert body["detail"]["limit"] == "allow_start_runs"


@pytest.mark.asyncio
async def test_plan_returns_default_roles(client_factory, seed_user):
    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/plan",
        json={"goal": "Ship the billing dashboard", "role_count": 2},
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["goal"] == "Ship the billing dashboard"
    assert [role["key"] for role in body["roles"]] == ["planner", "builder"]
    assert "Ship the billing dashboard" in body["kickoff_prompt"]


@pytest.mark.asyncio
async def test_provision_creates_agents_room_topic_and_kickoff_runs(
    client_factory,
    seed_user,
    db_session: AsyncSession,
):
    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Build a team orchestration MVP",
            "role_count": 2,
            "room_name": "Orchestration MVP",
            "budget": {"max_wall_time_seconds": 300, "max_tool_calls": 12},
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["room"]["name"] == "Orchestration MVP"
    assert body["room"]["owner_type"] == "human"
    assert body["room"]["member_count"] == 3
    assert body["topic"]["title"] == "Team kickoff"
    assert len(body["roles"]) == 2
    assert all(item["cloud_agent"]["status"] == "ready" for item in body["roles"])
    assert all(item["run_status"] == "queued" for item in body["roles"])
    assert all(item["budget"]["max_wall_time_seconds"] == 300 for item in body["roles"])

    room_id = body["room"]["room_id"]
    room = await db_session.scalar(select(Room).where(Room.room_id == room_id))
    assert room is not None
    assert room.owner_id.startswith("hu_")

    member_count = await db_session.scalar(
        select(func.count(RoomMember.id)).where(RoomMember.room_id == room_id)
    )
    assert member_count == 3
    agent_members = (
        await db_session.execute(
            select(RoomMember.agent_id).where(
                RoomMember.room_id == room_id,
                RoomMember.participant_type == ParticipantType.agent,
            )
        )
    ).scalars().all()
    assert set(agent_members) == {
        item["cloud_agent"]["agent_id"] for item in body["roles"]
    }

    topic = await db_session.scalar(select(Topic).where(Topic.room_id == room_id))
    assert topic is not None
    assert topic.goal == "Build a team orchestration MVP"

    run_count = await db_session.scalar(
        select(func.count(MessageRecord.id)).where(
            MessageRecord.room_id == room_id,
            MessageRecord.source_type == "cloud_agent_run",
        )
    )
    assert run_count == 2


@pytest.mark.asyncio
async def test_provision_can_skip_kickoff_runs(
    client_factory,
    seed_user,
    db_session: AsyncSession,
):
    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Prepare launch checklist",
            "role_count": 1,
            "start_runs": False,
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["roles"][0]["run_id"] is None
    room_id = body["room"]["room_id"]

    run_count = await db_session.scalar(
        select(func.count(MessageRecord.id)).where(
            MessageRecord.room_id == room_id,
            MessageRecord.source_type == "cloud_agent_run",
        )
    )
    assert run_count == 0


@pytest.mark.asyncio
async def test_provision_cleans_up_agents_room_and_topic_when_team_create_fails(
    client_factory,
    seed_user,
    db_session: AsyncSession,
    monkeypatch,
):
    original_create = CloudAgentService.create_cloud_agent
    calls = 0

    async def create_then_fail(self, *args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise CloudAgentError(
                "provider_create_failed",
                "simulated second agent failure",
                http_status=502,
            )
        return await original_create(self, *args, **kwargs)

    monkeypatch.setattr(CloudAgentService, "create_cloud_agent", create_then_fail)

    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Fail midway through team provisioning",
            "role_count": 2,
            "room_name": "Failed Team",
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )

    assert response.status_code == 502, response.text
    assert response.json()["detail"]["code"] == "provider_create_failed"

    active_cloud_agents = await db_session.scalar(
        select(func.count(CloudAgentInstance.id)).where(
            CloudAgentInstance.status != "deleted"
        )
    )
    active_agents = await db_session.scalar(
        select(func.count(Agent.agent_id)).where(Agent.status != "deleted")
    )
    active_cloud_daemons = await db_session.scalar(
        select(func.count(CloudDaemonInstance.id)).where(
            CloudDaemonInstance.status != "deleted"
        )
    )
    room_count = await db_session.scalar(select(func.count(Room.id)))
    member_count = await db_session.scalar(select(func.count(RoomMember.id)))
    topic_count = await db_session.scalar(select(func.count(Topic.id)))
    run_count = await db_session.scalar(select(func.count(MessageRecord.id)))

    assert active_cloud_agents == 0
    assert active_agents == 0
    assert active_cloud_daemons == 0
    assert room_count == 0
    assert member_count == 0
    assert topic_count == 0
    assert run_count == 0


async def _assert_no_active_team_artifacts(db_session: AsyncSession) -> None:
    active_cloud_agents = await db_session.scalar(
        select(func.count(CloudAgentInstance.id)).where(
            CloudAgentInstance.status != "deleted"
        )
    )
    active_agents = await db_session.scalar(
        select(func.count(Agent.agent_id)).where(Agent.status != "deleted")
    )
    active_cloud_daemons = await db_session.scalar(
        select(func.count(CloudDaemonInstance.id)).where(
            CloudDaemonInstance.status != "deleted"
        )
    )
    room_count = await db_session.scalar(select(func.count(Room.id)))
    member_count = await db_session.scalar(select(func.count(RoomMember.id)))
    topic_count = await db_session.scalar(select(func.count(Topic.id)))
    run_count = await db_session.scalar(select(func.count(MessageRecord.id)))

    assert active_cloud_agents == 0
    assert active_agents == 0
    assert active_cloud_daemons == 0
    assert room_count == 0
    assert member_count == 0
    assert topic_count == 0
    assert run_count == 0


@pytest.mark.asyncio
async def test_provision_cleans_up_when_role_skill_install_fails(
    client_factory,
    seed_user,
    db_session: AsyncSession,
    monkeypatch,
):
    import app.routers.team_orchestration as team_mod

    async def fail_install_agent_runtime_skill_for_agent(*args, **kwargs):
        del args, kwargs
        raise HTTPException(
            status_code=502,
            detail={
                "code": "daemon_runtime_skill_install_failed",
                "daemon_code": "skill_install_failed",
            },
        )

    monkeypatch.setattr(
        team_mod,
        "install_agent_runtime_skill_for_agent",
        fail_install_agent_runtime_skill_for_agent,
    )

    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Fail during skill installation",
            "roles": [
                {
                    "key": "builder",
                    "name": "Builder",
                    "brief": "Builds the thing.",
                    "skills": [
                        {
                            "manifest": {
                                "name": "build-kit",
                                "skillMd": "---\nname: build-kit\n---\nBuild.",
                            }
                        }
                    ],
                }
            ],
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )

    assert response.status_code == 502, response.text
    await _assert_no_active_team_artifacts(db_session)


@pytest.mark.asyncio
async def test_provision_cleans_up_marked_cloud_agent_when_create_persists_then_raises(
    client_factory,
    seed_user,
    db_session: AsyncSession,
):
    client = await client_factory(force_create_failure=True)
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Fail after cloud agent rows were persisted",
            "role_count": 1,
            "room_name": "Persisted Failure Team",
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )

    assert response.status_code == 502, response.text
    assert response.json()["detail"]["code"] == "fake_create_failed"
    await _assert_no_active_team_artifacts(db_session)


@pytest.mark.asyncio
async def test_provision_cleans_up_room_topic_and_runs_when_topic_create_fails(
    client_factory,
    seed_user,
    db_session: AsyncSession,
    monkeypatch,
):
    import hub.services.team_orchestration as service_mod

    original_create_team_topic = service_mod._create_team_topic

    async def create_topic_then_fail(*args, **kwargs):
        await original_create_team_topic(*args, **kwargs)
        raise RuntimeError("simulated topic follow-up failure")

    monkeypatch.setattr(service_mod, "_create_team_topic", create_topic_then_fail)

    client = await client_factory()
    with pytest.raises(RuntimeError, match="simulated topic follow-up failure"):
        await client.post(
            "/api/team-orchestration/provision",
            json={
                "goal": "Fail after topic creation",
                "role_count": 1,
                "room_name": "Leaked Team",
            },
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
    await _assert_no_active_team_artifacts(db_session)


@pytest.mark.asyncio
async def test_provision_keeps_team_and_reports_run_error_when_best_effort_kickoff_fails(
    client_factory,
    seed_user,
    db_session: AsyncSession,
    monkeypatch,
):
    async def create_run_failure(self, *args, **kwargs):
        del self, args, kwargs
        raise CloudAgentError(
            "kickoff_not_ready",
            "simulated kickoff run failure",
            http_status=409,
        )

    monkeypatch.setattr(CloudAgentService, "create_run", create_run_failure)

    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Create the team even if kickoff cannot start",
            "role_count": 1,
            "room_name": "Best Effort Kickoff",
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["roles"][0]["run_id"] is None
    assert body["roles"][0]["run_status"] is None
    assert body["roles"][0]["run_error"] == "kickoff_not_ready"

    room_id = body["room"]["room_id"]
    assert await db_session.scalar(select(func.count(Room.id))) == 1
    assert await db_session.scalar(select(func.count(Topic.id))) == 1
    assert await db_session.scalar(
        select(func.count(CloudAgentInstance.id)).where(
            CloudAgentInstance.status == "ready"
        )
    ) == 1
    assert await db_session.scalar(
        select(func.count(MessageRecord.id)).where(
            MessageRecord.room_id == room_id,
            MessageRecord.source_type == "cloud_agent_run",
        )
    ) == 0


@pytest.mark.asyncio
async def test_runtime_skills_install_dispatches_daemon_and_persists_snapshot(
    client_factory,
    seed_user,
    db_session: AsyncSession,
    monkeypatch,
):
    import app.routers.runtime_skills as runtime_skills_mod

    agent = Agent(
        agent_id="ag_skill_target",
        display_name="Skill Target",
        user_id=seed_user["user_id"],
        status="active",
        hosting_kind="daemon",
        daemon_instance_id="dm_skill_target",
        runtime="codex",
    )
    db_session.add(agent)
    await db_session.commit()

    monkeypatch.setattr(runtime_skills_mod, "is_daemon_online", lambda _id: True)
    calls = []
    probed_at = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append(
            {
                "daemon_instance_id": daemon_instance_id,
                "type": type_,
                "params": params,
                "timeout_ms": timeout_ms,
            }
        )
        return {
            "ok": True,
            "result": {
                "agentId": "ag_skill_target",
                "installed": [{"name": "review-kit", "targets": ["codex"], "paths": []}],
                "snapshot": {
                    "agentId": "ag_skill_target",
                    "skills": [
                        {
                            "name": "review-kit",
                            "source": "runtime-global",
                            "description": "Review support",
                            "mtimeMs": probed_at,
                        }
                    ],
                    "probedAt": probed_at,
                },
            },
        }

    monkeypatch.setattr(runtime_skills_mod, "send_control_frame", fake_send)

    client = await client_factory()
    response = await client.post(
        "/api/agents/ag_skill_target/runtime-skills/install",
        json={
            "manifest": {
                "name": "review-kit",
                "skillMd": "---\nname: review-kit\n---\nUse review checks.",
            }
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["skills"][0]["name"] == "review-kit"
    assert calls == [
        {
            "daemon_instance_id": "dm_skill_target",
            "type": "install_agent_skill",
            "params": {
                "agentId": "ag_skill_target",
                "manifest": {
                    "name": "review-kit",
                    "skillMd": "---\nname: review-kit\n---\nUse review checks.",
                },
            },
            "timeout_ms": 30000,
        }
    ]

    refreshed = await db_session.scalar(
        select(Agent).where(Agent.agent_id == "ag_skill_target")
    )
    assert refreshed is not None
    assert refreshed.skills_json[0]["name"] == "review-kit"
    assert refreshed.skills_probed_at is not None


@pytest.mark.asyncio
async def test_runtime_skills_install_rejects_invalid_target_runtime_at_api_boundary(
    client_factory,
    seed_user,
):
    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Reject invalid skill target",
            "roles": [
                {
                    "key": "bad-target",
                    "name": "Bad Target",
                    "brief": "Uses an invalid target.",
                    "skills": [
                        {
                            "manifest": {
                                "name": "bad-target-skill",
                                "targetRuntimes": ["not-a-runtime"],
                            }
                        }
                    ],
                }
            ],
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_runtime_skills_install_rejects_untrusted_vercel_package_at_api_boundary(
    client_factory,
    seed_user,
):
    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Reject untrusted package",
            "roles": [
                {
                    "key": "bad-package",
                    "name": "Bad Package",
                    "brief": "Uses an untrusted skill package.",
                    "skills": [
                        {
                            "vercel": {
                                "packageSpec": "attacker/skills",
                                "skills": ["anything"],
                            }
                        }
                    ],
                }
            ],
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_provision_installs_role_skills_before_starting_runs(
    client_factory,
    seed_user,
    monkeypatch,
):
    import app.routers.team_orchestration as team_mod

    events = []

    async def fake_install_agent_runtime_skill_for_agent(*, agent_id, body, ctx, db):
        del ctx, db
        events.append(("install", agent_id, body.manifest.name))

    monkeypatch.setattr(
        team_mod,
        "install_agent_runtime_skill_for_agent",
        fake_install_agent_runtime_skill_for_agent,
    )

    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Coordinate release readiness",
            "roles": [
                {
                    "key": "reviewer",
                    "name": "Release Reviewer",
                    "brief": "Checks release criteria.",
                    "skills": [
                        {
                            "manifest": {
                                "name": "release-checks",
                                "skillMd": "---\nname: release-checks\n---\nCheck the release.",
                            }
                        }
                    ],
                }
            ],
            "start_runs": True,
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    agent_id = body["roles"][0]["cloud_agent"]["agent_id"]
    assert events == [("install", agent_id, "release-checks")]
    assert body["roles"][0]["run_status"] == "queued"
    assert body["roles"][0]["role"]["skills"][0]["manifest"]["name"] == "release-checks"


@pytest.mark.asyncio
async def test_provision_retries_role_skill_install_until_cloud_agent_is_loaded(
    client_factory,
    seed_user,
    monkeypatch,
):
    import app.routers.runtime_skills as runtime_skills_mod

    monkeypatch.setattr(runtime_skills_mod, "is_cloud_daemon_online", lambda _id: True)

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(runtime_skills_mod.asyncio, "sleep", no_sleep)

    calls = 0
    probed_at = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)

    async def fake_send_cloud_control_frame(
        cloud_daemon_instance_id,
        type_,
        params=None,
        timeout_ms=None,
    ):
        nonlocal calls
        del cloud_daemon_instance_id, timeout_ms
        calls += 1
        assert type_ == "install_agent_skill"
        if calls == 1:
            return {
                "ok": False,
                "error": {
                    "code": "agent_not_loaded",
                    "message": "agent is still loading",
                },
            }
        return {
            "ok": True,
            "result": {
                "agentId": params["agentId"],
                "installed": [{"name": "release-checks", "targets": ["codex"], "paths": []}],
                "snapshot": {
                    "agentId": params["agentId"],
                    "skills": [
                        {
                            "name": "release-checks",
                            "source": "runtime-global",
                            "description": "Release support",
                            "mtimeMs": probed_at,
                        }
                    ],
                    "probedAt": probed_at,
                },
            },
        }

    monkeypatch.setattr(
        runtime_skills_mod,
        "send_cloud_control_frame",
        fake_send_cloud_control_frame,
    )

    client = await client_factory()
    response = await client.post(
        "/api/team-orchestration/provision",
        json={
            "goal": "Coordinate release readiness",
            "roles": [
                {
                    "key": "reviewer",
                    "name": "Release Reviewer",
                    "brief": "Checks release criteria.",
                    "runtime": "codex",
                    "skills": [
                        {
                            "manifest": {
                                "name": "release-checks",
                                "skillMd": "---\nname: release-checks\n---\nCheck the release.",
                            }
                        }
                    ],
                }
            ],
            "start_runs": False,
        },
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )

    assert response.status_code == 201, response.text
    assert calls == 2
