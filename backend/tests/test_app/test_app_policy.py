"""Tests for /api/agents/{agent_id}/policy (BFF — global agent policy)."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from unittest.mock import AsyncMock

from hub.enums import (
    AttentionMode,
    ContactPolicy,
    MessagePolicy,
    ParticipantType,
    RoomInvitePolicy,
    RoomJoinPolicy,
    RoomVisibility,
)
from hub.models import (
    Agent,
    AgentRoomPolicyOverride,
    Base,
    CloudAgentInstance,
    CloudDaemonInstance,
    DaemonInstance,
    Role,
    Room,
    RoomMember,
    User,
    UserRole,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


@pytest_asyncio.fixture
async def db_engine():
    engine = create_async_engine(
        TEST_DB_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        execution_options={"schema_translate_map": {"public": None}},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as s:
        yield s


@pytest_asyncio.fixture
async def client(db_session, monkeypatch):
    import hub.config
    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(hub.config, "BETA_GATE_ENABLED", False)
    import app.auth
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def seed(db_session: AsyncSession):
    supabase_uuid = uuid.uuid4()
    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        display_name="U",
        email="u@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
    )
    role = Role(id=uuid.uuid4(), name="member", display_name="Member", is_system=True, priority=0)
    db_session.add_all([user, role])
    await db_session.flush()
    db_session.add(UserRole(id=uuid.uuid4(), user_id=user_id, role_id=role.id))

    now = datetime.datetime.now(datetime.timezone.utc)
    agent = Agent(
        agent_id="ag_owned",
        display_name="Mine",
        bio="b",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        claimed_at=now,
    )
    other_user = User(
        id=uuid.uuid4(),
        display_name="Other",
        email="o@example.com",
        status="active",
        supabase_user_id=uuid.uuid4(),
    )
    other_agent = Agent(
        agent_id="ag_other",
        display_name="Other",
        bio="b",
        message_policy=MessagePolicy.contacts_only,
        user_id=other_user.id,
        claimed_at=now,
    )
    db_session.add_all([agent, other_user, other_agent])
    await db_session.commit()
    return {"token": _token(str(supabase_uuid))}


@pytest.mark.asyncio
async def test_get_policy_defaults(client, seed):
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_owned/policy", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["contact_policy"] == "contacts_only"
    assert body["allow_agent_sender"] is True
    assert body["allow_human_sender"] is True
    assert body["room_invite_policy"] == "contacts_only"
    assert body["default_attention"] == "always"
    assert body["attention_keywords"] == []


@pytest.mark.asyncio
async def test_patch_policy_updates_fields_and_dual_writes_message_policy(
    client, seed, db_session
):
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.patch(
        "/api/agents/ag_owned/policy",
        headers=headers,
        json={
            "contact_policy": "open",
            "room_invite_policy": "closed",
            "default_attention": "keyword",
            "attention_keywords": ["alpha", "  ", "beta"],
            "allow_agent_sender": False,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["contact_policy"] == "open"
    assert body["room_invite_policy"] == "closed"
    assert body["default_attention"] == "keyword"
    assert body["attention_keywords"] == ["alpha", "beta"]
    assert body["allow_agent_sender"] is False

    # Legacy `message_policy` is dual-written to keep older readers consistent.
    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    assert agent.message_policy == MessagePolicy.open


@pytest.mark.asyncio
async def test_patch_policy_rejects_unknown_value(client, seed):
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.patch(
        "/api/agents/ag_owned/policy",
        headers=headers,
        json={"contact_policy": "bogus"},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_policy_404_for_other_users_agent(client, seed):
    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_other/policy", headers=headers)
    assert r.status_code == 404
    r = await client.patch(
        "/api/agents/ag_other/policy",
        headers=headers,
        json={"contact_policy": "open"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_runtime_files_for_owned_daemon_agent_dispatches_control_frame(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_files as runtime_files_mod

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.daemon_instance_id = "dm_files"
    await db_session.commit()

    monkeypatch.setattr(runtime_files_mod, "is_daemon_online", lambda _id: True)

    calls = []

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append({
            "daemon_instance_id": daemon_instance_id,
            "type": type_,
            "params": params,
            "timeout_ms": timeout_ms,
        })
        return {
            "ok": True,
            "result": {
                "agentId": "ag_owned",
                "runtime": "hermes-agent",
                "files": [
                    {
                        "id": "memory:working-memory.json",
                        "name": "memory/working-memory.json",
                        "scope": "memory",
                        "content": '{"sections":{}}\n',
                    }
                ],
            },
        }

    monkeypatch.setattr(runtime_files_mod, "send_control_frame", fake_send)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get(
        "/api/agents/ag_owned/runtime-files?file_id=memory%3Aworking-memory.json",
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["files"][0]["content"] == '{"sections":{}}\n'
    assert calls == [
        {
            "daemon_instance_id": "dm_files",
            "type": "list_agent_files",
            "params": {"agentId": "ag_owned", "fileId": "memory:working-memory.json"},
            "timeout_ms": 5000,
        }
    ]


@pytest.mark.asyncio
async def test_runtime_skills_get_returns_stored_snapshot(client, seed, db_session):
    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.daemon_instance_id = "dm_skills"
    agent.runtime = "codex"
    agent.skills_json = [
        {
            "name": "workspace-skill",
            "source": "workspace",
            "description": "Workspace skill",
            "mtimeMs": 1710000000000,
            "mtimeAt": "2024-03-09T16:00:00+00:00",
        }
    ]
    agent.skills_probed_at = datetime.datetime.now(datetime.timezone.utc)
    await db_session.commit()

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_owned/skills", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agent_id"] == "ag_owned"
    assert body["daemon_instance_id"] == "dm_skills"
    assert body["runtime"] == "codex"
    assert body["skills"][0]["source"] == "workspace"
    assert body["sniffed_at"] is not None


@pytest.mark.asyncio
async def test_runtime_skills_refresh_dispatches_persists_and_returns(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_skills as runtime_skills_mod

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.daemon_instance_id = "dm_skills"
    agent.runtime = "codex"
    await db_session.commit()

    monkeypatch.setattr(runtime_skills_mod, "is_daemon_online", lambda _id: True)

    calls = []
    probed_at = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append({
            "daemon_instance_id": daemon_instance_id,
            "type": type_,
            "params": params,
            "timeout_ms": timeout_ms,
        })
        return {
            "ok": True,
            "result": {
                "agentId": "ag_owned",
                "skills": [
                    {
                        "name": f"global-skill-{i}",
                        "source": "runtime-global",
                        "sourceDetail": "global-codex",
                        "runtime": "codex",
                        "path": f"/home/test/.codex/skills/global-skill-{i}/SKILL.md",
                        "description": "Global skill",
                        "mtimeMs": probed_at,
                    }
                    for i in range(129)
                ],
                "probedAt": probed_at,
            },
        }

    monkeypatch.setattr(runtime_skills_mod, "send_control_frame", fake_send)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post("/api/agents/ag_owned/skills/refresh", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["skills"]) == 129
    assert body["skills"][0]["name"] == "global-skill-0"
    assert body["skills"][-1]["name"] == "global-skill-128"
    assert body["skills"][0]["source"] == "runtime-global"
    assert body["skills"][0]["sourceDetail"] == "global-codex"
    assert body["skills"][0]["runtime"] == "codex"
    assert body["skills"][0]["path"].endswith("/global-skill-0/SKILL.md")
    assert body["sniffed_at"] is not None
    assert calls == [
        {
            "daemon_instance_id": "dm_skills",
            "type": "list_agent_skills",
            "params": {"agentId": "ag_owned"},
            "timeout_ms": 5000,
        }
    ]

    refreshed = await db_session.scalar(select(Agent).where(Agent.agent_id == "ag_owned"))
    assert refreshed is not None
    assert len(refreshed.skills_json) == 129
    assert refreshed.skills_json[0]["name"] == "global-skill-0"
    assert refreshed.skills_json[-1]["name"] == "global-skill-128"
    assert refreshed.skills_json[0]["sourceDetail"] == "global-codex"
    assert refreshed.skills_json[0]["runtime"] == "codex"
    assert refreshed.skills_json[0]["path"].endswith("/global-skill-0/SKILL.md")
    assert refreshed.skills_json[0]["mtimeAt"]
    assert refreshed.skills_probed_at is not None


@pytest.mark.asyncio
async def test_runtime_skills_refresh_retries_cloud_dispatch_loss_and_persists(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_skills as runtime_skills_mod

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.hosting_kind = "cloud"
    agent.daemon_instance_id = "dm_cloud_retry_skills"
    agent.runtime = "codex"
    daemon = DaemonInstance(
        id="dm_cloud_retry_skills",
        user_id=agent.user_id,
        kind="cloud",
        refresh_token_hash="hash",
    )
    cloud_daemon = CloudDaemonInstance(
        id="cloud_dm_retry_skills",
        user_id=agent.user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        status="ready",
        runtime="codex",
        max_agents=1,
        active_agent_count=1,
    )
    cloud_binding = CloudAgentInstance(
        id="cloud_ag_retry_skills",
        user_id=agent.user_id,
        agent_id=agent.agent_id,
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=daemon.id,
        runtime="codex",
        model_profile="default",
        status="ready",
    )
    db_session.add_all([daemon, cloud_daemon, cloud_binding])
    await db_session.commit()

    monkeypatch.setattr(runtime_skills_mod, "is_cloud_daemon_online", lambda _id: True)

    resume_calls = []

    class FakeCloudAgentService:
        async def resume_cloud_agent(self, db, *, user_id, agent_id):
            resume_calls.append({"user_id": user_id, "agent_id": agent_id})
            return None

    monkeypatch.setattr(runtime_skills_mod, "CloudAgentService", FakeCloudAgentService)

    dispatch_calls = []
    probed_at = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)

    async def fake_send_cloud(cloud_daemon_instance_id, type_, params=None, timeout_ms=None):
        dispatch_calls.append({
            "cloud_daemon_instance_id": cloud_daemon_instance_id,
            "type": type_,
            "params": params,
            "timeout_ms": timeout_ms,
        })
        if len(dispatch_calls) == 1:
            raise runtime_skills_mod.CloudDaemonDispatchError(
                "cloud_daemon_disconnected",
                "connection closed",
            )
        return {
            "ok": True,
            "result": {
                "agentId": "ag_owned",
                "skills": [
                    {
                        "name": "cloud-skill",
                        "source": "runtime-global",
                        "description": "Cloud skill",
                        "mtimeMs": probed_at,
                    }
                ],
                "probedAt": probed_at,
            },
        }

    monkeypatch.setattr(runtime_skills_mod, "send_cloud_control_frame", fake_send_cloud)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post("/api/agents/ag_owned/skills/refresh", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["skills"][0]["name"] == "cloud-skill"
    assert resume_calls == [{"user_id": agent.user_id, "agent_id": "ag_owned"}]
    assert len(dispatch_calls) == 2

    refreshed = await db_session.scalar(select(Agent).where(Agent.agent_id == "ag_owned"))
    assert refreshed is not None
    assert refreshed.skills_json[0]["name"] == "cloud-skill"


@pytest.mark.asyncio
async def test_runtime_skills_install_does_not_retry_cloud_dispatch_loss(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_skills as runtime_skills_mod

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.hosting_kind = "cloud"
    agent.daemon_instance_id = "dm_cloud_install_skills"
    agent.runtime = "codex"
    daemon = DaemonInstance(
        id="dm_cloud_install_skills",
        user_id=agent.user_id,
        kind="cloud",
        refresh_token_hash="hash",
    )
    cloud_daemon = CloudDaemonInstance(
        id="cloud_dm_install_skills",
        user_id=agent.user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        status="ready",
        runtime="codex",
        max_agents=1,
        active_agent_count=1,
    )
    cloud_binding = CloudAgentInstance(
        id="cloud_ag_install_skills",
        user_id=agent.user_id,
        agent_id=agent.agent_id,
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=daemon.id,
        runtime="codex",
        model_profile="default",
        status="ready",
    )
    db_session.add_all([daemon, cloud_daemon, cloud_binding])
    await db_session.commit()

    monkeypatch.setattr(runtime_skills_mod, "is_cloud_daemon_online", lambda _id: True)

    resume_calls = []

    class FakeCloudAgentService:
        async def resume_cloud_agent(self, db, *, user_id, agent_id):
            resume_calls.append({"user_id": user_id, "agent_id": agent_id})
            return None

    monkeypatch.setattr(runtime_skills_mod, "CloudAgentService", FakeCloudAgentService)

    dispatch_calls = []

    async def fake_send_cloud(cloud_daemon_instance_id, type_, params=None, timeout_ms=None):
        dispatch_calls.append({
            "cloud_daemon_instance_id": cloud_daemon_instance_id,
            "type": type_,
            "params": params,
            "timeout_ms": timeout_ms,
        })
        raise runtime_skills_mod.CloudDaemonDispatchError(
            "cloud_daemon_disconnected",
            "connection closed after send",
        )

    monkeypatch.setattr(runtime_skills_mod, "send_cloud_control_frame", fake_send_cloud)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.post(
        "/api/agents/ag_owned/skills/install",
        headers=headers,
        json={
            "manifest": {
                "name": "cloud-install-skill",
                "skillMd": "# Cloud install skill\n",
                "targetRuntimes": ["codex"],
            }
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "daemon_offline"
    assert resume_calls == []
    assert dispatch_calls == [
        {
            "cloud_daemon_instance_id": "cloud_dm_install_skills",
            "type": "install_agent_skill",
            "params": {
                "agentId": "ag_owned",
                "manifest": {
                    "name": "cloud-install-skill",
                    "skillMd": "# Cloud install skill\n",
                    "targetRuntimes": ["codex"],
                },
            },
            "timeout_ms": 30000,
        }
    ]


@pytest.mark.asyncio
async def test_runtime_files_for_owned_cloud_agent_dispatches_cloud_control_frame(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_files as runtime_files_mod

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.hosting_kind = "cloud"
    agent.daemon_instance_id = "dm_cloudfiles"
    agent.runtime = "codex"
    daemon = DaemonInstance(
        id="dm_cloudfiles",
        user_id=agent.user_id,
        kind="cloud",
        refresh_token_hash="hash",
    )
    cloud_daemon = CloudDaemonInstance(
        id="cloud_dm_files",
        user_id=agent.user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        status="ready",
        runtime="codex",
        max_agents=1,
        active_agent_count=1,
    )
    cloud_binding = CloudAgentInstance(
        id="cloud_ag_files",
        user_id=agent.user_id,
        agent_id=agent.agent_id,
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=daemon.id,
        runtime="codex",
        model_profile="default",
        status="ready",
    )
    db_session.add_all([daemon, cloud_daemon, cloud_binding])
    await db_session.commit()

    monkeypatch.setattr(
        runtime_files_mod,
        "is_cloud_daemon_online",
        lambda cloud_daemon_id: cloud_daemon_id == "cloud_dm_files",
    )

    calls = []

    async def fake_send_cloud(cloud_daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append({
            "cloud_daemon_instance_id": cloud_daemon_instance_id,
            "type": type_,
            "params": params,
            "timeout_ms": timeout_ms,
        })
        return {
            "ok": True,
            "result": {
                "agentId": "ag_owned",
                "runtime": "codex",
                "files": [
                    {
                        "id": "workspace:AGENTS.md",
                        "name": "AGENTS.md",
                        "scope": "workspace",
                        "content": "# rules\n",
                    }
                ],
            },
        }

    monkeypatch.setattr(runtime_files_mod, "send_cloud_control_frame", fake_send_cloud)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_owned/runtime-files", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["files"][0]["content"] == "# rules\n"
    assert calls == [
        {
            "cloud_daemon_instance_id": "cloud_dm_files",
            "type": "list_agent_files",
            "params": {"agentId": "ag_owned"},
            "timeout_ms": 5000,
        }
    ]


@pytest.mark.asyncio
async def test_runtime_files_for_cloud_agent_resumes_sandbox_before_dispatch(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_files as runtime_files_mod

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.hosting_kind = "cloud"
    agent.daemon_instance_id = "dm_cloud_resume_files"
    agent.runtime = "codex"
    daemon = DaemonInstance(
        id="dm_cloud_resume_files",
        user_id=agent.user_id,
        kind="cloud",
        refresh_token_hash="hash",
    )
    cloud_daemon = CloudDaemonInstance(
        id="cloud_dm_resume_files",
        user_id=agent.user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        status="ready",
        runtime="codex",
        max_agents=1,
        active_agent_count=1,
    )
    cloud_binding = CloudAgentInstance(
        id="cloud_ag_resume_files",
        user_id=agent.user_id,
        agent_id=agent.agent_id,
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=daemon.id,
        runtime="codex",
        model_profile="default",
        status="ready",
    )
    db_session.add_all([daemon, cloud_daemon, cloud_binding])
    await db_session.commit()

    online = {"value": False}
    monkeypatch.setattr(
        runtime_files_mod,
        "is_cloud_daemon_online",
        lambda cloud_daemon_id: (
            cloud_daemon_id == "cloud_dm_resume_files" and online["value"]
        ),
    )

    resume_calls = []

    class FakeCloudAgentService:
        async def resume_cloud_agent(self, db, *, user_id, agent_id):
            resume_calls.append({"user_id": user_id, "agent_id": agent_id})
            online["value"] = True
            return None

    monkeypatch.setattr(runtime_files_mod, "CloudAgentService", FakeCloudAgentService)

    dispatch_calls = []

    async def fake_send_cloud(cloud_daemon_instance_id, type_, params=None, timeout_ms=None):
        dispatch_calls.append({
            "cloud_daemon_instance_id": cloud_daemon_instance_id,
            "type": type_,
            "params": params,
            "timeout_ms": timeout_ms,
        })
        return {
            "ok": True,
            "result": {
                "agentId": "ag_owned",
                "runtime": "codex",
                "files": [
                    {
                        "id": "memory:working-memory.json",
                        "name": "memory/working-memory.json",
                        "scope": "memory",
                        "content": '{"goal":"fresh"}\n',
                    }
                ],
            },
        }

    monkeypatch.setattr(runtime_files_mod, "send_cloud_control_frame", fake_send_cloud)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get(
        "/api/agents/ag_owned/runtime-files?file_id=memory%3Aworking-memory.json",
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["files"][0]["content"] == '{"goal":"fresh"}\n'
    assert resume_calls == [{"user_id": agent.user_id, "agent_id": "ag_owned"}]
    assert dispatch_calls == [
        {
            "cloud_daemon_instance_id": "cloud_dm_resume_files",
            "type": "list_agent_files",
            "params": {"agentId": "ag_owned", "fileId": "memory:working-memory.json"},
            "timeout_ms": 5000,
        }
    ]


@pytest.mark.asyncio
async def test_runtime_files_for_cloud_agent_retries_after_missing_credentials_ack(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_files as runtime_files_mod

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.hosting_kind = "cloud"
    agent.daemon_instance_id = "dm_cloud_retry_files"
    agent.runtime = "codex"
    daemon = DaemonInstance(
        id="dm_cloud_retry_files",
        user_id=agent.user_id,
        kind="cloud",
        refresh_token_hash="hash",
    )
    cloud_daemon = CloudDaemonInstance(
        id="cloud_dm_retry_files",
        user_id=agent.user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        status="ready",
        runtime="codex",
        max_agents=1,
        active_agent_count=1,
    )
    cloud_binding = CloudAgentInstance(
        id="cloud_ag_retry_files",
        user_id=agent.user_id,
        agent_id=agent.agent_id,
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=daemon.id,
        runtime="codex",
        model_profile="default",
        status="ready",
    )
    db_session.add_all([daemon, cloud_daemon, cloud_binding])
    await db_session.commit()

    monkeypatch.setattr(runtime_files_mod, "is_cloud_daemon_online", lambda _id: True)

    resume_calls = []

    class FakeCloudAgentService:
        async def resume_cloud_agent(self, db, *, user_id, agent_id):
            resume_calls.append({"user_id": user_id, "agent_id": agent_id})
            return None

    monkeypatch.setattr(runtime_files_mod, "CloudAgentService", FakeCloudAgentService)

    dispatch_calls = []

    async def fake_send_cloud(cloud_daemon_instance_id, type_, params=None, timeout_ms=None):
        dispatch_calls.append({
            "cloud_daemon_instance_id": cloud_daemon_instance_id,
            "type": type_,
            "params": params,
            "timeout_ms": timeout_ms,
        })
        if len(dispatch_calls) == 1:
            return {
                "ok": False,
                "error": {
                    "code": "agent_credentials_missing",
                    "message": "agent credentials are missing or unreadable",
                },
            }
        return {
            "ok": True,
            "result": {
                "agentId": "ag_owned",
                "runtime": "codex",
                "files": [
                    {
                        "id": "workspace:AGENTS.md",
                        "name": "workspace/AGENTS.md",
                        "scope": "workspace",
                        "content": "# rules\n",
                    }
                ],
            },
        }

    monkeypatch.setattr(runtime_files_mod, "send_cloud_control_frame", fake_send_cloud)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_owned/runtime-files", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["files"][0]["content"] == "# rules\n"
    assert resume_calls == [{"user_id": agent.user_id, "agent_id": "ag_owned"}]
    assert len(dispatch_calls) == 2


@pytest.mark.asyncio
async def test_runtime_files_for_cloud_agent_retries_after_initial_ack_timeout(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_files as runtime_files_mod

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.hosting_kind = "cloud"
    agent.daemon_instance_id = "dm_cloud_timeout_retry_files"
    agent.runtime = "codex"
    daemon = DaemonInstance(
        id="dm_cloud_timeout_retry_files",
        user_id=agent.user_id,
        kind="cloud",
        refresh_token_hash="hash",
    )
    cloud_daemon = CloudDaemonInstance(
        id="cloud_dm_timeout_retry_files",
        user_id=agent.user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        status="ready",
        runtime="codex",
        max_agents=1,
        active_agent_count=1,
    )
    cloud_binding = CloudAgentInstance(
        id="cloud_ag_timeout_retry_files",
        user_id=agent.user_id,
        agent_id=agent.agent_id,
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=daemon.id,
        runtime="codex",
        model_profile="default",
        status="ready",
    )
    db_session.add_all([daemon, cloud_daemon, cloud_binding])
    await db_session.commit()

    monkeypatch.setattr(runtime_files_mod, "is_cloud_daemon_online", lambda _id: True)

    resume_calls = []

    class FakeCloudAgentService:
        async def resume_cloud_agent(self, db, *, user_id, agent_id):
            resume_calls.append({"user_id": user_id, "agent_id": agent_id})
            return None

    monkeypatch.setattr(runtime_files_mod, "CloudAgentService", FakeCloudAgentService)

    dispatch_calls = []

    async def fake_send_cloud(cloud_daemon_instance_id, type_, params=None, timeout_ms=None):
        dispatch_calls.append({
            "cloud_daemon_instance_id": cloud_daemon_instance_id,
            "type": type_,
            "params": params,
            "timeout_ms": timeout_ms,
        })
        if len(dispatch_calls) == 1:
            raise runtime_files_mod.CloudDaemonDispatchError(
                "cloud_daemon_ack_timeout",
                "ack timeout after 5000ms",
            )
        return {
            "ok": True,
            "result": {
                "agentId": "ag_owned",
                "runtime": "codex",
                "files": [
                    {
                        "id": "workspace:AGENTS.md",
                        "name": "workspace/AGENTS.md",
                        "scope": "workspace",
                        "content": "# rules\n",
                    }
                ],
            },
        }

    monkeypatch.setattr(runtime_files_mod, "send_cloud_control_frame", fake_send_cloud)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_owned/runtime-files", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["files"][0]["content"] == "# rules\n"
    assert resume_calls == []
    assert dispatch_calls == [
        {
            "cloud_daemon_instance_id": "cloud_dm_timeout_retry_files",
            "type": "list_agent_files",
            "params": {"agentId": "ag_owned"},
            "timeout_ms": 5000,
        },
        {
            "cloud_daemon_instance_id": "cloud_dm_timeout_retry_files",
            "type": "list_agent_files",
            "params": {"agentId": "ag_owned"},
            "timeout_ms": 5000,
        },
    ]


@pytest.mark.asyncio
async def test_runtime_files_for_cloud_agent_keeps_504_after_persistent_ack_timeout(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_files as runtime_files_mod

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.hosting_kind = "cloud"
    agent.daemon_instance_id = "dm_cloud_timeout_files"
    agent.runtime = "codex"
    daemon = DaemonInstance(
        id="dm_cloud_timeout_files",
        user_id=agent.user_id,
        kind="cloud",
        refresh_token_hash="hash",
    )
    cloud_daemon = CloudDaemonInstance(
        id="cloud_dm_timeout_files",
        user_id=agent.user_id,
        daemon_instance_id=daemon.id,
        provider="e2b",
        status="ready",
        runtime="codex",
        max_agents=1,
        active_agent_count=1,
    )
    cloud_binding = CloudAgentInstance(
        id="cloud_ag_timeout_files",
        user_id=agent.user_id,
        agent_id=agent.agent_id,
        cloud_daemon_instance_id=cloud_daemon.id,
        daemon_instance_id=daemon.id,
        runtime="codex",
        model_profile="default",
        status="ready",
    )
    db_session.add_all([daemon, cloud_daemon, cloud_binding])
    await db_session.commit()

    monkeypatch.setattr(runtime_files_mod, "is_cloud_daemon_online", lambda _id: True)

    resume_calls = []

    class FakeCloudAgentService:
        async def resume_cloud_agent(self, db, *, user_id, agent_id):
            resume_calls.append({"user_id": user_id, "agent_id": agent_id})
            return None

    monkeypatch.setattr(runtime_files_mod, "CloudAgentService", FakeCloudAgentService)

    dispatch_calls = []

    async def fake_send_cloud(cloud_daemon_instance_id, type_, params=None, timeout_ms=None):
        dispatch_calls.append({
            "cloud_daemon_instance_id": cloud_daemon_instance_id,
            "type": type_,
            "params": params,
            "timeout_ms": timeout_ms,
        })
        raise runtime_files_mod.CloudDaemonDispatchError(
            "cloud_daemon_ack_timeout",
            "ack timeout after 5000ms",
        )

    monkeypatch.setattr(runtime_files_mod, "send_cloud_control_frame", fake_send_cloud)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_owned/runtime-files", headers=headers)
    assert r.status_code == 504, r.text
    assert r.json()["detail"] == "daemon_ack_timeout"
    assert resume_calls == []
    assert len(dispatch_calls) == 2


@pytest.mark.asyncio
async def test_runtime_files_rejects_unowned_or_offline_agent(
    client, seed, db_session, monkeypatch
):
    from app.routers import runtime_files as runtime_files_mod

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.get("/api/agents/ag_other/runtime-files", headers=headers)
    assert r.status_code == 404

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.daemon_instance_id = "dm_offline"
    await db_session.commit()

    monkeypatch.setattr(runtime_files_mod, "is_daemon_online", lambda _id: False)
    r = await client.get("/api/agents/ag_owned/runtime-files", headers=headers)
    assert r.status_code == 409
    assert r.json()["detail"] == "daemon_offline"


# ---------------------------------------------------------------------------
# Per-room override (/rooms/{room_id}/policy + /snooze)
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def room_seed(db_session: AsyncSession, seed):
    """Builds on ``seed`` — adds a public room and a DM room to the schema."""
    room = Room(
        room_id="rm_pub_1",
        name="Public Room",
        description="",
        owner_id="ag_owned",
        owner_type=ParticipantType.agent,
        visibility=RoomVisibility.public,
        join_policy=RoomJoinPolicy.open,
    )
    dm = Room(
        room_id="rm_dm_xyz",
        name="DM",
        description="",
        owner_id="ag_owned",
        owner_type=ParticipantType.agent,
        visibility=RoomVisibility.private,
        join_policy=RoomJoinPolicy.invite_only,
    )
    db_session.add_all([room, dm])
    db_session.add_all([
        RoomMember(
            room_id="rm_pub_1",
            agent_id="ag_owned",
            participant_type=ParticipantType.agent,
        ),
        RoomMember(
            room_id="rm_pub_1",
            agent_id="ag_other",
            participant_type=ParticipantType.agent,
        ),
    ])
    await db_session.commit()
    return seed


@pytest.mark.asyncio
async def test_get_room_policy_inherits_when_no_override(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.get("/api/agents/ag_owned/rooms/rm_pub_1/policy", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["inherits_global"] is True
    assert body["override"] is None
    assert body["effective"]["mode"] == "always"
    assert body["effective"]["source"] == "global"


@pytest.mark.asyncio
async def test_put_then_get_room_policy_mixed_inherit(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    # Set agent default to keyword + ['hi'] first so we can verify keyword inheritance.
    r = await client.patch(
        "/api/agents/ag_owned/policy",
        headers=headers,
        json={"default_attention": "keyword", "attention_keywords": ["hi"]},
    )
    assert r.status_code == 200, r.text

    # Override only the mode; leave keywords as inherit.
    r = await client.put(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy",
        headers=headers,
        json={"attention_mode": "mention_only", "keywords": None},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["inherits_global"] is False
    assert body["override"]["attention_mode"] == "mention_only"
    assert body["override"]["keywords"] is None
    assert body["effective"]["mode"] == "mention_only"
    # Inherited keywords surface in `effective`.
    assert body["effective"]["keywords"] == ["hi"]
    assert body["effective"]["source"] == "override"

    # GET reflects the same.
    r = await client.get("/api/agents/ag_owned/rooms/rm_pub_1/policy", headers=headers)
    assert r.status_code == 200
    assert r.json()["override"]["attention_mode"] == "mention_only"


@pytest.mark.asyncio
async def test_put_room_policy_allowed_senders_validates_room_members(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.put(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy",
        headers=headers,
        json={
            "attention_mode": "allowed_senders",
            "allowed_sender_ids": ["ag_other"],
            "keywords": None,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["override"]["attention_mode"] == "allowed_senders"
    assert body["override"]["allowed_sender_ids"] == ["ag_other"]
    assert body["effective"]["mode"] == "allowed_senders"
    assert body["effective"]["allowed_sender_ids"] == ["ag_other"]

    r = await client.put(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy",
        headers=headers,
        json={
            "attention_mode": "allowed_senders",
            "allowed_sender_ids": ["ag_not_in_room"],
        },
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_delete_room_policy_restores_inherit(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.put(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy",
        headers=headers,
        json={"attention_mode": "muted", "keywords": None},
    )
    assert r.status_code == 200
    r = await client.delete(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy", headers=headers
    )
    assert r.status_code == 204
    # Idempotent re-delete.
    r = await client.delete(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy", headers=headers
    )
    assert r.status_code == 204
    r = await client.get("/api/agents/ag_owned/rooms/rm_pub_1/policy", headers=headers)
    body = r.json()
    assert body["inherits_global"] is True
    assert body["override"] is None


@pytest.mark.asyncio
async def test_snooze_sets_muted_until_then_clears(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.post(
        "/api/agents/ag_owned/rooms/rm_pub_1/snooze",
        headers=headers,
        json={"minutes": 60},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["override"]["muted_until"] is not None
    assert body["effective"]["muted_until"] is not None

    # minutes=0 clears
    r = await client.post(
        "/api/agents/ag_owned/rooms/rm_pub_1/snooze",
        headers=headers,
        json={"minutes": 0},
    )
    assert r.status_code == 200
    assert r.json()["override"]["muted_until"] is None


@pytest.mark.asyncio
async def test_snooze_validates_range(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.post(
        "/api/agents/ag_owned/rooms/rm_pub_1/snooze",
        headers=headers,
        json={"minutes": -1},
    )
    assert r.status_code == 422
    r = await client.post(
        "/api/agents/ag_owned/rooms/rm_pub_1/snooze",
        headers=headers,
        json={"minutes": 999_999},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_dm_room_rejects_put_and_snooze(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.put(
        "/api/agents/ag_owned/rooms/rm_dm_xyz/policy",
        headers=headers,
        json={"attention_mode": "muted", "keywords": None},
    )
    assert r.status_code == 400
    r = await client.post(
        "/api/agents/ag_owned/rooms/rm_dm_xyz/snooze",
        headers=headers,
        json={"minutes": 30},
    )
    assert r.status_code == 400
    # GET still works and reports dm_forced=always.
    r = await client.get(
        "/api/agents/ag_owned/rooms/rm_dm_xyz/policy", headers=headers
    )
    assert r.status_code == 200
    body = r.json()
    assert body["effective"]["mode"] == "always"
    assert body["effective"]["source"] == "dm_forced"


@pytest.mark.asyncio
async def test_room_policy_404_for_other_users_agent(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.get(
        "/api/agents/ag_other/rooms/rm_pub_1/policy", headers=headers
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_room_policy_404_for_unknown_room(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.get(
        "/api/agents/ag_owned/rooms/rm_nope/policy", headers=headers
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_put_room_policy_rejects_bad_enum(client, room_seed):
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.put(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy",
        headers=headers,
        json={"attention_mode": "bogus", "keywords": None},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_patch_policy_dispatches_policy_updated_to_daemon(
    client, seed, db_session, monkeypatch
):
    """PR3: PATCH /api/agents/{id}/policy fans out a `policy_updated` control
    frame to the daemon hosting the agent."""
    from sqlalchemy import select

    # Bind the agent to a daemon so the dispatch fires.
    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.daemon_instance_id = "di_fake"
    await db_session.commit()

    calls: list[dict] = []

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append(
            {
                "daemon_instance_id": daemon_instance_id,
                "type": type_,
                "params": params,
            }
        )
        return {"ok": True, "result": {"applied": True}}

    import app.routers.policy as policy_mod

    monkeypatch.setattr(policy_mod, "is_daemon_online", lambda _id: True)
    monkeypatch.setattr(policy_mod, "send_control_frame", fake_send)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.patch(
        "/api/agents/ag_owned/policy",
        headers=headers,
        json={"default_attention": "mention_only", "attention_keywords": ["alpha"]},
    )
    assert r.status_code == 200, r.text
    assert len(calls) == 1
    call = calls[0]
    assert call["daemon_instance_id"] == "di_fake"
    assert call["type"] == "policy_updated"
    assert call["params"]["agent_id"] == "ag_owned"
    assert call["params"]["policy"]["mode"] == "mention_only"
    assert call["params"]["policy"]["keywords"] == ["alpha"]


@pytest.mark.asyncio
async def test_patch_policy_swallows_dispatch_failure(
    client, seed, db_session, monkeypatch
):
    """PR3: a dispatch error must NOT 500 the BFF — best-effort fan-out."""
    from sqlalchemy import select
    from fastapi import HTTPException

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.daemon_instance_id = "di_offline"
    await db_session.commit()

    async def boom(*args, **kwargs):
        raise HTTPException(status_code=409, detail="daemon_offline")

    import app.routers.policy as policy_mod

    monkeypatch.setattr(policy_mod, "is_daemon_online", lambda _id: True)
    monkeypatch.setattr(policy_mod, "send_control_frame", boom)

    headers = {"Authorization": f"Bearer {seed['token']}"}
    r = await client.patch(
        "/api/agents/ag_owned/policy",
        headers=headers,
        json={"default_attention": "muted"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["default_attention"] == "muted"


@pytest.mark.asyncio
async def test_put_room_override_dispatches_with_embedded_policy(
    client, room_seed, db_session, monkeypatch
):
    """PUT must fan out the post-mutation effective policy so the daemon's
    cache can install it directly. Prior to this fix PUT did not dispatch
    at all and the daemon kept stale state until TTL."""
    from sqlalchemy import select

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.daemon_instance_id = "di_x"
    await db_session.commit()

    calls: list[dict] = []

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append({"daemon_instance_id": daemon_instance_id, "type": type_, "params": params})
        return {"ok": True, "result": {"applied": True}}

    import app.routers.policy as policy_mod

    monkeypatch.setattr(policy_mod, "is_daemon_online", lambda _id: True)
    monkeypatch.setattr(policy_mod, "send_control_frame", fake_send)

    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.put(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy",
        headers=headers,
        json={"attention_mode": "mention_only", "keywords": None},
    )
    assert r.status_code == 200, r.text
    assert len(calls) == 1
    call = calls[0]
    assert call["type"] == "policy_updated"
    assert call["params"]["agent_id"] == "ag_owned"
    assert call["params"]["room_id"] == "rm_pub_1"
    assert call["params"]["policy"]["mode"] == "mention_only"


@pytest.mark.asyncio
async def test_snooze_dispatches_with_muted_until(
    client, room_seed, db_session, monkeypatch
):
    """Snooze must embed the resulting policy (including muted_until); without
    it the daemon would invalidate the room key and fall back to the global,
    which has no muted_until — losing the snooze entirely."""
    from sqlalchemy import select

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.daemon_instance_id = "di_x"
    await db_session.commit()

    calls: list[dict] = []

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append({"daemon_instance_id": daemon_instance_id, "type": type_, "params": params})
        return {"ok": True, "result": {"applied": True}}

    import app.routers.policy as policy_mod

    monkeypatch.setattr(policy_mod, "is_daemon_online", lambda _id: True)
    monkeypatch.setattr(policy_mod, "send_control_frame", fake_send)

    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.post(
        "/api/agents/ag_owned/rooms/rm_pub_1/snooze",
        headers=headers,
        json={"minutes": 60},
    )
    assert r.status_code == 200, r.text
    assert len(calls) == 1
    payload = calls[0]["params"]
    assert payload["room_id"] == "rm_pub_1"
    assert payload["policy"]["mode"] == "always"
    assert isinstance(payload["policy"]["muted_until"], int)
    assert payload["policy"]["muted_until"] > 0


@pytest.mark.asyncio
async def test_delete_room_override_dispatches_invalidate_only(
    client, room_seed, db_session, monkeypatch
):
    """DELETE leaves the per-room slot empty so the daemon falls back to the
    cached global. The frame should carry agent_id + room_id, no policy."""
    from sqlalchemy import select

    row = await db_session.execute(select(Agent).where(Agent.agent_id == "ag_owned"))
    agent = row.scalar_one()
    agent.daemon_instance_id = "di_x"
    await db_session.commit()

    # Seed an override so the DELETE has something to remove.
    headers = {"Authorization": f"Bearer {room_seed['token']}"}
    r = await client.put(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy",
        headers=headers,
        json={"attention_mode": "muted", "keywords": None},
    )
    assert r.status_code == 200

    calls: list[dict] = []

    async def fake_send(daemon_instance_id, type_, params=None, timeout_ms=None):
        calls.append({"params": params})
        return {"ok": True, "result": {}}

    import app.routers.policy as policy_mod

    monkeypatch.setattr(policy_mod, "is_daemon_online", lambda _id: True)
    monkeypatch.setattr(policy_mod, "send_control_frame", fake_send)

    r = await client.delete(
        "/api/agents/ag_owned/rooms/rm_pub_1/policy", headers=headers
    )
    assert r.status_code == 204
    assert len(calls) == 1
    payload = calls[0]["params"]
    assert payload["agent_id"] == "ag_owned"
    assert payload["room_id"] == "rm_pub_1"
    assert "policy" not in payload
