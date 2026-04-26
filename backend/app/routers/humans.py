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
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from app.routers.dashboard import _build_rooms_from_sql
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
    Invite,
    MessageRecord,
    Room,
    RoomMember,
    Share,
    ShareMessage,
    User,
)
from hub.share_payloads import frontend_url, room_continue_url, room_entry_type, share_create_payload

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


class PatchHumanBody(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    avatar_url: str | None = Field(default=None, max_length=2048)


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


class HumanAgentRoomBot(BaseModel):
    agent_id: str
    display_name: str
    role: str


class HumanAgentRoomSummary(BaseModel):
    room_id: str
    name: str
    description: str | None
    rule: str | None = None
    owner_id: str
    visibility: str
    join_policy: str | None = None
    member_count: int
    created_at: str | None = None
    required_subscription_product_id: str | None = None
    last_message_preview: str | None = None
    last_message_at: str | None = None
    last_sender_name: str | None = None
    allow_human_send: bool | None = None
    bots: list[HumanAgentRoomBot]


class HumanAgentRoomListResponse(BaseModel):
    rooms: list[HumanAgentRoomSummary]


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


class CreateHumanShareBody(BaseModel):
    expires_in_hours: int | None = 168


class CreateHumanInviteBody(BaseModel):
    expires_in_hours: int | None = 168
    max_uses: int = 1


class HumanRoomMemberResponse(BaseModel):
    room_id: str
    participant_id: str
    participant_type: Literal["agent", "human"]
    role: Literal["owner", "admin", "member"]
    joined_at: int


class TransferRoomOwnerBody(BaseModel):
    new_owner_id: str = Field(..., min_length=1, max_length=32)


class HumanRoomTransferResponse(BaseModel):
    room_id: str
    new_owner_id: str
    new_owner_type: Literal["agent", "human"]


class PromoteMemberBody(BaseModel):
    participant_id: str = Field(..., min_length=1, max_length=32)
    role: Literal["admin", "member"]


class HumanRoomRoleChangeResponse(BaseModel):
    room_id: str
    participant_id: str
    participant_type: Literal["agent", "human"]
    role: Literal["owner", "admin", "member"]


class HumanRoomRemoveMemberResponse(BaseModel):
    room_id: str
    participant_id: str
    removed: bool


class MuteRoomBody(BaseModel):
    muted: bool


class HumanRoomMuteResponse(BaseModel):
    room_id: str
    muted: bool


class SetMemberPermissionsBody(BaseModel):
    participant_id: str = Field(..., min_length=1, max_length=32)
    can_send: bool | None = None
    can_invite: bool | None = None


class HumanRoomPermissionsResponse(BaseModel):
    room_id: str
    participant_id: str
    participant_type: Literal["agent", "human"]
    can_send: bool | None
    can_invite: bool | None


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


def _invite_url(code: str) -> str:
    return frontend_url(f"/i/{code}")


def _serialize_human_room_invite_preview(
    invite: Invite,
    creator: User,
    room: Room,
    member_count: int = 0,
) -> dict:
    return {
        "code": invite.code,
        "kind": invite.kind,
        "entry_type": room_entry_type(room).replace("private_room", "private_invite"),
        "target_type": "room",
        "target_id": invite.room_id,
        "invite_url": _invite_url(invite.code),
        "continue_url": room_continue_url(invite.room_id or room.room_id),
        "expires_at": invite.expires_at.isoformat() if invite.expires_at else None,
        "max_uses": invite.max_uses,
        "use_count": invite.use_count,
        "creator": {
            "agent_id": creator.human_id,
            "display_name": creator.display_name,
        },
        "room": {
            "room_id": room.room_id,
            "name": room.name,
            "description": room.description,
            "visibility": room.visibility.value,
            "join_mode": room.join_policy.value,
            "requires_payment": bool(room.required_subscription_product_id),
            "required_subscription_product_id": room.required_subscription_product_id,
            "member_count": member_count,
        },
    }


def _extract_text_from_envelope(envelope_json: str | None) -> dict[str, object]:
    if not envelope_json:
        return {"type": "message", "text": "", "payload": {}}
    try:
        envelope = json.loads(envelope_json)
    except Exception:
        return {"type": "message", "text": "", "payload": {}}
    payload = envelope.get("payload", {})
    if not isinstance(payload, dict):
        payload = {}
    text = payload.get("text") or payload.get("body") or payload.get("message") or ""
    if text is not None and not isinstance(text, str):
        text = str(text)
    return {
        "type": envelope.get("type", "message") or "message",
        "text": text or "",
        "payload": payload,
    }


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


@router.patch("/me", response_model=HumanInfo)
async def patch_human(
    body: PatchHumanBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the authed user's Human profile (display_name, avatar_url)."""
    user = await _load_human(db, ctx)

    if body.display_name is not None:
        name = body.display_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="display_name must not be empty")
        user.display_name = name

    if body.avatar_url is not None:
        url = body.avatar_url.strip()
        user.avatar_url = url or None

    await db.commit()
    await db.refresh(user)
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


@router.get("/me/agent-rooms", response_model=HumanAgentRoomListResponse)
async def list_owned_agent_only_rooms(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Rooms joined by the user's Agents, excluding rooms joined/owned by the Human."""
    user = await _load_human(db, ctx)
    human_id = user.human_id

    agent_result = await db.execute(
        select(Agent.agent_id, Agent.display_name)
        .where(Agent.user_id == ctx.user_id)
        .order_by(Agent.created_at)
    )
    owned_agents = agent_result.all()
    if not owned_agents:
        return HumanAgentRoomListResponse(rooms=[])

    agent_names = {agent_id: display_name for agent_id, display_name in owned_agents}
    rooms_by_id: dict[str, dict] = {}
    bots_by_room: dict[str, dict[str, HumanAgentRoomBot]] = {}

    for agent_id, display_name in owned_agents:
        previews = await _build_rooms_from_sql(agent_id, db)
        for preview in previews:
            room_id = preview.get("room_id")
            if not isinstance(room_id, str) or not room_id:
                continue
            rooms_by_id.setdefault(room_id, preview)
            role = preview.get("my_role") or "member"
            bots_by_room.setdefault(room_id, {})[agent_id] = HumanAgentRoomBot(
                agent_id=agent_id,
                display_name=display_name or agent_id,
                role=str(role),
            )

    if not rooms_by_id:
        return HumanAgentRoomListResponse(rooms=[])

    room_ids = list(rooms_by_id.keys())
    human_membership_result = await db.execute(
        select(RoomMember.room_id)
        .where(
            RoomMember.room_id.in_(room_ids),
            RoomMember.agent_id == human_id,
            RoomMember.participant_type == ParticipantType.human,
        )
    )
    human_member_room_ids = {row[0] for row in human_membership_result.all()}

    response_rooms: list[HumanAgentRoomSummary] = []
    for room_id, preview in rooms_by_id.items():
        owner_id = str(preview.get("owner_id") or "")
        if room_id in human_member_room_ids or owner_id == human_id:
            continue
        bots = list(bots_by_room.get(room_id, {}).values())
        if not bots:
            continue
        response_rooms.append(
            HumanAgentRoomSummary(
                room_id=room_id,
                name=str(preview.get("name") or room_id),
                description=preview.get("description"),
                rule=preview.get("rule"),
                owner_id=owner_id,
                visibility=str(preview.get("visibility") or ""),
                join_policy=preview.get("join_policy"),
                member_count=int(preview.get("member_count") or 0),
                created_at=preview.get("created_at"),
                required_subscription_product_id=preview.get("required_subscription_product_id"),
                last_message_preview=preview.get("last_message_preview"),
                last_message_at=preview.get("last_message_at"),
                last_sender_name=preview.get("last_sender_name"),
                allow_human_send=preview.get("allow_human_send"),
                bots=sorted(bots, key=lambda bot: agent_names.get(bot.agent_id) or bot.agent_id),
            )
        )

    response_rooms.sort(key=lambda room: room.last_message_at or room.created_at or "", reverse=True)
    return HumanAgentRoomListResponse(rooms=response_rooms)


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
    "/me/rooms/{room_id}/join",
    response_model=HumanRoomSummary,
    status_code=201,
)
async def join_room_as_human(
    room_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Human self-joins a public + open room.

    Mirrors the self-join branch of ``hub/routers/room.py::add_member``:
    only public + open rooms accept a self-join. Invite-only rooms require
    an owner/admin to invite via ``POST /me/rooms/{room_id}/members``, or
    the caller must go through the join-request flow. Subscription-gated
    rooms are not yet reachable by Humans (no human-side subscription
    concept), except when the caller is already the owner.
    """
    user = await _load_human(db, ctx)
    me = user.human_id

    room_row = await db.execute(
        select(Room).where(Room.room_id == room_id).with_for_update()
    )
    room = room_row.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    existing = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == me,
            RoomMember.participant_type == ParticipantType.human,
        )
    )
    existing_member = existing.scalar_one_or_none()
    if existing_member is not None:
        raise HTTPException(status_code=409, detail="Already a member")

    if (
        room.visibility != RoomVisibility.public
        or room.join_policy != RoomJoinPolicy.open
    ):
        raise HTTPException(
            status_code=403,
            detail="self_join_public_open_only",
        )

    if room.required_subscription_product_id:
        is_owner_self_seat = (
            room.owner_type == ParticipantType.human and room.owner_id == me
        )
        if not is_owner_self_seat:
            raise HTTPException(
                status_code=403,
                detail="subscription-gated rooms do not yet support human members",
            )

    if room.max_members is not None:
        current_count_row = await db.execute(
            select(RoomMember).where(RoomMember.room_id == room_id)
        )
        current_count = len(list(current_count_row.scalars().all()))
        if current_count >= room.max_members:
            raise HTTPException(status_code=400, detail="room_is_full")

    new_member = RoomMember(
        room_id=room_id,
        agent_id=me,
        participant_type=ParticipantType.human,
        role=RoomRole.member,
    )
    try:
        db.add(new_member)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Already a member")
    await db.refresh(new_member)

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
            changed_agent_id=me,
            notify_agent_ids=all_member_ids,
        )
    except Exception:  # pragma: no cover — notification must not break the HTTP response
        _logger.exception("room_member_added broadcast failed for %s", room_id)

    return HumanRoomSummary(
        room_id=room.room_id,
        name=room.name,
        description=room.description or "",
        owner_id=room.owner_id,
        owner_type=room.owner_type.value,
        visibility=room.visibility.value,
        join_policy=room.join_policy.value,
        my_role=RoomRole.member.value,
    )


@router.post(
    "/me/rooms/{room_id}/share",
    status_code=201,
)
async def create_room_share_as_human(
    room_id: str,
    body: CreateHumanShareBody | None = None,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    user = await _load_human(db, ctx)
    me = user.human_id

    room_result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    membership_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.participant_type == ParticipantType.human,
            RoomMember.agent_id == me,
        )
    )
    if membership_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=403, detail="Not a member of this room")

    expires_at = None
    if body and body.expires_in_hours:
        expires_at = _now() + datetime.timedelta(hours=body.expires_in_hours)

    dedup_sub = (
        select(
            MessageRecord.msg_id,
            func.min(MessageRecord.id).label("min_id"),
        )
        .where(MessageRecord.room_id == room_id)
        .group_by(MessageRecord.msg_id)
        .subquery()
    )
    msg_result = await db.execute(
        select(MessageRecord)
        .where(MessageRecord.id.in_(select(dedup_sub.c.min_id)))
        .order_by(MessageRecord.id.desc())
        .limit(200)
    )
    records = list(reversed(msg_result.scalars().all()))

    share = Share(
        share_id=f"sh_{uuid4().hex[:24]}",
        room_id=room_id,
        shared_by_agent_id=me,
        shared_by_name=user.display_name or me,
        expires_at=expires_at,
    )
    db.add(share)
    await db.flush()

    agent_name_cache: dict[str, str] = {}
    human_name_cache: dict[str, str] = {me: user.display_name or me}

    for rec in records:
        parsed = _extract_text_from_envelope(rec.envelope_json)
        sender_name = rec.sender_id
        if (rec.source_type or "") == "dashboard_human_room" and rec.source_user_id:
            if rec.sender_id not in human_name_cache:
                human_row = await db.execute(
                    select(User.display_name).where(User.id == rec.source_user_id)
                )
                human_name_cache[rec.sender_id] = human_row.scalar() or "User"
            sender_name = human_name_cache[rec.sender_id]
        else:
            if rec.sender_id not in agent_name_cache:
                agent_row = await db.execute(
                    select(Agent.display_name).where(Agent.agent_id == rec.sender_id)
                )
                agent_name_cache[rec.sender_id] = agent_row.scalar() or rec.sender_id
            sender_name = agent_name_cache[rec.sender_id]

        db.add(
            ShareMessage(
                share_id=share.share_id,
                hub_msg_id=rec.hub_msg_id,
                msg_id=rec.msg_id,
                sender_id=rec.sender_id,
                sender_name=sender_name,
                type=str(parsed["type"]),
                text=str(parsed["text"]),
                payload_json=json.dumps(parsed["payload"]),
                created_at=rec.created_at or _now(),
            )
        )

    await db.commit()

    return share_create_payload(
        share_id=share.share_id,
        room=room,
        created_at=share.created_at.isoformat()
        if share.created_at
        else _now().isoformat(),
        expires_at=expires_at.isoformat() if expires_at else None,
    )


@router.post(
    "/me/rooms/{room_id}/invite",
    status_code=201,
)
async def create_room_invite_as_human(
    room_id: str,
    body: CreateHumanInviteBody | None = None,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    user = await _load_human(db, ctx)
    me = user.human_id
    payload = body or CreateHumanInviteBody()

    room = await db.scalar(select(Room).where(Room.room_id == room_id))
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    inviter = await db.scalar(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.participant_type == ParticipantType.human,
            RoomMember.agent_id == me,
        )
    )
    if inviter is None:
        raise HTTPException(status_code=403, detail="Not a member of this room")
    if inviter.role not in (RoomRole.owner, RoomRole.admin) and not bool(
        inviter.can_invite or room.default_invite
    ):
        raise HTTPException(
            status_code=403,
            detail="You do not have invite permission",
        )

    invite = Invite(
        code=f"iv_{uuid4().hex[:20]}",
        kind="room",
        creator_agent_id=me,
        room_id=room_id,
        expires_at=_now() + datetime.timedelta(hours=payload.expires_in_hours)
        if payload.expires_in_hours
        else None,
        max_uses=max(1, payload.max_uses),
    )
    db.add(invite)
    await db.commit()

    member_count = (
        await db.scalar(
            select(func.count(RoomMember.id)).where(RoomMember.room_id == room_id)
        )
        or 0
    )
    return _serialize_human_room_invite_preview(
        invite,
        creator=user,
        room=room,
        member_count=member_count,
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
# Room moderator actions (Human-side counterparts to hub/routers/room.py).
#
# The hub-layer endpoints live behind an Agent JWT and `_reject_human_id`
# guards on every body parameter — they are deliberately agent-only. These
# Human counterparts expose the same capabilities to the Supabase-auth'd
# owner/admin and accept polymorphic participant ids (``ag_*`` or ``hu_*``)
# so a Human moderator can operate on either kind of member.
# ---------------------------------------------------------------------------


async def _load_room_member_as_caller(
    db: AsyncSession, room_id: str, human_id: str, *, lock: bool = False
) -> tuple[Room, RoomMember]:
    """Fetch (room, caller_membership) for a Human acting on a room.

    Raises 404 if the room doesn't exist or the Human isn't a member.
    With ``lock=True`` the row is selected FOR UPDATE so the caller can
    serialize write-heavy operations (transfer, promote, member ops).
    """
    room_stmt = select(Room).where(Room.room_id == room_id)
    if lock:
        room_stmt = room_stmt.with_for_update()
    room = (await db.execute(room_stmt)).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    caller = (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.agent_id == human_id,
                RoomMember.participant_type == ParticipantType.human,
            )
        )
    ).scalar_one_or_none()
    if caller is None:
        raise HTTPException(status_code=404, detail="Not a member of this room")
    return room, caller


async def _find_room_member(
    db: AsyncSession, room_id: str, participant_id: str
) -> RoomMember | None:
    """Fetch a RoomMember by room_id + polymorphic participant id."""
    return (
        await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.agent_id == participant_id,
            )
        )
    ).scalar_one_or_none()


@router.post("/me/rooms/{room_id}/transfer", response_model=HumanRoomTransferResponse)
async def transfer_room_ownership_as_human(
    room_id: str,
    body: TransferRoomOwnerBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Transfer room ownership to another member. Human owner only.

    The new owner may be an Agent (``ag_*``) or a Human (``hu_*``) — both are
    first-class participants. Subscription-gated rooms keep the hub's
    ``required_subscription_product_id`` check for Agent targets only;
    Humans are admitted by being current members (see invite flow).
    """
    user = await _load_human(db, ctx)
    me = user.human_id
    room, caller = await _load_room_member_as_caller(db, room_id, me, lock=True)
    if caller.role != RoomRole.owner:
        raise HTTPException(status_code=403, detail="Only the room owner can transfer ownership")

    new_owner_id = body.new_owner_id
    new_owner_type = _split_prefix(new_owner_id)
    if new_owner_type == ParticipantType.human and new_owner_id == me:
        raise HTTPException(status_code=400, detail="Cannot transfer to self")

    new_owner_member = await _find_room_member(db, room_id, new_owner_id)
    if new_owner_member is None or new_owner_member.participant_type != new_owner_type:
        raise HTTPException(status_code=404, detail="Target must already be a member")

    # Subscription gating: for Agent targets we mirror the hub's check. For
    # Human targets there is no user-side subscription model yet, so they are
    # admitted purely on existing-membership.
    if room.required_subscription_product_id and new_owner_type == ParticipantType.agent:
        sub_row = await db.execute(
            select(AgentSubscription).where(
                AgentSubscription.product_id == room.required_subscription_product_id,
                AgentSubscription.subscriber_agent_id == new_owner_id,
                AgentSubscription.status == SubscriptionStatus.active,
            )
        )
        if sub_row.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=403,
                detail="Target must hold an active subscription to own this room",
            )

    caller.role = RoomRole.member
    new_owner_member.role = RoomRole.owner
    room.owner_id = new_owner_id
    room.owner_type = new_owner_type
    await db.commit()

    return HumanRoomTransferResponse(
        room_id=room_id,
        new_owner_id=new_owner_id,
        new_owner_type=new_owner_type.value,
    )


@router.post("/me/rooms/{room_id}/promote", response_model=HumanRoomRoleChangeResponse)
async def promote_member_as_human(
    room_id: str,
    body: PromoteMemberBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Promote/demote a member. Human owner only. Matches hub's `promote`."""
    user = await _load_human(db, ctx)
    _, caller = await _load_room_member_as_caller(db, room_id, user.human_id, lock=True)
    if caller.role != RoomRole.owner:
        raise HTTPException(status_code=403, detail="Only the room owner can promote or demote")

    target_type = _split_prefix(body.participant_id)
    target = await _find_room_member(db, room_id, body.participant_id)
    if target is None or target.participant_type != target_type:
        raise HTTPException(status_code=404, detail="Member not found in room")
    if target.role == RoomRole.owner:
        raise HTTPException(status_code=400, detail="Cannot change the owner's role")

    target.role = RoomRole(body.role)
    await db.commit()

    return HumanRoomRoleChangeResponse(
        room_id=room_id,
        participant_id=target.agent_id,
        participant_type=target.participant_type.value
        if hasattr(target.participant_type, "value")
        else str(target.participant_type),
        role=target.role.value if hasattr(target.role, "value") else str(target.role),
    )


@router.delete(
    "/me/rooms/{room_id}/members/{participant_id}",
    response_model=HumanRoomRemoveMemberResponse,
)
async def remove_member_as_human(
    room_id: str,
    participant_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a member. Human owner/admin only. Mirrors hub's remove_member,
    but accepts both ``ag_*`` and ``hu_*`` targets."""
    user = await _load_human(db, ctx)
    _, caller = await _load_room_member_as_caller(db, room_id, user.human_id, lock=True)
    if caller.role not in (RoomRole.owner, RoomRole.admin):
        raise HTTPException(status_code=403, detail="Owner or admin required")

    target_type = _split_prefix(participant_id)
    target = await _find_room_member(db, room_id, participant_id)
    if target is None or target.participant_type != target_type:
        raise HTTPException(status_code=404, detail="Member not found in room")
    if target.role == RoomRole.owner:
        raise HTTPException(status_code=400, detail="Cannot remove the room owner")
    if target.role == RoomRole.admin and caller.role != RoomRole.owner:
        raise HTTPException(status_code=403, detail="Only the owner can remove admins")

    removed_id = target.agent_id
    await db.delete(target)
    await db.commit()

    try:
        from hub.routers.room import _notify_room_member_change

        remaining = (
            await db.execute(
                select(RoomMember.agent_id).where(RoomMember.room_id == room_id)
            )
        ).all()
        remaining_ids = [row[0] for row in remaining]
        await _notify_room_member_change(
            db,
            event_type="room_member_removed",
            room_id=room_id,
            changed_agent_id=removed_id,
            notify_agent_ids=[removed_id] + remaining_ids,
        )
    except Exception:  # pragma: no cover — notification must not break the HTTP response
        _logger.exception("room_member_removed broadcast failed for %s", room_id)

    return HumanRoomRemoveMemberResponse(
        room_id=room_id,
        participant_id=removed_id,
        removed=True,
    )


@router.post("/me/rooms/{room_id}/mute", response_model=HumanRoomMuteResponse)
async def mute_room_as_human(
    room_id: str,
    body: MuteRoomBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Toggle mute on the caller's own Human membership."""
    user = await _load_human(db, ctx)
    _, caller = await _load_room_member_as_caller(db, room_id, user.human_id)
    caller.muted = body.muted
    await db.commit()
    return HumanRoomMuteResponse(room_id=room_id, muted=caller.muted)


@router.post(
    "/me/rooms/{room_id}/permissions",
    response_model=HumanRoomPermissionsResponse,
)
async def set_member_permissions_as_human(
    room_id: str,
    body: SetMemberPermissionsBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Set per-member permission overrides. Human owner/admin only."""
    user = await _load_human(db, ctx)
    _, caller = await _load_room_member_as_caller(db, room_id, user.human_id, lock=True)
    if caller.role not in (RoomRole.owner, RoomRole.admin):
        raise HTTPException(status_code=403, detail="Owner or admin required")

    target_type = _split_prefix(body.participant_id)
    target = await _find_room_member(db, room_id, body.participant_id)
    if target is None or target.participant_type != target_type:
        raise HTTPException(status_code=404, detail="Member not found in room")
    if target.role == RoomRole.owner:
        raise HTTPException(status_code=400, detail="Cannot modify the owner's permissions")
    if target.role == RoomRole.admin and caller.role != RoomRole.owner:
        raise HTTPException(status_code=403, detail="Only the owner can modify admin permissions")

    target.can_send = body.can_send
    target.can_invite = body.can_invite
    await db.commit()

    return HumanRoomPermissionsResponse(
        room_id=room_id,
        participant_id=target.agent_id,
        participant_type=target.participant_type.value
        if hasattr(target.participant_type, "value")
        else str(target.participant_type),
        can_send=target.can_send,
        can_invite=target.can_invite,
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

        if agent.user_id == user.id:
            raise HTTPException(
                status_code=400,
                detail="Cannot send contact request to your own agent",
            )

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


async def _accept_human_contact_request(
    db: AsyncSession, req: ContactRequest
) -> None:
    """Flip a pending ContactRequest to accepted and materialise mutual Contacts.

    Shared by the dedicated /contact-requests/{id}/accept endpoint and the
    unified /pending-approvals/{id}/resolve dispatcher so the state transition
    stays in a single place. Each direction is inserted in its own savepoint
    so a collision on one side does not erase the other (C3).
    """
    req.state = ContactRequestState.accepted
    req.resolved_at = _now()
    await db.flush()
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
            pass
    await db.commit()


async def _reject_human_contact_request(
    db: AsyncSession, req: ContactRequest
) -> None:
    req.state = ContactRequestState.rejected
    req.resolved_at = _now()
    await db.commit()


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

    await _accept_human_contact_request(db, req)

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

    await _reject_human_contact_request(db, req)

    return HumanContactRequestResolveResponse(id=str(req.id), state="rejected")


# ---------------------------------------------------------------------------
# Approval queue (Human-owned Agents)
# ---------------------------------------------------------------------------


@router.get("/me/pending-approvals", response_model=PendingApprovalListResponse)
async def list_pending_approvals(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Pending approvals addressed to this user.

    Merges two sources:
      * ``AgentApprovalQueue`` — requests queued for an Agent owned by the
        user (Human → claimed-Agent flow; ``id`` is the queue row UUID).
      * ``ContactRequest`` — requests addressed directly to the user as a
        Human (Human → Human and unclaimed-Agent → Human flows). These ids
        are prefixed ``cr_<int>`` to distinguish them from queue UUIDs so
        the resolve endpoint can dispatch without ambiguity.
    """
    queue_result = await db.execute(
        select(AgentApprovalQueue)
        .where(
            AgentApprovalQueue.owner_user_id == ctx.user_id,
            AgentApprovalQueue.state == ApprovalState.pending,
        )
        .order_by(AgentApprovalQueue.created_at.asc())
    )
    approvals: list[PendingApprovalSummary] = []
    for entry in queue_result.scalars().all():
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

    # Human-addressed ContactRequest rows — only materialise if the user has
    # a Human identity (human_id is nullable on legacy accounts).
    user = await _load_human(db, ctx)
    me = user.human_id
    cr_result = await db.execute(
        select(ContactRequest)
        .where(
            ContactRequest.to_type == ParticipantType.human,
            ContactRequest.to_agent_id == me,
            ContactRequest.state == ContactRequestState.pending,
        )
        .order_by(ContactRequest.created_at.asc())
    )
    cr_rows = list(cr_result.scalars().all())
    if cr_rows:
        # Resolve display names once per request for the panel header.
        name_lookup: dict[tuple[ParticipantType, str], str | None] = {}
        agent_ids = {r.from_agent_id for r in cr_rows if r.from_type == ParticipantType.agent}
        human_ids = {r.from_agent_id for r in cr_rows if r.from_type == ParticipantType.human}
        if agent_ids:
            rows = await db.execute(
                select(Agent.agent_id, Agent.display_name).where(Agent.agent_id.in_(agent_ids))
            )
            for aid, name in rows.all():
                name_lookup[(ParticipantType.agent, aid)] = name
        if human_ids:
            rows = await db.execute(
                select(User.human_id, User.display_name).where(User.human_id.in_(human_ids))
            )
            for hid, name in rows.all():
                name_lookup[(ParticipantType.human, hid)] = name
        for req in cr_rows:
            approvals.append(
                PendingApprovalSummary(
                    id=f"cr_{req.id}",
                    agent_id=req.to_agent_id,
                    kind=ApprovalKind.contact_request.value,
                    payload={
                        "from_participant_id": req.from_agent_id,
                        "from_type": req.from_type.value,
                        "from_display_name": name_lookup.get(
                            (req.from_type, req.from_agent_id)
                        ),
                        "message": req.message,
                    },
                    created_at=_ts(req.created_at),
                )
            )

    approvals.sort(key=lambda a: a.created_at)
    return PendingApprovalListResponse(approvals=approvals)


@router.post(
    "/me/pending-approvals/{approval_id}/resolve",
    response_model=ResolveApprovalResponse,
)
async def resolve_pending_approval(
    approval_id: str,
    body: ResolveApprovalBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Approve or reject a pending approval addressed to this user.

    Dispatches on the id format populated by ``list_pending_approvals``:
      * ``cr_<int>`` → Human-addressed ContactRequest; accept materialises
        mutual Contacts, reject just flips the state.
      * UUID → AgentApprovalQueue row owned by this user; approve materialises
        Contacts (for contact_request) or RoomMember rows (for room_invite).
    """
    # Human-addressed ContactRequest branch — id is ``cr_<int>``.
    if approval_id.startswith("cr_"):
        try:
            cr_id = int(approval_id[len("cr_"):])
        except ValueError:
            raise HTTPException(status_code=404, detail="Approval not found")
        user = await _load_human(db, ctx)
        me = user.human_id
        cr_result = await db.execute(
            select(ContactRequest).where(ContactRequest.id == cr_id)
        )
        req = cr_result.scalar_one_or_none()
        if req is None:
            raise HTTPException(status_code=404, detail="Approval not found")
        if req.to_type != ParticipantType.human or req.to_agent_id != me:
            raise HTTPException(
                status_code=403, detail="Approval is not yours to resolve"
            )
        if req.state != ContactRequestState.pending:
            raise HTTPException(status_code=409, detail="Approval already resolved")
        if body.decision == "approve":
            await _accept_human_contact_request(db, req)
            return ResolveApprovalResponse(id=approval_id, state="approved")
        await _reject_human_contact_request(db, req)
        return ResolveApprovalResponse(id=approval_id, state="rejected")

    try:
        approval_uuid = UUID(approval_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Approval not found")

    result = await db.execute(
        select(AgentApprovalQueue).where(AgentApprovalQueue.id == approval_uuid)
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
                select(AgentApprovalQueue).where(AgentApprovalQueue.id == approval_uuid)
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
