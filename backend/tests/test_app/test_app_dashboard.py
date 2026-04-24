"""Tests for /api/dashboard endpoints."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import (
    Agent,
    Base,
    Contact,
    ContactRequest,
    ContactRequestState,
    MessagePolicy,
    Role,
    Room,
    RoomMember,
    RoomRole,
    RoomVisibility,
    RoomJoinPolicy,
    User,
    UserRole,
)

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
async def seed_data(db_session: AsyncSession):
    """Create a test user, agent, room, contact, and pending request."""
    supabase_uuid = uuid.uuid4()
    supabase_uid = str(supabase_uuid)
    user_id = uuid.uuid4()

    user = User(
        id=user_id,
        display_name="Dashboard User",
        email="dash@example.com",
        status="active",
        supabase_user_id=supabase_uuid,
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

    user_role = UserRole(id=uuid.uuid4(), user_id=user_id, role_id=role.id)
    db_session.add(user_role)

    agent = Agent(
        agent_id="ag_dashtest001",
        display_name="Dashboard Agent",
        bio="dashboard test",
        message_policy=MessagePolicy.contacts_only,
        user_id=user_id,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add(agent)

    # Another agent (for contacts / requests)
    other_agent = Agent(
        agent_id="ag_other00001",
        display_name="Other Agent",
        message_policy=MessagePolicy.contacts_only,
    )
    db_session.add(other_agent)
    await db_session.flush()

    # Room with membership
    room = Room(
        room_id="rm_testroom001",
        name="Test Room",
        description="A test room",
        owner_id="ag_dashtest001",
        visibility=RoomVisibility.private,
        join_policy=RoomJoinPolicy.invite_only,
    )
    db_session.add(room)
    await db_session.flush()

    membership = RoomMember(
        room_id="rm_testroom001",
        agent_id="ag_dashtest001",
        role=RoomRole.owner,
    )
    db_session.add(membership)

    # Contact
    contact = Contact(
        owner_id="ag_dashtest001",
        contact_agent_id="ag_other00001",
        alias="Other",
    )
    db_session.add(contact)

    # Pending contact request
    req = ContactRequest(
        from_agent_id="ag_other00001",
        to_agent_id="ag_dashtest001",
        state=ContactRequestState.pending,
        message="Hi, let's connect!",
    )
    db_session.add(req)

    await db_session.commit()

    return {
        "user": user,
        "user_id": user_id,
        "supabase_uid": supabase_uid,
        "agent": agent,
        "token": _make_supabase_token(supabase_uid),
    }


@pytest.mark.asyncio
async def test_dashboard_overview(client: AsyncClient, seed_data: dict):
    token = seed_data["token"]
    resp = await client.get(
        "/api/dashboard/overview",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Active-Agent": "ag_dashtest001",
        },
    )
    assert resp.status_code == 200
    data = resp.json()

    # Agent
    assert data["agent"]["agent_id"] == "ag_dashtest001"
    assert data["agent"]["display_name"] == "Dashboard Agent"

    # Viewer descriptor (Agent mode)
    assert data["viewer"]["type"] == "agent"
    assert data["viewer"]["id"] == "ag_dashtest001"
    assert data["viewer"]["display_name"] == "Dashboard Agent"

    # Rooms
    assert len(data["rooms"]) == 1
    assert data["rooms"][0]["room_id"] == "rm_testroom001"
    assert data["rooms"][0]["name"] == "Test Room"
    assert data["rooms"][0]["my_role"] == "owner"

    # Contacts
    assert len(data["contacts"]) == 1
    assert data["contacts"][0]["contact_agent_id"] == "ag_other00001"
    assert data["contacts"][0]["alias"] == "Other"

    # Pending requests
    assert data["pending_requests"] == 1


@pytest.mark.asyncio
async def test_dashboard_overview_human_mode(
    client: AsyncClient, seed_data: dict
):
    """Without X-Active-Agent the overview returns the Human viewer."""
    token = seed_data["token"]
    resp = await client.get(
        "/api/dashboard/overview",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()

    # In Human mode, ``agent`` is None and a ``viewer`` descriptor identifies
    # the Human viewer via ``human_id``.
    assert data["agent"] is None
    assert data["viewer"]["type"] == "human"
    assert data["viewer"]["id"].startswith("hu_")
    assert data["viewer"]["display_name"] == "Dashboard User"

    # Seed data puts the Agent (not the Human) in room/contact/request rows,
    # so Human mode sees empty lists for now — Phase 2 will migrate those
    # call sites once Humans can be full participants everywhere.
    assert data["rooms"] == []
    assert data["contacts"] == []
    assert data["pending_requests"] == 0


@pytest.mark.asyncio
async def test_dashboard_overview_wrong_agent(client: AsyncClient, seed_data: dict):
    """Should return 404 when X-Active-Agent references a non-existent agent."""
    token = seed_data["token"]
    resp = await client.get(
        "/api/dashboard/overview",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Active-Agent": "ag_nonexistent",
        },
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_dashboard_overview_agent_not_owned(
    client: AsyncClient, seed_data: dict
):
    """Should return 403 when X-Active-Agent belongs to another user."""
    token = seed_data["token"]
    resp = await client.get(
        "/api/dashboard/overview",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Active-Agent": "ag_other00001",  # not owned by this user
        },
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# GET /api/dashboard/chat/room
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chat_room_creates_on_first_call(
    client: AsyncClient, seed_data: dict
):
    """First call to chat/room should create and return a room."""
    token = seed_data["token"]
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Active-Agent": "ag_dashtest001",
    }

    resp = await client.get("/api/dashboard/chat/room", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "room_id" in data
    assert data["agent_id"] == "ag_dashtest001"
    assert "Chat with" in data["name"]

    # Store room_id for idempotency check
    room_id = data["room_id"]
    assert room_id  # non-empty


@pytest.mark.asyncio
async def test_chat_room_idempotent(
    client: AsyncClient, seed_data: dict
):
    """Second call to chat/room should return the same room_id."""
    token = seed_data["token"]
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Active-Agent": "ag_dashtest001",
    }

    resp1 = await client.get("/api/dashboard/chat/room", headers=headers)
    assert resp1.status_code == 200
    room_id_1 = resp1.json()["room_id"]

    resp2 = await client.get("/api/dashboard/chat/room", headers=headers)
    assert resp2.status_code == 200
    room_id_2 = resp2.json()["room_id"]

    assert room_id_1 == room_id_2


@pytest.mark.asyncio
async def test_chat_room_for_explicit_owned_agent_without_active_agent(
    client: AsyncClient, seed_data: dict, db_session: AsyncSession, monkeypatch
):
    """Owner-chat can target an owned bot without switching X-Active-Agent."""
    token = seed_data["token"]
    user_id = seed_data["user_id"]
    db_session.add(
        Agent(
            agent_id="ag_secondbot01",
            display_name="Second Bot",
            message_policy=MessagePolicy.contacts_only,
            user_id=user_id,
            claimed_at=datetime.datetime.now(datetime.timezone.utc),
        )
    )
    await db_session.commit()

    headers = {"Authorization": f"Bearer {token}"}
    resp = await client.get(
        "/api/dashboard/chat/room",
        params={"agent_id": "ag_secondbot01"},
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == "ag_secondbot01"
    assert data["name"] == "Chat with Second Bot"

    from hub.routers import hub as hub_router

    monkeypatch.setattr(hub_router, "notify_inbox", AsyncMock())
    monkeypatch.setattr(hub_router, "_publish_agent_realtime_event", AsyncMock())

    send_resp = await client.post(
        "/api/dashboard/chat/send",
        json={"agent_id": "ag_secondbot01", "text": "hello second bot"},
        headers=headers,
    )
    assert send_resp.status_code == 202
    assert send_resp.json()["room_id"] == data["room_id"]

    messages_resp = await client.get(
        f"/api/dashboard/rooms/{data['room_id']}/messages",
        headers=headers,
    )
    assert messages_resp.status_code == 200
    assert len(messages_resp.json()["messages"]) == 1


# ---------------------------------------------------------------------------
# POST /api/dashboard/chat/send
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chat_send_success(
    client: AsyncClient, seed_data: dict, monkeypatch
):
    """Successful send returns 202 with hub_msg_id."""
    token = seed_data["token"]
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Active-Agent": "ag_dashtest001",
    }

    # Mock notify_inbox and _publish_agent_realtime_event so we don't need
    # the full hub WebSocket infrastructure.
    from hub.routers import hub as hub_router

    monkeypatch.setattr(hub_router, "notify_inbox", AsyncMock())
    monkeypatch.setattr(hub_router, "_publish_agent_realtime_event", AsyncMock())

    resp = await client.post(
        "/api/dashboard/chat/send",
        json={"text": "Hello from dashboard"},
        headers=headers,
    )
    assert resp.status_code == 202
    data = resp.json()
    assert "hub_msg_id" in data
    assert data["hub_msg_id"].startswith("h_")
    assert "room_id" in data
    assert data["status"] == "queued"
