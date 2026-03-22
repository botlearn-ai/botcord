"""Tests for /api/users/me/agents/* endpoints (Phase 2)."""

import base64
import datetime
import json
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import Agent, Base, MessagePolicy, Role, User, UserRole

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


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
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, monkeypatch):
    import hub.config
    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    import app.auth
    monkeypatch.setattr(app.auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

    from hub.main import app
    from hub.database import get_db

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def seed_user(db_session: AsyncSession):
    """Create a test user with two agents (first is default)."""
    supabase_uuid = uuid.uuid4()
    supabase_uid = str(supabase_uuid)
    user_id = uuid.uuid4()

    user = User(
        id=user_id,
        display_name="Test User",
        email="test@example.com",
        avatar_url=None,
        status="active",
        supabase_user_id=supabase_uuid,
        max_agents=5,
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

    agent_owner_role = Role(
        id=uuid.uuid4(),
        name="agent_owner",
        display_name="Agent Owner",
        is_system=True,
        priority=0,
    )
    db_session.add(agent_owner_role)
    await db_session.flush()

    user_role = UserRole(id=uuid.uuid4(), user_id=user_id, role_id=role.id)
    db_session.add(user_role)

    now = datetime.datetime.now(datetime.timezone.utc)

    agent1 = Agent(
        agent_id="ag_agent001",
        display_name="Agent One",
        bio="First agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        is_default=True,
        claimed_at=now,
        created_at=now,
    )
    agent2 = Agent(
        agent_id="ag_agent002",
        display_name="Agent Two",
        bio="Second agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        is_default=False,
        claimed_at=now,
        created_at=now + datetime.timedelta(seconds=1),
    )
    db_session.add(agent1)
    db_session.add(agent2)
    await db_session.commit()

    return {
        "user": user,
        "user_id": user_id,
        "supabase_uid": supabase_uid,
        "token": _make_supabase_token(supabase_uid),
        "agent1": agent1,
        "agent2": agent2,
        "agent_owner_role": agent_owner_role,
    }


# ---------------------------------------------------------------------------
# DELETE /api/users/me/agents/{agent_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_agent(client: AsyncClient, seed_user: dict):
    """Unbinding the default agent promotes the next one."""
    token = seed_user["token"]

    resp = await client.delete(
        "/api/users/me/agents/ag_agent001",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    # Verify agent2 became default
    agents_resp = await client.get(
        "/api/users/me/agents",
        headers={"Authorization": f"Bearer {token}"},
    )
    agents = agents_resp.json()["agents"]
    assert len(agents) == 1
    assert agents[0]["agent_id"] == "ag_agent002"
    assert agents[0]["is_default"] is True


@pytest.mark.asyncio
async def test_delete_agent_not_found(client: AsyncClient, seed_user: dict):
    token = seed_user["token"]
    resp = await client.delete(
        "/api/users/me/agents/ag_nonexistent",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /api/users/me/agents/{agent_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_agent_set_default(client: AsyncClient, seed_user: dict):
    """Setting agent2 as default should unset agent1."""
    token = seed_user["token"]

    resp = await client.patch(
        "/api/users/me/agents/ag_agent002",
        json={"is_default": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == "ag_agent002"
    assert data["is_default"] is True

    # Verify agent1 is no longer default
    agents_resp = await client.get(
        "/api/users/me/agents",
        headers={"Authorization": f"Bearer {token}"},
    )
    agents = {a["agent_id"]: a for a in agents_resp.json()["agents"]}
    assert agents["ag_agent001"]["is_default"] is False
    assert agents["ag_agent002"]["is_default"] is True


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/bind-ticket
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bind_ticket_returns_valid_ticket(client: AsyncClient, seed_user: dict):
    token = seed_user["token"]

    resp = await client.post(
        "/api/users/me/agents/bind-ticket",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()

    assert "bind_ticket" in data
    assert "nonce" in data
    assert "expires_at" in data
    assert isinstance(data["expires_at"], int)

    # Verify ticket structure: base64_payload.base64_signature
    parts = data["bind_ticket"].split(".")
    assert len(parts) == 2

    # Decode and verify payload
    payload_json = base64.urlsafe_b64decode(parts[0]).decode()
    payload = json.loads(payload_json)
    assert payload["uid"] == str(seed_user["user_id"])
    assert payload["nonce"] == data["nonce"]
    assert payload["exp"] == data["expires_at"]
    assert "iat" in payload
    assert "jti" in payload


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/claim/resolve
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_claim_resolve_success(client: AsyncClient, seed_user: dict, db_session: AsyncSession):
    """Claiming an unclaimed agent binds it to the user."""
    token = seed_user["token"]

    # Create a new unclaimed agent
    unclaimed = Agent(
        agent_id="ag_unclaimed01",
        display_name="Unclaimed Agent",
        bio="Waiting to be claimed",
        message_policy=MessagePolicy.contacts_only,
        claim_code="clm_testcode123",
    )
    db_session.add(unclaimed)
    await db_session.commit()

    resp = await client.post(
        "/api/users/me/agents/claim/resolve",
        json={"claim_code": "clm_testcode123"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["agent_id"] == "ag_unclaimed01"
    assert data["display_name"] == "Unclaimed Agent"
    # User already has agents, so this should not be default
    assert data["is_default"] is False
    assert data["claimed_at"] is not None


@pytest.mark.asyncio
async def test_claim_resolve_already_claimed(client: AsyncClient, seed_user: dict, db_session: AsyncSession):
    """Cannot claim an agent that is already bound to a user."""
    token = seed_user["token"]

    claimed = Agent(
        agent_id="ag_claimed01",
        display_name="Claimed Agent",
        message_policy=MessagePolicy.contacts_only,
        claim_code="clm_alreadyclaimed",
        user_id=uuid.uuid4(),  # already has an owner
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(claimed)
    await db_session.commit()

    resp = await client.post(
        "/api/users/me/agents/claim/resolve",
        json={"claim_code": "clm_alreadyclaimed"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 409
    assert "already claimed" in resp.json()["error"].lower()


@pytest.mark.asyncio
async def test_claim_resolve_quota_exceeded(client: AsyncClient, seed_user: dict, db_session: AsyncSession):
    """Exceeding max_agents quota returns 400."""
    token = seed_user["token"]

    # Set max_agents to 2 (user already has 2 agents)
    user = seed_user["user"]
    user.max_agents = 2
    db_session.add(user)
    await db_session.flush()

    unclaimed = Agent(
        agent_id="ag_quota01",
        display_name="Quota Agent",
        message_policy=MessagePolicy.contacts_only,
        claim_code="clm_quotatest",
    )
    db_session.add(unclaimed)
    await db_session.commit()

    resp = await client.post(
        "/api/users/me/agents/claim/resolve",
        json={"claim_code": "clm_quotatest"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400
    assert "quota" in resp.json()["error"].lower()
