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

from app.auth import RequestContext, require_active_agent
from app.helpers import escape_like, extract_text_from_envelope
from hub.database import get_db
from hub.dashboard_message_shaping import (
    derive_sender_fields,
    load_agent_display_names,
    load_user_display_names,
)
from hub.id_generators import generate_hub_msg_id, generate_join_request_id
from hub.models import (
    Agent,
    Block,
    Contact,
    ContactRequest,
    ContactRequestState,
    MessageRecord,
    MessageState,
    Room,
    RoomJoinPolicy,
    RoomJoinRequest,
    RoomJoinRequestStatus,
    RoomMember,
    RoomRole,
    RoomVisibility,
    Share,
    ShareMessage,
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
    to_agent_id: str
    message: str | None = None


class CreateShareBody(BaseModel):
    expires_in_hours: int | None = None


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
            "visibility": room.visibility.value if hasattr(room.visibility, "value") else str(room.visibility),
            "join_policy": room.join_policy.value if hasattr(room.join_policy, "value") else str(room.join_policy),
            "member_count": member_counts.get(rid, 0),
            "my_role": my_role,
            "can_invite": computed_can_invite,
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return dashboard overview for the active agent."""
    agent_id = ctx.active_agent_id

    result = await db.execute(
        select(Agent).where(Agent.agent_id == agent_id)
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

    rooms = await _build_rooms_from_sql(agent_id, db)

    contact_result = await db.execute(
        select(Contact, Agent.display_name)
        .outerjoin(Agent, Agent.agent_id == Contact.contact_agent_id)
        .where(Contact.owner_id == agent_id)
    )
    contacts = [
        {
            "contact_agent_id": c.contact_agent_id,
            "alias": c.alias,
            "display_name": dn or c.contact_agent_id,
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c, dn in contact_result.all()
    ]

    pending_result = await db.execute(
        select(func.count())
        .select_from(ContactRequest)
        .where(
            ContactRequest.to_agent_id == agent_id,
            ContactRequest.state == ContactRequestState.pending,
        )
    )
    pending_count = pending_result.scalar() or 0

    return {
        "agent": agent_data,
        "rooms": rooms,
        "contacts": contacts,
        "pending_requests": pending_count,
    }


# ---------------------------------------------------------------------------
# Contact Requests
# ---------------------------------------------------------------------------


@router.post("/contact-requests", status_code=201)
async def send_contact_request(
    body: SendContactRequestBody,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Send a contact request to another agent."""
    agent_id = ctx.active_agent_id

    if body.to_agent_id == agent_id:
        raise HTTPException(status_code=400, detail="Cannot send request to yourself")

    # Check target agent exists
    target = await db.execute(
        select(Agent).where(Agent.agent_id == body.to_agent_id)
    )
    target_agent = target.scalar_one_or_none()
    if target_agent is None:
        raise HTTPException(status_code=404, detail="Target agent not found")

    # Check not already contacts
    existing_contact = await db.execute(
        select(Contact).where(
            Contact.owner_id == agent_id,
            Contact.contact_agent_id == body.to_agent_id,
        )
    )
    if existing_contact.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Already in contacts")

    # Check existing request
    existing_req = await db.execute(
        select(ContactRequest).where(
            ContactRequest.from_agent_id == agent_id,
            ContactRequest.to_agent_id == body.to_agent_id,
        )
    )
    req = existing_req.scalar_one_or_none()

    if req is not None:
        if req.state in (ContactRequestState.pending, ContactRequestState.accepted):
            raise HTTPException(status_code=409, detail="Contact request already exists")
        # Rejected — allow resend
        req.state = ContactRequestState.pending
        req.message = body.message
        req.resolved_at = None
        await db.commit()
        await db.refresh(req)
    else:
        req = ContactRequest(
            from_agent_id=agent_id,
            to_agent_id=body.to_agent_id,
            state=ContactRequestState.pending,
            message=body.message,
        )
        db.add(req)
        await db.commit()
        await db.refresh(req)

    return {
        "id": req.id,
        "from_agent_id": req.from_agent_id,
        "to_agent_id": req.to_agent_id,
        "state": req.state.value if hasattr(req.state, "value") else str(req.state),
        "message": req.message,
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "resolved_at": req.resolved_at.isoformat() if req.resolved_at else None,
        "from_display_name": None,
        "to_display_name": target_agent.display_name,
    }


@router.get("/contact-requests/received")
async def list_received_requests(
    state: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """List contact requests received by the active agent."""
    agent_id = ctx.active_agent_id

    stmt = (
        select(ContactRequest, Agent.display_name)
        .outerjoin(Agent, Agent.agent_id == ContactRequest.from_agent_id)
        .where(ContactRequest.to_agent_id == agent_id)
    )
    if state:
        stmt = stmt.where(ContactRequest.state == state)

    result = await db.execute(stmt)
    rows = result.all()

    return {
        "requests": [
            {
                "id": cr.id,
                "from_agent_id": cr.from_agent_id,
                "from_display_name": dn,
                "to_agent_id": cr.to_agent_id,
                "to_display_name": None,
                "state": cr.state.value if hasattr(cr.state, "value") else str(cr.state),
                "message": cr.message,
                "created_at": cr.created_at.isoformat() if cr.created_at else None,
                "resolved_at": cr.resolved_at.isoformat() if cr.resolved_at else None,
            }
            for cr, dn in rows
        ],
    }


@router.get("/contact-requests/sent")
async def list_sent_requests(
    state: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """List contact requests sent by the active agent."""
    agent_id = ctx.active_agent_id

    stmt = (
        select(ContactRequest, Agent.display_name)
        .outerjoin(Agent, Agent.agent_id == ContactRequest.to_agent_id)
        .where(ContactRequest.from_agent_id == agent_id)
    )
    if state:
        stmt = stmt.where(ContactRequest.state == state)

    result = await db.execute(stmt)
    rows = result.all()

    return {
        "requests": [
            {
                "id": cr.id,
                "from_agent_id": cr.from_agent_id,
                "from_display_name": None,
                "to_agent_id": cr.to_agent_id,
                "to_display_name": dn,
                "state": cr.state.value if hasattr(cr.state, "value") else str(cr.state),
                "message": cr.message,
                "created_at": cr.created_at.isoformat() if cr.created_at else None,
                "resolved_at": cr.resolved_at.isoformat() if cr.resolved_at else None,
            }
            for cr, dn in rows
        ],
    }


@router.post("/contact-requests/{request_id}/accept")
async def accept_contact_request(
    request_id: int,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Accept a pending contact request."""
    agent_id = ctx.active_agent_id

    result = await db.execute(
        select(ContactRequest).where(ContactRequest.id == request_id)
    )
    req = result.scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="Contact request not found")
    if req.to_agent_id != agent_id:
        raise HTTPException(status_code=403, detail="Not your request to accept")
    if req.state != ContactRequestState.pending:
        raise HTTPException(status_code=409, detail="Request is not pending")

    req.state = ContactRequestState.accepted
    req.resolved_at = datetime.datetime.now(datetime.timezone.utc)

    # Create bidirectional contacts (ignore if already exists)
    for owner, contact_agent in [
        (req.from_agent_id, req.to_agent_id),
        (req.to_agent_id, req.from_agent_id),
    ]:
        existing = await db.execute(
            select(Contact).where(
                Contact.owner_id == owner,
                Contact.contact_agent_id == contact_agent,
            )
        )
        if existing.scalar_one_or_none() is None:
            db.add(Contact(owner_id=owner, contact_agent_id=contact_agent))

    await db.commit()
    await db.refresh(req)

    return {
        "id": req.id,
        "from_agent_id": req.from_agent_id,
        "to_agent_id": req.to_agent_id,
        "state": "accepted",
        "message": req.message,
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "resolved_at": req.resolved_at.isoformat() if req.resolved_at else None,
        "from_display_name": None,
        "to_display_name": None,
    }


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
    if req.to_agent_id != agent_id:
        raise HTTPException(status_code=403, detail="Not your request to reject")
    if req.state != ContactRequestState.pending:
        raise HTTPException(status_code=409, detail="Request is not pending")

    req.state = ContactRequestState.rejected
    req.resolved_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    await db.refresh(req)

    return {
        "id": req.id,
        "from_agent_id": req.from_agent_id,
        "to_agent_id": req.to_agent_id,
        "state": "rejected",
        "message": req.message,
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "resolved_at": req.resolved_at.isoformat() if req.resolved_at else None,
        "from_display_name": None,
        "to_display_name": None,
    }


# ---------------------------------------------------------------------------
# Agent search / details
# ---------------------------------------------------------------------------


@router.get("/agents/search")
async def search_agents(
    q: str = Query(..., min_length=1),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Search agents by agent_id or display_name."""
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
    }


@router.get("/agents/{agent_id}")
async def get_agent_detail(
    agent_id: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Get agent details."""
    result = await db.execute(
        select(Agent).where(Agent.agent_id == agent_id)
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    return {
        "agent_id": agent.agent_id,
        "display_name": agent.display_name,
        "bio": agent.bio,
        "message_policy": agent.message_policy.value if hasattr(agent.message_policy, "value") else str(agent.message_policy),
        "created_at": agent.created_at.isoformat() if agent.created_at else None,
    }


@router.get("/agents/{agent_id}/conversations")
async def get_shared_rooms(
    agent_id: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Get rooms where both the active agent and target agent are members."""
    my_agent_id = ctx.active_agent_id

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
    ctx: RequestContext = Depends(require_active_agent),
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
            }
            for r, mc in rows
        ],
    }


@router.post("/rooms/{room_id}/join", status_code=201)
async def join_room(
    room_id: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Join a public room with open join policy."""
    agent_id = ctx.active_agent_id

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

    # Check max_members
    if room.max_members is not None:
        count_result = await db.execute(
            select(func.count(RoomMember.id)).where(RoomMember.room_id == room_id)
        )
        current_count = count_result.scalar() or 0
        if current_count >= room.max_members:
            raise HTTPException(status_code=409, detail="Room is full")

    # Check not already member
    existing = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == agent_id,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Already a member")

    member = RoomMember(
        room_id=room_id,
        agent_id=agent_id,
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
    }


# ---------------------------------------------------------------------------
# Leave room
# ---------------------------------------------------------------------------


@router.post("/rooms/{room_id}/leave")
async def leave_room(
    room_id: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Leave a room. Owner cannot leave."""
    agent_id = ctx.active_agent_id

    result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == agent_id,
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Submit a join request for an invite-only public room."""
    agent_id = ctx.active_agent_id

    room_result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.visibility != RoomVisibility.public:
        raise HTTPException(status_code=403, detail="Room is not public")
    if room.join_policy != RoomJoinPolicy.invite_only:
        raise HTTPException(status_code=400, detail="Room is open — use the join endpoint instead")

    existing_member = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id, RoomMember.agent_id == agent_id)
    )
    if existing_member.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Already a member")

    existing_pending = await db.execute(
        select(RoomJoinRequest).where(
            RoomJoinRequest.room_id == room_id,
            RoomJoinRequest.agent_id == agent_id,
            RoomJoinRequest.status == RoomJoinRequestStatus.pending,
        )
    )
    if existing_pending.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Join request already pending")

    req = RoomJoinRequest(
        request_id=generate_join_request_id(),
        room_id=room_id,
        agent_id=agent_id,
        message=body.message if body else None,
        status=RoomJoinRequestStatus.pending,
    )
    db.add(req)
    await db.commit()

    return {
        "request_id": req.request_id,
        "room_id": room_id,
        "agent_id": agent_id,
        "status": "pending",
        "message": req.message,
        "created_at": req.created_at.isoformat() if req.created_at else None,
    }


@router.get("/rooms/{room_id}/join-requests")
async def list_join_requests(
    room_id: str,
    status: str | None = Query(default=None),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """List join requests for a room. Owner/admin only."""
    agent_id = ctx.active_agent_id

    member_result = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id, RoomMember.agent_id == agent_id)
    )
    member = member_result.scalar_one_or_none()
    if member is None or member.role not in (RoomRole.owner, RoomRole.admin):
        raise HTTPException(status_code=403, detail="Owner or admin required")

    stmt = (
        select(RoomJoinRequest, Agent.display_name)
        .outerjoin(Agent, Agent.agent_id == RoomJoinRequest.agent_id)
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Accept a join request. Owner/admin only."""
    agent_id = ctx.active_agent_id

    member_result = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id, RoomMember.agent_id == agent_id)
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
    jr.responded_by = agent_id
    jr.resolved_at = func.now()

    new_member = RoomMember(
        room_id=room_id,
        agent_id=jr.agent_id,
        role=RoomRole.member,
    )
    db.add(new_member)
    await db.commit()

    return {
        "request_id": request_id,
        "room_id": room_id,
        "agent_id": jr.agent_id,
        "status": "accepted",
    }


@router.post("/rooms/{room_id}/join-requests/{request_id}/reject", status_code=200)
async def reject_join_request(
    room_id: str,
    request_id: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Reject a join request. Owner/admin only."""
    agent_id = ctx.active_agent_id

    member_result = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id, RoomMember.agent_id == agent_id)
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
    jr.responded_by = agent_id
    jr.resolved_at = func.now()
    await db.commit()

    return {
        "request_id": request_id,
        "room_id": room_id,
        "agent_id": jr.agent_id,
        "status": "rejected",
    }


@router.get("/rooms/{room_id}/my-join-request")
async def get_my_join_request(
    room_id: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Check if the current agent has a pending join request for this room."""
    agent_id = ctx.active_agent_id
    result = await db.execute(
        select(RoomJoinRequest).where(
            RoomJoinRequest.room_id == room_id,
            RoomJoinRequest.agent_id == agent_id,
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Update last_viewed_at for the active agent in this room."""
    agent_id = ctx.active_agent_id

    result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == agent_id,
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

    # Try to resolve authenticated user and verify agent ownership
    if authorization and authorization.startswith("Bearer ") and x_active_agent:
        token = authorization[len("Bearer "):]
        try:
            jwt_payload = _decode_supabase_token(token)
            supabase_uid = jwt_payload["sub"]
            user, _roles = await _load_user_and_roles(supabase_uid, db, jwt_payload=jwt_payload)
            viewer_user_id = str(user.id)
            # Verify agent belongs to authenticated user
            agent_check = await db.execute(
                select(Agent).where(
                    Agent.agent_id == x_active_agent,
                    Agent.user_id == user.id,
                )
            )
            if agent_check.scalar_one_or_none() is not None:
                # Now check room membership
                member_result = await db.execute(
                    select(RoomMember).where(
                        RoomMember.room_id == room_id,
                        RoomMember.agent_id == x_active_agent,
                    )
                )
                if member_result.scalar_one_or_none() is not None:
                    is_member = True
                    viewer_agent_id = x_active_agent
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

    # Resolve human sender user display names (only for human room rows)
    human_user_ids = {
        r.source_user_id for r in records
        if (r.source_type or "") == "dashboard_human_room" and r.source_user_id
    }
    user_name_map = await load_user_display_names(db, human_user_ids)

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
# MVP — see docs/human-room-chat-prd.md §5, §6.
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Send a message to a room on behalf of the authenticated human user.

    Active agent is the admission anchor; the message is persisted as
    source_type='dashboard_human_room' and fanned out to all room members
    (including the active agent themselves — see PRD §6.3).
    """
    active_agent_id = ctx.active_agent_id

    # Verify agent is claimed (PRD §6.2 step 3)
    agent_row = await db.execute(
        select(Agent).where(Agent.agent_id == active_agent_id)
    )
    agent = agent_row.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if getattr(agent, "claimed_at", None) is None:
        raise HTTPException(status_code=403, detail="Agent not claimed")

    # Room exists (PRD §6.2 step 4)
    room_result = await db.execute(
        select(Room).where(Room.room_id == room_id)
    )
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # Active agent is a RoomMember (step 5)
    member_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == active_agent_id,
        )
    )
    active_member = member_result.scalar_one_or_none()
    if active_member is None:
        raise HTTPException(status_code=403, detail="Active agent is not a room member")

    # _can_send (step 6)
    if not _room_can_send(room, active_member):
        raise HTTPException(status_code=403, detail="Active agent cannot send in this room")

    # Slow mode + duplicate content (step 7) keyed by (room_id, active_agent_id)
    payload_for_checks = {"text": body.text}
    try:
        _check_slow_mode(room, active_member)
        _check_duplicate_content(room_id, active_agent_id, payload_for_checks)
    except HTTPException:
        raise
    _record_slow_mode_send(room_id, active_agent_id)

    # Load all room members
    members_result = await db.execute(
        select(RoomMember).where(RoomMember.room_id == room_id)
    )
    all_members = list(members_result.scalars().all())

    # Block check anchored on active_agent_id
    member_ids = {m.agent_id for m in all_members}
    blocked_by: set[str] = set()
    if member_ids:
        block_result = await db.execute(
            select(Block.owner_id).where(
                Block.owner_id.in_(member_ids),
                Block.blocked_agent_id == active_agent_id,
            )
        )
        blocked_by = {row[0] for row in block_result.all()}

    # Fan-out targets: all members minus muted minus blockers.  Active agent
    # is INCLUDED (PRD §6.3) — only skipped if they themselves are muted or
    # happen to block themselves (shouldn't happen).
    receivers = [
        m for m in all_members
        if not m.muted and m.agent_id not in blocked_by
    ]
    receiver_ids = [m.agent_id for m in receivers]

    msg_id = str(_uuid.uuid4())
    ts = int(_time.time())
    payload: dict = {"text": body.text}
    envelope_data = {
        "v": "a2a/0.1",
        "msg_id": msg_id,
        "ts": ts,
        "from": active_agent_id,
        "to": room_id,
        "type": "message",
        "reply_to": None,
        "ttl_sec": 3600,
        "payload": payload,
        "payload_hash": "",
        "sig": {"alg": "ed25519", "key_id": "dashboard-human", "value": ""},
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
            sender_id=active_agent_id,
            receiver_id=receiver_id,
            room_id=room_id,
            state=MessageState.queued,
            envelope_json=envelope_json,
            ttl_sec=3600,
            mentioned=False,
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
                sender_id=active_agent_id,
                room_id=room_id,
                hub_msg_id=receiver_hub_msg_ids.get(receiver_id, first_hub_msg_id),
                payload=payload,
                sender_name=user_display_name,
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
    if authorization and authorization.startswith("Bearer ") and x_active_agent:
        token = authorization[len("Bearer "):]
        try:
            jwt_payload = _decode_supabase_token(token)
            supabase_uid = jwt_payload["sub"]
            user, _ = await _load_user_and_roles(supabase_uid, db, jwt_payload=jwt_payload)
            agent_result = await db.execute(
                select(Agent).where(Agent.agent_id == x_active_agent)
            )
            agent = agent_result.scalar_one_or_none()
            if agent and str(agent.user_id) == str(user.id):
                mem = await db.execute(
                    select(RoomMember).where(
                        RoomMember.room_id == room_id,
                        RoomMember.agent_id == x_active_agent,
                    )
                )
                if mem.scalar_one_or_none() is not None:
                    is_member = True
        except Exception:
            pass

    if not is_member and room.visibility != RoomVisibility.public:
        raise HTTPException(status_code=404, detail="Room not found")

    result = await db.execute(
        select(RoomMember, Agent)
        .outerjoin(Agent, Agent.agent_id == RoomMember.agent_id)
        .where(RoomMember.room_id == room_id)
    )
    rows = result.all()

    members = [
        {
            "agent_id": m.agent_id,
            "display_name": a.display_name if a else m.agent_id,
            "bio": a.bio if a else None,
            "message_policy": (a.message_policy.value if hasattr(a.message_policy, "value") else str(a.message_policy)) if a else None,
            "created_at": a.created_at.isoformat() if a and a.created_at else None,
            "role": m.role.value if hasattr(m.role, "value") else str(m.role),
            "joined_at": m.joined_at.isoformat() if m.joined_at else None,
        }
        for m, a in rows
    ]
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
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Poll for queued messages for the active agent.

    Supports long-polling: when *timeout* > 0 and no messages are available,
    blocks until a message arrives or the timeout elapses — reusing the hub's
    shared ``_inbox_conditions`` so that ``notify_inbox()`` wakes us up.
    """
    import asyncio
    from hub.models import MessageState
    from hub.routers.hub import _inbox_conditions

    agent_id = ctx.active_agent_id

    records = await _fetch_inbox(db, agent_id, limit + 1, room_id)

    # Long-poll: if nothing found and timeout > 0, wait for notification
    if not records and timeout > 0:
        cond = _inbox_conditions.get(agent_id)
        if cond is None:
            cond = asyncio.Condition()
            _inbox_conditions[agent_id] = cond
        try:
            async with cond:
                await asyncio.wait_for(cond.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
        _inbox_conditions.pop(agent_id, None)
        # Re-query after wakeup / timeout
        records = await _fetch_inbox(db, agent_id, limit + 1, room_id)

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
    attachments: list[ChatAttachment] | None = Field(default=None, max_length=10)


@router.get("/chat/room")
async def get_chat_room(
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return (or create) the owner-agent chat room for the authenticated user."""
    from hub.routers.dashboard_chat import _ensure_owner_chat_room

    agent_id = ctx.active_agent_id

    # Fetch agent display name
    result = await db.execute(
        select(Agent.display_name).where(Agent.agent_id == agent_id)
    )
    display_name = result.scalar_one_or_none() or agent_id

    room_id = await _ensure_owner_chat_room(db, str(ctx.user_id), agent_id, display_name)
    await db.commit()

    return {"room_id": room_id, "name": f"Chat with {display_name}", "agent_id": agent_id}


# Allowed MIME type prefixes (mirrors hub/routers/files.py)
_ALLOWED_MIME_PREFIXES = (
    "text/", "image/", "audio/", "video/",
    "application/pdf", "application/json", "application/xml",
    "application/zip", "application/gzip", "application/octet-stream",
)


@router.post("/upload")
async def dashboard_upload_file(
    file: UploadFile,
    ctx: RequestContext = Depends(require_active_agent),
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
        uploader_id=ctx.active_agent_id,
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
    ctx: RequestContext = Depends(require_active_agent),
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

    agent_id = ctx.active_agent_id
    user_id = str(ctx.user_id)

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

    # Fetch agent display name
    agent_result = await db.execute(
        select(Agent.display_name).where(Agent.agent_id == agent_id)
    )
    agent_display_name = agent_result.scalar_one_or_none() or agent_id

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
