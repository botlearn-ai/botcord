"""Unified Room management endpoints (replaces group, channel, session routers)."""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from hub.i18n import I18nHTTPException
from sqlalchemy import select, func as sa_func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from hub.auth import get_current_claimed_agent
from hub import config as hub_config
from hub.config import JOIN_RATE_LIMIT_PER_MINUTE
from hub.database import get_db
from hub.id_generators import generate_room_id
from hub.enums import SubscriptionProductStatus, SubscriptionStatus
from hub.models import (
    Agent,
    AgentSubscription,
    Contact,
    MessagePolicy,
    Room,
    RoomJoinPolicy,
    RoomMember,
    RoomRole,
    RoomVisibility,
    SubscriptionRoomCreatorPolicy,
    SubscriptionProduct,
)
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
    SubscriptionRoomCreatorPolicyListResponse,
    SubscriptionRoomCreatorPolicyResponse,
    SubscriptionRoomCreatorPolicyUpsertRequest,
    SetMemberPermissionsRequest,
    TransferRoomOwnerRequest,
    UpdateRoomRequest,
)

router = APIRouter(prefix="/hub/rooms", tags=["rooms"])
internal_router = APIRouter(prefix="/internal/rooms", tags=["rooms-internal"])

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
        raise I18nHTTPException(status_code=429, message_key="join_rate_limit_exceeded")
    window.append(now)


def _require_internal(authorization: str | None = None):
    if not hub_config.ALLOW_PRIVATE_ENDPOINTS:
        raise HTTPException(status_code=403, detail="Internal endpoints are disabled")

    expected = hub_config.INTERNAL_API_SECRET
    if expected:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing internal API secret")
        provided = authorization.removeprefix("Bearer ").strip()
        if provided != expected:
            raise HTTPException(status_code=401, detail="Invalid internal API secret")


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
        required_subscription_product_id=room.required_subscription_product_id,
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
        required_subscription_product_id=room.required_subscription_product_id,
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
        raise I18nHTTPException(status_code=404, message_key="room_not_found")
    return room


def _require_membership(room: Room, agent_id: str) -> RoomMember:
    """Return the member record or raise 403."""
    for m in room.members:
        if m.agent_id == agent_id:
            return m
    raise I18nHTTPException(status_code=403, message_key="not_a_member")


def _require_admin_or_owner(room: Room, agent_id: str) -> RoomMember:
    """Return the member record if owner/admin, else raise 403."""
    member = _require_membership(room, agent_id)
    if member.role not in (RoomRole.owner, RoomRole.admin):
        raise I18nHTTPException(status_code=403, message_key="admin_or_owner_required")
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


def _validate_subscription_room_config(
    visibility: RoomVisibility,
    join_policy: RoomJoinPolicy,
    required_subscription_product_id: str | None,
) -> None:
    if required_subscription_product_id and join_policy != RoomJoinPolicy.invite_only:
        raise HTTPException(
            status_code=400,
            detail="Subscription-gated rooms must use invite_only join policy",
        )


async def _ensure_room_subscription_product(
    db: AsyncSession,
    owner_id: str,
    required_subscription_product_id: str | None,
) -> SubscriptionProduct | None:
    if not required_subscription_product_id:
        return None

    result = await db.execute(
        select(SubscriptionProduct).where(
            SubscriptionProduct.product_id == required_subscription_product_id
        )
    )
    product = result.scalar_one_or_none()
    if product is None:
        raise HTTPException(status_code=400, detail="Subscription product not found")
    if product.owner_agent_id != owner_id:
        raise HTTPException(
            status_code=403,
            detail="Room owner must own the required subscription product",
        )
    if product.status != SubscriptionProductStatus.active:
        raise HTTPException(
            status_code=400,
            detail="Required subscription product must be active",
        )
    return product


async def _ensure_subscription_room_access(
    db: AsyncSession,
    room: Room,
    target_agent_id: str,
) -> None:
    if not room.required_subscription_product_id or target_agent_id == room.owner_id:
        return

    result = await db.execute(
        select(AgentSubscription).where(
            AgentSubscription.product_id == room.required_subscription_product_id,
            AgentSubscription.subscriber_agent_id == target_agent_id,
            AgentSubscription.status == SubscriptionStatus.active,
        )
    )
    subscription = result.scalar_one_or_none()
    if subscription is None:
        raise HTTPException(
            status_code=403,
            detail="Active subscription required to join this room",
        )


def _subscription_room_creator_policy_response(
    policy: SubscriptionRoomCreatorPolicy,
) -> SubscriptionRoomCreatorPolicyResponse:
    return SubscriptionRoomCreatorPolicyResponse(
        agent_id=policy.agent_id,
        allowed_to_create=policy.allowed_to_create,
        max_active_rooms=policy.max_active_rooms,
        note=policy.note,
        created_at=policy.created_at,
        updated_at=policy.updated_at,
    )


async def _enforce_subscription_room_creator_policy(
    db: AsyncSession,
    agent_id: str,
    required_subscription_product_id: str | None,
    *,
    exclude_room_id: str | None = None,
) -> None:
    if not required_subscription_product_id:
        return

    result = await db.execute(
        select(SubscriptionRoomCreatorPolicy).where(
            SubscriptionRoomCreatorPolicy.agent_id == agent_id
        )
    )
    policy = result.scalar_one_or_none()
    if policy is None or not policy.allowed_to_create:
        raise HTTPException(
            status_code=403,
            detail="Agent is not allowed to create subscription-gated rooms",
        )

    stmt = select(sa_func.count(Room.id)).where(
        Room.owner_id == agent_id,
        Room.required_subscription_product_id.is_not(None),
    )
    if exclude_room_id is not None:
        stmt = stmt.where(Room.room_id != exclude_room_id)
    room_count_result = await db.execute(stmt)
    active_room_count = room_count_result.scalar() or 0
    if active_room_count >= policy.max_active_rooms:
        raise HTTPException(
            status_code=403,
            detail="Subscription-gated room quota exceeded",
        )


async def _ensure_existing_members_match_subscription_requirement(
    db: AsyncSession,
    room: Room,
    required_subscription_product_id: str | None,
) -> None:
    if not required_subscription_product_id:
        return

    member_ids = {
        member.agent_id
        for member in room.members
        if member.agent_id != room.owner_id
    }
    if not member_ids:
        return

    result = await db.execute(
        select(AgentSubscription.subscriber_agent_id).where(
            AgentSubscription.product_id == required_subscription_product_id,
            AgentSubscription.subscriber_agent_id.in_(member_ids),
            AgentSubscription.status == SubscriptionStatus.active,
        )
    )
    subscribed_member_ids = set(result.scalars().all())
    missing_member_ids = member_ids - subscribed_member_ids
    if missing_member_ids:
        raise HTTPException(
            status_code=400,
            detail="All existing members must have an active subscription for this room",
        )


# ---------------------------------------------------------------------------
# Routes — ordered so /me comes before /{room_id}
# ---------------------------------------------------------------------------


@router.post("", response_model=RoomResponse, status_code=201)
async def create_room(
    body: CreateRoomRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Create a new room. Creator becomes the owner."""
    _validate_subscription_room_config(
        body.visibility, body.join_policy, body.required_subscription_product_id
    )
    await _enforce_subscription_room_creator_policy(
        db, current_agent, body.required_subscription_product_id
    )
    await _ensure_room_subscription_product(
        db, current_agent, body.required_subscription_product_id
    )

    unique_member_ids = set(body.member_ids) - {current_agent}

    if unique_member_ids:
        result = await db.execute(
            select(Agent).where(Agent.agent_id.in_(unique_member_ids))
        )
        agents = list(result.scalars().all())
        if len(agents) != len(unique_member_ids):
            raise I18nHTTPException(status_code=400, message_key="member_ids_not_found")

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
                raise I18nHTTPException(
                    status_code=403,
                    message_key="admission_denied_contacts_only",
                    denied=str(sorted(denied)),
                )

    if body.max_members is not None and len(unique_member_ids) + 1 > body.max_members:
        raise I18nHTTPException(status_code=400, message_key="initial_members_exceed_max")

    if body.required_subscription_product_id:
        for member_id in unique_member_ids:
            result = await db.execute(
                select(AgentSubscription).where(
                    AgentSubscription.product_id == body.required_subscription_product_id,
                    AgentSubscription.subscriber_agent_id == member_id,
                    AgentSubscription.status == SubscriptionStatus.active,
                )
            )
            if result.scalar_one_or_none() is None:
                raise HTTPException(
                    status_code=400,
                    detail="All initial members must have an active subscription for this room",
                )

    room = Room(
        room_id=generate_room_id(),
        name=body.name,
        description=body.description,
        rule=_normalize_room_rule(body.rule),
        owner_id=current_agent,
        visibility=body.visibility,
        join_policy=body.join_policy,
        required_subscription_product_id=body.required_subscription_product_id,
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


@internal_router.put(
    "/subscription-room-policies/{agent_id}",
    response_model=SubscriptionRoomCreatorPolicyResponse,
)
async def upsert_subscription_room_creator_policy(
    agent_id: str,
    body: SubscriptionRoomCreatorPolicyUpsertRequest,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    _require_internal(authorization)

    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    result = await db.execute(
        select(SubscriptionRoomCreatorPolicy).where(
            SubscriptionRoomCreatorPolicy.agent_id == agent_id
        )
    )
    policy = result.scalar_one_or_none()
    if policy is None:
        policy = SubscriptionRoomCreatorPolicy(
            agent_id=agent_id,
            allowed_to_create=body.allowed_to_create,
            max_active_rooms=body.max_active_rooms,
            note=body.note,
        )
        db.add(policy)
    else:
        policy.allowed_to_create = body.allowed_to_create
        policy.max_active_rooms = body.max_active_rooms
        policy.note = body.note

    await db.commit()
    await db.refresh(policy)
    return _subscription_room_creator_policy_response(policy)


@internal_router.get(
    "/subscription-room-policies/{agent_id}",
    response_model=SubscriptionRoomCreatorPolicyResponse,
)
async def get_subscription_room_creator_policy(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    _require_internal(authorization)

    result = await db.execute(
        select(SubscriptionRoomCreatorPolicy).where(
            SubscriptionRoomCreatorPolicy.agent_id == agent_id
        )
    )
    policy = result.scalar_one_or_none()
    if policy is None:
        raise HTTPException(status_code=404, detail="Subscription room creator policy not found")
    return _subscription_room_creator_policy_response(policy)


@internal_router.get(
    "/subscription-room-policies",
    response_model=SubscriptionRoomCreatorPolicyListResponse,
)
async def list_subscription_room_creator_policies(
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    _require_internal(authorization)

    result = await db.execute(
        select(SubscriptionRoomCreatorPolicy).order_by(
            SubscriptionRoomCreatorPolicy.created_at.desc()
        )
    )
    policies = list(result.scalars().all())
    return SubscriptionRoomCreatorPolicyListResponse(
        policies=[
            _subscription_room_creator_policy_response(policy)
            for policy in policies
        ]
    )


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
    current_agent: str = Depends(get_current_claimed_agent),
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
    current_agent: str = Depends(get_current_claimed_agent),
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
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Update room info. Owner/admin only."""
    room = await _load_room(db, room_id)
    _require_admin_or_owner(room, current_agent)
    previous_required_subscription_product_id = room.required_subscription_product_id

    try:
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
        if "required_subscription_product_id" in body.model_fields_set:
            room.required_subscription_product_id = body.required_subscription_product_id
        if "max_members" in body.model_fields_set:
            room.max_members = body.max_members
        if "default_send" in body.model_fields_set:
            room.default_send = body.default_send
        if "default_invite" in body.model_fields_set:
            room.default_invite = body.default_invite
        if "slow_mode_seconds" in body.model_fields_set:
            room.slow_mode_seconds = body.slow_mode_seconds

        _validate_subscription_room_config(
            room.visibility, room.join_policy, room.required_subscription_product_id
        )
        await _enforce_subscription_room_creator_policy(
            db,
            room.owner_id,
            room.required_subscription_product_id,
            exclude_room_id=room.room_id,
        )
        await _ensure_room_subscription_product(
            db, room.owner_id, room.required_subscription_product_id
        )
        if (
            room.required_subscription_product_id
            and room.required_subscription_product_id != previous_required_subscription_product_id
        ):
            await _ensure_existing_members_match_subscription_requirement(
                db, room, room.required_subscription_product_id
            )

        await db.commit()
    except HTTPException:
        await db.rollback()
        raise

    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.delete("/{room_id}", response_model=dict)
async def dissolve_room(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Dissolve (delete) a room. Owner only."""
    room = await _load_room(db, room_id)
    member = _require_membership(room, current_agent)
    if member.role != RoomRole.owner:
        raise I18nHTTPException(status_code=403, message_key="only_owner_can_dissolve")

    await db.delete(room)
    await db.commit()
    return {"ok": True}


@router.post("/{room_id}/members", response_model=RoomResponse, status_code=201)
async def add_member(
    room_id: str,
    body: AddRoomMemberRequest | None = None,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
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
            raise I18nHTTPException(
                status_code=403,
                message_key="self_join_public_open_only",
            )
        _check_join_rate_limit(room_id)
    else:
        # Permission check: use _can_invite instead of _require_admin_or_owner
        inviter = _require_membership(room, current_agent)
        if not _can_invite(room, inviter):
            raise I18nHTTPException(status_code=403, message_key="no_invite_permission")

        # Check target agent exists and load for admission policy
        result = await db.execute(
            select(Agent).where(Agent.agent_id == target_agent_id)
        )
        target_agent = result.scalar_one_or_none()
        if target_agent is None:
            raise I18nHTTPException(status_code=404, message_key="agent_not_found")

        # Admission policy: contacts_only agents require inviter to be in their contacts
        if target_agent.message_policy == MessagePolicy.contacts_only:
            contact_result = await db.execute(
                select(Contact).where(
                    Contact.owner_id == target_agent_id,
                    Contact.contact_agent_id == current_agent,
                )
            )
            if contact_result.scalar_one_or_none() is None:
                raise I18nHTTPException(
                    status_code=403,
                    message_key="admission_denied_target_contacts_only",
                )

    # Check max_members
    if room.max_members is not None and len(room.members) >= room.max_members:
        raise I18nHTTPException(status_code=400, message_key="room_is_full")

    await _ensure_subscription_room_access(db, room, target_agent_id)

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
        raise I18nHTTPException(
            status_code=409,
            message_key="agent_already_member_or_not_exist",
        )

    await db.commit()
    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.delete("/{room_id}/members/{agent_id}", response_model=RoomResponse)
async def remove_member(
    room_id: str,
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
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
        raise I18nHTTPException(status_code=404, message_key="member_not_found_in_room")

    if target.role == RoomRole.owner:
        raise I18nHTTPException(status_code=400, message_key="cannot_remove_room_owner")

    if target.role == RoomRole.admin and caller.role != RoomRole.owner:
        raise I18nHTTPException(status_code=403, message_key="only_owner_can_remove_admins")

    await db.delete(target)
    await db.commit()

    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.post("/{room_id}/leave", response_model=dict)
async def leave_room(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Leave a room. Owner cannot leave."""
    room = await _load_room(db, room_id)
    member = _require_membership(room, current_agent)

    if member.role == RoomRole.owner:
        raise I18nHTTPException(status_code=400, message_key="owner_cannot_leave")

    await db.delete(member)
    await db.commit()
    return {"ok": True}


@router.post("/{room_id}/transfer", response_model=RoomResponse)
async def transfer_ownership(
    room_id: str,
    body: TransferRoomOwnerRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Transfer room ownership to another member. Owner only."""
    room = await _load_room(db, room_id)
    caller = _require_membership(room, current_agent)
    if caller.role != RoomRole.owner:
        raise I18nHTTPException(status_code=403, message_key="only_owner_can_transfer")

    if body.new_owner_id == current_agent:
        raise I18nHTTPException(status_code=400, message_key="cannot_transfer_to_self")

    new_owner_member = None
    for m in room.members:
        if m.agent_id == body.new_owner_id:
            new_owner_member = m
            break
    if new_owner_member is None:
        raise I18nHTTPException(status_code=404, message_key="new_owner_not_member")

    if room.required_subscription_product_id:
        await _ensure_room_subscription_product(
            db, body.new_owner_id, room.required_subscription_product_id
        )

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
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Promote/demote a member. Owner only. Valid roles: 'admin', 'member'."""
    room = await _load_room(db, room_id)
    caller = _require_membership(room, current_agent)
    if caller.role != RoomRole.owner:
        raise I18nHTTPException(status_code=403, message_key="only_owner_can_promote")

    target = None
    for m in room.members:
        if m.agent_id == body.agent_id:
            target = m
            break
    if target is None:
        raise I18nHTTPException(status_code=404, message_key="member_not_found_in_room")

    if target.role == RoomRole.owner:
        raise I18nHTTPException(status_code=400, message_key="cannot_change_owner_role")

    target.role = RoomRole(body.role)
    await db.commit()
    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)


@router.post("/{room_id}/mute", response_model=dict)
async def mute_room(
    room_id: str,
    body: MuteRoomRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
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
    current_agent: str = Depends(get_current_claimed_agent),
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
        raise I18nHTTPException(status_code=404, message_key="member_not_found_in_room")

    if target.role == RoomRole.owner:
        raise I18nHTTPException(status_code=400, message_key="cannot_modify_owner_permissions")

    if target.role == RoomRole.admin and caller.role != RoomRole.owner:
        raise I18nHTTPException(status_code=403, message_key="only_owner_can_modify_admin_permissions")

    # Apply permission overrides (None = use defaults)
    target.can_send = body.can_send
    target.can_invite = body.can_invite

    await db.commit()
    room = await _load_room(db, room.room_id, fresh=True)
    return _build_room_response(room)
