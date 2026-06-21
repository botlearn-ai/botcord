"""Tests for /api/users endpoints."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import Agent, Base, MessagePolicy, Role, User, UserRole

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"

# Fake Supabase JWT secret for tests
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_supabase_token(
    sub: str,
    secret: str = TEST_SUPABASE_SECRET,
    *,
    email: str | None = None,
    user_metadata: dict | None = None,
    app_metadata: dict | None = None,
) -> str:
    """Create a fake Supabase JWT for testing."""
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    if email is not None:
        payload["email"] = email
    if user_metadata is not None:
        payload["user_metadata"] = user_metadata
    if app_metadata is not None:
        payload["app_metadata"] = app_metadata
    return jwt.encode(payload, secret, algorithm="HS256")


@pytest_asyncio.fixture
async def db_session():
    from tests.test_app.conftest import create_test_engine; engine = create_test_engine()
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
        runtime="codex",
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
    assert data["agents"][0]["runtime"] == "codex"
    assert data["max_agents"] == 30


@pytest.mark.asyncio
async def test_get_me_unauthorized(client: AsyncClient):
    resp = await client.get("/api/users/me")
    assert resp.status_code == 401
    data = resp.json()
    assert data["error"] == "Unauthorized"


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
    assert "agents" in data
    agents = data["agents"]
    assert len(agents) == 1
    assert agents[0]["agent_id"] == "ag_testuser001"
    assert agents[0]["bio"] == "A test agent"
    assert agents[0]["message_policy"] == "contacts_only"
    assert agents[0]["is_default"] is True
    assert agents[0]["runtime"] == "codex"


@pytest.mark.asyncio
async def test_get_me_auto_creates_user(client: AsyncClient):
    """Token with valid format but user does not exist — auto-creates."""
    token = _make_supabase_token(str(uuid.uuid4()))
    resp = await client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["display_name"] == "User"  # fallback display name


@pytest.mark.asyncio
async def test_get_me_auto_creates_user_with_existing_member_role(
    client: AsyncClient,
    db_session: AsyncSession,
):
    role = Role(
        id=uuid.uuid4(),
        name="member",
        display_name="Member",
        is_system=True,
        priority=0,
    )
    db_session.add(role)
    await db_session.commit()

    supabase_uuid = uuid.uuid4()
    token = _make_supabase_token(str(supabase_uuid), email="new@example.com")
    resp = await client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["roles"] == ["member"]

    user = (
        await db_session.execute(
            select(User).where(User.supabase_user_id == supabase_uuid)
        )
    ).scalar_one()
    user_role = (
        await db_session.execute(
            select(UserRole).where(
                UserRole.user_id == user.id,
                UserRole.role_id == role.id,
            )
        )
    ).scalar_one()
    assert user_role.user_id == user.id


@pytest.mark.asyncio
async def test_get_me_auto_create_duplicate_bootstrap_selects_existing_user(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    supabase_uuid = uuid.uuid4()
    role_id = uuid.uuid4()
    role = Role(
        id=role_id,
        name="member",
        display_name="Member",
        is_system=True,
        priority=0,
    )
    db_session.add(role)
    await db_session.commit()

    original_flush = db_session.flush
    original_commit = db_session.commit
    original_rollback = db_session.rollback
    winner_id = uuid.uuid4()
    raced = False

    async def _flush_with_duplicate_bootstrap_race(objects=None):
        nonlocal raced
        pending_user = next(
            (
                obj
                for obj in db_session.new
                if isinstance(obj, User) and obj.supabase_user_id == supabase_uuid
            ),
            None,
        )
        if raced or pending_user is None:
            await original_flush(objects)
            return

        raced = True
        await original_rollback()
        db_session.add(
            User(
                id=winner_id,
                supabase_user_id=supabase_uuid,
                display_name="Race Winner",
                email="race@example.com",
                status="active",
            )
        )
        db_session.add(
            UserRole(
                id=uuid.uuid4(),
                user_id=winner_id,
                role_id=role_id,
            )
        )
        await original_flush()
        await original_commit()
        raise IntegrityError(
            "INSERT INTO public.users",
            {},
            Exception("duplicate key value violates unique constraint"),
        )

    monkeypatch.setattr(db_session, "flush", _flush_with_duplicate_bootstrap_race)

    token = _make_supabase_token(str(supabase_uuid), email="race@example.com")
    resp = await client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    assert raced is True
    data = resp.json()
    assert data["id"] == str(winner_id)
    assert data["display_name"] == "Race Winner"
    assert data["email"] == "race@example.com"
    assert data["roles"] == ["member"]

    users = (
        await db_session.execute(
            select(User).where(User.supabase_user_id == supabase_uuid)
        )
    ).scalars().all()
    assert len(users) == 1
    assert users[0].id == winner_id


@pytest.mark.asyncio
async def test_get_me_reattaches_existing_email_user(
    client: AsyncClient,
    db_session: AsyncSession,
    seed_user: dict,
):
    """A fresh Supabase sub with the same login email must not create a new local account."""
    previous_supabase_uid = seed_user["user"].supabase_user_id
    new_supabase_uid = uuid.uuid4()
    token = _make_supabase_token(
        str(new_supabase_uid),
        email="TEST@example.com",
        user_metadata={"avatar_url": "https://example.com/new-avatar.png"},
        app_metadata={"provider": "email", "providers": ["email"]},
    )

    resp = await client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == str(seed_user["user_id"])
    assert data["display_name"] == "Test User"
    assert [agent["agent_id"] for agent in data["agents"]] == ["ag_testuser001"]

    users = (await db_session.execute(select(User))).scalars().all()
    assert len(users) == 1
    assert users[0].supabase_user_id == new_supabase_uid
    assert users[0].supabase_user_id != previous_supabase_uid
    assert users[0].last_login_at is not None


@pytest.mark.asyncio
async def test_get_me_auto_create_honors_beta_access_metadata(client: AsyncClient):
    token = _make_supabase_token(
        str(uuid.uuid4()),
        email="beta@example.com",
        user_metadata={"beta_access": True, "full_name": "Beta User"},
    )

    resp = await client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["display_name"] == "Beta User"
    assert data["email"] == "beta@example.com"
    assert data["beta_access"] is True
