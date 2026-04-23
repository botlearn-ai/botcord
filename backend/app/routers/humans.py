"""
[INPUT]: Supabase-authenticated user context + shared database session
[OUTPUT]: /api/humans/me surface — Human profile, rooms, contacts, agent-approval queue
[POS]: app BFF entry for Human-as-first-class. Mirrors /api/users but from the
       social-identity (hu_*) angle, and exposes the owner-side approval queue
       that guards claimed Agents.
[PROTOCOL]: Human messages are unsigned; Hub-trust comes from Supabase JWT
            proving ``users.human_id == from``. See hub/crypto.py for the
            envelope-level short-circuit.
"""

from __future__ import annotations

import datetime
import json
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.enums import (
    ApprovalKind,
    ApprovalState,
    ContactRequestState,
    MessagePolicy,
    ParticipantType,
    RoomJoinPolicy,
    RoomRole,
    RoomVisibility,
    SubscriptionStatus,
)
from hub.id_generators import generate_human_id, generate_room_id
from hub.models import (
    Agent,
    AgentApprovalQueue,
    AgentSubscription,
    Contact,
    ContactRequest,
    Room,
    RoomMember,
    User,
)

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/humans", tags=["app-humans"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class HumanInfo(BaseModel):
    human_id: str
    display_name: str
    avatar_url: str | None
    email: str | None


class HumanRoomSummary(BaseModel):
    room_id: str
    name: str
    description: str
    owner_id: str
    owner_type: Literal["agent", "human"]
    visibility: str
    join_policy: str
    my_role: str


class HumanRoomListResponse(BaseModel):
    rooms: list[HumanRoomSummary]


class CreateHumanRoomBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    description: str = ""
    rule: str | None = Field(default=None, max_length=4000)
    visibility: Literal["public", "private"] = "private"
    join_policy: Literal["open", "invite_only"] = "invite_only"
    default_send: bool = True
    default_invite: bool = False
    max_members: int | None = Field(default=None, ge=1)
    slow_mode_seconds: int | None = Field(default=None, ge=0)
    member_ids: list[str] = Field(default_factory=list)


class HumanContactSummary(BaseModel):
    peer_id: str
    peer_type: Literal["agent", "human"]
    alias: str | None
    created_at: int


class HumanContactListResponse(BaseModel):
    contacts: list[HumanContactSummary]


class AddRoomMemberBody(BaseModel):
    participant_id: str = Field(..., min_length=1, max_length=32)
    role: Literal["member", "admin"] = "member"


class HumanRoomMemberResponse(BaseModel):
    room_id: str
    participant_id: str
    participant_type: Literal["agent", "human"]
    role: Literal["owner", "admin", "member"]
    joined_at: int


class HumanContactRequestSummary(BaseModel):
    id: str
    from_participant_id: str
    from_type: Literal["agent", "human"]
    from_display_name: str | None
    to_participant_id: str
    to_type: Literal["agent", "human"]
    to_display_name: str | None
    state: Literal["pending", "accepted", "rejected"]
    message: str | None
    created_at: int


class HumanContactRequestListResponse(BaseModel):
    requests: list[HumanContactRequestSummary]


class HumanContactRequestResolveResponse(BaseModel):
    id: str
    state: Literal["accepted", "rejected"]


class ContactRequestBody(BaseModel):
    peer_id: str = Field(..., min_length=1, max_length=32)
    message: str | None = Field(default=None, max_length=500)


class ContactRequestResponse(BaseModel):
    status: Literal["requested", "queued_for_approval", "already_contact", "already_requested"]
    approval_id: str | None = None
    request_id: str | None = None


class PendingApprovalSummary(BaseModel):
    id: str
    agent_id: str
    kind: str
    payload: dict
    created_at: int


class PendingApprovalListResponse(BaseModel):
    approvals: list[PendingApprovalSummary]


class ResolveApprovalBody(BaseModel):
    decision: Literal["approve", "reject"]


class ResolveApprovalResponse(BaseModel):
    id: str
    state: Literal["approved", "rejected"]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _ts(dt: datetime.datetime | None) -> int:
    if dt is None:
        return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return int(dt.timestamp())


async def _load_human(db: AsyncSession, ctx: RequestContext) -> User:
    """Fetch the User and guarantee its ``human_id`` column is populated.

    Legacy rows created before migration 021 can have a NULL human_id; they
    get a lazy backfill the first time the owner hits any /api/humans/me
    route. New rows already pick up the model-level default at INSERT time.
    """
    result = await db.execute(select(User).where(User.id == ctx.user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.human_id:
        user.human_id = generate_human_id()
        await db.flush()
    return user


def _split_prefix(participant_id: str) -> ParticipantType:
    if participant_id.startswith("hu_"):
        return ParticipantType.human
    if participant_id.startswith("ag_"):
        return ParticipantType.agent
    raise HTTPException(status_code=400, detail="peer_id must be prefixed with ag_ or hu_")


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------


@router.post("/me", response_model=HumanInfo)
async def create_or_get_human(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Idempotently return the current user's Human identity.

    The first Supabase login auto-creates the User with a ``human_id``
    default (see hub.models.User). This endpoint exists so the frontend
    can explicitly mint / refresh the Human before entering the dashboard,
    without having to infer it from the generic /api/users surface.
    """
    user = await _load_human(db, ctx)
    await db.commit()
    return HumanInfo(
        human_id=user.human_id,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        email=user.email,
    )


@router.get("/me", response_model=HumanInfo)
async def get_human(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    user = await _load_human(db, ctx)
    await db.commit()
    return HumanInfo(
        human_id=user.human_id,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        email=user.email,
    )


# ---------------------------------------------------------------------------
# Rooms
# ---------------------------------------------------------------------------


@router.get("/me/rooms", response_model=HumanRoomListResponse)
async def list_human_rooms(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Rooms the Human participates in (as owner or member)."""
    user = await _load_human(db, ctx)
    me = user.human_id

    membership = await db.execute(
        select(Room, RoomMember.role)
        .join(RoomMember, RoomMember.room_id == Room.room_id)
        .where(
            RoomMember.agent_id == me,
            RoomMember.participant_type == ParticipantType.human,
        )
        .order_by(Room.created_at.desc())
    )
    rooms: list[HumanRoomSummary] = []
    for room, role in membership.all():
        rooms.append(
            HumanRoomSummary(
                room_id=room.room_id,
                name=room.name,
                description=room.description or "",
                owner_id=room.owner_id,
                owner_type=room.owner_type.value if hasattr(room.owner_type, "value") else str(room.owner_type),
                visibility=room.visibility.value if hasattr(room.visibility, "value") else str(room.visibility),
                join_policy=room.join_policy.value if hasattr(room.join_policy, "value") else str(room.join_policy),
                my_role=role.value if hasattr(role, "value") else str(role),
            )
        )
    return HumanRoomListResponse(rooms=rooms)


@router.post("/me/rooms", response_model=HumanRoomSummary, status_code=201)
async def create_human_room(
    body: CreateHumanRoomBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a room owned by the current Human.

    The creator is added as the sole initial RoomMember with role ``owner``.
    Mirrors the Agent-side /hub/rooms POST but with a Human owner.
    """
    user = await _load_human(db, ctx)
    me = user.human_id

    normalized_rule = body.rule.strip() if body.rule else None
    unique_member_ids = [m for m in dict.fromkeys(body.member_ids) if m and m != me]

    # Classify every member id by prefix. Anything other than ag_ / hu_
    # is a client error. The creator's own hu_ id (== me) was filtered above,
    # but a caller could still provide another hu_ id.
    member_types: dict[str, ParticipantType] = {}
    for mid in unique_member_ids:
        if mid.startswith("ag_"):
            member_types[mid] = ParticipantType.agent
        elif mid.startswith("hu_"):
            member_types[mid] = ParticipantType.human
        else:
            raise HTTPException(
                status_code=400,
                detail="member_ids must be prefixed with ag_ or hu_",
            )

    if body.max_members is not None and len(unique_member_ids) + 1 > body.max_members:
        raise HTTPException(status_code=400, detail="initial_members_exceed_max")

    agent_member_ids = [m for m, t in member_types.items() if t == ParticipantType.agent]
    human_member_ids = [m for m, t in member_types.items() if t == ParticipantType.human]

    if agent_member_ids:
        result = await db.execute(
            select(Agent.agent_id).where(Agent.agent_id.in_(agent_member_ids))
        )
        found = {row[0] for row in result.all()}
        missing = set(agent_member_ids) - found
        if missing:
            raise HTTPException(status_code=400, detail="member_ids_not_found")
    if human_member_ids:
        result = await db.execute(
            select(User.human_id).where(User.human_id.in_(human_member_ids))
        )
        found = {row[0] for row in result.all()}
        missing = set(human_member_ids) - found
        if missing:
            raise HTTPException(status_code=400, detail="member_ids_not_found")

    room = Room(
        room_id=generate_room_id(),
        name=body.name,
        description=body.description,
        rule=normalized_rule,
        owner_id=me,
        owner_type=ParticipantType.human,
        visibility=RoomVisibility(body.visibility),
        join_policy=RoomJoinPolicy(body.join_policy),
        default_send=body.default_send,
        default_invite=body.default_invite,
        max_members=body.max_members,
        slow_mode_seconds=body.slow_mode_seconds,
    )
    db.add(room)
    await db.flush()

    db.add(
        RoomMember(
            room_id=room.room_id,
            agent_id=me,
            participant_type=ParticipantType.human,
            role=RoomRole.owner,
        )
    )
    for mid in unique_member_ids:
        db.add(
            RoomMember(
                room_id=room.room_id,
                agent_id=mid,
                participant_type=member_types[mid],
                role=RoomRole.member,
            )
        )
    await db.commit()
    await db.refresh(room)

    return HumanRoomSummary(
        room_id=room.room_id,
        name=room.name,
        description=room.description or "",
        owner_id=room.owner_id,
        owner_type=room.owner_type.value,
        visibility=room.visibility.value,
        join_policy=room.join_policy.value,
        my_role=RoomRole.owner.value,
    )


@router.post(
    "/me/rooms/{room_id}/members",
    response_model=HumanRoomMemberResponse,
    status_code=201,
)
async def invite_room_member_as_human(
    room_id: str,
    body: AddRoomMemberBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Human invites another participant (agent or human) into one of their rooms.

    Authorisation: inviter must already be an owner or admin of the room. We
    intentionally do NOT honour the softer ``default_invite`` policy here —
    ordinary members invite via their Agent, not via the Human surface — and
    always treat this call as an admin-side invite, matching the semantics of
    ``hub/routers/room.py::add_member`` when called by an owner/admin.
    """
    user = await _load_human(db, ctx)
    me = user.human_id

    # Serialize concurrent invites for this room (C4): lock the room row
    # up front so counting + inserting cannot race against a sibling call.
    # On SQLite this with_for_update() is a no-op (no row-level locks), so
    # we still rely on the unique (room_id, agent_id) constraint as a
    # correctness backstop via IntegrityError below.
    room_row = await db.execute(
        select(Room).where(Room.room_id == room_id).with_for_update()
    )
    room = room_row.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    inviter_row = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.participant_type == ParticipantType.human,
            RoomMember.agent_id == me,
        )
    )
    inviter = inviter_row.scalar_one_or_none()
    if inviter is None or inviter.role not in (RoomRole.owner, RoomRole.admin):
        raise HTTPException(
            status_code=403,
            detail="Only the room owner or admin can invite via the Human surface",
        )

    participant_id = body.participant_id
    participant_type = _split_prefix(participant_id)

    # Reject obvious self-invites (owner already seated as a member).
    if participant_type == ParticipantType.human and participant_id == me:
        raise HTTPException(status_code=409, detail="Already a member")

    # Verify the target exists in the appropriate registry.
    target_agent: Agent | None = None
    if participant_type == ParticipantType.agent:
        target_row = await db.execute(
            select(Agent).where(Agent.agent_id == participant_id)
        )
        target_agent = target_row.scalar_one_or_none()
        if target_agent is None:
            raise HTTPException(status_code=404, detail="Agent not found")
    else:
        target_user_row = await db.execute(
            select(User).where(User.human_id == participant_id)
        )
        if target_user_row.scalar_one_or_none() is None:
            raise HTTPException(status_code=404, detail="Human not found")

    # Duplicate check — the unique constraint is (room_id, agent_id) but
    # catching it up front yields a cleaner 409.
    existing = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == participant_id,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Already a member")

    # Order of checks mirrors hub/routers/room.py::add_member exactly:
    # 1) contacts_only admission  2) claimed-agent approval queue
    # 3) subscription gate        4) max_members  5) insert
    # Keeping these in the same order as the hub router prevents subtle
    # divergence (e.g. a contacts_only target being 403'd on the sub-gate
    # before its owner had a chance to approve/reject via the queue).

    # --- W2: admission policy (contacts_only, agent targets only) ---------
    if target_agent is not None and target_agent.message_policy == MessagePolicy.contacts_only:
        contact_row = await db.execute(
            select(Contact).where(
                Contact.owner_id == participant_id,
                Contact.owner_type == ParticipantType.agent,
                Contact.contact_agent_id == me,
            )
        )
        if contact_row.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=403,
                detail="admission_denied_target_contacts_only",
            )

    # --- C2: claimed-agent approval queue (agent targets only) ------------
    if (
        target_agent is not None
        and target_agent.user_id is not None
        and target_agent.user_id != ctx.user_id
    ):
        from fastapi.responses import JSONResponse

        entry = AgentApprovalQueue(
            agent_id=participant_id,
            owner_user_id=target_agent.user_id,
            kind=ApprovalKind.room_invite,
            payload_json=json.dumps(
                {
                    "room_id": room_id,
                    "invited_by": me,
                    "invited_by_type": ParticipantType.human.value,
                    "role": body.role,
                }
            ),
            state=ApprovalState.pending,
        )
        db.add(entry)
        await db.commit()
        await db.refresh(entry)
        return JSONResponse(
            {"status": "pending_approval", "approval_id": str(entry.id)},
            status_code=202,
        )

    # --- W3: subscription gate (applies to both agent and human invitees) -
    # Limitation: there is no human-side subscription concept yet, so a
    # Human invitee can only enter a sub-gated room when they are the
    # room's own owner (which is always admitted).
    if room.required_subscription_product_id:
        if participant_type == ParticipantType.agent:
            # Owner of the room (if this agent happens to be the owner_id)
            # bypasses — matches hub's _ensure_subscription_room_access.
            if participant_id != room.owner_id:
                sub_row = await db.execute(
                    select(AgentSubscription).where(
                        AgentSubscription.product_id == room.required_subscription_product_id,
                        AgentSubscription.subscriber_agent_id == participant_id,
                        AgentSubscription.status == SubscriptionStatus.active,
                    )
                )
                if sub_row.scalar_one_or_none() is None:
                    raise HTTPException(
                        status_code=403,
                        detail="Active subscription required to join this room",
                    )
        else:
            # Human invitee: the owning Human of a sub-gated room is always
            # admitted (they created the gate, they are not expected to pay
            # themselves). All other Humans are blocked until a human-side
            # subscription model exists.
            is_owner_self_seat = (
                room.owner_type == ParticipantType.human
                and participant_id == room.owner_id
            )
            if not is_owner_self_seat:
                raise HTTPException(
                    status_code=403,
                    detail="subscription-gated rooms do not yet support human members",
                )

    # --- C4: max_members check now runs under the row lock ----------------
    if room.max_members is not None:
        current_count_row = await db.execute(
            select(RoomMember).where(RoomMember.room_id == room_id)
        )
        current_count = len(list(current_count_row.scalars().all()))
        if current_count >= room.max_members:
            raise HTTPException(status_code=400, detail="room_is_full")

    new_role = RoomRole.admin if body.role == "admin" else RoomRole.member
    new_member = RoomMember(
        room_id=room_id,
        agent_id=participant_id,
        participant_type=participant_type,
        role=new_role,
    )
    try:
        db.add(new_member)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Already a member")
    await db.refresh(new_member)

    # --- W4: realtime broadcast (mirror hub's add_member) -----------------
    try:
        from hub.routers.room import _notify_room_member_change

        members_row = await db.execute(
            select(RoomMember.agent_id).where(RoomMember.room_id == room_id)
        )
        all_member_ids = [row[0] for row in members_row.all()]
        await _notify_room_member_change(
            db,
            event_type="room_member_added",
            room_id=room_id,
            changed_agent_id=participant_id,
            notify_agent_ids=all_member_ids,
        )
    except Exception:  # pragma: no cover — notification must not break the HTTP response
        _logger.exception("room_member_added broadcast failed for %s", room_id)

    return HumanRoomMemberResponse(
        room_id=new_member.room_id,
        participant_id=new_member.agent_id,
        participant_type=new_member.participant_type.value
        if hasattr(new_member.participant_type, "value")
        else str(new_member.participant_type),
        role=new_member.role.value if hasattr(new_member.role, "value") else str(new_member.role),
        joined_at=_ts(new_member.joined_at),
    )


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------


@router.get("/me/contacts", response_model=HumanContactListResponse)
async def list_human_contacts(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    user = await _load_human(db, ctx)
    me = user.human_id

    result = await db.execute(
        select(Contact)
        .where(Contact.owner_id == me, Contact.owner_type == ParticipantType.human)
        .order_by(Contact.created_at.desc())
    )
    contacts = [
        HumanContactSummary(
            peer_id=c.contact_agent_id,
            peer_type=c.peer_type.value if hasattr(c.peer_type, "value") else str(c.peer_type),
            alias=c.alias,
            created_at=_ts(c.created_at),
        )
        for c in result.scalars().all()
    ]
    return HumanContactListResponse(contacts=contacts)


@router.post(
    "/me/contacts/request",
    response_model=ContactRequestResponse,
    status_code=202,
)
async def send_contact_request(
    body: ContactRequestBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Human → any participant friend request.

    Branches:
      * peer is a **claimed Agent** → enqueue ``AgentApprovalQueue`` for its owner.
        The target Agent's owning Human resolves it from the dashboard.
      * peer is an **unclaimed Agent** → create a ContactRequest directly; the
        Agent itself will accept via the existing A2A flow.
      * peer is another **Human** → create a ContactRequest directly.
    """
    user = await _load_human(db, ctx)
    me = user.human_id
    peer_id = body.peer_id
    peer_type = _split_prefix(peer_id)

    if peer_id == me:
        raise HTTPException(status_code=400, detail="Cannot add yourself as a contact")

    existing = await db.execute(
        select(Contact).where(
            Contact.owner_id == me,
            Contact.owner_type == ParticipantType.human,
            Contact.contact_agent_id == peer_id,
        )
    )
    if existing.scalar_one_or_none() is not None:
        return ContactRequestResponse(status="already_contact")

    if peer_type == ParticipantType.agent:
        agent_result = await db.execute(
            select(Agent).where(Agent.agent_id == peer_id)
        )
        agent = agent_result.scalar_one_or_none()
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent not found")

        if agent.user_id is not None:
            # Claimed agent: queue for owner's approval.
            payload = {
                "from_participant_id": me,
                "from_type": ParticipantType.human.value,
                "from_display_name": user.display_name,
                "message": body.message or "",
            }
            entry = AgentApprovalQueue(
                agent_id=peer_id,
                owner_user_id=agent.user_id,
                kind=ApprovalKind.contact_request,
                payload_json=json.dumps(payload),
                state=ApprovalState.pending,
            )
            db.add(entry)
            await db.commit()
            await db.refresh(entry)
            return ContactRequestResponse(
                status="queued_for_approval",
                approval_id=str(entry.id),
            )

    # Fall-through: unclaimed Agent or peer Human → plain ContactRequest.
    #
    # Mirror the three-branch state-machine from
    # ``app/routers/dashboard.py::send_contact_request``:
    #   (a) reverse-pending (target→me AND pending) → 409 hint to accept incoming
    #   (b) forward-active (me→target AND state != rejected) → already_requested
    #   (c) forward-rejected (me→target AND state == rejected) → resend by
    #       flipping the existing row back to pending
    # TODO: share with dashboard.py — logic duplicated intentionally to keep
    # this patch narrow; extract into _contact_utils.py when touched again.
    reverse_pending = await db.execute(
        select(ContactRequest).where(
            ContactRequest.from_agent_id == peer_id,
            ContactRequest.from_type == peer_type,
            ContactRequest.to_agent_id == me,
            ContactRequest.to_type == ParticipantType.human,
            ContactRequest.state == ContactRequestState.pending,
        )
    )
    if reverse_pending.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=409,
            detail="Incoming contact request exists — accept it instead",
        )

    forward_active = await db.execute(
        select(ContactRequest).where(
            ContactRequest.from_agent_id == me,
            ContactRequest.from_type == ParticipantType.human,
            ContactRequest.to_agent_id == peer_id,
            ContactRequest.to_type == peer_type,
            ContactRequest.state != ContactRequestState.rejected,
        )
    )
    if forward_active.scalar_one_or_none() is not None:
        return ContactRequestResponse(status="already_requested")

    forward_rejected = await db.execute(
        select(ContactRequest).where(
            ContactRequest.from_agent_id == me,
            ContactRequest.from_type == ParticipantType.human,
            ContactRequest.to_agent_id == peer_id,
            ContactRequest.to_type == peer_type,
            ContactRequest.state == ContactRequestState.rejected,
        )
    )
    req = forward_rejected.scalar_one_or_none()
    if req is not None:
        # Resend after reject — reuse the existing row.
        req.state = ContactRequestState.pending
        req.message = body.message
        req.resolved_at = None
        await db.commit()
        await db.refresh(req)
        return ContactRequestResponse(status="requested", request_id=str(req.id))

    req = ContactRequest(
        from_agent_id=me,
        from_type=ParticipantType.human,
        to_agent_id=peer_id,
        to_type=peer_type,
        state=ContactRequestState.pending,
        message=body.message,
    )
    try:
        db.add(req)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        return ContactRequestResponse(status="already_requested")
    await db.refresh(req)
    return ContactRequestResponse(status="requested", request_id=str(req.id))


# ---------------------------------------------------------------------------
# Contact request listing + accept/reject (Human side)
# ---------------------------------------------------------------------------


async def _resolve_participant_display_name(
    db: AsyncSession,
    participant_id: str,
    participant_type: ParticipantType,
) -> str | None:
    """Best-effort lookup of a participant's display_name.

    Agents live in ``agents``; Humans live in ``public.users`` keyed by
    ``human_id``. Returns ``None`` if the id doesn't resolve.
    """
    if participant_type == ParticipantType.agent:
        row = await db.execute(
            select(Agent.display_name).where(Agent.agent_id == participant_id)
        )
        return row.scalar_one_or_none()
    row = await db.execute(
        select(User.display_name).where(User.human_id == participant_id)
    )
    return row.scalar_one_or_none()


async def _serialise_contact_requests(
    db: AsyncSession,
    rows: list[ContactRequest],
) -> list[HumanContactRequestSummary]:
    # Batch display-name resolution: collect unique (type, id) pairs across
    # every row, issue one query per participant type, then serialise via a
    # lookup dict. Mirrors ``app/routers/dashboard.py::_resolve_display_names``.
    agent_ids: set[str] = set()
    human_ids: set[str] = set()
    for req in rows:
        if req.from_type == ParticipantType.agent:
            agent_ids.add(req.from_agent_id)
        else:
            human_ids.add(req.from_agent_id)
        if req.to_type == ParticipantType.agent:
            agent_ids.add(req.to_agent_id)
        else:
            human_ids.add(req.to_agent_id)

    name_lookup: dict[tuple[ParticipantType, str], str | None] = {}
    if agent_ids:
        agent_rows = await db.execute(
            select(Agent.agent_id, Agent.display_name).where(Agent.agent_id.in_(agent_ids))
        )
        for aid, name in agent_rows.all():
            name_lookup[(ParticipantType.agent, aid)] = name
    if human_ids:
        human_rows = await db.execute(
            select(User.human_id, User.display_name).where(User.human_id.in_(human_ids))
        )
        for hid, name in human_rows.all():
            if hid is not None:
                name_lookup[(ParticipantType.human, hid)] = name

    summaries: list[HumanContactRequestSummary] = []
    for req in rows:
        from_name = name_lookup.get((req.from_type, req.from_agent_id))
        to_name = name_lookup.get((req.to_type, req.to_agent_id))
        summaries.append(
            HumanContactRequestSummary(
                id=str(req.id),
                from_participant_id=req.from_agent_id,
                from_type=req.from_type.value
                if hasattr(req.from_type, "value")
                else str(req.from_type),
                from_display_name=from_name,
                to_participant_id=req.to_agent_id,
                to_type=req.to_type.value
                if hasattr(req.to_type, "value")
                else str(req.to_type),
                to_display_name=to_name,
                state=req.state.value if hasattr(req.state, "value") else str(req.state),
                message=req.message,
                created_at=_ts(req.created_at),
            )
        )
    return summaries


@router.get(
    "/me/contact-requests/received",
    response_model=HumanContactRequestListResponse,
)
async def list_received_contact_requests(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Pending contact requests targeted at the active Human."""
    user = await _load_human(db, ctx)
    me = user.human_id
    await db.commit()

    result = await db.execute(
        select(ContactRequest)
        .where(
            ContactRequest.to_type == ParticipantType.human,
            ContactRequest.to_agent_id == me,
            ContactRequest.state == ContactRequestState.pending,
        )
        .order_by(ContactRequest.created_at.desc())
    )
    rows = list(result.scalars().all())
    requests = await _serialise_contact_requests(db, rows)
    return HumanContactRequestListResponse(requests=requests)


@router.get(
    "/me/contact-requests/sent",
    response_model=HumanContactRequestListResponse,
)
async def list_sent_contact_requests(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Contact requests initiated by the active Human (all states)."""
    user = await _load_human(db, ctx)
    me = user.human_id
    await db.commit()

    result = await db.execute(
        select(ContactRequest)
        .where(
            ContactRequest.from_type == ParticipantType.human,
            ContactRequest.from_agent_id == me,
        )
        .order_by(ContactRequest.created_at.desc())
    )
    rows = list(result.scalars().all())
    requests = await _serialise_contact_requests(db, rows)
    return HumanContactRequestListResponse(requests=requests)


@router.post(
    "/me/contact-requests/{request_id}/accept",
    response_model=HumanContactRequestResolveResponse,
)
async def accept_contact_request_as_human(
    request_id: int,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Human accepts a received contact request → mutual Contact rows.

    Idempotent for the ``accepted`` terminal state at the Contact level:
    duplicate Contact rows are swallowed via IntegrityError. Any non-pending
    state (already accepted/rejected) yields 409.
    """
    user = await _load_human(db, ctx)
    me = user.human_id

    result = await db.execute(
        select(ContactRequest).where(ContactRequest.id == request_id)
    )
    req = result.scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="Contact request not found")
    if req.to_type != ParticipantType.human or req.to_agent_id != me:
        raise HTTPException(
            status_code=403,
            detail="Only the recipient Human can accept this request",
        )
    if req.state != ContactRequestState.pending:
        raise HTTPException(status_code=409, detail="Request already resolved")

    req.state = ContactRequestState.accepted
    req.resolved_at = _now()
    await db.flush()

    # Insert each direction in its own savepoint so a collision on one side
    # does not erase the other (C3). Pattern mirrored from
    # hub/routers/contact_requests.py::accept flow.
    for owner_id, owner_type, contact_id, peer_type in (
        (req.to_agent_id, req.to_type, req.from_agent_id, req.from_type),
        (req.from_agent_id, req.from_type, req.to_agent_id, req.to_type),
    ):
        try:
            async with db.begin_nested():
                db.add(
                    Contact(
                        owner_id=owner_id,
                        owner_type=owner_type,
                        contact_agent_id=contact_id,
                        peer_type=peer_type,
                    )
                )
                await db.flush()
        except IntegrityError:
            # Row already exists — keep the other direction intact.
            pass

    await db.commit()

    return HumanContactRequestResolveResponse(id=str(req.id), state="accepted")


@router.post(
    "/me/contact-requests/{request_id}/reject",
    response_model=HumanContactRequestResolveResponse,
)
async def reject_contact_request_as_human(
    request_id: int,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Human rejects a received contact request. No Contact rows are created."""
    user = await _load_human(db, ctx)
    me = user.human_id

    result = await db.execute(
        select(ContactRequest).where(ContactRequest.id == request_id)
    )
    req = result.scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="Contact request not found")
    if req.to_type != ParticipantType.human or req.to_agent_id != me:
        raise HTTPException(
            status_code=403,
            detail="Only the recipient Human can reject this request",
        )
    if req.state != ContactRequestState.pending:
        raise HTTPException(status_code=409, detail="Request already resolved")

    req.state = ContactRequestState.rejected
    req.resolved_at = _now()
    await db.commit()

    return HumanContactRequestResolveResponse(id=str(req.id), state="rejected")


# ---------------------------------------------------------------------------
# Approval queue (Human-owned Agents)
# ---------------------------------------------------------------------------


@router.get("/me/pending-approvals", response_model=PendingApprovalListResponse)
async def list_pending_approvals(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Pending approval-queue entries across all agents owned by this user."""
    result = await db.execute(
        select(AgentApprovalQueue)
        .where(
            AgentApprovalQueue.owner_user_id == ctx.user_id,
            AgentApprovalQueue.state == ApprovalState.pending,
        )
        .order_by(AgentApprovalQueue.created_at.asc())
    )
    approvals: list[PendingApprovalSummary] = []
    for entry in result.scalars().all():
        try:
            payload = json.loads(entry.payload_json or "{}")
        except json.JSONDecodeError:
            payload = {}
        approvals.append(
            PendingApprovalSummary(
                id=str(entry.id),
                agent_id=entry.agent_id,
                kind=entry.kind.value if hasattr(entry.kind, "value") else str(entry.kind),
                payload=payload,
                created_at=_ts(entry.created_at),
            )
        )
    return PendingApprovalListResponse(approvals=approvals)


@router.post(
    "/me/pending-approvals/{approval_id}/resolve",
    response_model=ResolveApprovalResponse,
)
async def resolve_pending_approval(
    approval_id: UUID,
    body: ResolveApprovalBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Approve or reject a queued request on behalf of one of the user's Agents.

    For ``kind=contact_request`` approvals we also materialise the mutual
    Contact rows so the downstream send flow works without further plumbing.
    """
    result = await db.execute(
        select(AgentApprovalQueue).where(AgentApprovalQueue.id == approval_id)
    )
    entry = result.scalar_one_or_none()
    if entry is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    if entry.owner_user_id != ctx.user_id:
        raise HTTPException(status_code=403, detail="Approval is not yours to resolve")
    if entry.state != ApprovalState.pending:
        raise HTTPException(status_code=409, detail="Approval already resolved")

    now = _now()
    if body.decision == "approve":
        entry.state = ApprovalState.approved
        entry.resolved_by_user_id = ctx.user_id
        entry.resolved_at = now

        if entry.kind == ApprovalKind.contact_request:
            try:
                payload = json.loads(entry.payload_json or "{}")
            except json.JSONDecodeError:
                payload = {}
            from_pid = payload.get("from_participant_id")
            from_type_raw = payload.get("from_type")
            if from_pid:
                if from_type_raw and from_type_raw in {p.value for p in ParticipantType}:
                    from_type = ParticipantType(from_type_raw)
                elif from_pid.startswith("ag_"):
                    from_type = ParticipantType.agent
                elif from_pid.startswith("hu_"):
                    from_type = ParticipantType.human
                else:
                    from_type = ParticipantType.human
                # Agent-side contact: Agent ← peer
                db.add(
                    Contact(
                        owner_id=entry.agent_id,
                        owner_type=ParticipantType.agent,
                        contact_agent_id=from_pid,
                        peer_type=from_type,
                    )
                )
                # Peer-side contact: peer ← Agent
                db.add(
                    Contact(
                        owner_id=from_pid,
                        owner_type=from_type,
                        contact_agent_id=entry.agent_id,
                        peer_type=ParticipantType.agent,
                    )
                )
        elif entry.kind == ApprovalKind.room_invite:
            try:
                payload = json.loads(entry.payload_json or "{}")
            except json.JSONDecodeError:
                payload = {}
            room_id_for_invite = payload.get("room_id")
            if room_id_for_invite:
                db.add(
                    RoomMember(
                        room_id=room_id_for_invite,
                        agent_id=entry.agent_id,
                        role=RoomRole.member,
                        can_send=payload.get("can_send"),
                        can_invite=payload.get("can_invite"),
                    )
                )

        # For payment and future kinds, approval is recorded; side-effects
        # are handled by their own downstream services.
        try:
            await db.commit()
        except IntegrityError:
            # Duplicate contact / member row → still mark approved
            await db.rollback()
            result2 = await db.execute(
                select(AgentApprovalQueue).where(AgentApprovalQueue.id == approval_id)
            )
            entry = result2.scalar_one()
            entry.state = ApprovalState.approved
            entry.resolved_by_user_id = ctx.user_id
            entry.resolved_at = now
            await db.commit()
        return ResolveApprovalResponse(id=str(entry.id), state="approved")

    # reject
    entry.state = ApprovalState.rejected
    entry.resolved_by_user_id = ctx.user_id
    entry.resolved_at = now
    await db.commit()
    return ResolveApprovalResponse(id=str(entry.id), state="rejected")
