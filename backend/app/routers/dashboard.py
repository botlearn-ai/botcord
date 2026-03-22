"""Dashboard overview API route under /api/dashboard."""

import datetime
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_active_agent
from hub.database import get_db
from hub.models import (
    Agent,
    Contact,
    ContactRequest,
    ContactRequestState,
    MessageRecord,
    Room,
    RoomMember,
)

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["app-dashboard"])


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
    text = payload.get("text") or payload.get("body") or payload.get("message") or ""
    if text and not isinstance(text, str):
        text = str(text)
    return sender_id, (text[:200] if text else None)


async def _build_rooms_from_sql(
    agent_id: str,
    db: AsyncSession,
) -> list[dict]:
    """Build room list for dashboard overview.

    Tries to call get_agent_room_previews SQL function (PostgreSQL).
    Falls back to ORM query on failure (e.g. SQLite in tests).
    """
    # Column mapping: SQL function uses room_name/room_description/room_rule/last_sender_id
    # but frontend contract expects name/description/rule (no last_sender_id).
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
            # Coerce member_count to int (SQL returns bigint)
            if "member_count" in item:
                item["member_count"] = int(item["member_count"] or 0)
            mapped.append(item)
        return mapped
    except Exception:
        _logger.debug(
            "get_agent_room_previews unavailable, falling back to ORM query",
            exc_info=True,
        )
        # Rollback the failed statement so subsequent queries succeed
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

    # Member counts
    count_result = await db.execute(
        select(RoomMember.room_id, func.count(RoomMember.id))
        .where(RoomMember.room_id.in_(room_ids))
        .group_by(RoomMember.room_id)
    )
    member_counts = dict(count_result.all())

    # Last message per room (deduplicated)
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

    # Resolve sender names
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


@router.get("/overview")
async def get_overview(
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return dashboard overview for the active agent."""
    agent_id = ctx.active_agent_id

    # Agent profile
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

    # Rooms
    rooms = await _build_rooms_from_sql(agent_id, db)

    # Contacts
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

    # Pending requests
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
