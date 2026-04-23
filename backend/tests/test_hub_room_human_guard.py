"""Regression tests for the hub-router human-id guard and human-owned room
permission checks.

These cover two concerns:

1. The hub router (``/hub/rooms/*``) is the agent-protocol layer. It must
   reject ``hu_*`` ids on any input field so human users are forced to go
   through ``/api/humans/me/rooms*``.
2. When a room's owner is a human (``owner_type='human'``) an agent that is
   merely a member (not the owner) should still be able to invite another
   agent when ``default_invite=True`` — the permission helpers must not
   crash or wrongly grant owner privileges to the agent.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from tests.test_room import _auth_header, _create_agent, client, db_session  # noqa: F401


# ---------------------------------------------------------------------------
# 1. Hub router rejects hu_* on inputs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_member_rejects_human_id_in_body(client: AsyncClient):
    """POST /hub/rooms/{id}/members with a hu_* agent_id → HTTP 400."""
    _sk, owner_id, _key, owner_token = await _create_agent(client, "owner")

    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Agent Room"},
        headers=_auth_header(owner_token),
    )
    assert create_resp.status_code == 201
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/members",
        json={"agent_id": "hu_abc123def456"},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 400
    detail = resp.json().get("detail", "")
    assert "hu_" in detail
    assert "/api/humans/me/rooms" in detail


@pytest.mark.asyncio
async def test_create_room_rejects_human_id_in_member_ids(client: AsyncClient):
    """POST /hub/rooms with hu_* in member_ids → HTTP 400."""
    _sk, _agent_id, _key, token = await _create_agent(client, "owner")

    resp = await client.post(
        "/hub/rooms",
        json={"name": "Bad Room", "member_ids": ["hu_deadbeefcafe"]},
        headers=_auth_header(token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_promote_rejects_human_id(client: AsyncClient):
    """POST /hub/rooms/{id}/promote with hu_* agent_id → HTTP 400."""
    _sk, _owner_id, _key, owner_token = await _create_agent(client, "owner")
    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room"},
        headers=_auth_header(owner_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/promote",
        json={"agent_id": "hu_abc123def456", "role": "admin"},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_transfer_rejects_human_id(client: AsyncClient):
    """POST /hub/rooms/{id}/transfer with hu_* new_owner_id → HTTP 400."""
    _sk, _owner_id, _key, owner_token = await _create_agent(client, "owner")
    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room"},
        headers=_auth_header(owner_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.post(
        f"/hub/rooms/{room_id}/transfer",
        json={"new_owner_id": "hu_abc123def456"},
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_remove_member_rejects_human_id_in_path(client: AsyncClient):
    """DELETE /hub/rooms/{id}/members/hu_* → HTTP 400."""
    _sk, _owner_id, _key, owner_token = await _create_agent(client, "owner")
    create_resp = await client.post(
        "/hub/rooms",
        json={"name": "Room"},
        headers=_auth_header(owner_token),
    )
    room_id = create_resp.json()["room_id"]

    resp = await client.delete(
        f"/hub/rooms/{room_id}/members/hu_abc123def456",
        headers=_auth_header(owner_token),
    )
    assert resp.status_code == 400


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
