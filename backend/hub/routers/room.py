"""Unified Room management endpoints (replaces group, channel, session routers).

Hub / agent-protocol layer (``a2a/0.1``).

All routes in this module serve the **agent-protocol layer**: every request is
authenticated via :func:`hub.auth.get_current_claimed_agent`, which requires
an ``Active-Agent-Id`` header plus a valid agent JWT (or a signed envelope).
No Supabase / human JWT is accepted here.

Human-scoped room operations (rooms that are owned by a human user and the
BFF endpoints called from the dashboard while the user is signed in as a
human) live at ``/api/humans/me/rooms*`` in ``app/routers/humans.py``. Human
users MUST go through that router — they cannot create, invite, transfer, or
otherwise operate on rooms through this router.

Polymorphism notes (post Human-first merge):

* ``Room.owner_type`` can be ``'agent'`` (default) or ``'human'``.
* ``RoomMember.participant_type`` can be ``'agent'`` or ``'human'``.

This router only creates ``owner_type='agent'`` rooms — ``hu_*`` ids are
rejected on any input field (member ids, new owner id, promote target, etc.)
with HTTP 400. The permission helpers in this module also make sure that
when the caller is an agent we only ever look at the agent's own
``RoomMember`` row (``participant_type='agent'``) so a human's row in the
same room doesn't collide or grant the agent unintended privileges.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import JSONResponse
from hub.i18n import I18nHTTPException
from sqlalchemy import select, func as sa_func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from hub.auth import get_current_claimed_agent
from hub.routers.hub import is_agent_ws_online
from hub import config as hub_config
from hub.config import JOIN_RATE_LIMIT_PER_MINUTE
from hub.share_payloads import frontend_url
from hub.database import get_db
from hub.id_generators import generate_room_id
from hub.enums import SubscriptionProductStatus, SubscriptionStatus
from hub.models import (
    Agent,
    AgentApprovalQueue,
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
from hub.enums import ApprovalKind, ApprovalState, ParticipantType
from hub.policy import Principal, check_room_invite_admission
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

logger = logging.getLogger(__name__)

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


_HUMAN_ID_ERROR = (
    "human ids (hu_*) are not accepted on the hub router; "
    "use /api/humans/me/rooms*"
)


def _reject_human_id(value: str | None, *, field: str = "id") -> None:
    """Reject ``hu_*`` ids on any input field of this router.

    Humans operate through ``/api/humans/*`` (Supabase-authenticated BFF),
    never through the agent-protocol layer. We only validate inputs here —
    read-only output fields that may legitimately contain ``hu_*`` ids
    (e.g. a member list) are untouched.
    """
    if value is None:
        return
    if isinstance(value, str) and value.startswith("hu_"):
        raise HTTPException(
            status_code=400,
            detail=f"{_HUMAN_ID_ERROR} (field={field}, value={value})",
        )


def _reject_human_ids(values, *, field: str = "ids") -> None:
    """Batch version of :func:`_reject_human_id`."""
    if not values:
        return
    for v in values:
        _reject_human_id(v, field=field)


def _room_owner_is_human(room: Room) -> bool:
    return getattr(room, "owner_type", "agent") == "human"


def _normalize_room_rule(rule: str | None) -> str | None:
    """Collapse blank/whitespace-only room rules to None."""
    if rule is None:
        return None
    normalized = rule.strip()
    return normalized or None


def _room_url(room_id: str) -> str:
    return frontend_url(f"/chats/messages/{room_id}")


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
        allow_human_send=room.allow_human_send,
        slow_mode_seconds=room.slow_mode_seconds,
        member_count=len(room.members),
        members=[
            RoomMemberResponse(
                agent_id=m.agent_id,
                display_name=m.agent.display_name if m.agent is not None else None,
                role=m.role.value,
                muted=m.muted,
                can_send=m.can_send,
                can_invite=m.can_invite,
                joined_at=m.joined_at,
                online=is_agent_ws_online(m.agent_id),
            )
            for m in room.members
        ],
        created_at=room.created_at,
        url=_room_url(room.room_id),
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
        allow_human_send=room.allow_human_send,
        member_count=len(room.members),
        created_at=room.created_at,
        url=_room_url(room.room_id),
    )


async def _load_room(db: AsyncSession, room_id: str, *, fresh: bool = False) -> Room:
    """Load room with members eagerly. Raises 404 if not found."""
    if fresh:
        db.expire_all()
    result = await db.execute(
        select(Room)
        .where(Room.room_id == room_id)
        .options(selectinload(Room.members).selectinload(RoomMember.agent))
    )
    room = result.scalar_one_or_none()
    if room is None:
        raise I18nHTTPException(status_code=404, message_key="room_not_found")
    return room


def _require_membership(room: Room, agent_id: str) -> RoomMember:
    """Return the agent-member record for ``agent_id`` or raise 403.

    Always filters by ``participant_type='agent'`` (when the column is
    present) so a human's row — which may share the ``agent_id`` column —
    does not accidentally satisfy the check for an agent caller.
    """
    for m in room.members:
        if m.agent_id != agent_id:
            continue
        # Only match the agent-type row. Pre-Human-first the attribute is
        # absent; legacy rows (and tests that bypass model defaults) can
        # also leave ``participant_type`` NULL — both count as 'agent'.
        # Explicit 'human' is still excluded.
        ptype = getattr(m, "participant_type", None)
        if ptype is not None and ptype != "agent" and getattr(ptype, "value", None) != "agent":
            continue
        return m
    raise I18nHTTPException(status_code=403, message_key="not_a_member")


def _require_admin_or_owner(room: Room, agent_id: str) -> RoomMember:
    """Return the agent-member record if owner/admin, else raise 403.

    In a human-owned room (``room.owner_type='human'``) the hub-level
    "owner" is a human, so no agent can be the owner — only an agent with
    ``role=admin`` can satisfy this check from the hub side. A human user
    who wants to administer the room must go through
    ``/api/humans/me/rooms*``.
    """
    member = _require_membership(room, agent_id)
    if member.role not in (RoomRole.owner, RoomRole.admin):
        raise I18nHTTPException(status_code=403, message_key="admin_or_owner_required")
    return member


def _can_invite(room: Room, member: RoomMember) -> bool:
    """Check if an agent-member can invite others to a room.

    Resolution order:
      1. agent-owner → always True
         (In a human-owned room no agent is the owner; we fall through.)
      2. public + open room → always True (anyone can join anyway)
      3. member.can_invite is not None → use explicit value
      4. admin → default True
      5. room.default_invite

    Human-owned rooms are handled the same way as agent-owned rooms for
    non-owner permissions: an agent member who has ``default_invite=True``
    (or an explicit ``can_invite=True`` override) can still invite other
    agents through this router.
    """
    # Only treat the member as the owner when the room itself is
    # agent-owned. Belt-and-suspenders: ``_require_membership`` already
    # filters to agent-type rows, but we also guard on owner_type so a
    # mis-labelled row can't grant silent owner privileges to an agent in
    # a human-owned room.
    if member.role == RoomRole.owner and not _room_owner_is_human(room):
        return True
    if room.visibility == RoomVisibility.public and room.join_policy == RoomJoinPolicy.open:
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
    # Subscription-gated rooms no longer require invite_only — subscribers
    # can self-join regardless of join_policy.
    pass


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
    # TODO: temporarily skip whitelist verification — allow anyone to create subscription rooms
    return


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
# Realtime broadcast helpers for room membership changes
# ---------------------------------------------------------------------------


async def _notify_room_member_change(
    db: AsyncSession,
    *,
    event_type: str,
    room_id: str,
    changed_agent_id: str,
    notify_agent_ids: list[str],
) -> None:
    """Broadcast a room membership event to each agent in *notify_agent_ids*.

    Uses the same ``build_agent_realtime_event`` / ``notify_inbox`` pipeline
    that message and contact events use, so the frontend Supabase channel
    picks the event up automatically.
    """
    from hub.routers.hub import build_agent_realtime_event, notify_inbox

    async def _send(agent_id: str) -> None:
        event = build_agent_realtime_event(
            type=event_type,
            agent_id=agent_id,
            room_id=room_id,
            ext={"changed_agent_id": changed_agent_id},
        )
        await notify_inbox(agent_id, db=db, realtime_event=event)

    await asyncio.gather(*[_send(aid) for aid in notify_agent_ids], return_exceptions=True)


# ---------------------------------------------------------------------------
# Routes — ordered so /me comes before /{room_id}
# ---------------------------------------------------------------------------


@router.post("", response_model=RoomResponse, status_code=201)
async def create_room(
    body: CreateRoomRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Create a new room. Creator becomes the owner.

    Rooms created through this router default to ``owner_type='agent'``.
    Human-owned rooms must be created via ``POST /api/humans/me/rooms``.
    """
    # Reject hu_* in any input list — humans cannot be invited through the
    # agent-protocol layer.
    _reject_human_ids(body.member_ids, field="member_ids")
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

        # Admission policy via the central helper — applied per-invitee so
        # `room_invite_policy` / `allow_agent_sender` / blocks all gate consistently.
        inviter_principal = Principal(id=current_agent, type=ParticipantType.agent)
        denied: list[str] = []
        for invitee in agents:
            try:
                await check_room_invite_admission(
                    db, inviter=inviter_principal, invitee=invitee
                )
            except I18nHTTPException:
                denied.append(invitee.agent_id)
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
        allow_human_send=body.allow_human_send,
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
        .options(selectinload(Room.members).selectinload(RoomMember.agent))
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
        if body.allow_human_send is not None:
            room.allow_human_send = body.allow_human_send
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

    # Pre-cancel any subscriptions bound to this room. The FK uses ON DELETE
    # SET NULL, so without this step the active subscriptions become orphaned
    # ("ghost" subs whose mismatch check can never trigger). No need to revoke
    # room membership — the room itself is about to be deleted.
    import datetime as _dt
    bound_subs = (
        await db.execute(
            select(AgentSubscription).where(
                AgentSubscription.room_id == room.room_id,
                AgentSubscription.status.in_(
                    [SubscriptionStatus.active, SubscriptionStatus.past_due]
                ),
            )
        )
    ).scalars().all()
    if bound_subs:
        now = _dt.datetime.now(_dt.timezone.utc)
        for sub in bound_subs:
            sub.status = SubscriptionStatus.cancelled
            sub.cancelled_at = now
            sub.cancel_at_period_end = False
        await db.flush()

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
    # Reject hu_* on the body — humans are added through
    # /api/humans/me/rooms*, never through this router.
    if body is not None:
        _reject_human_id(body.agent_id, field="agent_id")

    room = await _load_room(db, room_id)
    target_agent_id = body.agent_id if body and body.agent_id else None
    is_self_join = target_agent_id is None or target_agent_id == current_agent

    if is_self_join:
        target_agent_id = current_agent
        # Subscription-gated rooms: subscribers can self-join regardless of join_policy,
        # but room must still be public (visibility check is NOT bypassed).
        has_subscription_access = False
        if room.required_subscription_product_id and room.visibility == RoomVisibility.public:
            sub_result = await db.execute(
                select(AgentSubscription).where(
                    AgentSubscription.product_id == room.required_subscription_product_id,
                    AgentSubscription.subscriber_agent_id == target_agent_id,
                    AgentSubscription.status == SubscriptionStatus.active,
                )
            )
            has_subscription_access = sub_result.scalar_one_or_none() is not None
        if not has_subscription_access:
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

        # Admission policy via the central helper.
        try:
            await check_room_invite_admission(
                db,
                inviter=Principal(id=current_agent, type=ParticipantType.agent),
                invitee=target_agent,
            )
        except I18nHTTPException as exc:
            # Preserve the legacy message key for the contacts_only path so
            # existing clients keep their copy; pass through other reasons.
            if exc.message_key == "room_invite_requires_contact":
                raise I18nHTTPException(
                    status_code=403,
                    message_key="admission_denied_target_contacts_only",
                ) from None
            raise

        # Claimed agents: queue the invite for owner Human to approve
        if target_agent.user_id is not None:
            import json as _json
            entry = AgentApprovalQueue(
                agent_id=target_agent_id,
                owner_user_id=target_agent.user_id,
                kind=ApprovalKind.room_invite,
                payload_json=_json.dumps({
                    "room_id": room_id,
                    "invited_by": current_agent,
                    "can_send": body.can_send if body else None,
                    "can_invite": body.can_invite if body else None,
                }),
                state=ApprovalState.pending,
            )
            db.add(entry)
            await db.commit()
            return JSONResponse(
                {"status": "queued_for_approval", "approval_id": str(entry.id)},
                status_code=202,
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

    # Notify the new member and all existing members about the addition
    all_member_ids = [m.agent_id for m in room.members]
    await _notify_room_member_change(
        db,
        event_type="room_member_added",
        room_id=room.room_id,
        changed_agent_id=target_agent_id,
        notify_agent_ids=all_member_ids,
    )

    return _build_room_response(room)


@router.delete("/{room_id}/members/{agent_id}", response_model=RoomResponse)
async def remove_member(
    room_id: str,
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Remove a member from the room. Owner/admin only. Cannot remove the owner."""
    # Humans cannot be removed via the hub router — route through
    # /api/humans/me/rooms* instead.
    _reject_human_id(agent_id, field="agent_id")
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

    removed_agent_id = target.agent_id
    await db.delete(target)
    await db.commit()

    room = await _load_room(db, room.room_id, fresh=True)

    # Notify the removed member and all remaining members
    remaining_ids = [m.agent_id for m in room.members]
    await _notify_room_member_change(
        db,
        event_type="room_member_removed",
        room_id=room.room_id,
        changed_agent_id=removed_agent_id,
        notify_agent_ids=[removed_agent_id] + remaining_ids,
    )

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

    # Capture remaining member IDs before deleting
    remaining_ids = [m.agent_id for m in room.members if m.agent_id != current_agent]

    await db.delete(member)
    await db.commit()

    # Notify remaining members about the departure
    await _notify_room_member_change(
        db,
        event_type="room_member_removed",
        room_id=room.room_id,
        changed_agent_id=current_agent,
        notify_agent_ids=remaining_ids,
    )

    return {"ok": True}


@router.post("/{room_id}/transfer", response_model=RoomResponse)
async def transfer_ownership(
    room_id: str,
    body: TransferRoomOwnerRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Transfer room ownership to another member. Owner only.

    Only agent-to-agent transfers are supported here. Transferring
    ownership to a human must be done through the human BFF layer.
    """
    _reject_human_id(body.new_owner_id, field="new_owner_id")
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
    _reject_human_id(body.agent_id, field="agent_id")
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
    _reject_human_id(body.agent_id, field="agent_id")
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
