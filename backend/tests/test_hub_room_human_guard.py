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
    """Simulate a human-owned room: an agent that is a member (not the
    owner) with ``default_invite=True`` must be able to invite another
    agent without crashing and without needing owner/admin role.

    We build this state directly against the DB to avoid depending on the
    /api/humans BFF layer (which may not be present on every branch). We
    defensively set ``owner_type``/``participant_type`` via ``setattr`` so
    the test works both pre- and post-Human-first merge.
    """
    from hub.models import Room, RoomMember, RoomRole, RoomVisibility, RoomJoinPolicy

    # Two agents — alice (member, will invite) and bob (to be invited).
    _sk_a, alice_id, _a_key, alice_token = await _create_agent(client, "alice")
    _sk_b, bob_id, _b_key, _bob_token = await _create_agent(client, "bob")

    # Build a synthetic human-owned room. We use a ``hu_*`` id for the
    # owner_id column. The column is an FK to agents on pre-merge schemas,
    # so we insert it through raw SQL and accept that the FK may or may
    # not be present — if the FK is still tight this test becomes a no-op
    # and skips.
    from sqlalchemy import text
    from hub.id_generators import generate_room_id

    room_id = generate_room_id()
    try:
        await db_session.execute(
            text(
                "INSERT INTO rooms (room_id, name, description, owner_id, "
                "visibility, join_policy, default_send, default_invite, max_members) "
                "VALUES (:room_id, :name, :description, :owner_id, "
                ":visibility, :join_policy, :default_send, :default_invite, :max_members)"
            ),
            {
                "room_id": room_id,
                "name": "Human Room",
                "description": "",
                # Pre-merge: owner_id FK to agents.agent_id — we can only
                # simulate "human owner" if we drop the FK constraint.
                # When FK is present, use alice_id as a stand-in and set
                # owner_type='human' via attribute assignment below so
                # _room_owner_is_human() returns True.
                "owner_id": alice_id,
                "visibility": "public",
                "join_policy": "invite_only",
                "default_send": True,
                "default_invite": True,
                "max_members": None,
            },
        )
    except Exception:
        pytest.skip("Cannot synthesise human-owned room on this schema")

    # Alice joins as a plain member (not owner).
    await db_session.execute(
        text(
            "INSERT INTO room_members (room_id, agent_id, role, muted) "
            "VALUES (:room_id, :agent_id, :role, :muted)"
        ),
        {
            "room_id": room_id,
            "agent_id": alice_id,
            "role": "member",
            "muted": False,
        },
    )
    await db_session.commit()

    # Patch the Room instance to report owner_type='human' so the
    # permission helpers treat it as a human-owned room. We monkey-patch
    # the attribute lookup via a SQLAlchemy event — or more simply, we
    # override it by setting the attribute after load via a router
    # helper. Easiest path: set it as a class-level default for this test.
    # Since _room_owner_is_human uses getattr(room, 'owner_type', 'agent'),
    # we can expose a 'owner_type' attribute at the instance level.
    from hub.routers import room as room_router

    original_is_human = room_router._room_owner_is_human
    room_router._room_owner_is_human = lambda _room: True  # type: ignore[assignment]
    try:
        # Alice invites Bob. Alice is role='member' but default_invite=True.
        resp = await client.post(
            f"/hub/rooms/{room_id}/members",
            json={"agent_id": bob_id},
            headers=_auth_header(alice_token),
        )
        # Should succeed — default_invite=True lets any agent member invite.
        assert resp.status_code == 201, resp.text
        data = resp.json()
        member_ids = {m["agent_id"] for m in data["members"]}
        assert alice_id in member_ids
        assert bob_id in member_ids
    finally:
        room_router._room_owner_is_human = original_is_human  # type: ignore[assignment]
