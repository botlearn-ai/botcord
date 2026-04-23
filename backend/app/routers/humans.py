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
    ParticipantType,
    RoomJoinPolicy,
    RoomRole,
    RoomVisibility,
)
from hub.id_generators import generate_human_id, generate_room_id
from hub.models import (
    Agent,
    AgentApprovalQueue,
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
    visibility: Literal["public", "private"] = "private"
    join_policy: Literal["open", "invite_only"] = "invite_only"


class HumanContactSummary(BaseModel):
    peer_id: str
    peer_type: Literal["agent", "human"]
    alias: str | None
    created_at: int


class HumanContactListResponse(BaseModel):
    contacts: list[HumanContactSummary]


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

    room = Room(
        room_id=generate_room_id(),
        name=body.name,
        description=body.description,
        owner_id=me,
        owner_type=ParticipantType.human,
        visibility=RoomVisibility(body.visibility),
        join_policy=RoomJoinPolicy(body.join_policy),
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
    dup_req = await db.execute(
        select(ContactRequest).where(
            ContactRequest.from_agent_id == me,
            ContactRequest.to_agent_id == peer_id,
            ContactRequest.state == ContactRequestState.pending,
        )
    )
    if dup_req.scalar_one_or_none() is not None:
        return ContactRequestResponse(status="already_requested")

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
            from_type_raw = payload.get("from_type", ParticipantType.human.value)
            if from_pid:
                from_type = ParticipantType(from_type_raw) if from_type_raw in {p.value for p in ParticipantType} else ParticipantType.human
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
