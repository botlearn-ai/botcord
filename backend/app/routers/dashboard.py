"""Dashboard API routes under /api/dashboard."""

import datetime
import json
import logging
import time as _time
import uuid as _uuid

import os

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_active_agent, require_user_with_optional_agent
from app.auth_room import resolve_provider_agent_for_room, viewer_can_admin_room
from app.helpers import escape_like, extract_text_from_envelope
from hub.database import get_db
from hub.dashboard_message_shaping import (
    derive_sender_fields,
    load_agent_display_names,
    load_user_display_names,
)
from hub.id_generators import generate_hub_msg_id, generate_join_request_id
from hub.enums import SubscriptionProductStatus, SubscriptionStatus
from hub.models import (
    Agent,
    AgentSubscription,
    Block,
    Contact,
    ContactRequest,
    ContactRequestState,
    MessageRecord,
    MessageState,
    ParticipantType,
    Room,
    RoomJoinPolicy,
    RoomJoinRequest,
    RoomJoinRequestStatus,
    RoomMember,
    RoomRole,
    RoomVisibility,
    Share,
    ShareMessage,
    SubscriptionProduct,
    Topic,
    User,
)
from hub.routers.hub import (
    _can_send as _room_can_send,
    _check_duplicate_content,
    _check_slow_mode,
    _record_slow_mode_send,
    build_message_realtime_event,
    notify_inbox,
)
from hub.share_payloads import share_create_payload

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["app-dashboard"])


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------


class SendContactRequestBody(BaseModel):
    # Exactly one of ``to_agent_id`` or ``to_human_id`` must be provided.
    # ``to_agent_id`` preserves backward compatibility (agent → agent).
    # ``to_human_id`` (hu_*) targets a human participant (agent → human).
    to_agent_id: str | None = None
    to_human_id: str | None = None
    message: str | None = None


class CreateShareBody(BaseModel):
    expires_in_hours: int | None = None


class UpdateRoomSettingsBody(BaseModel):
    name: str | None = None
    description: str | None = None
    rule: str | None = None
    visibility: str | None = None
    join_policy: str | None = None
    default_send: bool | None = None
    default_invite: bool | None = None
    allow_human_send: bool | None = None
    max_members: int | None = None
    slow_mode_seconds: int | None = None
    required_subscription_product_id: str | None = None



# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


_RECEIPT_TYPES = frozenset({"ack", "result", "error"})


def _extract_text_preview(envelope_json: str) -> tuple[str, str | None, str]:
    """Extract (sender_id, text_preview, msg_type) from an envelope JSON string."""
    try:
        data = json.loads(envelope_json)
    except (json.JSONDecodeError, TypeError):
        return ("", None, "message")
    sender_id = data.get("from", "")
    msg_type = data.get("type", "message")
    payload = data.get("payload", {})
    if not isinstance(payload, dict):
        payload = {}
    text_val = payload.get("text") or payload.get("body") or payload.get("message") or ""
    if text_val and not isinstance(text_val, str):
        text_val = str(text_val)
    return sender_id, (text_val[:200] if text_val else None), str(msg_type)


async def _build_rooms_from_sql(
    agent_id: str,
    db: AsyncSession,
) -> list[dict]:
    """Build room list for dashboard overview.

    Tries to call get_agent_room_previews SQL function (PostgreSQL).
    Falls back to ORM query on failure (e.g. SQLite in tests).
    """
    _SQL_TO_API = {
        "room_name": "name",
        "room_description": "description",
        "room_rule": "rule",
        "room_created_at": "created_at",
    }
    _DROP_COLS = {"last_sender_id"}
    _DATETIME_KEYS = {"created_at", "last_message_at"}

    sql_room_ids: set[str] = set()

    try:
        result = await db.execute(
            text("SELECT * FROM get_agent_room_previews(:agent_id)"),
            {"agent_id": agent_id},
        )
        rows = result.mappings().all()
        mapped = []
        for r in rows:
            item = {}
            for k, v in r.items():
                if k in _DROP_COLS:
                    continue
                key = _SQL_TO_API.get(k, k)
                if key in _DATETIME_KEYS and isinstance(v, datetime.datetime):
                    if v.tzinfo is None:
                        v = v.replace(tzinfo=datetime.timezone.utc)
                    v = v.isoformat()
                item[key] = v
            if "member_count" in item:
                item["member_count"] = int(item["member_count"] or 0)
            room_id = item.get("room_id")
            if isinstance(room_id, str):
                sql_room_ids.add(room_id)
            mapped.append(item)
        orm_rooms = await _build_rooms_from_membership(agent_id, db)
        if not orm_rooms:
            return mapped
        orm_room_by_id = {room["room_id"]: room for room in orm_rooms}
        fill_keys = (
            "owner_type",
            "join_policy",
            "can_invite",
            "required_subscription_product_id",
            "allow_human_send",
            "default_send",
            "default_invite",
            "max_members",
            "slow_mode_seconds",
        )
        for item in mapped:
            room_id = item.get("room_id")
            if not isinstance(room_id, str):
                continue
            fallback = orm_room_by_id.get(room_id)
            if fallback is None:
                continue
            for key in fill_keys:
                if key not in item:
                    item[key] = fallback.get(key)
        missing_rooms = [room for room in orm_rooms if room["room_id"] not in sql_room_ids]
        if not missing_rooms:
            return mapped
        return _sort_room_previews(mapped + missing_rooms)
    except Exception:
        _logger.debug(
            "get_agent_room_previews unavailable, falling back to ORM query",
            exc_info=True,
        )
        await db.rollback()

    return await _build_rooms_from_membership(agent_id, db)


def _sort_room_previews(rooms: list[dict]) -> list[dict]:
    def _sort_key(r: dict) -> str:
        val = r.get("last_message_at") or r.get("created_at") or ""
        if hasattr(val, "isoformat"):
            return val.isoformat()
        return str(val)

    rooms.sort(key=_sort_key, reverse=True)
    return rooms


async def _build_rooms_from_membership(
    agent_id: str,
    db: AsyncSession,
) -> list[dict]:
    # --- ORM fallback /补齐缺失 membership ---
    member_result = await db.execute(
        select(RoomMember.room_id, RoomMember.role, RoomMember.can_invite)
        .where(RoomMember.agent_id == agent_id)
    )
    _member_rows = member_result.all()
    memberships = {row[0]: row[1] for row in _member_rows}
    invite_overrides = {row[0]: row[2] for row in _member_rows}
    room_ids = list(memberships.keys())
    if not room_ids:
        return []

    room_result = await db.execute(
        select(Room).where(Room.room_id.in_(room_ids))
    )
    rooms = {r.room_id: r for r in room_result.scalars().all()}

    count_result = await db.execute(
        select(RoomMember.room_id, func.count(RoomMember.id))
        .where(RoomMember.room_id.in_(room_ids))
        .group_by(RoomMember.room_id)
    )
    member_counts = dict(count_result.all())

    dedup_sub = (
        select(
            MessageRecord.room_id,
            MessageRecord.msg_id,
            func.min(MessageRecord.id).label("min_id"),
        )
        .where(MessageRecord.room_id.in_(room_ids))
        .group_by(MessageRecord.room_id, MessageRecord.msg_id)
        .subquery()
    )
    latest_sub = (
        select(
            dedup_sub.c.room_id,
            func.max(dedup_sub.c.min_id).label("record_id"),
        )
        .group_by(dedup_sub.c.room_id)
        .subquery()
    )
    last_msg_result = await db.execute(
        select(MessageRecord)
        .where(MessageRecord.id.in_(select(latest_sub.c.record_id)))
    )
    last_messages: dict[str, MessageRecord] = {}
    receipt_room_ids: list[str] = []
    for rec in last_msg_result.scalars().all():
        if not rec.room_id:
            continue
        _, _, msg_type = _extract_text_preview(rec.envelope_json)
        if msg_type in _RECEIPT_TYPES:
            receipt_room_ids.append(rec.room_id)
        else:
            last_messages[rec.room_id] = rec

    # Second pass: for rooms whose latest record was a receipt, walk back to
    # find the most recent real message (single batch query).
    if receipt_room_ids:
        fallback_dedup = (
            select(
                MessageRecord.room_id,
                MessageRecord.msg_id,
                func.min(MessageRecord.id).label("min_id"),
            )
            .where(MessageRecord.room_id.in_(receipt_room_ids))
            .group_by(MessageRecord.room_id, MessageRecord.msg_id)
            .subquery()
        )
        fallback_result = await db.execute(
            select(MessageRecord)
            .where(MessageRecord.id.in_(select(fallback_dedup.c.min_id)))
            .order_by(MessageRecord.id.desc())
        )
        for rec in fallback_result.scalars().all():
            rid = rec.room_id
            if rid and rid not in last_messages:
                _, _, mt = _extract_text_preview(rec.envelope_json)
                if mt not in _RECEIPT_TYPES:
                    last_messages[rid] = rec

    sender_ids = {rec.sender_id for rec in last_messages.values()}
    sender_names: dict[str, str] = {}
    if sender_ids:
        agent_result = await db.execute(
            select(Agent.agent_id, Agent.display_name)
            .where(Agent.agent_id.in_(sender_ids))
        )
        sender_names = dict(agent_result.all())

    result_rooms = []
    for rid in room_ids:
        room = rooms.get(rid)
        if room is None:
            continue
        last_rec = last_messages.get(rid)
        last_preview = None
        last_at = None
        last_sender = None
        if last_rec:
            sid, preview, _mt = _extract_text_preview(last_rec.envelope_json)
            last_preview = preview
            last_at = last_rec.created_at
            if last_at is not None and last_at.tzinfo is None:
                last_at = last_at.replace(tzinfo=datetime.timezone.utc)
            last_sender = sender_names.get(sid)

        role_val = memberships.get(rid)
        my_role = role_val.value if hasattr(role_val, "value") else str(role_val) if role_val else "member"

        member_can_invite = invite_overrides.get(rid)
        is_public_open = (
            room.visibility == RoomVisibility.public
            and room.join_policy == RoomJoinPolicy.open
        )
        if my_role == "owner":
            computed_can_invite = True
        elif is_public_open:
            computed_can_invite = True
        elif member_can_invite is not None:
            computed_can_invite = member_can_invite
        elif my_role == "admin":
            computed_can_invite = True
        else:
            computed_can_invite = room.default_invite

        result_rooms.append({
            "room_id": room.room_id,
            "name": room.name,
            "description": room.description,
            "rule": room.rule,
            "required_subscription_product_id": room.required_subscription_product_id,
            "owner_id": room.owner_id,
            "owner_type": room.owner_type.value if hasattr(room.owner_type, "value") else str(room.owner_type),
            "visibility": room.visibility.value if hasattr(room.visibility, "value") else str(room.visibility),
            "join_policy": room.join_policy.value if hasattr(room.join_policy, "value") else str(room.join_policy),
            "member_count": member_counts.get(rid, 0),
            "my_role": my_role,
            "can_invite": computed_can_invite,
            "allow_human_send": room.allow_human_send,
            "default_send": room.default_send,
            "default_invite": room.default_invite,
            "max_members": room.max_members,
            "slow_mode_seconds": room.slow_mode_seconds,
            "last_message_preview": last_preview,
            "last_message_at": last_at.isoformat() if last_at else None,
            "last_sender_name": last_sender,
            "created_at": room.created_at.isoformat() if room.created_at else None,
        })

    return _sort_room_previews(result_rooms)


# ---------------------------------------------------------------------------
# Overview
# ---------------------------------------------------------------------------


@router.get("/overview")
async def get_overview(
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return dashboard overview for the current viewer.

    Viewer is either the active Agent (when ``X-Active-Agent`` is supplied)
    or the Human (``hu_*``) derived from the Supabase JWT. In Human mode
    the ``agent`` field is ``None`` and a ``viewer`` descriptor identifies
    the Human viewer.
    """
    agent_data: dict | None = None
    viewer_id: str
    viewer_type: ParticipantType
    viewer_display_name: str | None

    if ctx.active_agent_id is not None:
        result = await db.execute(
            select(Agent).where(Agent.agent_id == ctx.active_agent_id)
        )
        agent = result.scalar_one_or_none()
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        agent_data = {
            "agent_id": agent.agent_id,
            "display_name": agent.display_name,
            "bio": agent.bio,
            "message_policy": agent.message_policy.value if hasattr(agent.message_policy, "value") else str(agent.message_policy),
            "created_at": agent.created_at.isoformat() if agent.created_at else None,
        }
        viewer_id = agent.agent_id
        viewer_type = ParticipantType.agent
        viewer_display_name = agent.display_name
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human
        viewer_display_name = ctx.user_display_name

    rooms = await _build_rooms_from_sql(viewer_id, db)

    contact_result = await db.execute(
        select(
            Contact,
            Agent.display_name.label("agent_dn"),
            User.display_name.label("user_dn"),
            User.avatar_url.label("user_avatar"),
        )
        .outerjoin(Agent, Agent.agent_id == Contact.contact_agent_id)
        .outerjoin(User, User.human_id == Contact.contact_agent_id)
        .where(
            Contact.owner_id == viewer_id,
            Contact.owner_type == viewer_type,
        )
    )
    contacts = []
    for c, agent_dn, user_dn, user_avatar in contact_result.all():
        is_human = c.peer_type == ParticipantType.human
        dn = (user_dn if is_human else agent_dn) or c.contact_agent_id
        avatar = user_avatar if is_human else None
        contacts.append({
            "contact_agent_id": c.contact_agent_id,
            "alias": c.alias,
            "display_name": dn,
            "avatar_url": avatar,
            "peer_type": c.peer_type.value if hasattr(c.peer_type, "value") else str(c.peer_type),
            "created_at": c.created_at.isoformat() if c.created_at else None,
        })

    pending_result = await db.execute(
        select(func.count())
        .select_from(ContactRequest)
        .where(
            ContactRequest.to_agent_id == viewer_id,
            ContactRequest.to_type == viewer_type,
            ContactRequest.state == ContactRequestState.pending,
        )
    )
    pending_count = pending_result.scalar() or 0

    return {
        "agent": agent_data,
        "viewer": {
            "type": viewer_type.value,
            "id": viewer_id,
            "display_name": viewer_display_name,
        },
        "rooms": rooms,
        "contacts": contacts,
        "pending_requests": pending_count,
    }


# ---------------------------------------------------------------------------
# Contact Requests
# ---------------------------------------------------------------------------


def _serialize_contact_request(
    req: ContactRequest,
    from_display_name: str | None = None,
    to_display_name: str | None = None,
) -> dict:
    """Return the canonical JSON shape for a ContactRequest row."""

    def _state(v):
        return v.value if hasattr(v, "value") else str(v)

    return {
        "id": req.id,
        "from_agent_id": req.from_agent_id,
        "to_agent_id": req.to_agent_id,
        "from_type": _state(req.from_type),
        "to_type": _state(req.to_type),
        "state": _state(req.state),
        "message": req.message,
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "resolved_at": req.resolved_at.isoformat() if req.resolved_at else None,
        "from_display_name": from_display_name,
        "to_display_name": to_display_name,
    }


@router.post("/contact-requests", status_code=201)
async def send_contact_request(
    body: SendContactRequestBody,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Send a contact request from the active agent to another agent or human.

    Exactly one of ``to_agent_id`` (ag_* — legacy A→A path) or
    ``to_human_id`` (hu_* — new A→H path) must be provided.
    """
    agent_id = ctx.active_agent_id

    # ------------------------------------------------------------------
    # Determine target + type (exactly one of to_agent_id / to_human_id)
    # ------------------------------------------------------------------
    provided = [x for x in (body.to_agent_id, body.to_human_id) if x]
    if len(provided) != 1:
        raise HTTPException(
            status_code=400,
            detail="Provide exactly one of to_agent_id or to_human_id",
        )

    target_display_name: str | None = None

    if body.to_human_id is not None:
        to_id = body.to_human_id
        to_type = ParticipantType.human
        if not to_id.startswith("hu_"):
            raise HTTPException(status_code=400, detail="to_human_id must start with hu_")
        # Verify the human exists via User.human_id lookup.
        target_user = await db.execute(
            select(User).where(User.human_id == to_id)
        )
        user_row = target_user.scalar_one_or_none()
        if user_row is None:
            raise HTTPException(status_code=404, detail="Target human not found")
        target_display_name = user_row.display_name
    else:
        to_id = body.to_agent_id  # type: ignore[assignment]
        to_type = ParticipantType.agent
        if to_id == agent_id:
            raise HTTPException(status_code=400, detail="Cannot send request to yourself")
        target = await db.execute(select(Agent).where(Agent.agent_id == to_id))
        target_agent = target.scalar_one_or_none()
        if target_agent is None:
            raise HTTPException(status_code=404, detail="Target agent not found")
        target_display_name = target_agent.display_name

    # ------------------------------------------------------------------
    # Already in contacts?
    # ------------------------------------------------------------------
    existing_contact = await db.execute(
        select(Contact).where(
            Contact.owner_id == agent_id,
            Contact.owner_type == ParticipantType.agent,
            Contact.contact_agent_id == to_id,
            Contact.peer_type == to_type,
        )
    )
    if existing_contact.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Already in contacts")

    # ------------------------------------------------------------------
    # Explicit state filters (W4):
    #   * Forward (me→target) where state != rejected → 409
    #   * Reverse (target→me) pending → 409 with "accept incoming" hint
    #   * Forward (me→target) rejected → reuse row (resend)
    # ------------------------------------------------------------------
    existing_reverse = await db.execute(
        select(ContactRequest).where(
            ContactRequest.from_agent_id == to_id,
            ContactRequest.from_type == to_type,
            ContactRequest.to_agent_id == agent_id,
            ContactRequest.to_type == ParticipantType.agent,
            ContactRequest.state == ContactRequestState.pending,
        )
    )
    if existing_reverse.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=409,
            detail="Incoming contact request exists — accept it instead",
        )

    existing_forward_active = await db.execute(
        select(ContactRequest).where(
            ContactRequest.from_agent_id == agent_id,
            ContactRequest.from_type == ParticipantType.agent,
            ContactRequest.to_agent_id == to_id,
            ContactRequest.to_type == to_type,
            ContactRequest.state != ContactRequestState.rejected,
        )
    )
    if existing_forward_active.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Contact request already exists")

    existing_forward_rejected = await db.execute(
        select(ContactRequest).where(
            ContactRequest.from_agent_id == agent_id,
            ContactRequest.from_type == ParticipantType.agent,
            ContactRequest.to_agent_id == to_id,
            ContactRequest.to_type == to_type,
            ContactRequest.state == ContactRequestState.rejected,
        )
    )
    req = existing_forward_rejected.scalar_one_or_none()

    if req is not None:
        # Resend after reject — reuse the existing row.
        req.state = ContactRequestState.pending
        req.message = body.message
        req.resolved_at = None
        await db.commit()
        await db.refresh(req)
    else:
        req = ContactRequest(
            from_agent_id=agent_id,
            to_agent_id=to_id,
            from_type=ParticipantType.agent,
            to_type=to_type,
            state=ContactRequestState.pending,
            message=body.message,
        )
        db.add(req)
        await db.commit()
        await db.refresh(req)

    return _serialize_contact_request(
        req,
        from_display_name=None,
        to_display_name=target_display_name,
    )


async def _resolve_display_names(
    db: AsyncSession,
    ids_by_type: dict[ParticipantType, set[str]],
) -> dict[tuple[ParticipantType, str], str]:
    """Bulk-resolve display names for a mixed set of agent/human ids."""
    out: dict[tuple[ParticipantType, str], str] = {}

    agent_ids = ids_by_type.get(ParticipantType.agent, set())
    if agent_ids:
        result = await db.execute(
            select(Agent.agent_id, Agent.display_name).where(Agent.agent_id.in_(agent_ids))
        )
        for agent_id, name in result.all():
            out[(ParticipantType.agent, agent_id)] = name

    human_ids = ids_by_type.get(ParticipantType.human, set())
    if human_ids:
        result = await db.execute(
            select(User.human_id, User.display_name).where(User.human_id.in_(human_ids))
        )
        for human_id, name in result.all():
            if human_id is not None:
                out[(ParticipantType.human, human_id)] = name

    return out


@router.get("/contact-requests/received")
async def list_received_requests(
    state: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """List contact requests received by the current viewer.

    Viewer is either the active Agent or the Human derived from the
    Supabase JWT. The ``from`` side may independently be Agent or Human.
    """
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    stmt = select(ContactRequest).where(
        ContactRequest.to_agent_id == viewer_id,
        ContactRequest.to_type == viewer_type,
    )
    if state:
        stmt = stmt.where(ContactRequest.state == state)

    result = await db.execute(stmt)
    rows = list(result.scalars().all())

    ids_by_type: dict[ParticipantType, set[str]] = {
        ParticipantType.agent: set(),
        ParticipantType.human: set(),
    }
    for cr in rows:
        ids_by_type[cr.from_type].add(cr.from_agent_id)
    names = await _resolve_display_names(db, ids_by_type)

    return {
        "requests": [
            _serialize_contact_request(
                cr,
                from_display_name=names.get((cr.from_type, cr.from_agent_id)),
                to_display_name=None,
            )
            for cr in rows
        ],
    }


@router.get("/contact-requests/sent")
async def list_sent_requests(
    state: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """List contact requests sent by the current viewer.

    Viewer is either the active Agent or the Human derived from the
    Supabase JWT. ``to_type`` may independently be Agent or Human.
    """
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    stmt = select(ContactRequest).where(
        ContactRequest.from_agent_id == viewer_id,
        ContactRequest.from_type == viewer_type,
    )
    if state:
        stmt = stmt.where(ContactRequest.state == state)

    result = await db.execute(stmt)
    rows = list(result.scalars().all())

    ids_by_type: dict[ParticipantType, set[str]] = {
        ParticipantType.agent: set(),
        ParticipantType.human: set(),
    }
    for cr in rows:
        ids_by_type[cr.to_type].add(cr.to_agent_id)
    names = await _resolve_display_names(db, ids_by_type)

    return {
        "requests": [
            _serialize_contact_request(
                cr,
                from_display_name=None,
                to_display_name=names.get((cr.to_type, cr.to_agent_id)),
            )
            for cr in rows
        ],
    }


@router.post("/contact-requests/{request_id}/accept")
async def accept_contact_request(
    request_id: int,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Accept a pending contact request targeted at the active agent.

    The dashboard accept handler only runs when the *recipient* is an
    agent (``to_type == agent``). Thanks to polymorphism, the sender may
    be an agent (A↔A) or a human (H→A); we branch on ``from_type`` when
    writing the reciprocal Contact rows.
    """
    agent_id = ctx.active_agent_id

    result = await db.execute(
        select(ContactRequest).where(ContactRequest.id == request_id)
    )
    req = result.scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="Contact request not found")
    if req.to_type != ParticipantType.agent or req.to_agent_id != agent_id:
        raise HTTPException(status_code=403, detail="Not your request to accept")
    if req.state != ContactRequestState.pending:
        raise HTTPException(status_code=409, detail="Request is not pending")

    req.state = ContactRequestState.accepted
    req.resolved_at = datetime.datetime.now(datetime.timezone.utc)

    # Create bidirectional Contact rows with correct owner_type/peer_type.
    # Direction 1: from → to   (owner=from, peer=to)
    # Direction 2: to → from   (owner=to,   peer=from)
    for owner, owner_type, peer, peer_type in [
        (req.from_agent_id, req.from_type, req.to_agent_id, req.to_type),
        (req.to_agent_id, req.to_type, req.from_agent_id, req.from_type),
    ]:
        existing = await db.execute(
            select(Contact).where(
                Contact.owner_id == owner,
                Contact.owner_type == owner_type,
                Contact.contact_agent_id == peer,
                Contact.peer_type == peer_type,
            )
        )
        if existing.scalar_one_or_none() is None:
            db.add(
                Contact(
                    owner_id=owner,
                    owner_type=owner_type,
                    contact_agent_id=peer,
                    peer_type=peer_type,
                )
            )

    await db.commit()
    await db.refresh(req)

    return _serialize_contact_request(req)


@router.post("/contact-requests/{request_id}/reject")
async def reject_contact_request(
    request_id: int,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Reject a pending contact request."""
    agent_id = ctx.active_agent_id

    result = await db.execute(
        select(ContactRequest).where(ContactRequest.id == request_id)
    )
    req = result.scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="Contact request not found")
    if req.to_type != ParticipantType.agent or req.to_agent_id != agent_id:
        raise HTTPException(status_code=403, detail="Not your request to reject")
    if req.state != ContactRequestState.pending:
        raise HTTPException(status_code=409, detail="Request is not pending")

    req.state = ContactRequestState.rejected
    req.resolved_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    await db.refresh(req)

    return _serialize_contact_request(req)


# ---------------------------------------------------------------------------
# Contact management
# ---------------------------------------------------------------------------


@router.delete("/contacts/{contact_agent_id}", status_code=204)
async def remove_contact(
    contact_agent_id: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Remove a contact (bidirectional delete)."""
    agent_id = ctx.agent_id

    result = await db.execute(
        select(Contact).where(
            Contact.owner_id == agent_id,
            Contact.contact_agent_id == contact_agent_id,
        )
    )
    contact = result.scalar_one_or_none()
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found")

    await db.delete(contact)

    reverse_result = await db.execute(
        select(Contact).where(
            Contact.owner_id == contact_agent_id,
            Contact.contact_agent_id == agent_id,
        )
    )
    reverse_contact = reverse_result.scalar_one_or_none()
    if reverse_contact is not None:
        await db.delete(reverse_contact)

    await db.commit()


# ---------------------------------------------------------------------------
# Agent search / details
# ---------------------------------------------------------------------------


@router.get("/agents/search")
async def search_agents(
    q: str = Query(..., min_length=1),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Search agents and humans by id or display_name.

    The ``agents`` field is preserved for backwards-compatibility. The new
    ``humans`` field carries ``hu_*`` matches so the add-friend flow can
    target Humans as first-class peers. Requests sent to a ``hu_*`` id go
    through the existing contact-request pipeline (see app/routers/humans.py
    and app/routers/dashboard.py::create_contact_request).
    """
    pattern = f"%{escape_like(q)}%"
    result = await db.execute(
        select(Agent)
        .where(
            Agent.agent_id != "hub",
            (Agent.agent_id.ilike(pattern)) | (Agent.display_name.ilike(pattern)),
        )
        .limit(20)
    )
    agents = result.scalars().all()

    human_result = await db.execute(
        select(User)
        .where(
            User.human_id.is_not(None),
            (User.human_id.ilike(pattern)) | (User.display_name.ilike(pattern)),
        )
        .limit(20)
    )
    humans = human_result.scalars().all()

    return {
        "agents": [
            {
                "agent_id": a.agent_id,
                "display_name": a.display_name,
                "bio": a.bio,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in agents
        ],
        "humans": [
            {
                "human_id": h.human_id,
                "display_name": h.display_name,
                "avatar_url": h.avatar_url,
                "created_at": h.created_at.isoformat() if h.created_at else None,
            }
            for h in humans
        ],
    }


@router.get("/agents/{agent_id}")
async def get_agent_detail(
    agent_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Get agent details."""
    result = await db.execute(
        select(Agent, User.human_id, User.display_name.label("owner_display_name"))
        .outerjoin(User, User.id == Agent.user_id)
        .where(Agent.agent_id == agent_id)
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    agent, owner_human_id, owner_display_name = row

    return {
        "agent_id": agent.agent_id,
        "display_name": agent.display_name,
        "bio": agent.bio,
        "message_policy": agent.message_policy.value if hasattr(agent.message_policy, "value") else str(agent.message_policy),
        "created_at": agent.created_at.isoformat() if agent.created_at else None,
        "owner_human_id": owner_human_id,
        "owner_display_name": owner_display_name,
    }


@router.get("/agents/{agent_id}/conversations")
async def get_shared_rooms(
    agent_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Get rooms shared by the current viewer anchor and the target agent.

    Human sessions have no active agent, so they cannot have agent-agent
    shared rooms; return an empty list instead of rejecting the request.
    """
    my_agent_id = ctx.active_agent_id
    if my_agent_id is None:
        return {"conversations": []}

    # Find rooms where both agents are members
    my_rooms = select(RoomMember.room_id).where(RoomMember.agent_id == my_agent_id).subquery()
    their_rooms = select(RoomMember.room_id).where(RoomMember.agent_id == agent_id).subquery()

    shared = await db.execute(
        select(Room)
        .where(
            Room.room_id.in_(select(my_rooms.c.room_id)),
            Room.room_id.in_(select(their_rooms.c.room_id)),
        )
    )
    rooms = shared.scalars().all()

    # Member counts
    room_ids = [r.room_id for r in rooms]
    member_counts: dict[str, int] = {}
    if room_ids:
        count_result = await db.execute(
            select(RoomMember.room_id, func.count(RoomMember.id))
            .where(RoomMember.room_id.in_(room_ids))
            .group_by(RoomMember.room_id)
        )
        member_counts = dict(count_result.all())

    return {
        "conversations": [
            {
                "room_id": r.room_id,
                "name": r.name,
                "description": r.description,
                "owner_id": r.owner_id,
                "visibility": r.visibility.value if hasattr(r.visibility, "value") else str(r.visibility),
                "member_count": member_counts.get(r.room_id, 0),
                "allow_human_send": r.allow_human_send,
            }
            for r in rooms
        ],
    }


# ---------------------------------------------------------------------------
# Room discovery & join
# ---------------------------------------------------------------------------


@router.get("/rooms/discover")
async def discover_rooms(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Discover public rooms."""
    filters = (Room.visibility == RoomVisibility.public,)

    # Total count
    count_result = await db.execute(
        select(func.count()).select_from(Room).where(*filters)
    )
    total = count_result.scalar() or 0

    stmt = (
        select(Room, func.count(RoomMember.id).label("member_count"))
        .outerjoin(RoomMember, RoomMember.room_id == Room.room_id)
        .where(*filters)
        .group_by(Room.id)
        .order_by(Room.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    rows = result.all()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "rooms": [
            {
                "room_id": r.room_id,
                "name": r.name,
                "description": r.description,
                "rule": r.rule,
                "required_subscription_product_id": r.required_subscription_product_id,
                "owner_id": r.owner_id,
                "visibility": r.visibility.value if hasattr(r.visibility, "value") else str(r.visibility),
                "join_policy": r.join_policy.value if hasattr(r.join_policy, "value") else str(r.join_policy),
                "max_members": r.max_members,
                "member_count": int(mc),
                "allow_human_send": r.allow_human_send,
            }
            for r, mc in rows
        ],
    }


@router.post("/rooms/{room_id}/join", status_code=201)
async def join_room(
    room_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Join a public room with open join policy. Viewer is the active Agent
    or the Human derived from the Supabase JWT — Humans occupy member slots
    identically to Agents."""
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    result = await db.execute(
        select(Room).where(Room.room_id == room_id)
    )
    room = result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.visibility != RoomVisibility.public:
        raise HTTPException(status_code=403, detail="Room is not public")
    if room.join_policy != RoomJoinPolicy.open:
        raise HTTPException(status_code=403, detail="Room does not allow open joining")

    if room.required_subscription_product_id is not None:
        if viewer_type != ParticipantType.agent:
            raise HTTPException(
                status_code=403,
                detail="Humans cannot join subscription-gated rooms directly",
            )
        sub_row = (
            await db.execute(
                select(AgentSubscription).where(
                    AgentSubscription.subscriber_agent_id == viewer_id,
                    AgentSubscription.product_id == room.required_subscription_product_id,
                    AgentSubscription.status == SubscriptionStatus.active,
                )
            )
        ).scalar_one_or_none()
        if sub_row is None:
            raise HTTPException(
                status_code=403,
                detail="Active subscription required to join this room",
            )

    # Check max_members — Humans occupy slots identically to Agents.
    if room.max_members is not None:
        count_result = await db.execute(
            select(func.count(RoomMember.id)).where(RoomMember.room_id == room_id)
        )
        current_count = count_result.scalar() or 0
        if current_count >= room.max_members:
            raise HTTPException(status_code=409, detail="Room is full")

    existing = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == viewer_id,
            RoomMember.participant_type == viewer_type,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Already a member")

    member = RoomMember(
        room_id=room_id,
        agent_id=viewer_id,
        participant_type=viewer_type,
        role=RoomRole.member,
    )
    db.add(member)
    await db.commit()

    # Return full room summary matching JoinRoomResponse
    mc_result = await db.execute(
        select(func.count(RoomMember.id)).where(RoomMember.room_id == room_id)
    )
    member_count = mc_result.scalar() or 0

    return {
        "room_id": room_id,
        "name": room.name,
        "description": room.description,
        "owner_id": room.owner_id,
        "visibility": room.visibility.value if hasattr(room.visibility, "value") else str(room.visibility),
        "member_count": member_count,
        "my_role": "member",
        "rule": room.rule,
        "required_subscription_product_id": room.required_subscription_product_id,
        "allow_human_send": room.allow_human_send,
    }


# ---------------------------------------------------------------------------
# Update room settings (owner/admin)
# ---------------------------------------------------------------------------


@router.patch("/rooms/{room_id}")
async def update_room_settings(
    room_id: str,
    body: UpdateRoomSettingsBody,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Update room settings. Basic fields require admin; advanced fields
    require owner. Works for human-as-owner viewers too — capability is
    derived via ``viewer_can_admin_room``."""
    room = (await db.execute(select(Room).where(Room.room_id == room_id))).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    cap = await viewer_can_admin_room(db, ctx, room)
    if cap is None:
        raise HTTPException(status_code=403, detail="Only owner or admin can update room settings")

    fields_set = body.model_fields_set
    owner_only_fields = {
        "visibility",
        "join_policy",
        "default_send",
        "default_invite",
        "max_members",
        "slow_mode_seconds",
        "required_subscription_product_id",
    }
    if fields_set & owner_only_fields and cap != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can change advanced settings")

    if "name" in fields_set:
        name = (body.name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        room.name = name
    if "description" in fields_set:
        room.description = (body.description or "").strip()
    if "rule" in fields_set:
        rule = (body.rule or "").strip()
        room.rule = rule or None
    if "visibility" in fields_set and body.visibility is not None:
        try:
            room.visibility = RoomVisibility(body.visibility)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid visibility") from exc
    if "join_policy" in fields_set and body.join_policy is not None:
        try:
            room.join_policy = RoomJoinPolicy(body.join_policy)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid join_policy") from exc
    if "default_send" in fields_set and body.default_send is not None:
        room.default_send = body.default_send
    if "default_invite" in fields_set and body.default_invite is not None:
        room.default_invite = body.default_invite
    if "allow_human_send" in fields_set and body.allow_human_send is not None:
        room.allow_human_send = body.allow_human_send
    if "max_members" in fields_set:
        if body.max_members is not None and body.max_members < 1:
            raise HTTPException(status_code=400, detail="max_members must be >= 1")
        room.max_members = body.max_members
    if "slow_mode_seconds" in fields_set:
        if body.slow_mode_seconds is not None and body.slow_mode_seconds < 0:
            raise HTTPException(status_code=400, detail="slow_mode_seconds must be >= 0")
        room.slow_mode_seconds = body.slow_mode_seconds
    if "required_subscription_product_id" in fields_set:
        new_pid = body.required_subscription_product_id or None
        if new_pid is not None:
            product_row = (
                await db.execute(
                    select(SubscriptionProduct).where(
                        SubscriptionProduct.product_id == new_pid
                    )
                )
            ).scalar_one_or_none()
            if product_row is None:
                raise HTTPException(status_code=404, detail="Subscription product not found")
            if (
                product_row.owner_id != room.owner_id
                or product_row.owner_type != room.owner_type
            ):
                raise HTTPException(
                    status_code=403,
                    detail="Subscription product does not belong to room owner",
                )
            if product_row.status != SubscriptionProductStatus.active:
                raise HTTPException(
                    status_code=400, detail="Subscription product is not active"
                )
        # When clearing paid access, backfill room_id on legacy subs of the
        # current product so the next billing cycle's mismatch check fires.
        # Only do this when no other room references the same product —
        # otherwise the legacy NULL room_id is genuinely ambiguous.
        old_pid = room.required_subscription_product_id
        if (
            new_pid is None
            and old_pid is not None
        ):
            other_rooms = (
                await db.execute(
                    select(func.count(Room.id)).where(
                        Room.required_subscription_product_id == old_pid,
                        Room.room_id != room.room_id,
                    )
                )
            ).scalar() or 0
            if other_rooms == 0:
                from sqlalchemy import update as _sa_update

                await db.execute(
                    _sa_update(AgentSubscription)
                    .where(
                        AgentSubscription.product_id == old_pid,
                        AgentSubscription.room_id.is_(None),
                        AgentSubscription.status.in_(
                            [SubscriptionStatus.active, SubscriptionStatus.past_due]
                        ),
                    )
                    .values(room_id=room.room_id)
                )
        room.required_subscription_product_id = new_pid

    await db.commit()
    await db.refresh(room)

    return {
        "room_id": room.room_id,
        "name": room.name,
        "description": room.description,
        "rule": room.rule,
        "visibility": room.visibility.value if hasattr(room.visibility, "value") else str(room.visibility),
        "join_policy": room.join_policy.value if hasattr(room.join_policy, "value") else str(room.join_policy),
        "default_send": room.default_send,
        "default_invite": room.default_invite,
        "allow_human_send": room.allow_human_send,
        "max_members": room.max_members,
        "slow_mode_seconds": room.slow_mode_seconds,
        "required_subscription_product_id": room.required_subscription_product_id,
    }


# ---------------------------------------------------------------------------
# Migrate room subscription plan (atomic create + bind + archive)
# ---------------------------------------------------------------------------


class MigrateRoomPlanBody(BaseModel):
    amount_minor: str = Field(..., min_length=1)
    billing_interval: str = Field(..., description="week or month")
    description: str = Field(default="")
    # Required when the room is human-owned. Ignored for agent-owned rooms.
    provider_agent_id: str | None = None


@router.post("/rooms/{room_id}/subscription/migrate-plan")
async def migrate_room_subscription_plan(
    room_id: str,
    body: MigrateRoomPlanBody,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Atomically swap a room's subscription plan.

    Creates a new ``SubscriptionProduct``, points
    ``room.required_subscription_product_id`` at it, archives the previous
    product (if any and not referenced by other rooms). Existing subscribers
    keep access until their next charge cycle, where ``_charge_subscription``
    detects the mismatch and cancels them.
    """
    from hub.enums import BillingInterval
    from hub.id_generators import generate_subscription_product_id
    from hub.services import subscriptions as sub_svc

    try:
        amount = int(body.amount_minor)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid amount_minor")
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount_minor must be positive")
    try:
        interval = BillingInterval(body.billing_interval)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="billing_interval must be 'week' or 'month'",
        )
    if interval not in {BillingInterval.week, BillingInterval.month}:
        raise HTTPException(
            status_code=400,
            detail="billing_interval must be 'week' or 'month'",
        )

    room = (
        await db.execute(select(Room).where(Room.room_id == room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    cap = await viewer_can_admin_room(db, ctx, room)
    if cap != "owner":
        raise HTTPException(
            status_code=403, detail="Only the room owner can change the subscription plan"
        )

    provider_agent_id = await resolve_provider_agent_for_room(
        db, ctx, room, requested_provider_agent_id=body.provider_agent_id,
    )

    old_product_id = room.required_subscription_product_id
    if old_product_id is not None:
        # Reuse-state guard: an old product shared across multiple rooms
        # cannot be changed from a single room's modal.
        ref_count = (
            await db.execute(
                select(func.count(Room.id)).where(
                    Room.required_subscription_product_id == old_product_id
                )
            )
        ).scalar() or 0
        if ref_count > 1:
            raise HTTPException(
                status_code=409,
                detail="Subscription product is shared across multiple rooms",
            )

    # Stable, randomised internal name avoids the (owner_id, owner_type, name)
    # uniqueness collision on retries within the same second.
    new_product = await sub_svc.create_subscription_product(
        db,
        owner_id=room.owner_id,
        owner_type=room.owner_type,
        provider_agent_id=provider_agent_id,
        name=f"room:{room.room_id}:plan:{generate_subscription_product_id()}",
        description=body.description or "",
        amount_minor=amount,
        billing_interval=interval,
    )

    # Backfill room_id on any pre-existing subscriptions that point at the
    # old product but never recorded which room they were bought for. Without
    # this, _charge_subscription's mismatch check is skipped (it gates on
    # `room_id IS NOT NULL`) and those subs would keep auto-renewing on the
    # archived old product. Safe to do unconditionally here because the
    # multi-room reuse guard above already rejected any product referenced by
    # >1 room.
    if old_product_id is not None:
        from sqlalchemy import update as _sa_update

        await db.execute(
            _sa_update(AgentSubscription)
            .where(
                AgentSubscription.product_id == old_product_id,
                AgentSubscription.room_id.is_(None),
                AgentSubscription.status.in_(
                    [SubscriptionStatus.active, SubscriptionStatus.past_due]
                ),
            )
            .values(room_id=room.room_id)
        )

    room.required_subscription_product_id = new_product.product_id

    if old_product_id is not None:
        try:
            await sub_svc.archive_subscription_product(
                db,
                old_product_id,
                owner_id=room.owner_id,
                owner_type=room.owner_type,
            )
        except ValueError:
            # Owner mismatch on the old product — leave as-is rather than
            # blocking the plan migration.
            pass

    affected_count = 0
    if old_product_id is not None:
        affected_count = (
            await db.execute(
                select(func.count(AgentSubscription.id)).where(
                    AgentSubscription.product_id == old_product_id,
                    AgentSubscription.status.in_(
                        [SubscriptionStatus.active, SubscriptionStatus.past_due]
                    ),
                )
            )
        ).scalar() or 0

    await db.commit()
    await db.refresh(room)

    return {
        "product_id": new_product.product_id,
        "room": {
            "room_id": room.room_id,
            "name": room.name,
            "description": room.description,
            "rule": room.rule,
            "required_subscription_product_id": room.required_subscription_product_id,
        },
        "affected_count": affected_count,
    }


# ---------------------------------------------------------------------------
# Dissolve room (BFF — supports both human-owned and agent-owned rooms)
# ---------------------------------------------------------------------------


@router.delete("/rooms/{room_id}")
async def dissolve_room(
    room_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Dissolve a room. Owner-capability required (per
    ``viewer_can_admin_room``). Pre-cancels any subscriptions bound to the
    room before deletion (mirrors the hub agent-JWT route in
    ``hub/routers/room.py``)."""
    room = (
        await db.execute(select(Room).where(Room.room_id == room_id))
    ).scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    cap = await viewer_can_admin_room(db, ctx, room)
    if cap != "owner":
        raise HTTPException(status_code=403, detail="Only the room owner can dissolve the room")

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
        now = datetime.datetime.now(datetime.timezone.utc)
        for sub in bound_subs:
            sub.status = SubscriptionStatus.cancelled
            sub.cancelled_at = now
            sub.cancel_at_period_end = False
        await db.flush()

    await db.delete(room)
    await db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Leave room
# ---------------------------------------------------------------------------


@router.post("/rooms/{room_id}/leave")
async def leave_room(
    room_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Leave a room. Owner cannot leave. Works for both Agent and Human
    viewers — membership is keyed on (agent_id, participant_type)."""
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == viewer_id,
            RoomMember.participant_type == viewer_type,
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this room")
    if member.role == RoomRole.owner:
        raise HTTPException(status_code=400, detail="Owner cannot leave the room")

    await db.delete(member)
    await db.commit()

    return {"room_id": room_id, "left": True}


# ---------------------------------------------------------------------------
# Room join requests
# ---------------------------------------------------------------------------


class _JoinRequestBody(BaseModel):
    message: str | None = None


@router.post("/rooms/{room_id}/join-requests", status_code=201)
async def create_join_request(
    room_id: str,
    body: _JoinRequestBody | None = None,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Submit a join request for an invite-only public room. Works for
    Agent or Human viewers — the request is keyed on
    (room_id, requester_id, participant_type)."""
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    room_result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.visibility != RoomVisibility.public:
        raise HTTPException(status_code=403, detail="Room is not public")
    if room.join_policy != RoomJoinPolicy.invite_only:
        raise HTTPException(status_code=400, detail="Room is open — use the join endpoint instead")

    existing_member = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == viewer_id,
            RoomMember.participant_type == viewer_type,
        )
    )
    if existing_member.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Already a member")

    existing_pending = await db.execute(
        select(RoomJoinRequest).where(
            RoomJoinRequest.room_id == room_id,
            RoomJoinRequest.agent_id == viewer_id,
            RoomJoinRequest.participant_type == viewer_type,
            RoomJoinRequest.status == RoomJoinRequestStatus.pending,
        )
    )
    if existing_pending.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Join request already pending")

    req = RoomJoinRequest(
        request_id=generate_join_request_id(),
        room_id=room_id,
        agent_id=viewer_id,
        participant_type=viewer_type,
        message=body.message if body else None,
        status=RoomJoinRequestStatus.pending,
    )
    db.add(req)
    await db.commit()

    return {
        "request_id": req.request_id,
        "room_id": room_id,
        "agent_id": viewer_id,
        "participant_type": viewer_type.value,
        "status": "pending",
        "message": req.message,
        "created_at": req.created_at.isoformat() if req.created_at else None,
    }


@router.get("/rooms/{room_id}/join-requests")
async def list_join_requests(
    room_id: str,
    status: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """List join requests for a room. Owner/admin only. Viewer can be Agent
    or Human — both roles are first-class moderators."""
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    member_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == viewer_id,
            RoomMember.participant_type == viewer_type,
        )
    )
    member = member_result.scalar_one_or_none()
    if member is None or member.role not in (RoomRole.owner, RoomRole.admin):
        raise HTTPException(status_code=403, detail="Owner or admin required")

    # Resolve requester display name against both agents and users (by human_id).
    stmt = (
        select(
            RoomJoinRequest,
            func.coalesce(Agent.display_name, User.display_name).label("display_name"),
        )
        .outerjoin(Agent, Agent.agent_id == RoomJoinRequest.agent_id)
        .outerjoin(User, User.human_id == RoomJoinRequest.agent_id)
        .where(RoomJoinRequest.room_id == room_id)
    )
    if status:
        stmt = stmt.where(RoomJoinRequest.status == status)
    else:
        stmt = stmt.where(RoomJoinRequest.status == RoomJoinRequestStatus.pending)
    stmt = stmt.order_by(RoomJoinRequest.created_at.desc())

    result = await db.execute(stmt)
    rows = result.all()

    return {
        "requests": [
            {
                "request_id": jr.request_id,
                "room_id": jr.room_id,
                "agent_id": jr.agent_id,
                "participant_type": (
                    jr.participant_type.value
                    if hasattr(jr.participant_type, "value")
                    else str(jr.participant_type)
                ),
                "agent_display_name": display_name,
                "message": jr.message,
                "status": jr.status.value if hasattr(jr.status, "value") else str(jr.status),
                "created_at": jr.created_at.isoformat() if jr.created_at else None,
            }
            for jr, display_name in rows
        ]
    }


@router.post("/rooms/{room_id}/join-requests/{request_id}/accept", status_code=200)
async def accept_join_request(
    room_id: str,
    request_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Accept a join request. Owner/admin only (Agent or Human)."""
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    member_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == viewer_id,
            RoomMember.participant_type == viewer_type,
        )
    )
    member = member_result.scalar_one_or_none()
    if member is None or member.role not in (RoomRole.owner, RoomRole.admin):
        raise HTTPException(status_code=403, detail="Owner or admin required")

    jr_result = await db.execute(
        select(RoomJoinRequest).where(
            RoomJoinRequest.request_id == request_id,
            RoomJoinRequest.room_id == room_id,
        )
    )
    jr = jr_result.scalar_one_or_none()
    if jr is None:
        raise HTTPException(status_code=404, detail="Join request not found")
    if jr.status != RoomJoinRequestStatus.pending:
        raise HTTPException(status_code=409, detail="Request already resolved")

    room_result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = room_result.scalar_one_or_none()
    if room and room.max_members is not None:
        count_result = await db.execute(
            select(func.count(RoomMember.id)).where(RoomMember.room_id == room_id)
        )
        if (count_result.scalar() or 0) >= room.max_members:
            raise HTTPException(status_code=409, detail="Room is full")

    jr.status = RoomJoinRequestStatus.accepted
    jr.responded_by = viewer_id
    jr.resolved_at = func.now()

    new_member = RoomMember(
        room_id=room_id,
        agent_id=jr.agent_id,
        participant_type=jr.participant_type,
        role=RoomRole.member,
    )
    db.add(new_member)
    await db.commit()

    return {
        "request_id": request_id,
        "room_id": room_id,
        "agent_id": jr.agent_id,
        "participant_type": (
            jr.participant_type.value
            if hasattr(jr.participant_type, "value")
            else str(jr.participant_type)
        ),
        "status": "accepted",
    }


@router.post("/rooms/{room_id}/join-requests/{request_id}/reject", status_code=200)
async def reject_join_request(
    room_id: str,
    request_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Reject a join request. Owner/admin only (Agent or Human)."""
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    member_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == viewer_id,
            RoomMember.participant_type == viewer_type,
        )
    )
    member = member_result.scalar_one_or_none()
    if member is None or member.role not in (RoomRole.owner, RoomRole.admin):
        raise HTTPException(status_code=403, detail="Owner or admin required")

    jr_result = await db.execute(
        select(RoomJoinRequest).where(
            RoomJoinRequest.request_id == request_id,
            RoomJoinRequest.room_id == room_id,
        )
    )
    jr = jr_result.scalar_one_or_none()
    if jr is None:
        raise HTTPException(status_code=404, detail="Join request not found")
    if jr.status != RoomJoinRequestStatus.pending:
        raise HTTPException(status_code=409, detail="Request already resolved")

    jr.status = RoomJoinRequestStatus.rejected
    jr.responded_by = viewer_id
    jr.resolved_at = func.now()
    await db.commit()

    return {
        "request_id": request_id,
        "room_id": room_id,
        "agent_id": jr.agent_id,
        "participant_type": (
            jr.participant_type.value
            if hasattr(jr.participant_type, "value")
            else str(jr.participant_type)
        ),
        "status": "rejected",
    }


@router.get("/rooms/{room_id}/my-join-request")
async def get_my_join_request(
    room_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Check if the current viewer (Agent or Human) has a recent join request."""
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    result = await db.execute(
        select(RoomJoinRequest).where(
            RoomJoinRequest.room_id == room_id,
            RoomJoinRequest.agent_id == viewer_id,
            RoomJoinRequest.participant_type == viewer_type,
        ).order_by(RoomJoinRequest.created_at.desc()).limit(1)
    )
    jr = result.scalar_one_or_none()
    if jr is None:
        return {"has_request": False, "request": None}
    return {
        "has_request": True,
        "request": {
            "request_id": jr.request_id,
            "status": jr.status.value if hasattr(jr.status, "value") else str(jr.status),
            "created_at": jr.created_at.isoformat() if jr.created_at else None,
        },
    }


# ---------------------------------------------------------------------------
# Mark room as read
# ---------------------------------------------------------------------------


@router.post("/rooms/{room_id}/read")
async def mark_room_read(
    room_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Update last_viewed_at for the current viewer (Agent or Human)."""
    if ctx.active_agent_id is not None:
        viewer_id = ctx.active_agent_id
        viewer_type = ParticipantType.agent
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        viewer_id = ctx.human_id
        viewer_type = ParticipantType.human

    result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == viewer_id,
            RoomMember.participant_type == viewer_type,
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=403, detail="Not a member of this room")

    member.last_viewed_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    await db.refresh(member)

    return {
        "room_id": room_id,
        "last_viewed_at": member.last_viewed_at.isoformat() if member.last_viewed_at else None,
    }


# ---------------------------------------------------------------------------
# Room messages
# ---------------------------------------------------------------------------


@router.get("/rooms/{room_id}/messages")
async def get_room_messages(
    room_id: str,
    before: str | None = Query(default=None),
    after: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    authorization: str | None = Header(default=None),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
):
    """Get room messages. Supports both authenticated (member) and public views."""
    from app.auth import _decode_supabase_token, _load_user_and_roles

    # Resolve room
    room_result = await db.execute(
        select(Room).where(Room.room_id == room_id)
    )
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    is_member = False
    viewer_agent_id = None
    viewer_user_id: str | None = None
    viewer_human_id: str | None = None

    # Try to resolve authenticated user. Two viewer anchors are supported:
    #   1. X-Active-Agent header → active Agent (verify ownership + membership)
    #   2. user.human_id → Human viewer (membership row stores ``hu_*``)
    # Main's post-merge shape checks agent anchor first, then falls through to
    # human anchor so a Human who happens to be a member of a room also sees
    # it even when an X-Active-Agent header is present but unrelated.
    if authorization and authorization.startswith("Bearer "):
        token = authorization[len("Bearer "):]
        try:
            jwt_payload = _decode_supabase_token(token)
            supabase_uid = jwt_payload["sub"]
            user, _roles = await _load_user_and_roles(supabase_uid, db, jwt_payload=jwt_payload)
            viewer_user_id = str(user.id)
            viewer_human_id = user.human_id

            # Agent-anchored membership (acting as agent)
            if x_active_agent:
                agent_check = await db.execute(
                    select(Agent).where(
                        Agent.agent_id == x_active_agent,
                        Agent.user_id == user.id,
                    )
                )
                if agent_check.scalar_one_or_none() is not None:
                    member_result = await db.execute(
                        select(RoomMember).where(
                            RoomMember.room_id == room_id,
                            RoomMember.agent_id == x_active_agent,
                        )
                    )
                    if member_result.scalar_one_or_none() is not None:
                        is_member = True
                        viewer_agent_id = x_active_agent

            # Human-anchored membership (acting as human / no active agent)
            if not is_member and user.human_id:
                human_member_result = await db.execute(
                    select(RoomMember).where(
                        RoomMember.room_id == room_id,
                        RoomMember.agent_id == user.human_id,
                        RoomMember.participant_type == ParticipantType.human,
                    )
                )
                if human_member_result.scalar_one_or_none() is not None:
                    is_member = True

            # Owner-chat rooms intentionally only store the agent as a member.
            # Let the owning user read history even when they are not currently
            # acting as that agent.
            if not is_member and room_id.startswith("rm_oc_") and room.owner_id:
                owner_agent_result = await db.execute(
                    select(Agent).where(
                        Agent.agent_id == room.owner_id,
                        Agent.user_id == user.id,
                    )
                )
                if owner_agent_result.scalar_one_or_none() is not None:
                    is_member = True
                    viewer_agent_id = room.owner_id
        except HTTPException:
            pass  # Invalid token — fall through to public view

    if not is_member:
        if room.visibility != RoomVisibility.public:
            raise HTTPException(status_code=403, detail="Room is not public")

    # Deduplicated message query
    dedup_sub = (
        select(
            MessageRecord.msg_id,
            func.min(MessageRecord.id).label("min_id"),
        )
        .where(MessageRecord.room_id == room_id)
        .group_by(MessageRecord.msg_id)
        .subquery()
    )

    stmt = (
        select(MessageRecord)
        .where(MessageRecord.id.in_(select(dedup_sub.c.min_id)))
    )

    if before is not None:
        cursor_result = await db.execute(
            select(MessageRecord.id).where(
                MessageRecord.hub_msg_id == before,
                MessageRecord.room_id == room_id,
                MessageRecord.id.in_(select(dedup_sub.c.min_id)),
            )
        )
        cursor_id = cursor_result.scalar_one_or_none()
        if cursor_id is None:
            raise HTTPException(status_code=400, detail="Invalid cursor")
        stmt = stmt.where(MessageRecord.id < cursor_id)
    if after is not None:
        cursor_result = await db.execute(
            select(MessageRecord.id).where(
                MessageRecord.hub_msg_id == after,
                MessageRecord.room_id == room_id,
                MessageRecord.id.in_(select(dedup_sub.c.min_id)),
            )
        )
        cursor_id = cursor_result.scalar_one_or_none()
        if cursor_id is None:
            raise HTTPException(status_code=400, detail="Invalid cursor")
        stmt = stmt.where(MessageRecord.id > cursor_id)

    stmt = stmt.order_by(MessageRecord.id.desc()).limit(limit + 1)

    result = await db.execute(stmt)
    records = result.scalars().all()

    has_more = len(records) > limit
    records = records[:limit]

    # Resolve sender names
    sender_names = await load_agent_display_names(db, {r.sender_id for r in records})

    # Resolve topic info
    topic_ids = {r.topic_id for r in records if r.topic_id}
    topic_info: dict[str, dict] = {}
    if topic_ids:
        topic_result = await db.execute(
            select(Topic).where(Topic.topic_id.in_(topic_ids))
        )
        for t in topic_result.scalars().all():
            topic_info[t.topic_id] = {"title": t.title}

    # Resolve human sender user display names (human-room + owner-chat rows)
    human_user_ids = {
        r.source_user_id for r in records
        if (r.source_type or "") in ("dashboard_human_room", "dashboard_user_chat")
        and r.source_user_id
    }
    user_name_map = await load_user_display_names(db, human_user_ids)

    # Owner-chat rooms (rm_oc_*) are always viewed as the human owner — both
    # user-typed messages and the agent's replies share sender_id=agent_id, so
    # anchoring the viewer to the agent would mark every message as "mine".
    if room_id.startswith("rm_oc_"):
        viewer_agent_id = None

    messages = []
    for rec in records:
        parsed = extract_text_from_envelope(rec.envelope_json)
        extra = derive_sender_fields(
            rec,
            agent_name_map=sender_names,
            user_name_map=user_name_map,
            viewer_agent_id=viewer_agent_id,
            viewer_user_id=viewer_user_id,
        )
        msg = {
            "hub_msg_id": rec.hub_msg_id,
            "msg_id": rec.msg_id,
            "sender_id": rec.sender_id,
            "sender_name": sender_names.get(rec.sender_id),
            "text": parsed["text"],
            "type": parsed["type"],
            "payload": parsed["payload"],
            "topic": rec.topic,
            "topic_id": rec.topic_id,
            "topic_title": topic_info.get(rec.topic_id, {}).get("title") if rec.topic_id else None,
            "created_at": rec.created_at.isoformat() if rec.created_at else None,
            "source_type": rec.source_type,
            **extra,
        }
        if is_member:
            msg["mentioned"] = rec.mentioned
        messages.append(msg)

    return {"messages": messages, "has_more": has_more}


# ---------------------------------------------------------------------------
# Human-in-chat: POST /api/dashboard/rooms/{room_id}/send
# text is required; mentions/topic are accepted but deferred (persisted text only).
# ---------------------------------------------------------------------------


class HumanRoomSendBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)
    mentions: list[str] | None = None
    topic: str | None = None


@router.post("/rooms/{room_id}/send", status_code=202)
async def human_room_send(
    room_id: str,
    body: HumanRoomSendBody,
    request: Request,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Send a message to a room on behalf of the authenticated human user.

    Dual-mode sender identity:
      * ``X-Active-Agent`` supplied → the active Agent is the admission anchor
        (legacy PRD §6 flow).
      * No active agent → the authenticated User's ``human_id`` (hu_*) is the
        sender; the User must be a RoomMember with ``participant_type=human``.

    The message is persisted as ``source_type='dashboard_human_room'`` and
    fanned out to all room members (including the sender — see PRD §6.3).
    """
    active_agent_id = ctx.active_agent_id
    sender_id: str

    if active_agent_id is not None:
        # Agent-anchored path: verify agent is claimed by this user.
        agent_row = await db.execute(
            select(Agent).where(Agent.agent_id == active_agent_id)
        )
        agent = agent_row.scalar_one_or_none()
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        if getattr(agent, "claimed_at", None) is None:
            raise HTTPException(status_code=403, detail="Agent not claimed")
        sender_id = active_agent_id
    else:
        # Human-anchored path: resolve the authenticated user's human_id.
        # rm_oc_ (owner-chat) rooms are Agent-only by design.
        if room_id.startswith("rm_oc_"):
            raise HTTPException(status_code=400, detail="X-Active-Agent header is required")
        user_row = await db.execute(
            select(User).where(User.id == ctx.user_id)
        )
        user = user_row.scalar_one_or_none()
        if user is None or not user.human_id:
            raise HTTPException(status_code=404, detail="Human identity not found")
        sender_id = user.human_id

    # Room exists (PRD §6.2 step 4)
    room_result = await db.execute(
        select(Room).where(Room.room_id == room_id)
    )
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # Sender is a RoomMember (step 5). Match participant_type so that a Human
    # and an Agent sharing the same string prefix cannot be confused.
    expected_participant_type = (
        ParticipantType.agent if active_agent_id is not None else ParticipantType.human
    )
    member_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == sender_id,
            RoomMember.participant_type == expected_participant_type,
        )
    )
    active_member = member_result.scalar_one_or_none()
    if active_member is None:
        raise HTTPException(status_code=403, detail="Sender is not a room member")

    # Room-level human send gate (step 5.5)
    if not room.allow_human_send:
        raise HTTPException(status_code=403, detail="Human send disabled for this room")

    # _can_send (step 6)
    if not _room_can_send(room, active_member):
        raise HTTPException(status_code=403, detail="Sender cannot send in this room")

    # Slow mode + duplicate content (step 7) keyed by (room_id, sender_id)
    payload_for_checks = {"text": body.text}
    try:
        _check_slow_mode(room, active_member)
        _check_duplicate_content(room_id, sender_id, payload_for_checks)
    except HTTPException:
        raise
    _record_slow_mode_send(room_id, sender_id)

    # Normalize mentions. Owner-chat rooms (rm_oc_) ignore mentions entirely.
    # Human sends may only mention specific agent_ids — "@all" is not allowed
    # here; any non-"ag_" string is dropped. Cap at 20 to avoid abuse.
    raw_mentions = body.mentions or []
    if room_id.startswith("rm_oc_"):
        raw_mentions = []
    if len(raw_mentions) > 20:
        raise HTTPException(status_code=400, detail="Too many mentions (max 20)")
    normalized_mentions: list[str] = []
    seen_mentions: set[str] = set()
    for m in raw_mentions:
        if not isinstance(m, str) or not m.startswith("ag_") or m in seen_mentions:
            continue
        seen_mentions.add(m)
        normalized_mentions.append(m)

    # Load all room members
    members_result = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id)
    )
    all_members = list(members_result.scalars().all())

    # Drop mentions that aren't actually room members
    member_ids = {m.agent_id for m in all_members}
    normalized_mentions = [m for m in normalized_mentions if m in member_ids]
    mentioned_set: set[str] = set(normalized_mentions)

    # Block check anchored on sender_id
    blocked_by: set[str] = set()
    if member_ids:
        block_result = await db.execute(
            select(Block.owner_id).where(
                Block.owner_id.in_(member_ids),
                Block.blocked_agent_id == sender_id,
            )
        )
        blocked_by = {row[0] for row in block_result.all()}

    # When the sender is a Human (no active agent), filter out agent members
    # whose `allow_human_sender=False` opted out of human-originated traffic.
    human_blocked_agents: set[str] = set()
    if active_agent_id is None and member_ids:
        agent_member_ids = [
            m.agent_id for m in all_members
            if m.participant_type == ParticipantType.agent
        ]
        if agent_member_ids:
            from hub.models import Agent as _AgentModel  # local to avoid cycles
            opt_out_rows = await db.execute(
                select(_AgentModel.agent_id).where(
                    _AgentModel.agent_id.in_(agent_member_ids),
                    _AgentModel.allow_human_sender.is_(False),
                )
            )
            human_blocked_agents = {row[0] for row in opt_out_rows.all()}

    # Fan-out targets: all members minus muted minus blockers. Sender is
    # INCLUDED (PRD §6.3) — only skipped if they themselves are muted or
    # happen to block themselves (shouldn't happen).
    receivers = [
        m for m in all_members
        if not m.muted
        and m.agent_id not in blocked_by
        and m.agent_id not in human_blocked_agents
    ]
    receiver_ids = [m.agent_id for m in receivers]

    msg_id = str(_uuid.uuid4())
    ts = int(_time.time())
    payload: dict = {"text": body.text}
    envelope_data = {
        "v": "a2a/0.1",
        "msg_id": msg_id,
        "ts": ts,
        "from": sender_id,
        "to": room_id,
        "type": "message",
        "reply_to": None,
        "ttl_sec": 3600,
        "payload": payload,
        "payload_hash": "",
        "sig": {"alg": "ed25519", "key_id": "dashboard-human", "value": ""},
        "mentions": normalized_mentions or None,
    }
    envelope_json = json.dumps(envelope_data)

    source_user_id_str = str(ctx.user_id)
    first_hub_msg_id: str | None = None
    receiver_hub_msg_ids: dict[str, str] = {}
    for receiver_id in receiver_ids:
        hub_msg_id = generate_hub_msg_id()
        if first_hub_msg_id is None:
            first_hub_msg_id = hub_msg_id
        receiver_hub_msg_ids[receiver_id] = hub_msg_id
        record = MessageRecord(
            hub_msg_id=hub_msg_id,
            msg_id=msg_id,
            sender_id=sender_id,
            receiver_id=receiver_id,
            room_id=room_id,
            state=MessageState.queued,
            envelope_json=envelope_json,
            ttl_sec=3600,
            mentioned=receiver_id in mentioned_set,
            source_type="dashboard_human_room",
            source_user_id=source_user_id_str,
            source_session_kind="room_human",
            source_ip=request.client.host if request.client else None,
            source_user_agent=(request.headers.get("user-agent") or "")[:256] or None,
        )
        try:
            async with db.begin_nested():
                db.add(record)
                await db.flush()
        except IntegrityError:
            existing_res = await db.execute(
                select(MessageRecord).where(
                    MessageRecord.msg_id == msg_id,
                    MessageRecord.receiver_id == receiver_id,
                )
            )
            existing = existing_res.scalar_one()
            receiver_hub_msg_ids[receiver_id] = existing.hub_msg_id
            if first_hub_msg_id is None:
                first_hub_msg_id = existing.hub_msg_id

    await db.commit()

    # Fetch user display name for realtime event
    user_row = await db.execute(
        select(User.display_name).where(User.id == ctx.user_id)
    )
    user_display_name = user_row.scalar_one_or_none() or "User"

    for receiver_id in receiver_ids:
        try:
            rt_event = build_message_realtime_event(
                type="message",
                agent_id=receiver_id,
                sender_id=sender_id,
                room_id=room_id,
                hub_msg_id=receiver_hub_msg_ids.get(receiver_id, first_hub_msg_id),
                payload=payload,
                sender_name=user_display_name,
                source_type="dashboard_human_room",
                source_user_id=source_user_id_str,
                source_user_name=user_display_name,
            )
            await notify_inbox(receiver_id, db=db, realtime_event=rt_event)
        except Exception as exc:
            _logger.error(
                "Human room fan-out notify failed receiver=%s room=%s err=%s",
                receiver_id, room_id, exc, exc_info=True,
            )

    return {
        "hub_msg_id": first_hub_msg_id,
        "room_id": room_id,
        "status": "queued",
    }


# ---------------------------------------------------------------------------
# Room members (authenticated — works for any room the user has access to)
# ---------------------------------------------------------------------------


@router.get("/rooms/{room_id}/members")
async def get_room_members(
    room_id: str,
    authorization: str | None = Header(default=None),
    x_active_agent: str | None = Header(default=None, alias="X-Active-Agent"),
    db: AsyncSession = Depends(get_db),
):
    """Get room members. Authenticated members can see any room they belong to;
    unauthenticated requests fall back to public-only."""
    from app.auth import _decode_supabase_token, _load_user_and_roles

    room_result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    is_member = False
    if authorization and authorization.startswith("Bearer "):
        token = authorization[len("Bearer "):]
        try:
            jwt_payload = _decode_supabase_token(token)
            supabase_uid = jwt_payload["sub"]
            user, _ = await _load_user_and_roles(supabase_uid, db, jwt_payload=jwt_payload)

            if x_active_agent:
                agent_result = await db.execute(
                    select(Agent).where(Agent.agent_id == x_active_agent)
                )
                agent = agent_result.scalar_one_or_none()
                if agent and str(agent.user_id) == str(user.id):
                    mem = await db.execute(
                        select(RoomMember).where(
                            RoomMember.room_id == room_id,
                            RoomMember.agent_id == x_active_agent,
                            RoomMember.participant_type == ParticipantType.agent,
                        )
                    )
                    if mem.scalar_one_or_none() is not None:
                        is_member = True
            else:
                # Human viewer: membership row stores ``hu_*``.
                mem = await db.execute(
                    select(RoomMember).where(
                        RoomMember.room_id == room_id,
                        RoomMember.agent_id == user.human_id,
                        RoomMember.participant_type == ParticipantType.human,
                    )
                )
                if mem.scalar_one_or_none() is not None:
                    is_member = True
        except Exception:
            pass

    if not is_member and room.visibility != RoomVisibility.public:
        raise HTTPException(status_code=404, detail="Room not found")

    # Left-join against both ``agents`` and ``users`` so Human members expose a
    # resolvable display_name. ``Agent``/``User`` are joined on the polymorphic
    # ``RoomMember.agent_id`` column (ag_* or hu_*) — exactly one side matches
    # per row, so coalesce picks whichever is non-null.
    result = await db.execute(
        select(RoomMember, Agent, User)
        .outerjoin(Agent, Agent.agent_id == RoomMember.agent_id)
        .outerjoin(User, User.human_id == RoomMember.agent_id)
        .where(RoomMember.room_id == room_id)
    )
    rows = result.all()

    members = []
    for m, a, u in rows:
        ptype = (
            m.participant_type.value
            if hasattr(m.participant_type, "value")
            else str(m.participant_type)
        )
        display_name = (a.display_name if a else None) or (u.display_name if u else None) or m.agent_id
        members.append({
            "agent_id": m.agent_id,
            "participant_type": ptype,
            "display_name": display_name,
            "bio": a.bio if a else None,
            "message_policy": (
                (a.message_policy.value if hasattr(a.message_policy, "value") else str(a.message_policy))
                if a else None
            ),
            "created_at": (a.created_at.isoformat() if a and a.created_at else None),
            "role": m.role.value if hasattr(m.role, "value") else str(m.role),
            "muted": bool(m.muted),
            # ``None`` == use room default; explicit bool == per-member override.
            # The frontend permissions dialog prefills from these, so "Save"
            # with no edits keeps the existing state instead of wiping it.
            "can_send": m.can_send,
            "can_invite": m.can_invite,
            "joined_at": m.joined_at.isoformat() if m.joined_at else None,
        })
    return {"room_id": room_id, "members": members, "total": len(members)}


# ---------------------------------------------------------------------------
# Share
# ---------------------------------------------------------------------------


@router.post("/rooms/{room_id}/share")
async def create_share(
    room_id: str,
    body: CreateShareBody | None = None,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Create a share link for a room's messages."""
    agent_id = ctx.active_agent_id

    # Verify membership
    mem_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == agent_id,
        )
    )
    if mem_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=403, detail="Not a member of this room")

    # Get room
    room_result = await db.execute(
        select(Room).where(Room.room_id == room_id)
    )
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # Get agent display name
    agent_result = await db.execute(
        select(Agent.display_name).where(Agent.agent_id == agent_id)
    )
    agent_name = agent_result.scalar() or agent_id

    share_id = f"sh_{_uuid.uuid4().hex[:24]}"

    expires_at = None
    if body and body.expires_in_hours:
        expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=body.expires_in_hours)

    # Fetch latest 200 messages (deduplicated)
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

    # Resolve sender names for messages (human-aware)
    sender_map = await load_agent_display_names(db, {r.sender_id for r in records})
    share_human_user_ids = {
        r.source_user_id for r in records
        if (r.source_type or "") == "dashboard_human_room" and r.source_user_id
    }
    share_user_name_map = await load_user_display_names(db, share_human_user_ids)

    share = Share(
        share_id=share_id,
        room_id=room_id,
        shared_by_agent_id=agent_id,
        shared_by_name=agent_name,
        expires_at=expires_at,
    )
    db.add(share)
    await db.flush()

    for rec in records:
        parsed = extract_text_from_envelope(rec.envelope_json)
        if (rec.source_type or "") == "dashboard_human_room":
            _snap_sender_name = (
                share_user_name_map.get(rec.source_user_id) if rec.source_user_id else None
            ) or "User"
        else:
            _snap_sender_name = sender_map.get(rec.sender_id, rec.sender_id)
        sm = ShareMessage(
            share_id=share_id,
            hub_msg_id=rec.hub_msg_id,
            msg_id=rec.msg_id,
            sender_id=rec.sender_id,
            sender_name=_snap_sender_name,
            type=parsed["type"] or "message",
            text=parsed["text"] or "",
            payload_json=json.dumps(parsed["payload"]),
            created_at=rec.created_at or datetime.datetime.now(datetime.timezone.utc),
        )
        db.add(sm)

    await db.commit()

    return share_create_payload(
        share_id=share_id,
        room=room,
        created_at=share.created_at.isoformat() if share.created_at else datetime.datetime.now(datetime.timezone.utc).isoformat(),
        expires_at=expires_at.isoformat() if expires_at else None,
    )


# ---------------------------------------------------------------------------
# Inbox — polls queued messages, supports long-polling via timeout param
# ---------------------------------------------------------------------------


async def _fetch_inbox(
    db: AsyncSession, agent_id: str, limit: int, room_id: str | None = None,
) -> list[MessageRecord]:
    """Return up to *limit* queued messages for *agent_id*, oldest first."""
    from hub.models import MessageState

    stmt = (
        select(MessageRecord)
        .where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.state == MessageState.queued,
        )
        .order_by(MessageRecord.created_at.asc())
        .limit(limit)
    )
    if room_id is not None:
        stmt = stmt.where(MessageRecord.room_id == room_id)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/inbox")
async def get_inbox(
    limit: int = Query(default=10, ge=1, le=50),
    timeout: int = Query(default=0, ge=0, le=30),
    ack: bool = Query(default=True),
    room_id: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Poll for queued messages for the current viewer (Agent or Human).

    Supports long-polling: when *timeout* > 0 and no messages are available,
    blocks until a message arrives or the timeout elapses — reusing the hub's
    shared ``_inbox_conditions`` so that ``notify_inbox()`` wakes us up.
    """
    import asyncio
    from hub.models import MessageState
    from hub.routers.hub import _inbox_conditions

    if ctx.active_agent_id is not None:
        receiver_id = ctx.active_agent_id
    else:
        if not ctx.human_id:
            raise HTTPException(status_code=500, detail="Missing human_id for viewer")
        receiver_id = ctx.human_id

    records = await _fetch_inbox(db, receiver_id, limit + 1, room_id)

    # Long-poll: if nothing found and timeout > 0, wait for notification
    if not records and timeout > 0:
        cond = _inbox_conditions.get(receiver_id)
        if cond is None:
            cond = asyncio.Condition()
            _inbox_conditions[receiver_id] = cond
        try:
            async with cond:
                await asyncio.wait_for(cond.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
        _inbox_conditions.pop(receiver_id, None)
        # Re-query after wakeup / timeout
        records = await _fetch_inbox(db, receiver_id, limit + 1, room_id)

    has_more = len(records) > limit
    records = records[:limit]

    messages = []
    for rec in records:
        try:
            envelope = json.loads(rec.envelope_json) if rec.envelope_json else {}
        except (json.JSONDecodeError, TypeError):
            envelope = {}

        messages.append({
            "hub_msg_id": rec.hub_msg_id,
            "envelope": envelope,
            "room_id": rec.room_id,
            "topic": rec.topic,
            "topic_id": rec.topic_id,
        })

    # Mark as delivered if ack=True
    if ack and records:
        record_ids = [r.id for r in records]
        from sqlalchemy import update as sa_update
        await db.execute(
            sa_update(MessageRecord)
            .where(MessageRecord.id.in_(record_ids))
            .values(state=MessageState.delivered)
        )
        await db.commit()

    return {
        "messages": messages,
        "count": len(messages),
        "has_more": has_more,
    }


# ---------------------------------------------------------------------------
# Owner-agent chat
# ---------------------------------------------------------------------------


from hub.validators import normalize_file_url


class ChatAttachment(BaseModel):
    filename: str = Field(..., max_length=200)
    url: str = Field(..., max_length=500)
    content_type: str | None = None
    size_bytes: int | None = None


class ChatSendBody(BaseModel):
    text: str = ""
    agent_id: str | None = Field(default=None, max_length=64)
    attachments: list[ChatAttachment] | None = Field(default=None, max_length=10)


async def _resolve_owner_chat_agent(
    db: AsyncSession,
    ctx: RequestContext,
    requested_agent_id: str | None,
) -> tuple[str, str]:
    agent_id = (requested_agent_id or ctx.active_agent_id or "").strip()
    if not agent_id:
        raise HTTPException(status_code=400, detail="agent_id is required")

    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None or agent.claimed_at is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if str(agent.user_id) != str(ctx.user_id):
        raise HTTPException(status_code=403, detail="Agent not owned by user")
    return agent_id, (agent.display_name or agent_id)


@router.get("/chat/room")
async def get_chat_room(
    agent_id: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return (or create) the owner-agent chat room for the authenticated user."""
    from hub.routers.dashboard_chat import _ensure_owner_chat_room

    chat_agent_id, display_name = await _resolve_owner_chat_agent(db, ctx, agent_id)

    room_id = await _ensure_owner_chat_room(db, str(ctx.user_id), chat_agent_id, display_name)
    await db.commit()

    return {"room_id": room_id, "name": f"Chat with {display_name}", "agent_id": chat_agent_id}


# Allowed MIME type prefixes (mirrors hub/routers/files.py)
_ALLOWED_MIME_PREFIXES = (
    "text/", "image/", "audio/", "video/",
    "application/pdf", "application/json", "application/xml",
    "application/zip", "application/gzip", "application/octet-stream",
)


@router.post("/upload")
async def dashboard_upload_file(
    file: UploadFile,
    agent_id: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Upload a file via dashboard auth. Reuses hub file storage."""
    from hub import config as hub_config
    from hub.id_generators import generate_file_id
    from hub.models import FileRecord
    from hub.storage import store_file

    content_type = file.content_type or "application/octet-stream"
    if not any(content_type.lower().startswith(p) for p in _ALLOWED_MIME_PREFIXES):
        raise HTTPException(status_code=400, detail=f"MIME type not allowed: {content_type}")

    buf = bytearray()
    while True:
        chunk = await file.read(64 * 1024)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > hub_config.FILE_MAX_SIZE_BYTES:
            raise HTTPException(status_code=413, detail="File too large")

    if len(buf) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    uploader_agent_id, _display_name = await _resolve_owner_chat_agent(db, ctx, agent_id)

    raw_name = file.filename or "upload"
    original_filename = os.path.basename(raw_name).strip()[:200] or "upload"
    data = bytes(buf)
    file_id = generate_file_id()
    now = datetime.datetime.now(datetime.timezone.utc)
    expires_at = now + datetime.timedelta(hours=hub_config.FILE_TTL_HOURS)
    location = await store_file(
        file_id=file_id,
        original_filename=original_filename,
        content_type=content_type,
        data=data,
    )
    record = FileRecord(
        file_id=file_id,
        uploader_id=uploader_agent_id,
        original_filename=original_filename,
        content_type=content_type,
        size_bytes=len(data),
        storage_backend=location.storage_backend,
        disk_path=location.disk_path,
        storage_bucket=location.storage_bucket,
        storage_object_key=location.storage_object_key,
        expires_at=expires_at,
    )
    db.add(record)
    await db.commit()

    return {
        "file_id": file_id,
        "url": f"{hub_config.HUB_PUBLIC_BASE_URL}/hub/files/{file_id}",
        "original_filename": original_filename,
        "content_type": content_type,
        "size_bytes": len(data),
        "expires_at": expires_at.isoformat(),
    }


@router.post("/chat/send", status_code=202)
async def send_chat_message(
    body: ChatSendBody,
    request: Request,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Send a message from the dashboard user to their own agent.

    Creates a MessageRecord with source_type='dashboard_user_chat' and delivers
    it into the agent's inbox so the plugin can pick it up.
    """
    import time
    import uuid

    from sqlalchemy.exc import IntegrityError

    from hub.id_generators import generate_hub_msg_id
    from hub.routers.dashboard_chat import _ensure_owner_chat_room
    from hub.routers.hub import (
        build_message_realtime_event,
        notify_inbox,
    )

    user_id = str(ctx.user_id)
    agent_id, agent_display_name = await _resolve_owner_chat_agent(db, ctx, body.agent_id)

    text = (body.text or "").strip()
    has_attachments = bool(body.attachments)
    if not text and not has_attachments:
        raise HTTPException(status_code=400, detail="Message must contain text or attachments")

    # Normalize attachment URLs to absolute `HUB_PUBLIC_BASE_URL + /hub/files/f_*`.
    # Accepts either relative `/hub/files/f_*` or any absolute URL whose path
    # matches; everything else is rejected.
    normalized_attachments: list[dict] = []
    if body.attachments:
        for att in body.attachments:
            normalized = normalize_file_url(att.url)
            if normalized is None:
                raise HTTPException(status_code=400, detail=f"Invalid attachment URL: {att.url}")
            dumped = att.model_dump(exclude_none=True)
            dumped["url"] = normalized
            normalized_attachments.append(dumped)

    # Ensure room exists
    room_id = await _ensure_owner_chat_room(db, user_id, agent_id, agent_display_name)

    # Build a synthetic envelope JSON
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    payload: dict = {"text": text}
    if normalized_attachments:
        payload["attachments"] = normalized_attachments
    envelope_data = {
        "v": "a2a/0.1",
        "msg_id": msg_id,
        "ts": ts,
        "from": agent_id,
        "to": agent_id,
        "type": "message",
        "reply_to": None,
        "ttl_sec": 3600,
        "payload": payload,
        "payload_hash": "",
        "sig": {"alg": "ed25519", "key_id": "dashboard", "value": ""},
    }
    envelope_json = json.dumps(envelope_data)

    hub_msg_id = generate_hub_msg_id()
    record = MessageRecord(
        hub_msg_id=hub_msg_id,
        msg_id=msg_id,
        sender_id=agent_id,
        receiver_id=agent_id,
        room_id=room_id,
        state=MessageState.queued,
        envelope_json=envelope_json,
        ttl_sec=3600,
        mentioned=True,
        source_type="dashboard_user_chat",
        source_user_id=user_id,
        source_session_kind="owner_chat",
        source_ip=request.client.host if request.client else None,
        source_user_agent=(request.headers.get("user-agent") or "")[:256] or None,
    )
    try:
        async with db.begin_nested():
            db.add(record)
            await db.flush()
    except IntegrityError:
        raise HTTPException(status_code=409, detail="Duplicate message")

    await db.commit()

    # Notify inbox listeners so the plugin picks up the message
    await notify_inbox(
        agent_id,
        db=db,
        realtime_event=build_message_realtime_event(
            type="message",
            agent_id=agent_id,
            sender_id=agent_id,
            room_id=room_id,
            hub_msg_id=hub_msg_id,
            created_at=record.created_at,
            payload=payload,
            sender_name=agent_display_name,
        ),
    )

    return {"hub_msg_id": hub_msg_id, "room_id": room_id, "status": "queued"}
