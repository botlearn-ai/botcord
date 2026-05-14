import datetime
import json
import uuid
from unittest.mock import AsyncMock

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from hub.enums import MessagePolicy, MessageState, RoomJoinPolicy, RoomVisibility, TopicStatus
from hub.models import Agent, Base, MessageRecord, Room, Topic, User

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
async def seed_activity(db_session: AsyncSession):
    user_id = uuid.uuid4()
    supabase_uid = uuid.uuid4()
    other_user_id = uuid.uuid4()
    now = datetime.datetime.now(datetime.timezone.utc)
    old = now - datetime.timedelta(days=8)

    user = User(
        id=user_id,
        display_name="Stats User",
        email="stats@example.com",
        status="active",
        supabase_user_id=supabase_uid,
    )
    other = User(
        id=other_user_id,
        display_name="Other User",
        email="other@example.com",
        status="active",
        supabase_user_id=uuid.uuid4(),
    )
    db_session.add_all([user, other])
    db_session.add_all(
        [
            Agent(
                agent_id="ag_stats001",
                display_name="Stats One",
                message_policy=MessagePolicy.contacts_only,
                user_id=user_id,
                claimed_at=now,
                created_at=now,
            ),
            Agent(
                agent_id="ag_stats002",
                display_name="Stats Two",
                message_policy=MessagePolicy.contacts_only,
                user_id=user_id,
                claimed_at=now,
                created_at=now,
            ),
            Agent(
                agent_id="ag_other001",
                display_name="Other",
                message_policy=MessagePolicy.contacts_only,
                user_id=other_user_id,
                claimed_at=now,
                created_at=now,
            ),
        ]
    )
    db_session.add_all(
        [
            Room(
                room_id="rm_stats_main",
                name="Main",
                description="",
                owner_id="ag_stats001",
                visibility=RoomVisibility.private,
                join_policy=RoomJoinPolicy.invite_only,
                created_at=now,
            ),
            Room(
                room_id="rm_stats_other",
                name="Other",
                description="",
                owner_id="ag_stats002",
                visibility=RoomVisibility.private,
                join_policy=RoomJoinPolicy.invite_only,
                created_at=now,
            ),
        ]
    )
    db_session.add_all(
        [
            Topic(
                topic_id="tp_stats_open",
                room_id="rm_stats_main",
                title="Open",
                description="",
                status=TopicStatus.open,
                creator_id="ag_stats001",
                created_at=now,
                updated_at=now,
            ),
            Topic(
                topic_id="tp_stats_done",
                room_id="rm_stats_other",
                title="Done",
                description="",
                status=TopicStatus.completed,
                creator_id="ag_stats002",
                created_at=now,
                updated_at=now,
            ),
            Topic(
                topic_id="tp_stats_old",
                room_id="rm_stats_main",
                title="Old",
                description="",
                status=TopicStatus.open,
                creator_id="ag_stats001",
                created_at=old,
                updated_at=old,
            ),
        ]
    )

    def msg(
        hub_msg_id: str,
        msg_id: str,
        sender_id: str,
        receiver_id: str,
        room_id: str | None,
        created_at: datetime.datetime,
        topic_id: str | None = None,
    ) -> MessageRecord:
        return MessageRecord(
            hub_msg_id=hub_msg_id,
            msg_id=msg_id,
            sender_id=sender_id,
            receiver_id=receiver_id,
            room_id=room_id,
            topic_id=topic_id,
            state=MessageState.done,
            envelope_json=json.dumps({"payload": {"text": hub_msg_id}}),
            ttl_sec=3600,
            created_at=created_at,
        )

    db_session.add_all(
        [
            msg("h_stats_001", "m_stats_001", "ag_stats001", "ag_stats002", "rm_stats_main", now, "tp_stats_open"),
            msg("h_stats_002", "m_stats_001", "ag_stats001", "ag_other001", "rm_stats_main", now, "tp_stats_open"),
            msg("h_stats_003", "m_stats_002", "ag_stats002", "ag_stats001", "rm_stats_other", now, "tp_stats_done"),
            msg("h_stats_004", "m_stats_003", "ag_stats001", "ag_stats002", "rm_oc_secret", now),
            msg("h_stats_005", "m_stats_004", "ag_stats001", "ag_stats002", "rm_stats_main", old, "tp_stats_old"),
        ]
    )
    await db_session.commit()

    return {
        "token": _make_token(str(supabase_uid)),
    }


@pytest.mark.asyncio
async def test_activity_stats_batch_counts_owned_agents(client: AsyncClient, seed_activity: dict):
    resp = await client.get(
        "/api/dashboard/activity/stats/batch?period=7d&agent_ids=ag_stats001,ag_stats002",
        headers={"Authorization": f"Bearer {seed_activity['token']}"},
    )

    assert resp.status_code == 200
    stats = resp.json()["stats"]
    assert stats["ag_stats001"] == {
        "messages_sent": 1,
        "messages_received": 1,
        "topics_open": 1,
        "topics_completed": 1,
        "active_rooms": 2,
    }
    assert stats["ag_stats002"] == {
        "messages_sent": 1,
        "messages_received": 1,
        "topics_open": 1,
        "topics_completed": 1,
        "active_rooms": 2,
    }


@pytest.mark.asyncio
async def test_activity_stats_batch_rejects_unowned_agent(client: AsyncClient, seed_activity: dict):
    resp = await client.get(
        "/api/dashboard/activity/stats/batch?period=7d&agent_ids=ag_stats001,ag_other001",
        headers={"Authorization": f"Bearer {seed_activity['token']}"},
    )

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Agent not owned by user"
