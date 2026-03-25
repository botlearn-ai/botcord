"""Dashboard API routes under /api/dashboard."""

import datetime
import json
import logging
import uuid as _uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_active_agent
from app.helpers import escape_like, extract_text_from_envelope
from hub.database import get_db
from hub.models import (
    Agent,
    Contact,
    ContactRequest,
    ContactRequestState,
    MessageRecord,
    MessageState,
    Room,
    RoomJoinPolicy,
    RoomMember,
    RoomRole,
    RoomVisibility,
    Share,
    ShareMessage,
    Topic,
)

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


def _extract_text_preview(envelope_json: str) -> tuple[str, str | None]:
    """Extract (sender_id, text_preview) from an envelope JSON string."""
    try:
        data = json.loads(envelope_json)
    except (json.JSONDecodeError, TypeError):
        return ("", None)
    sender_id = data.get("from", "")
    payload = data.get("payload", {})
    if not isinstance(payload, dict):
        payload = {}
    text_val = payload.get("text") or payload.get("body") or payload.get("message") or ""
    if text_val and not isinstance(text_val, str):
        text_val = str(text_val)
    return sender_id, (text_val[:200] if text_val else None)


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
    }
    _DROP_COLS = {"last_sender_id"}

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
            mapped.append(item)
        return mapped
    except Exception:
        _logger.debug(
            "get_agent_room_previews unavailable, falling back to ORM query",
            exc_info=True,
        )
        await db.rollback()

    # --- ORM fallback ---
    member_result = await db.execute(
        select(RoomMember.room_id, RoomMember.role)
        .where(RoomMember.agent_id == agent_id)
    )
    memberships = {row[0]: row[1] for row in member_result.all()}
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
    for rec in last_msg_result.scalars().all():
        if rec.room_id:
            last_messages[rec.room_id] = rec

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
            sid, preview = _extract_text_preview(last_rec.envelope_json)
            last_preview = preview
            last_at = last_rec.created_at
            if last_at is not None and last_at.tzinfo is None:
                last_at = last_at.replace(tzinfo=datetime.timezone.utc)
            last_sender = sender_names.get(sid)

        role_val = memberships.get(rid)
        my_role = role_val.value if hasattr(role_val, "value") else str(role_val) if role_val else "member"

        result_rooms.append({
            "room_id": room.room_id,
            "name": room.name,
            "description": room.description,
            "rule": room.rule,
            "required_subscription_product_id": room.required_subscription_product_id,
            "owner_id": room.owner_id,
            "visibility": room.visibility.value if hasattr(room.visibility, "value") else str(room.visibility),
            "member_count": member_counts.get(rid, 0),
            "my_role": my_role,
            "last_message_preview": last_preview,
            "last_message_at": last_at.isoformat() if last_at else None,
            "last_sender_name": last_sender,
        })

    result_rooms.sort(
        key=lambda r: r.get("last_message_at") or "",
        reverse=True,
    )
    return result_rooms


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
    """Discover public rooms the agent is not a member of."""
    agent_id = ctx.active_agent_id

    my_rooms = select(RoomMember.room_id).where(RoomMember.agent_id == agent_id).subquery()

    not_joined = (
        Room.visibility == RoomVisibility.public,
        ~Room.room_id.in_(select(my_rooms.c.room_id)),
    )

    # Total count
    count_result = await db.execute(
        select(func.count()).select_from(Room).where(*not_joined)
    )
    total = count_result.scalar() or 0

    stmt = (
        select(Room, func.count(RoomMember.id).label("member_count"))
        .outerjoin(RoomMember, RoomMember.room_id == Room.room_id)
        .where(*not_joined)
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
    before: int | None = Query(default=None),
    after: int | None = Query(default=None),
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

    # Try to resolve authenticated user and verify agent ownership
    if authorization and authorization.startswith("Bearer ") and x_active_agent:
        token = authorization[len("Bearer "):]
        try:
            jwt_payload = _decode_supabase_token(token)
            supabase_uid = jwt_payload["sub"]
            user, _roles = await _load_user_and_roles(supabase_uid, db, jwt_payload=jwt_payload)
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
        stmt = stmt.where(MessageRecord.id < before)
    if after is not None:
        stmt = stmt.where(MessageRecord.id > after)

    stmt = stmt.order_by(MessageRecord.id.desc()).limit(limit + 1)

    result = await db.execute(stmt)
    records = result.scalars().all()

    has_more = len(records) > limit
    records = records[:limit]

    # Resolve sender names
    sender_ids = {r.sender_id for r in records}
    sender_names: dict[str, str] = {}
    if sender_ids:
        name_result = await db.execute(
            select(Agent.agent_id, Agent.display_name)
            .where(Agent.agent_id.in_(sender_ids))
        )
        sender_names = dict(name_result.all())

    # Resolve topic info
    topic_ids = {r.topic_id for r in records if r.topic_id}
    topic_info: dict[str, dict] = {}
    if topic_ids:
        topic_result = await db.execute(
            select(Topic).where(Topic.topic_id.in_(topic_ids))
        )
        for t in topic_result.scalars().all():
            topic_info[t.topic_id] = {"title": t.title}

    messages = []
    for rec in records:
        parsed = extract_text_from_envelope(rec.envelope_json)
        msg = {
            "msg_id": rec.msg_id,
            "sender_id": rec.sender_id,
            "sender_display_name": sender_names.get(rec.sender_id),
            "text": parsed["text"],
            "type": parsed["type"],
            "topic": rec.topic,
            "topic_id": rec.topic_id,
            "topic_title": topic_info.get(rec.topic_id, {}).get("title") if rec.topic_id else None,
            "created_at": rec.created_at.isoformat() if rec.created_at else None,
        }
        if is_member:
            msg["mentioned"] = rec.mentioned
        messages.append(msg)

    return {"messages": messages, "has_more": has_more}


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

    # Resolve sender names for messages
    sender_ids = {r.sender_id for r in records}
    sender_map: dict[str, str] = {}
    if sender_ids:
        sn_result = await db.execute(
            select(Agent.agent_id, Agent.display_name)
            .where(Agent.agent_id.in_(sender_ids))
        )
        sender_map = dict(sn_result.all())

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
        sm = ShareMessage(
            share_id=share_id,
            hub_msg_id=rec.hub_msg_id,
            msg_id=rec.msg_id,
            sender_id=rec.sender_id,
            sender_name=sender_map.get(rec.sender_id, rec.sender_id),
            type=parsed["type"] or "message",
            text=parsed["text"] or "",
            payload_json=json.dumps(parsed["payload"]),
            created_at=rec.created_at or datetime.datetime.now(datetime.timezone.utc),
        )
        db.add(sm)

    await db.commit()

    return {
        "share_id": share_id,
        "share_url": f"/share/{share_id}",
        "created_at": share.created_at.isoformat() if share.created_at else datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "expires_at": expires_at.isoformat() if expires_at else None,
    }


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


class ChatSendBody(BaseModel):
    text: str


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
        build_agent_realtime_event,
        build_message_realtime_event,
        notify_inbox,
        _publish_agent_realtime_event,
    )

    agent_id = ctx.active_agent_id
    user_id = str(ctx.user_id)

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
    payload = {"text": body.text}
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
        ),
    )

    # Publish a typing indicator so the dashboard shows the agent is processing
    typing_event = build_agent_realtime_event(
        type="typing",
        agent_id=agent_id,
        room_id=room_id,
    )
    await _publish_agent_realtime_event(db, typing_event)

    return {"hub_msg_id": hub_msg_id, "room_id": room_id, "status": "queued"}
