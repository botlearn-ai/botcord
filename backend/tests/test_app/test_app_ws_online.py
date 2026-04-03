"""Tests for ws_online field in /api/users/me and /api/users/me/agents."""

import datetime
import uuid
from unittest.mock import AsyncMock, MagicMock

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.models import Agent, Base, MessagePolicy, Role, User, UserRole

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_supabase_token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


@pytest_asyncio.fixture
async def db_session():
    from tests.test_app.conftest import create_test_engine

    engine = create_test_engine()
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
    supabase_uuid = uuid.uuid4()
    supabase_uid = str(supabase_uuid)
    user_id = uuid.uuid4()

    user = User(
        id=user_id,
        display_name="WS User",
        email="ws@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
        max_agents=10,
    )
    db_session.add(user)

    role = Role(
        id=uuid.uuid4(), name="member", display_name="Member", is_system=True, priority=0
    )
    db_session.add(role)
    await db_session.flush()

    user_role = UserRole(id=uuid.uuid4(), user_id=user_id, role_id=role.id)
    db_session.add(user_role)

    agent = Agent(
        agent_id="ag_wsonline001",
        display_name="WS Agent",
        bio="test",
        message_policy=MessagePolicy.open,
        user_id=user_id,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)
    await db_session.commit()

    return {
        "user_id": user_id,
        "supabase_uid": supabase_uid,
        "agent": agent,
        "token": _make_supabase_token(supabase_uid),
    }


@pytest.mark.asyncio
async def test_get_me_ws_online_false(client: AsyncClient, seed_user: dict):
    """Without WS connections, ws_online should be False."""
    resp = await client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 200
    agents = resp.json()["agents"]
    assert len(agents) == 1
    assert agents[0]["ws_online"] is False


@pytest.mark.asyncio
async def test_get_me_ws_online_true(client: AsyncClient, seed_user: dict, monkeypatch):
    """With an active WS connection, ws_online should be True."""
    from hub.routers import hub as hub_router

    fake_ws = MagicMock()
    original = hub_router._ws_connections.copy()
    hub_router._ws_connections["ag_wsonline001"] = {fake_ws}

    try:
        resp = await client.get(
            "/api/users/me",
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        assert resp.status_code == 200
        agents = resp.json()["agents"]
        assert agents[0]["ws_online"] is True
    finally:
        hub_router._ws_connections.clear()
        hub_router._ws_connections.update(original)


@pytest.mark.asyncio
async def test_get_me_agents_ws_online(client: AsyncClient, seed_user: dict):
    """/me/agents should also include ws_online field."""
    resp = await client.get(
        "/api/users/me/agents",
        headers={"Authorization": f"Bearer {seed_user['token']}"},
    )
    assert resp.status_code == 200
    agents = resp.json()["agents"]
    assert len(agents) == 1
    assert agents[0]["ws_online"] is False


@pytest.mark.asyncio
async def test_ws_online_disconnection(client: AsyncClient, seed_user: dict):
    """After removing WS connection, ws_online should revert to False."""
    from hub.routers import hub as hub_router

    fake_ws = MagicMock()
    original = hub_router._ws_connections.copy()
    hub_router._ws_connections["ag_wsonline001"] = {fake_ws}

    try:
        # Online
        resp = await client.get(
            "/api/users/me",
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        assert resp.json()["agents"][0]["ws_online"] is True

        # Disconnect
        hub_router._ws_connections.pop("ag_wsonline001", None)

        resp = await client.get(
            "/api/users/me",
            headers={"Authorization": f"Bearer {seed_user['token']}"},
        )
        assert resp.json()["agents"][0]["ws_online"] is False
    finally:
        hub_router._ws_connections.clear()
        hub_router._ws_connections.update(original)
