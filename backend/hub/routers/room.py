"""Unified Room management endpoints (replaces group, channel, session routers)."""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func as sa_func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from hub.auth import get_current_agent
from hub.config import JOIN_RATE_LIMIT_PER_MINUTE
from hub.database import get_db
from hub.id_generators import generate_room_id
from hub.models import Agent, Contact, MessagePolicy, Room, RoomMember, RoomRole, RoomVisibility, RoomJoinPolicy
from hub.schemas import (
    AddRoomMemberRequest,
    CreateRoomRequest,
    MuteRoomRequest,
    PromoteRoomMemberRequest,
    RoomDiscoveryResponse,
    RoomListResponse,
    RoomMemberResponse,
    RoomPublicResponse,
    RoomResponse,
    SetMemberPermissionsRequest,
    TransferRoomOwnerRequest,
    UpdateRoomRequest,
)

router = APIRouter(prefix="/hub/rooms", tags=["rooms"])

# ---------------------------------------------------------------------------
# In-memory join rate-limit state: room_id → deque of timestamps
# ---------------------------------------------------------------------------
_join_rate_windows: dict[str, deque[float]] = defaultdict(deque)


def _check_join_rate_limit(room_id: str) -> None:
    """Sliding-window join rate limit per room. Raises 429."""
    now = time.monotonic()
    window = _join_rate_windows[room_id]
    while window and window[0] <= now - 60:
        window.popleft()
    if len(window) >= JOIN_RATE_LIMIT_PER_MINUTE:
        raise HTTPException(status_code=429, detail="Join rate limit exceeded for this room")
    window.append(now)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_room_rule(rule: str | None) -> str | None:
    """Collapse blank/whitespace-only room rules to None."""
    if rule is None:
        return None
    normalized = rule.strip()
    return normalized or None


def _build_room_response(room: Room) -> RoomResponse:
    return RoomResponse(
        room_id=room.room_id,
        name=room.name,
        description=room.description,
        rule=room.rule,
        owner_id=room.owner_id,
        visibility=room.visibility.value,
        join_policy=room.join_policy.value,
        max_members=room.max_members,
        default_send=room.default_send,
        default_invite=room.default_invite,
        slow_mode_seconds=room.slow_mode_seconds,
        member_count=len(room.members),
        members=[
            RoomMemberResponse(
                agent_id=m.agent_id,
                role=m.role.value,
                muted=m.muted,
                can_send=m.can_send,
                can_invite=m.can_invite,
                joined_at=m.joined_at,
            )
            for m in room.members
        ],
        created_at=room.created_at,
    )


def _build_room_public_response(room: Room) -> RoomPublicResponse:
    return RoomPublicResponse(
        room_id=room.room_id,
        name=room.name,
        description=room.description,
        rule=room.rule,
        owner_id=room.owner_id,
        visibility=room.visibility.value,
        join_policy=room.join_policy.value,
        slow_mode_seconds=room.slow_mode_seconds,
        member_count=len(room.members),
        created_at=room.created_at,
    )


async def _load_room(db: AsyncSession, room_id: str, *, fresh: bool = False) -> Room:
    """Load room with members eagerly. Raises 404 if not found."""
    if fresh:
        db.expire_all()
    result = await db.execute(
        select(Room)
        .where(Room.room_id == room_id)
        .options(selectinload(Room.members))
    )
    room = result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


def _require_membership(room: Room, agent_id: str) -> RoomMember:
    """Return the member record or raise 403."""
    for m in room.members:
        if m.agent_id == agent_id:
            return m
    raise HTTPException(status_code=403, detail="Not a member of this room")


def _require_admin_or_owner(room: Room, agent_id: str) -> RoomMember:
    """Return the member record if owner/admin, else raise 403."""
    member = _require_membership(room, agent_id)
    if member.role not in (RoomRole.owner, RoomRole.admin):
        raise HTTPException(status_code=403, detail="Admin or owner role required")
    return member


def _can_invite(room: Room, member: RoomMember) -> bool:
    """Check if a member can invite others to a room.

    Resolution order:
      1. owner → always True
      2. member.can_invite is not None → use explicit value
      3. admin → default True
      4. room.default_invite
    """
    if member.role == RoomRole.owner:
        return True
    if member.can_invite is not None:
        return member.can_invite
    if member.role == RoomRole.admin:
        return True
    return room.default_invite


# ---------------------------------------------------------------------------
# Routes — ordered so /me comes before /{room_id}
# ---------------------------------------------------------------------------


@router.post("", response_model=RoomResponse, status_code=201)
async def create_room(
    body: CreateRoomRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Create a new room. Creator becomes the owner."""
    unique_member_ids = set(body.member_ids) - {current_agent}

    if unique_member_ids:
        result = await db.execute(
            select(Agent).where(Agent.agent_id.in_(unique_member_ids))
        )
        agents = list(result.scalars().all())
        if len(agents) != len(unique_member_ids):
            raise HTTPException(status_code=400, detail="One or more member_ids not found")

        # Admission policy: contacts_only agents require creator to be in their contacts
        contacts_only_ids = [
            a.agent_id for a in agents if a.message_policy == MessagePolicy.contacts_only
        ]
        if contacts_only_ids:
            contact_result = await db.execute(
                select(Contact.owner_id).where(
                    Contact.owner_id.in_(contacts_only_ids),
                    Contact.contact_agent_id == current_agent,
                )
            )
            has_contact = {row[0] for row in contact_result.all()}
            denied = set(contacts_only_ids) - has_contact
            if denied:
                raise HTTPException(
                    status_code=403,
                    detail=f"Admission denied: agents {sorted(denied)} have contacts_only policy and you are not in their contacts",
                )

    if body.max_members is not None and len(unique_member_ids) + 1 > body.max_members:
        raise HTTPException(status_code=400, detail="Initial members exceed max_members")

    room = Room(
        room_id=generate_room_id(),
        name=body.name,
        description=body.description,
        rule=_normalize_room_rule(body.rule),
        owner_id=current_agent,
        visibility=body.visibility,
        join_policy=body.join_policy,
        max_members=body.max_members,
        default_send=body.default_send,
        default_invite=body.default_invite,
        slow_mode_seconds=body.slow_mode_seconds,
    )
    db.add(room)
    await db.flush()

    owner_member = RoomMember(
        room_id=room.room_id,
        agent_id=current_agent,
        role=RoomRole.owner,
    )
    db.add(owner_member)

    for mid in unique_member_ids:
        db.add(RoomMember(
            room_id=room.room_id,
            agent_id=mid,
            role=RoomRole.member,
        ))

    await db.commit()

    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.get("", response_model=RoomDiscoveryResponse)
async def discover_rooms(
    name: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """Discover public rooms. Optional name filter with pagination."""
    stmt = (
        select(Room)
        .where(Room.visibility == RoomVisibility.public)
        .options(selectinload(Room.members))
        .order_by(Room.created_at.desc())
    )
    if name is not None:
        # Escape LIKE wildcards in user input
        escaped = name.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        stmt = stmt.where(Room.name.ilike(f"%{escaped}%"))
    stmt = stmt.limit(limit).offset(offset)
    result = await db.execute(stmt)
    rooms = list(result.scalars().all())
    return RoomDiscoveryResponse(
        rooms=[_build_room_public_response(r) for r in rooms]
    )


@router.get("/me", response_model=RoomListResponse)
async def list_my_rooms(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """List all rooms the current agent is a member of."""
    result = await db.execute(
        select(Room)
        .join(RoomMember, RoomMember.room_id == Room.room_id)
        .where(RoomMember.agent_id == current_agent)
        .options(selectinload(Room.members))
        .order_by(Room.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rooms = list(result.scalars().unique().all())
    return RoomListResponse(
        rooms=[_build_room_response(r) for r in rooms]
    )


@router.get("/{room_id}", response_model=RoomResponse)
async def get_room(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Get room info. Only members can view."""
    room = await _load_room(db, room_id, fresh=True)
    _require_membership(room, current_agent)
    return _build_room_response(room)


@router.patch("/{room_id}", response_model=RoomResponse)
async def update_room(
    room_id: str,
    body: UpdateRoomRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Update room info. Owner/admin only."""
    room = await _load_room(db, room_id)
    _require_admin_or_owner(room, current_agent)

    # Use model_fields_set to distinguish "field omitted" from "field set to None"
    # This allows setting max_members/description back to None.
    if "name" in body.model_fields_set:
        room.name = body.name
    if "description" in body.model_fields_set:
        room.description = body.description
    if "rule" in body.model_fields_set:
        room.rule = _normalize_room_rule(body.rule)
    if "visibility" in body.model_fields_set:
        room.visibility = body.visibility
    if "join_policy" in body.model_fields_set:
        room.join_policy = body.join_policy
    if "max_members" in body.model_fields_set:
        room.max_members = body.max_members
    if "default_send" in body.model_fields_set:
        room.default_send = body.default_send
    if "default_invite" in body.model_fields_set:
        room.default_invite = body.default_invite
    if "slow_mode_seconds" in body.model_fields_set:
        room.slow_mode_seconds = body.slow_mode_seconds

    await db.commit()
    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.delete("/{room_id}", response_model=dict)
async def dissolve_room(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Dissolve (delete) a room. Owner only."""
    room = await _load_room(db, room_id)
    member = _require_membership(room, current_agent)
    if member.role != RoomRole.owner:
        raise HTTPException(status_code=403, detail="Only the owner can dissolve the room")

    await db.delete(room)
    await db.commit()
    return {"ok": True}


@router.post("/{room_id}/members", response_model=RoomResponse, status_code=201)
async def add_member(
    room_id: str,
    body: AddRoomMemberRequest | None = None,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Add a member to the room.

    - If body is empty or agent_id matches current agent → self-join
      (only allowed for public + open rooms).
    - Otherwise → invite (requires invite permission via _can_invite).
    - Admission policy: contacts_only agents require inviter in their contacts.
    """
    room = await _load_room(db, room_id)
    target_agent_id = body.agent_id if body and body.agent_id else None
    is_self_join = target_agent_id is None or target_agent_id == current_agent

    if is_self_join:
        target_agent_id = current_agent
        if room.visibility != RoomVisibility.public or room.join_policy != RoomJoinPolicy.open:
            raise HTTPException(
                status_code=403,
                detail="Self-join only allowed for public rooms with open join policy",
            )
        _check_join_rate_limit(room_id)
    else:
        # Permission check: use _can_invite instead of _require_admin_or_owner
        inviter = _require_membership(room, current_agent)
        if not _can_invite(room, inviter):
            raise HTTPException(status_code=403, detail="You do not have invite permission")

        # Check target agent exists and load for admission policy
        result = await db.execute(
            select(Agent).where(Agent.agent_id == target_agent_id)
        )
        target_agent = result.scalar_one_or_none()
        if target_agent is None:
            raise HTTPException(status_code=404, detail="Agent not found")

        # Admission policy: contacts_only agents require inviter to be in their contacts
        if target_agent.message_policy == MessagePolicy.contacts_only:
            contact_result = await db.execute(
                select(Contact).where(
                    Contact.owner_id == target_agent_id,
                    Contact.contact_agent_id == current_agent,
                )
            )
            if contact_result.scalar_one_or_none() is None:
                raise HTTPException(
                    status_code=403,
                    detail="Admission denied: target agent has contacts_only policy and you are not in their contacts",
                )

    # Check max_members
    if room.max_members is not None and len(room.members) >= room.max_members:
        raise HTTPException(status_code=400, detail="Room is full")

    new_member = RoomMember(
        room_id=room.room_id,
        agent_id=target_agent_id,
        role=RoomRole.member,
        can_send=body.can_send if body else None,
        can_invite=body.can_invite if body else None,
    )
    try:
        async with db.begin_nested():
            db.add(new_member)
            await db.flush()
    except IntegrityError:
        raise HTTPException(
            status_code=409,
            detail="Agent is already a member or does not exist",
        )

    await db.commit()
    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.delete("/{room_id}/members/{agent_id}", response_model=RoomResponse)
async def remove_member(
    room_id: str,
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Remove a member from the room. Owner/admin only. Cannot remove the owner."""
    room = await _load_room(db, room_id)
    caller = _require_admin_or_owner(room, current_agent)

    target = None
    for m in room.members:
        if m.agent_id == agent_id:
            target = m
            break
    if target is None:
        raise HTTPException(status_code=404, detail="Member not found in room")

    if target.role == RoomRole.owner:
        raise HTTPException(status_code=400, detail="Cannot remove the room owner")

    if target.role == RoomRole.admin and caller.role != RoomRole.owner:
        raise HTTPException(status_code=403, detail="Only the owner can remove admins")

    await db.delete(target)
    await db.commit()

    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.post("/{room_id}/leave", response_model=dict)
async def leave_room(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Leave a room. Owner cannot leave."""
    room = await _load_room(db, room_id)
    member = _require_membership(room, current_agent)

    if member.role == RoomRole.owner:
        raise HTTPException(status_code=400, detail="Owner cannot leave the room")

    await db.delete(member)
    await db.commit()
    return {"ok": True}


@router.post("/{room_id}/transfer", response_model=RoomResponse)
async def transfer_ownership(
    room_id: str,
    body: TransferRoomOwnerRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Transfer room ownership to another member. Owner only."""
    room = await _load_room(db, room_id)
    caller = _require_membership(room, current_agent)
    if caller.role != RoomRole.owner:
        raise HTTPException(status_code=403, detail="Only the owner can transfer ownership")

    if body.new_owner_id == current_agent:
        raise HTTPException(status_code=400, detail="Cannot transfer ownership to yourself")

    new_owner_member = None
    for m in room.members:
        if m.agent_id == body.new_owner_id:
            new_owner_member = m
            break
    if new_owner_member is None:
        raise HTTPException(status_code=404, detail="New owner is not a member of this room")

    caller.role = RoomRole.member
    new_owner_member.role = RoomRole.owner
    room.owner_id = body.new_owner_id

    await db.commit()
    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.post("/{room_id}/promote", response_model=RoomResponse)
async def promote_demote(
    room_id: str,
    body: PromoteRoomMemberRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Promote/demote a member. Owner only. Valid roles: 'admin', 'member'."""
    room = await _load_room(db, room_id)
    caller = _require_membership(room, current_agent)
    if caller.role != RoomRole.owner:
        raise HTTPException(status_code=403, detail="Only the owner can promote/demote")

    target = None
    for m in room.members:
        if m.agent_id == body.agent_id:
            target = m
            break
    if target is None:
        raise HTTPException(status_code=404, detail="Member not found in room")

    if target.role == RoomRole.owner:
        raise HTTPException(status_code=400, detail="Cannot change owner role via promote/demote")

    target.role = RoomRole(body.role)
    await db.commit()
    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.post("/{room_id}/mute", response_model=dict)
async def mute_room(
    room_id: str,
    body: MuteRoomRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Set mute status for the current member. Muted members skip fan-out."""
    room = await _load_room(db, room_id)
    member = _require_membership(room, current_agent)
    member.muted = body.muted
    await db.commit()
    return {"ok": True, "muted": member.muted}


@router.post("/{room_id}/permissions", response_model=RoomResponse)
async def set_member_permissions(
    room_id: str,
    body: SetMemberPermissionsRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_agent),
):
    """Set per-member permission overrides (can_send, can_invite).

    - Owner/admin can set permissions for members.
    - Cannot modify owner's permissions.
    - Admin cannot modify another admin's permissions.
    """
    room = await _load_room(db, room_id)
    caller = _require_admin_or_owner(room, current_agent)

    target = None
    for m in room.members:
        if m.agent_id == body.agent_id:
            target = m
            break
    if target is None:
        raise HTTPException(status_code=404, detail="Member not found in room")

    if target.role == RoomRole.owner:
        raise HTTPException(status_code=400, detail="Cannot modify owner permissions")

    if target.role == RoomRole.admin and caller.role != RoomRole.owner:
        raise HTTPException(status_code=403, detail="Only the owner can modify admin permissions")

    # Apply permission overrides (None = use defaults)
    target.can_send = body.can_send
    target.can_invite = body.can_invite

    await db.commit()
    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)
