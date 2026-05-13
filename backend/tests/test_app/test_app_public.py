"""Tests for /api/public and /api/stats endpoints."""

import datetime
import json
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from unittest.mock import AsyncMock

from hub.models import (
    Agent,
    Base,
    MessagePolicy,
    MessageRecord,
    MessageState,
    Role,
    Room,
    RoomJoinPolicy,
    RoomMember,
    RoomRole,
    RoomVisibility,
    User,
    UserRole,
)

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


@pytest_asyncio.fixture
async def db_session():
    from tests.test_app.conftest import create_test_engine; engine = create_test_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
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

    async def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def seed(db_session: AsyncSession):
    """Seed with agents, public room, private room, and messages."""
    uid = uuid.uuid4()
    supa = uuid.uuid4()
    user = User(id=uid, display_name="User", email="u@x.com", status="active", supabase_user_id=supa)
    db_session.add(user)

    role = Role(id=uuid.uuid4(), name="member", display_name="Member", is_system=True, priority=0)
    db_session.add(role)
    await db_session.flush()
    db_session.add(UserRole(id=uuid.uuid4(), user_id=uid, role_id=role.id))

    a1 = Agent(agent_id="ag_pub_agent1", display_name="Public Agent", message_policy=MessagePolicy.open,
               user_id=uid, is_default=True, claimed_at=datetime.datetime.now(datetime.timezone.utc))
    a2 = Agent(agent_id="ag_pub_agent2", display_name="Agent Two", message_policy=MessagePolicy.contacts_only)
    db_session.add_all([a1, a2])
    await db_session.flush()

    # Public room
    pub_room = Room(
        room_id="rm_public001", name="Public Room", description="A public room",
        owner_id="ag_pub_agent1", visibility=RoomVisibility.public, join_policy=RoomJoinPolicy.open,
    )
    db_session.add(pub_room)
    await db_session.flush()
    db_session.add(RoomMember(room_id="rm_public001", agent_id="ag_pub_agent1", role=RoomRole.owner))

    # Private room
    priv_room = Room(
        room_id="rm_private01", name="Private Room", description="A private room",
        owner_id="ag_pub_agent1", visibility=RoomVisibility.private, join_policy=RoomJoinPolicy.invite_only,
    )
    db_session.add(priv_room)
    await db_session.flush()
    db_session.add(RoomMember(room_id="rm_private01", agent_id="ag_pub_agent1", role=RoomRole.owner))

    # Messages in public room
    envelope = json.dumps({"from": "ag_pub_agent1", "type": "message", "payload": {"text": "Hello world"}})
    msg = MessageRecord(
        hub_msg_id="h_pubmsg001", msg_id="m_pubmsg001", sender_id="ag_pub_agent1",
        receiver_id="ag_pub_agent1", room_id="rm_public001", envelope_json=envelope,
        state=MessageState.delivered, ttl_sec=3600,
    )
    db_session.add(msg)

    await db_session.commit()
    return {}


@pytest.mark.asyncio
async def test_public_overview(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/overview")
    assert resp.status_code == 200
    data = resp.json()
    assert "stats" in data
    assert data["stats"]["total_agents"] >= 2
    assert data["stats"]["public_rooms"] >= 1
    assert "featured_rooms" in data
    assert "recent_agents" in data


@pytest.mark.asyncio
async def test_public_rooms_list(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/rooms")
    assert resp.status_code == 200
    data = resp.json()
    assert "rooms" in data
    assert "total" in data
    room_ids = [r["room_id"] for r in data["rooms"]]
    assert "rm_public001" in room_ids
    assert "rm_private01" not in room_ids


@pytest.mark.asyncio
async def test_public_rooms_search(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/rooms?q=Public")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["rooms"]) >= 1
    assert data["rooms"][0]["room_id"] == "rm_public001"


@pytest.mark.asyncio
async def test_public_room_members(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/rooms/rm_public001/members")
    assert resp.status_code == 200
    data = resp.json()
    assert "members" in data
    assert "room_id" in data
    assert len(data["members"]) >= 1
    assert data["members"][0]["agent_id"] == "ag_pub_agent1"


@pytest.mark.asyncio
async def test_public_room_members_private_404(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/rooms/rm_private01/members")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_public_room_messages(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/rooms/rm_public001/messages")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) >= 1
    assert data["messages"][0]["text"] == "Hello world"


@pytest.mark.asyncio
async def test_public_room_messages_private_403(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/rooms/rm_private01/messages")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_subscription_room_message_previews_are_safe(
    client: AsyncClient,
    db_session: AsyncSession,
    seed: dict,
):
    room_result = await db_session.execute(
        select(Room).where(Room.room_id == "rm_public001")
    )
    room = room_result.scalar_one()
    room.required_subscription_product_id = "sp_preview"

    long_text = "paid alpha " * 30
    for idx in range(4):
        envelope = json.dumps({
            "from": "ag_pub_agent1",
            "type": "message",
            "payload": {"text": f"{long_text}{idx}"},
        })
        db_session.add(MessageRecord(
            hub_msg_id=f"h_preview{idx}",
            msg_id=f"m_preview{idx}",
            sender_id="ag_pub_agent1",
            receiver_id="ag_pub_agent1",
            room_id="rm_public001",
            envelope_json=envelope,
            state=MessageState.delivered,
            ttl_sec=3600,
        ))
    await db_session.commit()

    resp = await client.get("/api/public/rooms/rm_public001/message-previews")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 3
    for item in data["messages"]:
        assert set(item) == {"hub_msg_id", "sender_id", "sender_name", "preview", "created_at"}
        assert item["sender_name"] == "Public Agent"
        assert len(item["preview"]) <= 99
        assert item["preview"].endswith("...")


@pytest.mark.asyncio
async def test_subscription_room_message_previews_require_subscription_room(
    client: AsyncClient,
    seed: dict,
):
    resp = await client.get("/api/public/rooms/rm_public001/message-previews")
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_subscription_room_message_previews_private_403(
    client: AsyncClient,
    db_session: AsyncSession,
    seed: dict,
):
    room_result = await db_session.execute(
        select(Room).where(Room.room_id == "rm_private01")
    )
    room = room_result.scalar_one()
    room.required_subscription_product_id = "sp_preview"
    await db_session.commit()

    resp = await client.get("/api/public/rooms/rm_private01/message-previews")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_public_agents_list(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/agents")
    assert resp.status_code == 200
    data = resp.json()
    assert "agents" in data
    assert "total" in data
    assert len(data["agents"]) >= 2


@pytest.mark.asyncio
async def test_public_agents_list_orders_by_newest_created(
    client: AsyncClient,
    db_session: AsyncSession,
):
    older = Agent(
        agent_id="ag_public_older",
        display_name="Older Agent",
        message_policy=MessagePolicy.open,
        created_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
    )
    newer = Agent(
        agent_id="ag_public_newer",
        display_name="Newer Agent",
        message_policy=MessagePolicy.open,
        created_at=datetime.datetime(2026, 1, 2, tzinfo=datetime.timezone.utc),
    )
    db_session.add_all([older, newer])
    await db_session.commit()

    resp = await client.get("/api/public/agents")

    assert resp.status_code == 200
    agent_ids = [agent["agent_id"] for agent in resp.json()["agents"]]
    assert agent_ids[:2] == ["ag_public_newer", "ag_public_older"]


@pytest.mark.asyncio
async def test_public_agents_search(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/agents?q=Public")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["agents"]) >= 1
    assert data["agents"][0]["agent_id"] == "ag_pub_agent1"


@pytest.mark.asyncio
async def test_public_agent_detail(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/agents/ag_pub_agent1")
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == "ag_pub_agent1"
    assert data["display_name"] == "Public Agent"


@pytest.mark.asyncio
async def test_public_agent_not_found(client: AsyncClient, seed: dict):
    resp = await client.get("/api/public/agents/ag_nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_stats(client: AsyncClient, seed: dict):
    resp = await client.get("/api/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_agents"] >= 2
    assert data["total_rooms"] >= 2
    assert data["public_rooms"] >= 1
    assert data["total_messages"] >= 1
