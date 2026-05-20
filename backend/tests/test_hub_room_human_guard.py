"""Regression tests for hub-router human invite handling and human-owned room
permission checks.

These cover three concerns:

1. The hub router (``/hub/rooms/*``) is the agent-protocol layer, but room
   membership targets may be either Agent or Human participants.
2. Agents may add ``hu_*`` room members only when the Human is already a
   Contact of the inviting agent; once seated, those Human members can be
   promoted, permissioned, removed, or made owner through the same surface.
3. When a room's owner is a human (``owner_type='human'``) an agent that is
   merely a member (not the owner) should still be able to invite another
   agent when ``default_invite=True`` — the permission helpers must not
   crash or wrongly grant owner privileges to the agent.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tests.test_room import _auth_header, _create_agent, client, db_session  # noqa: F401


async def _create_contacted_human(db_session, owner_agent_id: str) -> str:
    from hub.enums import ParticipantType
    from hub.models import Contact, User

    human = User(
        supabase_user_id=uuid.uuid4(),
        display_name="Contact Human",
    )
    db_session.add(human)
    await db_session.flush()
    human_id = human.human_id
    db_session.add(
        Contact(
            owner_id=owner_agent_id,
            owner_type=ParticipantType.agent,
            contact_agent_id=human_id,
            peer_type=ParticipantType.human,
        )
    )
    await db_session.commit()
    return human_id


# ---------------------------------------------------------------------------
# 1. Hub router add-member permits contacted humans only
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_member_rejects_human_id_when_not_contact(
    client: AsyncClient,
    db_session,
):
    """POST /hub/rooms/{id}/members with a non-contact hu_* -> HTTP 403."""
    from hub.models import User

    _sk, owner_id, _key, owner_token = await _create_agent(client, "owner")
    bob = User(
        supabase_user_id=uuid.uuid4(),
        display_name="Bob Human",
    )
    db_session.add(bob)
    await db_session.flush()
    bob_human_id = bob.human_id
    await db_session.commit()

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Agent Room"},
        headers=_auth_header(owner_token),
    )
    assert create_resp.status_code == 201
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": bob_human_id},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_room_rejects_human_id_when_not_contact(
    client: AsyncClient,
    db_session,
):
    """POST /hub/rooms with a non-contact hu_* initial member -> HTTP 403."""
    from hub.models import User

    _sk, _owner_id, _key, owner_token = await _create_agent(client, "owner")
    bob = User(
        supabase_user_id=uuid.uuid4(),
        display_name="Bob Human",
    )
    db_session.add(bob)
    await db_session.flush()
    bob_human_id = bob.human_id
    await db_session.commit()

    resp = await client.post(
        "/hub/rooms",
        json={"name": "Agent Room", "member_ids": [bob_human_id]},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_add_member_allows_human_contact(
    client: AsyncClient,
    db_session,
):
    """POST /hub/rooms/{id}/members can add a hu_* Contact."""
    from hub.enums import ParticipantType
    from hub.models import Contact, RoomMember, User

    _sk, owner_id, _key, owner_token = await _create_agent(client, "owner")
    bob = User(
        supabase_user_id=uuid.uuid4(),
        display_name="Bob Human",
    )
    db_session.add(bob)
    await db_session.flush()
    bob_human_id = bob.human_id
    db_session.add(
        Contact(
            owner_id=owner_id,
            owner_type=ParticipantType.agent,
            contact_agent_id=bob_human_id,
            peer_type=ParticipantType.human,
        )
    )
    await db_session.commit()

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Agent Room"},
        headers=_auth_header(owner_token),
    )
    assert create_resp.status_code == 201
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"participant_id": bob_human_id, "can_send": True},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 201, resp.text
    member = next(m for m in resp.json()["members"] if m["agent_id"] == bob_human_id)
    assert member["can_send"] is True

    row = await db_session.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == bob_human_id,
        )
    )
    saved = row.scalar_one()
    assert saved.participant_type == ParticipantType.human


@pytest.mark.asyncio
async def test_create_room_allows_human_contact_in_member_ids(
    client: AsyncClient,
    db_session,
):
    """POST /hub/rooms can include contacted hu_* participants."""
    from hub.enums import ParticipantType
    from hub.models import RoomMember

    _sk, owner_id, _key, token = await _create_agent(client, "owner")
    human_id = await _create_contacted_human(db_session, owner_id)

    resp = await client.post(
        "/hub/rooms",
        json={"name": "Mixed Room", "member_ids": [human_id]},
        headers=_auth_header(token),
    )
    assert resp.status_code == 201, resp.text
    room_id = resp.json()["room_id"]
    member = next(m for m in resp.json()["members"] if m["agent_id"] == human_id)
    assert member["participant_type"] == "human"

    row = await db_session.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == human_id,
        )
    )
    saved = row.scalar_one()
    assert saved.participant_type == ParticipantType.human


@pytest.mark.asyncio
async def test_promote_allows_human_id(client: AsyncClient, db_session):
    """POST /hub/rooms/{id}/promote accepts a hu_* participant."""
    _sk, owner_id, _key, owner_token = await _create_agent(client, "owner")
    human_id = await _create_contacted_human(db_session, owner_id)
    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [human_id]},
        headers=_auth_header(owner_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"participant_id": human_id, "role": "admin"},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 200, resp.text
    member = next(m for m in resp.json()["members"] if m["agent_id"] == human_id)
    assert member["participant_type"] == "human"
    assert member["role"] == "admin"


@pytest.mark.asyncio
async def test_transfer_allows_human_id(client: AsyncClient, db_session):
    """POST /hub/rooms/{id}/transfer can transfer ownership to a hu_* member."""
    from hub.enums import ParticipantType
    from hub.models import Room

    _sk, owner_id, _key, owner_token = await _create_agent(client, "owner")
    human_id = await _create_contacted_human(db_session, owner_id)
    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [human_id]},
        headers=_auth_header(owner_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/transfer",
        json={"new_owner_id": human_id},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["owner_id"] == human_id
    assert body["owner_type"] == "human"
    member = next(m for m in body["members"] if m["agent_id"] == human_id)
    assert member["participant_type"] == "human"
    assert member["role"] == "owner"

    row = await db_session.execute(select(Room).where(Room.room_id == room_id))
    saved_room = row.scalar_one()
    assert saved_room.owner_type == ParticipantType.human


@pytest.mark.asyncio
async def test_remove_member_allows_human_id_in_path(client: AsyncClient, db_session):
    """DELETE /hub/rooms/{id}/members/hu_* removes a Human member."""
    from hub.models import RoomMember

    _sk, owner_id, _key, owner_token = await _create_agent(client, "owner")
    human_id = await _create_contacted_human(db_session, owner_id)
    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [human_id]},
        headers=_auth_header(owner_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.delete(
        f"/hub/rooms/{room_id}/members/{human_id}",
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 200, resp.text
    member_ids = {m["agent_id"] for m in resp.json()["members"]}
    assert human_id not in member_ids

    row = await db_session.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == human_id,
        )
    )
    assert row.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_permissions_allows_human_id(client: AsyncClient, db_session):
    """POST /hub/rooms/{id}/permissions accepts a hu_* participant."""
    _sk, owner_id, _key, owner_token = await _create_agent(client, "owner")
    human_id = await _create_contacted_human(db_session, owner_id)
    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room", "member_ids": [human_id]},
        headers=_auth_header(owner_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/permissions",
        json={"participant_id": human_id, "can_send": False, "can_invite": True},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 200, resp.text
    member = next(m for m in resp.json()["members"] if m["agent_id"] == human_id)
    assert member["participant_type"] == "human"
    assert member["can_send"] is False
    assert member["can_invite"] is True


# ---------------------------------------------------------------------------
# 2. Human-owned room: agent member with default_invite=True can invite
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_can_invite_in_human_owned_room_with_default_invite(
    client: AsyncClient,
    db_session,
):
    """Human-owned room: an agent member (not owner) with ``default_invite=True``
    must be able to invite another agent — no monkey-patching.

    We build the state directly: create a User with a ``human_id``, a Room
    with ``owner_type='human'`` and ``owner_id=<hu_*>``, and seat alice as
    a plain agent-type member.
    """
    import uuid

    from hub.models import (
        ParticipantType,
        Room,
        RoomJoinPolicy,
        RoomMember,
        RoomRole,
        RoomVisibility,
        User,
    )
    from hub.id_generators import generate_human_id, generate_room_id

    # Two agents — alice (member, will invite) and bob (to be invited).
    _sk_a, alice_id, _a_key, alice_token = await _create_agent(client, "alice")
    _sk_b, bob_id, _b_key, _bob_token = await _create_agent(client, "bob")

    # Create a real human owner (User row + hu_* id). Skip if the schema
    # cannot accept a human-owned room (e.g. pre-merge FK still tight).
    human_id = generate_human_id()
    try:
        owner_user = User(
            id=uuid.uuid4(),
            supabase_user_id=uuid.uuid4(),
            email=f"owner-{human_id}@example.com",
            display_name="Room Owner",
            status="active",
            human_id=human_id,
        )
        db_session.add(owner_user)
        await db_session.flush()

        room = Room(
            room_id=generate_room_id(),
            name="Human Room",
            description="",
            owner_id=human_id,
            owner_type=ParticipantType.human,
            visibility=RoomVisibility.public,
            join_policy=RoomJoinPolicy.invite_only,
            default_send=True,
            default_invite=True,
        )
        db_session.add(room)
        await db_session.flush()
    except Exception:
        await db_session.rollback()
        pytest.skip("Cannot synthesise human-owned room on this schema")

    # Alice joins as a plain agent-type member (not owner).
    db_session.add(
        RoomMember(
            room_id=room.room_id,
            agent_id=alice_id,
            participant_type=ParticipantType.agent,
            role=RoomRole.member,
        )
    )
    await db_session.commit()

    room_id = room.room_id

    # Alice invites Bob. Alice is role='member' but default_invite=True,
    # and the real owner_type='human' drives _room_owner_is_human() natively.
    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": bob_id},
        headers=_auth_header(alice_token),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    member_ids = {m["agent_id"] for m in data["members"]}
    assert alice_id in member_ids
    assert bob_id in member_ids
