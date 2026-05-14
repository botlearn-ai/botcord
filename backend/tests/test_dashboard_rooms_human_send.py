"""Tests for POST /api/dashboard/rooms/{room_id}/send — human-in-chat MVP."""

import datetime
import json
import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from unittest.mock import AsyncMock

from hub.enums import ParticipantType, TopicStatus
from hub.models import (
    Agent,
    Base,
    Block,
    MessagePolicy,
    MessageRecord,
    Role,
    Room,
    RoomJoinPolicy,
    RoomMember,
    RoomRole,
    RoomVisibility,
    Topic,
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
    # User 1 (sender) with active agent ag_user1
    uid1 = uuid.uuid4()
    supa1 = uuid.uuid4()
    uid2 = uuid.uuid4()
    supa2 = uuid.uuid4()
    uid3 = uuid.uuid4()
    supa3 = uuid.uuid4()

    db_session.add(User(id=uid1, display_name="Alice", email="a@x.com", status="active", supabase_user_id=supa1))
    db_session.add(User(id=uid2, display_name="Bob", email="b@x.com", status="active", supabase_user_id=supa2))
    db_session.add(User(id=uid3, display_name="Carol", email="c@x.com", status="active", supabase_user_id=supa3))

    role = Role(id=uuid.uuid4(), name="member", display_name="Member", is_system=True, priority=0)
    db_session.add(role)
    await db_session.flush()
    for u in (uid1, uid2, uid3):
        db_session.add(UserRole(id=uuid.uuid4(), user_id=u, role_id=role.id))

    now = datetime.datetime.now(datetime.timezone.utc)
    a1 = Agent(
        agent_id="ag_user1___", display_name="Alice Agent", message_policy=MessagePolicy.open,
        user_id=uid1, is_default=True, claimed_at=now,
    )
    a2 = Agent(
        agent_id="ag_user2___", display_name="Bob Agent", message_policy=MessagePolicy.open,
        user_id=uid2, is_default=True, claimed_at=now,
    )
    a3 = Agent(
        agent_id="ag_user3___", display_name="Carol Agent", message_policy=MessagePolicy.open,
        user_id=uid3, is_default=True, claimed_at=now,
    )
    a_stranger = Agent(
        agent_id="ag_stranger", display_name="Stranger Agent", message_policy=MessagePolicy.open,
        user_id=uid2, is_default=False,
    )
    db_session.add_all([a1, a2, a3, a_stranger])
    await db_session.flush()

    # Public room: a1 owner, a2 admin, a3 member. a2 muted.
    room = Room(
        room_id="rm_humanroom", name="Group", description="group",
        owner_id="ag_user1___", visibility=RoomVisibility.public, join_policy=RoomJoinPolicy.open,
        default_send=True,
    )
    db_session.add(room)
    await db_session.flush()
    db_session.add(RoomMember(room_id="rm_humanroom", agent_id="ag_user1___", role=RoomRole.owner))
    db_session.add(RoomMember(room_id="rm_humanroom", agent_id="ag_user2___", role=RoomRole.admin, muted=True))
    db_session.add(RoomMember(room_id="rm_humanroom", agent_id="ag_user3___", role=RoomRole.member))

    # Second room where a1 is a member but can_send=False
    room_readonly = Room(
        room_id="rm_readonly_", name="ReadOnly", description="readonly",
        owner_id="ag_user3___", visibility=RoomVisibility.public, join_policy=RoomJoinPolicy.open,
        default_send=False,
    )
    db_session.add(room_readonly)
    await db_session.flush()
    db_session.add(RoomMember(room_id="rm_readonly_", agent_id="ag_user3___", role=RoomRole.owner))
    db_session.add(RoomMember(room_id="rm_readonly_", agent_id="ag_user1___", role=RoomRole.member, can_send=False))

    # Third room a1 is NOT a member of
    room_no = Room(
        room_id="rm_nomember_", name="NoMember", description="",
        owner_id="ag_user3___", visibility=RoomVisibility.public, join_policy=RoomJoinPolicy.open,
        default_send=True,
    )
    db_session.add(room_no)
    await db_session.flush()
    db_session.add(RoomMember(room_id="rm_nomember_", agent_id="ag_user3___", role=RoomRole.owner))

    await db_session.commit()
    return {
        "token1": _make_token(str(supa1)),
        "token2": _make_token(str(supa2)),
        "agent1": "ag_user1___",
        "agent2": "ag_user2___",
        "agent3": "ag_user3___",
        "agent_stranger": "ag_stranger",
        "uid1": str(uid1),
        "user1_name": "Alice",
    }


def _h(token: str, agent_id: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Active-Agent": agent_id}


@pytest.mark.asyncio
async def test_not_logged_in_rejected(client: AsyncClient, seed: dict):
    r = await client.post("/api/dashboard/rooms/rm_humanroom/send", json={"text": "hi"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_missing_active_agent_without_human_membership(client: AsyncClient, seed: dict):
    # No X-Active-Agent → Human path. Alice has no RoomMember row as Human,
    # so she can't send as Human either → 403 "Sender is not a room member".
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers={"Authorization": f"Bearer {seed['token1']}"},
        json={"text": "hi"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_human_send_inherits_highest_owned_bot_role(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    user = (
        await db_session.execute(select(User).where(User.id == uuid.UUID(seed["uid1"])))
    ).scalar_one()
    room = Room(
        room_id="rm_human_inherit",
        name="Inherited",
        description="",
        owner_id=seed["agent3"],
        visibility=RoomVisibility.public,
        join_policy=RoomJoinPolicy.open,
        default_send=False,
    )
    db_session.add(room)
    await db_session.flush()
    db_session.add_all([
        RoomMember(room_id=room.room_id, agent_id=seed["agent3"], role=RoomRole.owner),
        RoomMember(
            room_id=room.room_id,
            agent_id=seed["agent1"],
            participant_type=ParticipantType.agent,
            role=RoomRole.admin,
        ),
        RoomMember(
            room_id=room.room_id,
            agent_id=user.human_id,
            participant_type=ParticipantType.human,
            role=RoomRole.member,
            can_send=False,
        ),
    ])
    await db_session.commit()

    r = await client.post(
        "/api/dashboard/rooms/rm_human_inherit/send",
        headers={"Authorization": f"Bearer {seed['token1']}"},
        json={"text": "inherited admin can send"},
    )
    assert r.status_code == 202, r.text


@pytest.mark.asyncio
async def test_active_agent_send_inherits_sibling_owned_bot_role(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    sibling = Agent(
        agent_id="ag_user1adm",
        display_name="Alice Admin Sibling",
        message_policy=MessagePolicy.open,
        user_id=uuid.UUID(seed["uid1"]),
        claimed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    room = Room(
        room_id="rm_sibling_role",
        name="Sibling Role",
        description="",
        owner_id=seed["agent3"],
        visibility=RoomVisibility.public,
        join_policy=RoomJoinPolicy.open,
        default_send=False,
    )
    db_session.add_all([sibling, room])
    await db_session.flush()
    db_session.add_all([
        RoomMember(room_id=room.room_id, agent_id=seed["agent3"], role=RoomRole.owner),
        RoomMember(
            room_id=room.room_id,
            agent_id=seed["agent1"],
            participant_type=ParticipantType.agent,
            role=RoomRole.member,
            can_send=False,
        ),
        RoomMember(
            room_id=room.room_id,
            agent_id="ag_user1adm",
            participant_type=ParticipantType.agent,
            role=RoomRole.admin,
        ),
    ])
    await db_session.commit()

    r = await client.post(
        "/api/dashboard/rooms/rm_sibling_role/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "sibling admin can send"},
    )
    assert r.status_code == 202, r.text


@pytest.mark.asyncio
async def test_human_send_respects_owned_bot_explicit_send_deny(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    user = (
        await db_session.execute(select(User).where(User.id == uuid.UUID(seed["uid1"])))
    ).scalar_one()
    room = Room(
        room_id="rm_admin_send_deny",
        name="Admin Deny",
        description="",
        owner_id=seed["agent3"],
        visibility=RoomVisibility.public,
        join_policy=RoomJoinPolicy.open,
        default_send=False,
    )
    db_session.add(room)
    await db_session.flush()
    db_session.add_all([
        RoomMember(room_id=room.room_id, agent_id=seed["agent3"], role=RoomRole.owner),
        RoomMember(
            room_id=room.room_id,
            agent_id=seed["agent1"],
            participant_type=ParticipantType.agent,
            role=RoomRole.admin,
            can_send=False,
        ),
        RoomMember(
            room_id=room.room_id,
            agent_id=user.human_id,
            participant_type=ParticipantType.human,
            role=RoomRole.member,
            can_send=False,
        ),
    ])
    await db_session.commit()

    r = await client.post(
        "/api/dashboard/rooms/rm_admin_send_deny/send",
        headers={"Authorization": f"Bearer {seed['token1']}"},
        json={"text": "denied"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_active_agent_not_owned(client: AsyncClient, seed: dict):
    # token1 is Alice; ag_user2___ belongs to Bob
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent2"]),
        json={"text": "hi"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_not_member(client: AsyncClient, seed: dict):
    r = await client.post(
        "/api/dashboard/rooms/rm_nomember_/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "hi"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_member_cannot_send(client: AsyncClient, seed: dict):
    r = await client.post(
        "/api/dashboard/rooms/rm_readonly_/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "hi"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_happy_path_fanout(client: AsyncClient, seed: dict, db_session: AsyncSession):
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "hello everyone"},
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["room_id"] == "rm_humanroom"
    assert body["status"] == "queued"

    # Verify persistence: fan-out rows for all non-muted members (a1 + a3). a2 is muted.
    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.room_id == "rm_humanroom")
    )).scalars().all()
    receiver_ids = {r.receiver_id for r in rows}
    assert "ag_user1___" in receiver_ids  # active agent included (PRD §6.3)
    assert "ag_user3___" in receiver_ids
    assert "ag_user2___" not in receiver_ids  # muted — excluded
    for rec in rows:
        assert rec.source_type == "dashboard_human_room"
        assert rec.source_session_kind == "room_human"
        assert rec.source_user_id == seed["uid1"]
        assert rec.sender_id == "ag_user1___"


@pytest.mark.asyncio
async def test_attachment_only_message_allowed(client: AsyncClient, seed: dict, db_session: AsyncSession):
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={
            "text": "",
            "attachments": [
                {
                    "filename": "diagnostics.zip",
                    "url": "/hub/files/f_diagnostics",
                    "content_type": "application/zip",
                    "size_bytes": 123,
                }
            ],
        },
    )
    assert r.status_code == 202, r.text

    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.room_id == "rm_humanroom")
    )).scalars().all()
    assert rows
    env = json.loads(rows[0].envelope_json)
    assert env["payload"]["text"] == ""
    assert env["payload"]["attachments"][0]["filename"] == "diagnostics.zip"


@pytest.mark.asyncio
async def test_empty_message_without_attachments_rejected(client: AsyncClient, seed: dict):
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": ""},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "Message must contain text or attachments"


@pytest.mark.asyncio
async def test_topic_reply_keeps_message_in_topic(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    topic = Topic(
        topic_id="tp_replytopic",
        room_id="rm_humanroom",
        title="Support thread",
        status=TopicStatus.open,
        creator_id=seed["agent1"],
        message_count=1,
    )
    db_session.add(topic)
    await db_session.commit()

    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "thread reply", "topic_id": "tp_replytopic"},
    )
    assert r.status_code == 202, r.text
    assert r.json()["topic_id"] == "tp_replytopic"

    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.room_id == "rm_humanroom")
    )).scalars().all()
    assert rows
    for rec in rows:
        assert rec.topic_id == "tp_replytopic"
        assert rec.topic == "Support thread"
        env = json.loads(rec.envelope_json)
        assert env["topic"] == "Support thread"

    refreshed = (await db_session.execute(
        select(Topic).where(Topic.topic_id == "tp_replytopic")
    )).scalar_one()
    assert refreshed.message_count == 2


@pytest.mark.asyncio
async def test_topic_reply_rejects_topic_from_other_room(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    other_room = Room(
        room_id="rm_other_topic",
        name="Other",
        description="",
        owner_id=seed["agent1"],
        visibility=RoomVisibility.public,
        join_policy=RoomJoinPolicy.open,
        default_send=True,
    )
    db_session.add(other_room)
    db_session.add(Topic(
        topic_id="tp_otherroom",
        room_id="rm_other_topic",
        title="Other thread",
        status=TopicStatus.open,
        creator_id=seed["agent1"],
        message_count=1,
    ))
    await db_session.commit()

    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "wrong thread", "topic_id": "tp_otherroom"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_human_path_sends_without_active_agent(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    # Add Alice as a Human RoomMember in rm_humanroom (hu_* identity, participant_type=human).
    user_row = await db_session.execute(select(User).where(User.id == uuid.UUID(seed["uid1"])))
    alice = user_row.scalar_one()
    human_id = alice.human_id
    assert human_id and human_id.startswith("hu_")
    db_session.add(
        RoomMember(
            room_id="rm_humanroom",
            agent_id=human_id,
            participant_type=ParticipantType.human,
            role=RoomRole.member,
        )
    )
    await db_session.commit()

    # POST without X-Active-Agent — should succeed via Human path.
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers={"Authorization": f"Bearer {seed['token1']}"},
        json={"text": "hello from human"},
    )
    assert r.status_code == 202, r.text

    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.room_id == "rm_humanroom")
    )).scalars().all()
    assert rows, "expected message records to be persisted"
    for rec in rows:
        assert rec.sender_id == human_id
        assert rec.source_type == "dashboard_human_room"
        assert rec.source_user_id == seed["uid1"]


@pytest.mark.asyncio
async def test_default_allow_human_send_is_true(db_session: AsyncSession, seed: dict):
    row = await db_session.execute(select(Room).where(Room.room_id == "rm_humanroom"))
    room = row.scalar_one()
    assert room.allow_human_send is True


@pytest.mark.asyncio
async def test_member_send_blocked_when_allow_human_send_false(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    row = await db_session.execute(select(Room).where(Room.room_id == "rm_humanroom"))
    room = row.scalar_one()
    room.allow_human_send = False
    await db_session.commit()

    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "hi"},
    )
    assert r.status_code == 403
    assert "Human send disabled" in r.json()["detail"]


@pytest.mark.asyncio
async def test_non_member_detail_distinct_from_member_disabled(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    # Disable human send on rm_nomember_ — a1 is NOT a member there.
    row = await db_session.execute(select(Room).where(Room.room_id == "rm_nomember_"))
    room = row.scalar_one()
    room.allow_human_send = False
    await db_session.commit()

    r = await client.post(
        "/api/dashboard/rooms/rm_nomember_/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "hi"},
    )
    assert r.status_code == 403
    non_member_detail = r.json()["detail"]
    assert "Human send disabled" not in non_member_detail

    # And a member-disabled room produces a different message
    row2 = await db_session.execute(select(Room).where(Room.room_id == "rm_humanroom"))
    room2 = row2.scalar_one()
    room2.allow_human_send = False
    await db_session.commit()

    r2 = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "hi"},
    )
    assert r2.status_code == 403
    member_disabled_detail = r2.json()["detail"]
    assert member_disabled_detail != non_member_detail
    assert "Human send disabled" in member_disabled_detail


def _agent_auth(agent_id: str) -> dict:
    from hub.auth import create_agent_token
    token, _ = create_agent_token(agent_id)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_patch_room_owner_can_toggle_allow_human_send(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    r = await client.patch(
        "/hub/rooms/rm_humanroom",
        json={"allow_human_send": False},
        headers=_agent_auth(seed["agent1"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["allow_human_send"] is False

    db_session.expire_all()
    row = await db_session.execute(select(Room).where(Room.room_id == "rm_humanroom"))
    assert row.scalar_one().allow_human_send is False


@pytest.mark.asyncio
async def test_patch_room_admin_can_toggle_allow_human_send(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    # agent2 is admin in rm_humanroom
    r = await client.patch(
        "/hub/rooms/rm_humanroom",
        json={"allow_human_send": False},
        headers=_agent_auth(seed["agent2"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["allow_human_send"] is False


@pytest.mark.asyncio
async def test_patch_room_member_cannot_toggle(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    # agent3 is plain member in rm_humanroom
    r = await client.patch(
        "/hub/rooms/rm_humanroom",
        json={"allow_human_send": False},
        headers=_agent_auth(seed["agent3"]),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_get_room_returns_allow_human_send(
    client: AsyncClient, seed: dict
):
    r = await client.get(
        "/hub/rooms/rm_humanroom",
        headers=_agent_auth(seed["agent1"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["allow_human_send"] is True


@pytest.mark.asyncio
async def test_list_my_rooms_returns_allow_human_send(
    client: AsyncClient, seed: dict
):
    r = await client.get(
        "/hub/rooms/me",
        headers=_agent_auth(seed["agent1"]),
    )
    assert r.status_code == 200, r.text
    rooms = r.json()["rooms"]
    assert rooms
    for room in rooms:
        assert "allow_human_send" in room


@pytest.mark.asyncio
async def test_dashboard_overview_rooms_include_allow_human_send(
    client: AsyncClient, seed: dict
):
    r = await client.get(
        "/api/dashboard/overview",
        headers=_h(seed["token1"], seed["agent1"]),
    )
    assert r.status_code == 200, r.text
    rooms = r.json()["rooms"]
    assert rooms
    for room in rooms:
        assert "allow_human_send" in room
        assert isinstance(room["allow_human_send"], bool)


@pytest.mark.asyncio
async def test_history_exposes_human_sender_fields(client: AsyncClient, seed: dict):
    # Send first
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "hello from human"},
    )
    assert r.status_code == 202, r.text

    # Read room history via app router
    r2 = await client.get(
        "/api/dashboard/rooms/rm_humanroom/messages",
        headers=_h(seed["token1"], seed["agent1"]),
    )
    assert r2.status_code == 200, r2.text
    data = r2.json()
    msgs = data["messages"]
    # Find the human message
    human_msgs = [m for m in msgs if m.get("source_type") == "dashboard_human_room"]
    assert human_msgs, f"no human message found; got={msgs}"
    m = human_msgs[0]
    assert m["sender_kind"] == "human"
    assert m["display_sender_name"] == seed["user1_name"]
    assert m["source_user_id"] == seed["uid1"]
    assert m["source_user_name"] == seed["user1_name"]
    assert m["is_mine"] is True


@pytest.mark.asyncio
async def test_dashboard_patch_room_owner_can_toggle_via_bff(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    # Owner (active agent = agent1) toggles via the BFF route using the
    # browser-friendly Supabase JWT + X-Active-Agent.
    r = await client.patch(
        "/api/dashboard/rooms/rm_humanroom",
        json={"allow_human_send": False},
        headers=_h(seed["token1"], seed["agent1"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["allow_human_send"] is False

    db_session.expire_all()
    row = await db_session.execute(select(Room).where(Room.room_id == "rm_humanroom"))
    assert row.scalar_one().allow_human_send is False


@pytest.mark.asyncio
async def test_dashboard_patch_room_member_rejected_via_bff(
    client: AsyncClient, seed: dict
):
    # agent3 is a plain member; hub-layer update_room rejects non-admin/owner.
    r = await client.patch(
        "/api/dashboard/rooms/rm_humanroom",
        json={"allow_human_send": False},
        headers=_h(seed["token1"], seed["agent3"]),
    )
    # token1 (supa1) does not own agent3, so require_active_agent rejects at
    # the BFF boundary before reaching the hub-layer check.
    assert r.status_code in (403, 404), r.text


@pytest.mark.asyncio
async def test_hub_inbox_human_message_surfaces_source_user_name(
    client: AsyncClient, seed: dict
):
    # Send as human
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "hi plugin"},
    )
    assert r.status_code == 202, r.text

    # agent3 (room member) polls the hub inbox — should receive the human
    # message with source_user_name populated via the Supabase UUID lookup.
    r2 = await client.get("/hub/inbox", headers=_agent_auth(seed["agent3"]))
    assert r2.status_code == 200, r2.text
    msgs = r2.json()["messages"]
    human = [m for m in msgs if m.get("source_type") == "dashboard_human_room"]
    assert human, f"no human message reached hub inbox; got={msgs}"
    assert human[0]["source_user_id"] == seed["uid1"]
    assert human[0]["source_user_name"] == seed["user1_name"]


@pytest.mark.asyncio
async def test_mentions_set_mentioned_flag_per_receiver(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "hey @carol", "mentions": ["ag_user3___"]},
    )
    assert r.status_code == 202, r.text

    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.room_id == "rm_humanroom")
    )).scalars().all()
    by_receiver = {r.receiver_id: r for r in rows}
    assert by_receiver["ag_user3___"].mentioned is True
    assert by_receiver["ag_user1___"].mentioned is False  # sender not mentioned

    # Envelope carries mentions
    env = json.loads(by_receiver["ag_user3___"].envelope_json)
    assert env["mentions"] == ["ag_user3___"]


@pytest.mark.asyncio
async def test_mentions_filter_non_member_agent_ids(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    # ag_stranger exists but is NOT a member of rm_humanroom — must be filtered.
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "stranger ping", "mentions": ["ag_stranger", "ag_user3___"]},
    )
    assert r.status_code == 202, r.text

    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.room_id == "rm_humanroom")
    )).scalars().all()
    env = json.loads(rows[0].envelope_json)
    assert env["mentions"] == ["ag_user3___"]


@pytest.mark.asyncio
async def test_mentions_allow_at_all_and_drop_other_non_ag_prefix(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "mass ping", "mentions": ["@all", "rm_notagent", "ag_user3___"]},
    )
    assert r.status_code == 202, r.text

    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.room_id == "rm_humanroom")
    )).scalars().all()
    assert rows
    assert all(row.mentioned is True for row in rows)
    env = json.loads(rows[0].envelope_json)
    assert env["mentions"] == ["@all"]


@pytest.mark.asyncio
async def test_mentions_allow_human_id(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    # Add Carol (uid3) as a Human RoomMember in rm_humanroom so she can be @-mentioned.
    user_row = await db_session.execute(
        select(User).where(User.email == "c@x.com")
    )
    carol = user_row.scalar_one()
    carol_human_id = carol.human_id
    assert carol_human_id and carol_human_id.startswith("hu_")
    db_session.add(
        RoomMember(
            room_id="rm_humanroom",
            agent_id=carol_human_id,
            participant_type=ParticipantType.human,
            role=RoomRole.member,
        )
    )
    await db_session.commit()

    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": f"hey @{carol.display_name}", "mentions": [carol_human_id]},
    )
    assert r.status_code == 202, r.text

    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.room_id == "rm_humanroom")
    )).scalars().all()
    by_receiver = {r.receiver_id: r for r in rows}
    assert by_receiver[carol_human_id].mentioned is True
    assert by_receiver["ag_user1___"].mentioned is False
    env = json.loads(by_receiver[carol_human_id].envelope_json)
    assert env["mentions"] == [carol_human_id]


@pytest.mark.asyncio
async def test_mentions_cap_at_20(client: AsyncClient, seed: dict):
    too_many = [f"ag_x{i:08d}" for i in range(21)]
    r = await client.post(
        "/api/dashboard/rooms/rm_humanroom/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "spam", "mentions": too_many},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_owner_chat_ignores_mentions(
    client: AsyncClient, seed: dict, db_session: AsyncSession
):
    # Create an owner-chat room (rm_oc_ prefix) where user1 is sender.
    oc_room = Room(
        room_id="rm_oc_test_",
        name="OwnerChat",
        description="",
        owner_id=seed["agent1"],
        visibility=RoomVisibility.private,
        join_policy=RoomJoinPolicy.invite_only,
        default_send=True,
        max_members=2,
    )
    db_session.add(oc_room)
    await db_session.flush()
    db_session.add(RoomMember(room_id="rm_oc_test_", agent_id=seed["agent1"], role=RoomRole.owner))
    db_session.add(RoomMember(room_id="rm_oc_test_", agent_id=seed["agent3"], role=RoomRole.member))
    await db_session.commit()

    r = await client.post(
        "/api/dashboard/rooms/rm_oc_test_/send",
        headers=_h(seed["token1"], seed["agent1"]),
        json={"text": "should ignore", "mentions": ["ag_user3___"]},
    )
    assert r.status_code == 202, r.text

    rows = (await db_session.execute(
        select(MessageRecord).where(MessageRecord.room_id == "rm_oc_test_")
    )).scalars().all()
    for row in rows:
        assert row.mentioned is False
        env = json.loads(row.envelope_json)
        assert env["mentions"] is None
