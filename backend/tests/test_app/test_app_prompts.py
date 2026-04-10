"""Tests for /api/prompts endpoints."""

import datetime

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import MessagePolicy, RoomVisibility, RoomJoinPolicy
from hub.models import Agent, Base, Invite, Room, Share

from tests.test_app.conftest import create_test_engine


@pytest_asyncio.fixture
async def db_session():
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
async def client(db_session: AsyncSession):
    from hub.main import app
    from hub.database import get_db
    from unittest.mock import AsyncMock

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    app.state.http_client = AsyncMock(spec=AsyncClient)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def seed_agent(db_session: AsyncSession) -> Agent:
    agent = Agent(
        agent_id="ag_creator",
        display_name="Creator",
        message_policy=MessagePolicy.open,
    )
    db_session.add(agent)
    await db_session.commit()
    return agent


@pytest_asyncio.fixture
async def seed_room(db_session: AsyncSession, seed_agent: Agent) -> Room:
    room = Room(
        room_id="rm_testroom",
        name="Test Room",
        owner_id=seed_agent.agent_id,
        visibility=RoomVisibility.public,
        join_policy=RoomJoinPolicy.open,
    )
    db_session.add(room)
    await db_session.commit()
    return room


@pytest_asyncio.fixture
async def seed_paid_room(db_session: AsyncSession, seed_agent: Agent) -> Room:
    room = Room(
        room_id="rm_paidroom",
        name="Paid Room",
        owner_id=seed_agent.agent_id,
        visibility=RoomVisibility.private,
        join_policy=RoomJoinPolicy.invite_only,
        required_subscription_product_id="sp_test",
    )
    db_session.add(room)
    await db_session.commit()
    return room


@pytest_asyncio.fixture
async def seed_room_invite(db_session: AsyncSession, seed_room: Room, seed_agent: Agent) -> Invite:
    invite = Invite(
        code="iv_testroomcode",
        kind="room",
        creator_agent_id=seed_agent.agent_id,
        room_id=seed_room.room_id,
        max_uses=10,
    )
    db_session.add(invite)
    await db_session.commit()
    return invite


@pytest_asyncio.fixture
async def seed_friend_invite(db_session: AsyncSession, seed_agent: Agent) -> Invite:
    invite = Invite(
        code="iv_testfriendcode",
        kind="friend",
        creator_agent_id=seed_agent.agent_id,
        max_uses=1,
    )
    db_session.add(invite)
    await db_session.commit()
    return invite


@pytest_asyncio.fixture
async def seed_share(db_session: AsyncSession, seed_room: Room, seed_agent: Agent) -> Share:
    share = Share(
        share_id="sh_testshare",
        room_id=seed_room.room_id,
        shared_by_agent_id=seed_agent.agent_id,
        shared_by_name="Creator",
    )
    db_session.add(share)
    await db_session.commit()
    return share


# ---------------------------------------------------------------------------
# /api/prompts/share
# ---------------------------------------------------------------------------

class TestSharePrompt:
    @pytest.mark.asyncio
    async def test_share_with_invite_code_zh(self, client: AsyncClient, seed_room_invite: Invite):
        resp = await client.get("/api/prompts/share", params={
            "invite_code": seed_room_invite.code,
            "language": "zh",
        })
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "BotCord 群邀请" in prompt
        assert "Test Room" in prompt
        assert seed_room_invite.code in prompt
        assert "botcord_contacts" in prompt
        assert "redeem_invite" in prompt

    @pytest.mark.asyncio
    async def test_share_with_invite_code_en(self, client: AsyncClient, seed_room_invite: Invite):
        resp = await client.get("/api/prompts/share", params={
            "invite_code": seed_room_invite.code,
            "language": "en",
        })
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "invitation to a BotCord group" in prompt
        assert "Test Room" in prompt
        assert "redeem_invite" in prompt

    @pytest.mark.asyncio
    async def test_share_with_room_id_zh(self, client: AsyncClient, seed_room: Room):
        resp = await client.get("/api/prompts/share", params={
            "room_id": seed_room.room_id,
            "language": "zh",
        })
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "BotCord 群邀请" in prompt
        assert "botcord_rooms" in prompt
        assert seed_room.room_id in prompt

    @pytest.mark.asyncio
    async def test_share_with_share_id(self, client: AsyncClient, seed_share: Share):
        resp = await client.get("/api/prompts/share", params={
            "share_id": seed_share.share_id,
            "language": "en",
        })
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "share details" in prompt
        assert seed_share.share_id in prompt

    @pytest.mark.asyncio
    async def test_share_paid_room(self, client: AsyncClient, seed_paid_room: Room, db_session: AsyncSession):
        invite = Invite(
            code="iv_paidinvite",
            kind="room",
            creator_agent_id="ag_creator",
            room_id=seed_paid_room.room_id,
            max_uses=10,
        )
        db_session.add(invite)
        await db_session.commit()

        resp = await client.get("/api/prompts/share", params={
            "invite_code": "iv_paidinvite",
            "language": "zh",
        })
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "付费订阅" in prompt
        assert "步骤一" in prompt
        assert "步骤二" in prompt
        assert "sp_test" in prompt
        assert "botcord_subscription" in prompt

    @pytest.mark.asyncio
    async def test_share_missing_params(self, client: AsyncClient):
        resp = await client.get("/api/prompts/share")
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_share_conflicting_params(self, client: AsyncClient, seed_room_invite: Invite, seed_room: Room):
        resp = await client.get("/api/prompts/share", params={
            "invite_code": seed_room_invite.code,
            "room_id": seed_room.room_id,
        })
        assert resp.status_code == 400
        assert "Only one" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_share_invalid_invite(self, client: AsyncClient):
        resp = await client.get("/api/prompts/share", params={"invite_code": "iv_nonexistent"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_share_revoked_invite(self, client: AsyncClient, seed_room_invite: Invite, db_session: AsyncSession):
        seed_room_invite.revoked_at = datetime.datetime.now(datetime.timezone.utc)
        await db_session.commit()
        resp = await client.get("/api/prompts/share", params={"invite_code": seed_room_invite.code})
        assert resp.status_code == 410

    @pytest.mark.asyncio
    async def test_share_expired_invite(self, client: AsyncClient, seed_agent, db_session: AsyncSession, seed_room: Room):
        invite = Invite(
            code="iv_expiredcode",
            kind="room",
            creator_agent_id=seed_agent.agent_id,
            room_id=seed_room.room_id,
            max_uses=10,
            expires_at=datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1),
        )
        db_session.add(invite)
        await db_session.commit()
        resp = await client.get("/api/prompts/share", params={"invite_code": "iv_expiredcode"})
        assert resp.status_code == 410

    @pytest.mark.asyncio
    async def test_share_friend_invite_rejected(self, client: AsyncClient, seed_friend_invite: Invite):
        resp = await client.get("/api/prompts/share", params={"invite_code": seed_friend_invite.code})
        assert resp.status_code == 400
        assert "friend invite" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_share_expired_share(self, client: AsyncClient, seed_agent, seed_room: Room, db_session: AsyncSession):
        from hub.models import Share
        share = Share(
            share_id="sh_expired",
            room_id=seed_room.room_id,
            shared_by_agent_id=seed_agent.agent_id,
            shared_by_name="Creator",
            expires_at=datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1),
        )
        db_session.add(share)
        await db_session.commit()
        resp = await client.get("/api/prompts/share", params={"share_id": "sh_expired"})
        assert resp.status_code == 410


# ---------------------------------------------------------------------------
# /api/prompts/friend-invite
# ---------------------------------------------------------------------------

class TestFriendInvitePrompt:
    @pytest.mark.asyncio
    async def test_friend_invite_zh(self, client: AsyncClient, seed_friend_invite: Invite):
        resp = await client.get("/api/prompts/friend-invite", params={
            "invite_code": seed_friend_invite.code,
            "language": "zh",
        })
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "好友邀请" in prompt
        assert seed_friend_invite.code in prompt
        assert "botcord_contacts" in prompt

    @pytest.mark.asyncio
    async def test_friend_invite_en(self, client: AsyncClient, seed_friend_invite: Invite):
        resp = await client.get("/api/prompts/friend-invite", params={
            "invite_code": seed_friend_invite.code,
            "language": "en",
        })
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "friend invite" in prompt
        assert "redeem_invite" in prompt

    @pytest.mark.asyncio
    async def test_friend_invite_not_found(self, client: AsyncClient):
        resp = await client.get("/api/prompts/friend-invite", params={
            "invite_code": "iv_nonexistent",
        })
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_friend_invite_with_room_invite_rejected(self, client: AsyncClient, seed_room_invite: Invite):
        resp = await client.get("/api/prompts/friend-invite", params={
            "invite_code": seed_room_invite.code,
        })
        assert resp.status_code == 400
        assert "not a friend invite" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_friend_invite_revoked(self, client: AsyncClient, seed_friend_invite: Invite, db_session: AsyncSession):
        seed_friend_invite.revoked_at = datetime.datetime.now(datetime.timezone.utc)
        await db_session.commit()
        resp = await client.get("/api/prompts/friend-invite", params={
            "invite_code": seed_friend_invite.code,
        })
        assert resp.status_code == 410


# ---------------------------------------------------------------------------
# /api/prompts/self-join
# ---------------------------------------------------------------------------

class TestSelfJoinPrompt:
    @pytest.mark.asyncio
    async def test_self_join_zh(self, client: AsyncClient, seed_room: Room):
        resp = await client.get("/api/prompts/self-join", params={
            "room_id": seed_room.room_id,
            "language": "zh",
        })
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "帮我加入" in prompt
        assert "Test Room" in prompt
        assert seed_room.room_id in prompt
        assert "botcord_rooms" in prompt

    @pytest.mark.asyncio
    async def test_self_join_en(self, client: AsyncClient, seed_room: Room):
        resp = await client.get("/api/prompts/self-join", params={
            "room_id": seed_room.room_id,
            "language": "en",
        })
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "Help me join" in prompt
        assert "Test Room" in prompt

    @pytest.mark.asyncio
    async def test_self_join_room_not_found(self, client: AsyncClient):
        resp = await client.get("/api/prompts/self-join", params={
            "room_id": "rm_nonexistent",
        })
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# /api/prompts/create-room
# ---------------------------------------------------------------------------

class TestCreateRoomPrompt:
    @pytest.mark.asyncio
    async def test_create_room_zh(self, client: AsyncClient):
        resp = await client.get("/api/prompts/create-room", params={"language": "zh"})
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "帮我创建" in prompt
        assert "botcord_rooms" in prompt
        assert "create" in prompt

    @pytest.mark.asyncio
    async def test_create_room_en(self, client: AsyncClient):
        resp = await client.get("/api/prompts/create-room", params={"language": "en"})
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        assert "Help me create" in prompt
        assert "botcord_rooms" in prompt

    @pytest.mark.asyncio
    async def test_create_room_default_language(self, client: AsyncClient):
        resp = await client.get("/api/prompts/create-room")
        assert resp.status_code == 200
        prompt = resp.json()["prompt"]
        # Default should be zh
        assert "帮我创建" in prompt
