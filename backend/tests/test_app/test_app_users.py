"""Tests for /api/users endpoints."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import Agent, Base, MessagePolicy, Role, User, UserRole

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"

# Fake Supabase JWT secret for tests
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_supabase_token(sub: str, secret: str = TEST_SUPABASE_SECRET) -> str:
    """Create a fake Supabase JWT for testing."""
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
    # Patch SUPABASE_JWT_SECRET before importing app modules
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
    """Create a test user with a role and an agent."""
    supabase_uuid = uuid.uuid4()
    supabase_uid = str(supabase_uuid)
    user_id = uuid.uuid4()

    user = User(
        id=user_id,
        display_name="Test User",
        email="test@example.com",
        avatar_url="https://example.com/avatar.png",
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
    await db_session.flush()

    user_role = UserRole(
        id=uuid.uuid4(),
        user_id=user_id,
        role_id=role.id,
    )
    db_session.add(user_role)

    agent = Agent(
        agent_id="ag_testuser001",
        display_name="Test Agent",
        bio="A test agent",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)
    await db_session.commit()

    return {
        "user": user,
        "user_id": user_id,
        "supabase_uid": supabase_uid,
        "role": role,
        "agent": agent,
        "token": _make_supabase_token(supabase_uid),
    }


@pytest.mark.asyncio
async def test_get_me(client: AsyncClient, seed_user: dict):
    token = seed_user["token"]
    resp = await client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["display_name"] == "Test User"
    assert data["email"] == "test@example.com"
    assert "member" in data["roles"]
    assert len(data["agents"]) == 1
    assert data["agents"][0]["agent_id"] == "ag_testuser001"
    assert data["agents"][0]["is_default"] is True
    assert data["max_agents"] == 5


@pytest.mark.asyncio
async def test_get_me_unauthorized(client: AsyncClient):
    resp = await client.get("/api/users/me")
    assert resp.status_code == 422  # missing header


@pytest.mark.asyncio
async def test_get_me_invalid_token(client: AsyncClient):
    resp = await client.get(
        "/api/users/me",
        headers={"Authorization": "Bearer invalid-token"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_get_my_agents(client: AsyncClient, seed_user: dict):
    token = seed_user["token"]
    resp = await client.get(
        "/api/users/me/agents",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["agent_id"] == "ag_testuser001"
    assert data[0]["bio"] == "A test agent"
    assert data[0]["message_policy"] == "contacts_only"
    assert data[0]["is_default"] is True


@pytest.mark.asyncio
async def test_get_me_user_not_found(client: AsyncClient):
    """Token with valid format but user does not exist in DB."""
    token = _make_supabase_token(str(uuid.uuid4()))
    resp = await client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 404
