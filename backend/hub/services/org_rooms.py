"""Organization rooms backed by Hub Rooms (agents can be members).

An organization room is a normal ``Room`` whose ``space_id`` points at a Team
space. Messages, history, read markers and agent delivery reuse the ordinary
Room machinery; this module owns who may be in such a room:

- humans: active members of the organization only;
- agents: active organization agents, added by their owner or an org manager;
- ``space_visibility="organization"`` rooms are open to every active member
  (joining adds a ``RoomMember``); ``"private"`` rooms and DMs are explicit.

Leaving the organization removes the person (and the agents they sponsored)
from every room of the space. Callers commit once after a mutation.
"""

from __future__ import annotations

import hashlib
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import ParticipantType, RoomJoinPolicy, RoomRole, RoomVisibility
from hub.id_generators import generate_room_id
from hub.models import Agent, Room, RoomMember, SpaceAgentMembership, SpaceUserMembership, User
from hub.services import spaces

KINDS = ("room", "dm")
VISIBILITIES = ("organization", "private")


async def _human_id(db: AsyncSession, user_id: UUID) -> str:
    human_id = await db.scalar(select(User.human_id).where(User.id == user_id))
    if not human_id:
        spaces.reject("user_not_active")
    return human_id


async def space_room(db: AsyncSession, space_id: UUID, room_id: str, *, lock: bool = False) -> Room:
    query = select(Room).where(Room.room_id == room_id, Room.space_id == space_id)
    if lock:
        query = query.with_for_update()
    room = await db.scalar(query.execution_options(populate_existing=True))
    if room is None:
        spaces.reject("room_not_found", 404)
    return room


async def _member_row(db: AsyncSession, room_id: str, participant_id: str) -> RoomMember | None:
    return await db.scalar(select(RoomMember).where(
        RoomMember.room_id == room_id, RoomMember.agent_id == participant_id))


def _add_member(db: AsyncSession, room_id: str, participant_id: str, *, role: RoomRole = RoomRole.member) -> RoomMember:
    member = RoomMember(
        room_id=room_id,
        agent_id=participant_id,
        participant_type=ParticipantType.agent if participant_id.startswith("ag_") else ParticipantType.human,
        role=role,
    )
    db.add(member)
    return member


async def _active_member_users(db: AsyncSession, space_id: UUID, membership_ids: list[UUID]) -> list[str]:
    """Resolve organization membership ids to human ids; every one must be active."""
    if not membership_ids:
        return []
    rows = (await db.execute(
        select(SpaceUserMembership.id, User.human_id)
        .join(User, User.id == SpaceUserMembership.user_id)
        .where(SpaceUserMembership.space_id == space_id,
               SpaceUserMembership.id.in_(membership_ids),
               SpaceUserMembership.status == "active")
    )).all()
    if len(rows) != len(set(membership_ids)):
        spaces.reject("member_not_in_organization", 422)
    return [human_id for _, human_id in rows]


async def create_room(
    db: AsyncSession, space_id: UUID, actor_id: UUID, *, name: str, visibility: str,
    member_ids: list[UUID] | None = None, agent_ids: list[str] | None = None,
) -> Room:
    if visibility not in VISIBILITIES:
        spaces.reject("invalid_visibility", 422)
    await spaces.organization_space(db, space_id)
    await spaces.require_membership(db, space_id, actor_id)
    actor_hu = await _human_id(db, actor_id)
    others = [hu for hu in await _active_member_users(db, space_id, list(member_ids or [])) if hu != actor_hu]
    room = Room(
        room_id=generate_room_id(),
        name=name,
        owner_id=actor_hu,
        owner_type=ParticipantType.human,
        visibility=RoomVisibility.private,
        join_policy=RoomJoinPolicy.invite_only,
        default_send=True,
        space_id=space_id,
        space_kind="room",
        space_visibility=visibility,
    )
    db.add(room)
    await db.flush()
    _add_member(db, room.room_id, actor_hu, role=RoomRole.owner)
    for hu in dict.fromkeys(others):
        _add_member(db, room.room_id, hu)
    for agent_id in dict.fromkeys(agent_ids or []):
        await _check_agent_addable(db, space_id, actor_id, agent_id)
        _add_member(db, room.room_id, agent_id)
    await db.flush()
    spaces.audit(db, space_id, actor_id, "org_room.created", room.room_id, visibility=visibility)
    return room


def dm_room_id(space_id: UUID, a: str, b: str) -> str:
    first, second = sorted((a, b))
    digest = hashlib.sha256(f"{space_id}:{first}:{second}".encode()).hexdigest()[:20]
    return f"rm_sdm_{digest}"


async def open_dm(db: AsyncSession, space_id: UUID, actor_id: UUID, peer_membership_id: UUID) -> Room:
    """Organization DM between two active members (one per pair per space)."""
    await spaces.organization_space(db, space_id)
    await spaces.require_membership(db, space_id, actor_id)
    actor_hu = await _human_id(db, actor_id)
    [peer_hu] = await _active_member_users(db, space_id, [peer_membership_id])
    if peer_hu == actor_hu:
        spaces.reject("cannot_dm_self", 422)
    room_id = dm_room_id(space_id, actor_hu, peer_hu)
    room = await db.scalar(select(Room).where(Room.room_id == room_id))
    if room is not None:
        # Re-admit a returning participant if the pair left and came back.
        for hu in (actor_hu, peer_hu):
            if await _member_row(db, room_id, hu) is None:
                _add_member(db, room_id, hu)
        await db.flush()
        return room
    peer_name = await db.scalar(select(User.display_name).where(User.human_id == peer_hu))
    actor_name = await db.scalar(select(User.display_name).where(User.human_id == actor_hu))
    room = Room(
        room_id=room_id, name=f"{actor_name} & {peer_name}", owner_id=actor_hu,
        owner_type=ParticipantType.human, visibility=RoomVisibility.private,
        join_policy=RoomJoinPolicy.invite_only, max_members=2, default_send=True,
        space_id=space_id, space_kind="dm", space_visibility="private",
    )
    db.add(room)
    await db.flush()
    _add_member(db, room_id, actor_hu, role=RoomRole.owner)
    _add_member(db, room_id, peer_hu)
    await db.flush()
    return room


async def join_room(db: AsyncSession, space_id: UUID, actor_id: UUID, room_id: str) -> Room:
    """Join an organization-visible room (idempotent)."""
    await spaces.require_membership(db, space_id, actor_id)
    room = await space_room(db, space_id, room_id)
    actor_hu = await _human_id(db, actor_id)
    if await _member_row(db, room_id, actor_hu) is not None:
        return room
    if room.space_kind != "room" or room.space_visibility != "organization":
        spaces.reject("room_invite_required")
    _add_member(db, room_id, actor_hu)
    await db.flush()
    return room


async def _room_role(db: AsyncSession, room_id: str, participant_id: str) -> RoomRole | None:
    row = await _member_row(db, room_id, participant_id)
    return row.role if row else None


async def _check_agent_addable(db: AsyncSession, space_id: UUID, actor_id: UUID, agent_id: str) -> None:
    membership = await spaces.require_agent_membership(db, space_id, agent_id)
    sponsor = await db.get(SpaceUserMembership, membership.sponsor_user_membership_id)
    if sponsor is not None and sponsor.user_id == actor_id:
        return  # the agent's owner
    try:
        await spaces.require_manager(db, space_id, actor_id)
    except HTTPException:
        spaces.reject("agent_owner_or_manager_required")


async def add_agent(db: AsyncSession, space_id: UUID, actor_id: UUID, room_id: str, agent_id: str) -> RoomMember:
    await spaces.require_membership(db, space_id, actor_id)
    room = await space_room(db, space_id, room_id, lock=True)
    if room.space_kind != "room":
        spaces.reject("agents_only_in_rooms", 422)
    actor_hu = await _human_id(db, actor_id)
    if await _room_role(db, room_id, actor_hu) is None:
        spaces.reject("room_membership_required")
    await _check_agent_addable(db, space_id, actor_id, agent_id)
    existing = await _member_row(db, room_id, agent_id)
    if existing is not None:
        return existing
    member = _add_member(db, room_id, agent_id)
    await db.flush()
    spaces.audit(db, space_id, actor_id, "org_room.agent_added", room_id, agent_id=agent_id)
    return member


async def add_members(db: AsyncSession, space_id: UUID, actor_id: UUID, room_id: str,
                      member_ids: list[UUID]) -> list[str]:
    await spaces.require_membership(db, space_id, actor_id)
    room = await space_room(db, space_id, room_id, lock=True)
    if room.space_kind != "room":
        spaces.reject("dm_members_fixed", 422)
    actor_hu = await _human_id(db, actor_id)
    if await _room_role(db, room_id, actor_hu) is None:
        spaces.reject("room_membership_required")
    added = []
    for hu in await _active_member_users(db, space_id, member_ids):
        if await _member_row(db, room_id, hu) is None:
            _add_member(db, room_id, hu)
            added.append(hu)
    await db.flush()
    return added


async def remove_participant(db: AsyncSession, space_id: UUID, actor_id: UUID, room_id: str,
                             participant_id: str) -> None:
    """Room owner/admin, an org manager, or (for agents) the agent's owner may remove."""
    await spaces.require_membership(db, space_id, actor_id)
    room = await space_room(db, space_id, room_id, lock=True)
    actor_hu = await _human_id(db, actor_id)
    row = await _member_row(db, room_id, participant_id)
    if row is None:
        return
    allowed = participant_id == actor_hu or await _room_role(db, room_id, actor_hu) in (RoomRole.owner, RoomRole.admin)
    if not allowed and participant_id.startswith("ag_"):
        agent = await db.scalar(select(Agent).where(Agent.agent_id == participant_id))
        allowed = agent is not None and agent.user_id == actor_id
    if not allowed:
        try:
            await spaces.require_manager(db, space_id, actor_id)
        except HTTPException:
            spaces.reject("room_manager_required")
    if row.role == RoomRole.owner and room.space_kind == "room":
        spaces.reject("cannot_remove_room_owner", 422)
    await db.delete(row)
    await db.flush()


async def drop_space_participants(db: AsyncSession, space_id: UUID, participant_ids: list[str]) -> None:
    """Remove people/agents from every room of the space (org membership ended)."""
    ids = [pid for pid in participant_ids if pid]
    if not ids:
        return
    room_ids = select(Room.room_id).where(Room.space_id == space_id).scalar_subquery()
    await db.execute(delete(RoomMember).where(RoomMember.agent_id.in_(ids), RoomMember.room_id.in_(room_ids)))


async def sponsored_agent_ids(db: AsyncSession, space_id: UUID, membership_id: UUID) -> list[str]:
    return list((await db.scalars(select(SpaceAgentMembership.agent_id).where(
        SpaceAgentMembership.space_id == space_id,
        SpaceAgentMembership.sponsor_user_membership_id == membership_id,
    ))).all())


async def assert_generic_room(db: AsyncSession, room_id: str) -> None:
    """Generic join/invite/approval paths must not change organization rooms.

    Organization room membership is governed by the space (see the Team
    rooms API), so personal-mode invites, join requests and agent-side
    ``add_member`` are refused for them.
    """
    space_id = await db.scalar(select(Room.space_id).where(Room.room_id == room_id))
    if space_id is not None:
        raise HTTPException(status_code=403, detail="org_room_membership_managed_by_team")


async def open_agent_dm(db: AsyncSession, space_id: UUID, actor_id: UUID, agent_id: str) -> Room:
    """Organization DM between a member and an agent: its owner, or a grantee."""
    from hub.services import agent_access

    await spaces.organization_space(db, space_id)
    await spaces.require_membership(db, space_id, actor_id)
    membership = await spaces.require_agent_membership(db, space_id, agent_id)
    sponsor = await db.get(SpaceUserMembership, membership.sponsor_user_membership_id)
    is_owner = sponsor is not None and sponsor.user_id == actor_id
    if not is_owner:
        grant = await agent_access.active_grant_for_pair(db, agent_id, actor_id)
        if grant is None or grant.space_id != space_id:
            spaces.reject("agent_access_required")
    actor_hu = await _human_id(db, actor_id)
    room_id = dm_room_id(space_id, actor_hu, agent_id)
    room = await db.scalar(select(Room).where(Room.room_id == room_id))
    if room is None:
        agent_name = await db.scalar(select(Agent.display_name).where(Agent.agent_id == agent_id))
        room = Room(
            room_id=room_id, name=agent_name or agent_id, owner_id=actor_hu,
            owner_type=ParticipantType.human, visibility=RoomVisibility.private,
            join_policy=RoomJoinPolicy.invite_only, max_members=2, default_send=True,
            space_id=space_id, space_kind="dm", space_visibility="private",
        )
        db.add(room)
        await db.flush()
    for participant, role in ((actor_hu, RoomRole.owner), (agent_id, RoomRole.member)):
        if await _member_row(db, room_id, participant) is None:
            _add_member(db, room_id, participant, role=role)
    await db.flush()
    return room


async def assert_org_send_allowed(db: AsyncSession, room_id: str, sender_id: str, user_id) -> None:
    """Per-send check for organization rooms: a member↔agent DM needs the
    agent's owner or a live grant (a revoked grant stops the conversation)."""
    room = await db.scalar(select(Room).where(Room.room_id == room_id))
    if room is None or room.space_id is None or room.space_kind != "dm" or not sender_id.startswith("hu_"):
        return
    agent_id = await db.scalar(select(RoomMember.agent_id).where(
        RoomMember.room_id == room_id, RoomMember.agent_id.like("ag_%")))
    if agent_id is None:
        return
    agent = await db.scalar(select(Agent).where(Agent.agent_id == agent_id))
    if agent is not None and agent.user_id is not None and str(agent.user_id) == str(user_id):
        return
    from hub.services import agent_access

    grant = await agent_access.active_grant_for_pair(db, agent_id, user_id)
    if grant is None or grant.space_id != room.space_id:
        raise HTTPException(status_code=403, detail="agent_access_revoked")
