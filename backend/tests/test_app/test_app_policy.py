"""Tests for /api/agents/{agent_id}/policy (BFF — global agent policy)."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from unittest.mock import AsyncMock

from hub.enums import AttentionMode, ContactPolicy, MessagePolicy, RoomInvitePolicy
from hub.models import Agent, Base, Role, User, UserRole

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
    from sqlalchemy import select
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
