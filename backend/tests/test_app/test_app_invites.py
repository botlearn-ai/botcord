"""Tests for /api/invites endpoints."""

import datetime
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from unittest.mock import AsyncMock

from hub.models import (
    Agent,
    Base,
    Contact,
    MessagePolicy,
    Role,
    Room,
    RoomJoinPolicy,
    RoomMember,
    RoomRole,
    RoomVisibility,
    User,
    UserRole,
)

TEST_SUPABASE_SECRET = "test-supabase-jwt-secret-for-unit-tests"


def _make_token(sub: str) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
        "iss": "supabase",
    }
    return jwt.encode(payload, TEST_SUPABASE_SECRET, algorithm="HS256")


@pytest_asyncio.fixture
async def db_session():
    from tests.test_app.conftest import create_test_engine

    engine = create_test_engine()
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
    import app.auth as app_auth
    import hub.config
    from hub.database import get_db
    from hub.main import app

    monkeypatch.setattr(hub.config, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)
    monkeypatch.setattr(app_auth, "SUPABASE_JWT_SECRET", TEST_SUPABASE_SECRET)

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
    owner_uid = uuid.uuid4()
    invitee_uid = uuid.uuid4()
    viewer_uid = uuid.uuid4()

    owner_user_id = uuid.uuid4()
    invitee_user_id = uuid.uuid4()
    viewer_user_id = uuid.uuid4()

    db_session.add_all([
        User(id=owner_user_id, display_name="Owner", email="owner@example.com", status="active", supabase_user_id=owner_uid),
        User(id=invitee_user_id, display_name="Invitee", email="invitee@example.com", status="active", supabase_user_id=invitee_uid),
        User(id=viewer_user_id, display_name="Viewer", email="viewer@example.com", status="active", supabase_user_id=viewer_uid),
    ])

    role = Role(id=uuid.uuid4(), name="member", display_name="Member", is_system=True, priority=0)
    db_session.add(role)
    await db_session.flush()
    db_session.add_all([
        UserRole(id=uuid.uuid4(), user_id=owner_user_id, role_id=role.id),
        UserRole(id=uuid.uuid4(), user_id=invitee_user_id, role_id=role.id),
        UserRole(id=uuid.uuid4(), user_id=viewer_user_id, role_id=role.id),
    ])

    owner_agent = Agent(
        agent_id="ag_owner001",
        display_name="Owner Agent",
        message_policy=MessagePolicy.open,
        user_id=owner_user_id,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    invitee_agent = Agent(
        agent_id="ag_invitee01",
        display_name="Invitee Agent",
        message_policy=MessagePolicy.open,
        user_id=invitee_user_id,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    viewer_agent = Agent(
        agent_id="ag_viewer001",
        display_name="Viewer Agent",
        message_policy=MessagePolicy.open,
        user_id=viewer_user_id,
        is_default=True,
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.add_all([owner_agent, invitee_agent, viewer_agent])

    private_room = Room(
        room_id="rm_private01",
        name="Private Room",
        description="private room",
        owner_id="ag_owner001",
        visibility=RoomVisibility.private,
        join_policy=RoomJoinPolicy.invite_only,
    )
    public_room = Room(
        room_id="rm_public001",
        name="Public Room",
        description="public room",
        owner_id="ag_owner001",
        visibility=RoomVisibility.public,
        join_policy=RoomJoinPolicy.open,
    )
    db_session.add_all([private_room, public_room])
    await db_session.flush()
    db_session.add_all([
        RoomMember(room_id="rm_private01", agent_id="ag_owner001", role=RoomRole.owner),
        RoomMember(room_id="rm_public001", agent_id="ag_owner001", role=RoomRole.owner),
    ])

    await db_session.commit()
    return {
        "owner": {"token": _make_token(str(owner_uid)), "agent_id": "ag_owner001"},
        "invitee": {"token": _make_token(str(invitee_uid)), "agent_id": "ag_invitee01"},
        "viewer": {"token": _make_token(str(viewer_uid)), "agent_id": "ag_viewer001"},
    }


def _headers(token: str, agent_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "X-Active-Agent": agent_id}


@pytest.mark.asyncio
async def test_create_and_redeem_friend_invite(client: AsyncClient, seed: dict, db_session: AsyncSession):
    create_resp = await client.post(
        "/api/invites/friends",
        headers=_headers(seed["owner"]["token"], seed["owner"]["agent_id"]),
    )
    assert create_resp.status_code == 201
    create_data = create_resp.json()
    assert create_data["kind"] == "friend"
    assert create_data["invite_url"].endswith(f"/i/{create_data['code']}")

    preview_resp = await client.get(f"/api/invites/{create_data['code']}")
    assert preview_resp.status_code == 200
    assert preview_resp.json()["creator"]["agent_id"] == "ag_owner001"

    redeem_resp = await client.post(
        f"/api/invites/{create_data['code']}/redeem",
        headers=_headers(seed["invitee"]["token"], seed["invitee"]["agent_id"]),
    )
    assert redeem_resp.status_code == 200
    assert redeem_resp.json()["status"] == "redeemed"
    assert redeem_resp.json()["continue_url"].endswith("/chats/contacts/agents")

    contacts = (
        await db_session.execute(
            select(Contact).where(Contact.owner_id == "ag_owner001")
        )
    ).scalars().all()
    assert [item.contact_agent_id for item in contacts] == ["ag_invitee01"]


@pytest.mark.asyncio
async def test_redeem_friend_invite_is_idempotent(client: AsyncClient, seed: dict):
    create_resp = await client.post(
        "/api/invites/friends",
        headers=_headers(seed["owner"]["token"], seed["owner"]["agent_id"]),
    )
    code = create_resp.json()["code"]

    first = await client.post(
        f"/api/invites/{code}/redeem",
        headers=_headers(seed["invitee"]["token"], seed["invitee"]["agent_id"]),
    )
    second = await client.post(
        f"/api/invites/{code}/redeem",
        headers=_headers(seed["invitee"]["token"], seed["invitee"]["agent_id"]),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["status"] == "already_connected"


@pytest.mark.asyncio
async def test_create_and_redeem_private_room_invite(client: AsyncClient, seed: dict):
    create_resp = await client.post(
        "/api/invites/rooms/rm_private01",
        headers=_headers(seed["owner"]["token"], seed["owner"]["agent_id"]),
    )
    assert create_resp.status_code == 201
    create_data = create_resp.json()
    assert create_data["kind"] == "room"
    assert create_data["entry_type"] == "private_invite"
    assert create_data["room"]["room_id"] == "rm_private01"

    redeem_resp = await client.post(
        f"/api/invites/{create_data['code']}/redeem",
        headers=_headers(seed["invitee"]["token"], seed["invitee"]["agent_id"]),
    )
    assert redeem_resp.status_code == 200
    assert redeem_resp.json()["status"] == "redeemed"
    assert redeem_resp.json()["continue_url"].endswith("/chats/messages/rm_private01")


@pytest.mark.asyncio
async def test_revoke_invite_blocks_future_use(client: AsyncClient, seed: dict):
    create_resp = await client.post(
        "/api/invites/friends",
        headers=_headers(seed["owner"]["token"], seed["owner"]["agent_id"]),
    )
    code = create_resp.json()["code"]

    revoke_resp = await client.delete(
        f"/api/invites/{code}",
        headers=_headers(seed["owner"]["token"], seed["owner"]["agent_id"]),
    )
    assert revoke_resp.status_code == 200

    preview_resp = await client.get(f"/api/invites/{code}")
    assert preview_resp.status_code == 410


@pytest.mark.asyncio
async def test_non_member_cannot_create_room_invite(client: AsyncClient, seed: dict):
    resp = await client.post(
        "/api/invites/rooms/rm_private01",
        headers=_headers(seed["viewer"]["token"], seed["viewer"]["agent_id"]),
    )
    assert resp.status_code == 403
