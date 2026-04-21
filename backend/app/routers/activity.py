"""Activity feed API routes under /api/dashboard/activity."""

import datetime
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_active_agent
from hub.database import get_db
from hub.models import (
    Agent,
    MessageRecord,
    Room,
    Topic,
    TopicStatus,
)

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["app-activity"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_OWNER_CHAT_ROOM_PREFIX = "rm_oc_"

# Reusable filter: exclude owner-chat rooms while keeping NULL room_id (direct messages)
_not_owner_chat = or_(
    MessageRecord.room_id.is_(None),
    ~MessageRecord.room_id.startswith(_OWNER_CHAT_ROOM_PREFIX),
)


def _period_start(period: str) -> datetime.datetime:
    now = datetime.datetime.now(datetime.timezone.utc)
    if period == "7d":
        return now - datetime.timedelta(days=7)
    if period == "30d":
        return now - datetime.timedelta(days=30)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _extract_preview(envelope_json: str | None, max_len: int = 60) -> str | None:
    """Extract text preview from message envelope JSON."""
    if not envelope_json:
        return None
    try:
        env = json.loads(envelope_json)
        payload = env.get("payload") or {}
        text = payload.get("text") or payload.get("body") or ""
        if not text and isinstance(payload.get("parts"), list):
            for part in payload["parts"]:
                if isinstance(part, dict) and part.get("type") == "text":
                    text = part.get("text", "")
                    break
        if text and len(text) > max_len:
            text = text[:max_len] + "\u2026"
        return text or None
    except (json.JSONDecodeError, AttributeError):
        return None


# ---------------------------------------------------------------------------
# GET /api/dashboard/activity/stats
# ---------------------------------------------------------------------------


@router.get("/activity/stats")
async def get_activity_stats(
    period: str = Query(default="today", pattern="^(today|7d|30d)$"),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """User-friendly overview statistics."""
    agent_id = ctx.active_agent_id
    start = _period_start(period)

    sent_result = await db.execute(
        select(func.count(distinct(MessageRecord.msg_id))).where(
            MessageRecord.sender_id == agent_id,
            MessageRecord.created_at >= start,
            _not_owner_chat,
        )
    )
    messages_sent = sent_result.scalar() or 0

    received_result = await db.execute(
        select(func.count()).select_from(MessageRecord).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.created_at >= start,
            _not_owner_chat,
        )
    )
    messages_received = received_result.scalar() or 0

    msg_topic_sub = (
        select(distinct(MessageRecord.topic_id))
        .where(
            MessageRecord.topic_id.isnot(None),
            or_(
                MessageRecord.sender_id == agent_id,
                MessageRecord.receiver_id == agent_id,
            ),
        )
        .subquery()
    )
    topic_counts_result = await db.execute(
        select(Topic.status, func.count().label("cnt"))
        .where(
            Topic.updated_at >= start,
            or_(
                Topic.creator_id == agent_id,
                Topic.topic_id.in_(select(msg_topic_sub)),
            ),
        )
        .group_by(Topic.status)
    )
    tc: dict[str, int] = {}
    for row in topic_counts_result.all():
        sv = row[0].value if hasattr(row[0], "value") else str(row[0])
        tc[sv] = row[1]

    active_rooms_result = await db.execute(
        select(func.count(distinct(MessageRecord.room_id))).where(
            MessageRecord.room_id.isnot(None),
            ~MessageRecord.room_id.startswith(_OWNER_CHAT_ROOM_PREFIX),
            MessageRecord.created_at >= start,
            or_(
                MessageRecord.sender_id == agent_id,
                MessageRecord.receiver_id == agent_id,
            ),
        )
    )
    active_rooms = active_rooms_result.scalar() or 0

    return {
        "messages_sent": messages_sent,
        "messages_received": messages_received,
        "topics_open": tc.get("open", 0),
        "topics_completed": tc.get("completed", 0),
        "active_rooms": active_rooms,
    }


# ---------------------------------------------------------------------------
# GET /api/dashboard/activity/feed
# ---------------------------------------------------------------------------


@router.get("/activity/feed")
async def get_activity_feed(
    period: str = Query(default="today", pattern="^(today|7d|30d)$"),
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Unified activity feed — messages grouped per conversation + topic events.

    Implementation note: we run 4 independent queries (sent/recv messages,
    created/closed topics), each capped and sorted, then merge in Python.
    Pagination is approximate — acceptable because conversation-level grouping
    keeps result sets small (typically <100 rows per period).
    """
    agent_id = ctx.active_agent_id
    start = _period_start(period)
    cap = limit + offset + 20

    events: list[dict[str, Any]] = []

    ReceiverAgent = Agent.__table__.alias("receiver_agent")
    SenderAgent = Agent.__table__.alias("sender_agent")

    # --- Sent messages grouped by (receiver, room) ---
    sent_grp = (
        select(
            MessageRecord.receiver_id,
            MessageRecord.room_id,
            func.count().label("msg_count"),
            func.max(MessageRecord.created_at).label("latest_at"),
            func.max(MessageRecord.id).label("latest_id"),
        )
        .where(
            MessageRecord.sender_id == agent_id,
            MessageRecord.created_at >= start,
            _not_owner_chat,
        )
        .group_by(MessageRecord.receiver_id, MessageRecord.room_id)
        .order_by(func.max(MessageRecord.created_at).desc())
        .limit(cap)
        .subquery()
    )
    sent_stmt = (
        select(
            sent_grp.c.receiver_id,
            sent_grp.c.room_id,
            sent_grp.c.msg_count,
            sent_grp.c.latest_at,
            ReceiverAgent.c.display_name.label("other_name"),
            Room.name.label("room_name"),
            MessageRecord.envelope_json,
            MessageRecord.state,
            MessageRecord.last_error,
        )
        .join(MessageRecord, MessageRecord.id == sent_grp.c.latest_id)
        .outerjoin(ReceiverAgent, ReceiverAgent.c.agent_id == sent_grp.c.receiver_id)
        .outerjoin(Room, Room.room_id == sent_grp.c.room_id)
    )
    for row in (await db.execute(sent_stmt)).all():
        state_val = row.state.value if hasattr(row.state, "value") else str(row.state)
        etype = "message_failed" if state_val == "failed" else "message_sent"
        events.append({
            "type": etype,
            "timestamp": row.latest_at.isoformat() if row.latest_at else None,
            "agent_id": row.receiver_id,
            "agent_name": row.other_name,
            "room_id": row.room_id,
            "room_name": row.room_name,
            "preview": _extract_preview(row.envelope_json),
            "count": row.msg_count,
            "meta": {"error": (row.last_error or "delivery failed").split("\n")[0][:120]} if etype == "message_failed" else None,
        })

    # --- Received messages grouped by (sender, room) ---
    recv_grp = (
        select(
            MessageRecord.sender_id,
            MessageRecord.room_id,
            func.count().label("msg_count"),
            func.max(MessageRecord.created_at).label("latest_at"),
            func.max(MessageRecord.id).label("latest_id"),
        )
        .where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.created_at >= start,
            _not_owner_chat,
        )
        .group_by(MessageRecord.sender_id, MessageRecord.room_id)
        .order_by(func.max(MessageRecord.created_at).desc())
        .limit(cap)
        .subquery()
    )
    recv_stmt = (
        select(
            recv_grp.c.sender_id,
            recv_grp.c.room_id,
            recv_grp.c.msg_count,
            recv_grp.c.latest_at,
            SenderAgent.c.display_name.label("other_name"),
            Room.name.label("room_name"),
            MessageRecord.envelope_json,
        )
        .join(MessageRecord, MessageRecord.id == recv_grp.c.latest_id)
        .outerjoin(SenderAgent, SenderAgent.c.agent_id == recv_grp.c.sender_id)
        .outerjoin(Room, Room.room_id == recv_grp.c.room_id)
    )
    for row in (await db.execute(recv_stmt)).all():
        events.append({
            "type": "message_received",
            "timestamp": row.latest_at.isoformat() if row.latest_at else None,
            "agent_id": row.sender_id,
            "agent_name": row.other_name,
            "room_id": row.room_id,
            "room_name": row.room_name,
            "preview": _extract_preview(row.envelope_json),
            "count": row.msg_count,
            "meta": None,
        })

    # --- Topic events ---
    msg_topic_sub = (
        select(distinct(MessageRecord.topic_id))
        .where(
            MessageRecord.topic_id.isnot(None),
            MessageRecord.created_at >= start,
            or_(
                MessageRecord.sender_id == agent_id,
                MessageRecord.receiver_id == agent_id,
            ),
        )
        .subquery()
    )
    CreatorAgent = Agent.__table__.alias("creator_agent")
    topic_base = or_(
        Topic.creator_id == agent_id,
        Topic.topic_id.in_(select(msg_topic_sub)),
    )

    # Created topics
    created_stmt = (
        select(
            Topic.topic_id,
            Topic.title,
            Topic.room_id,
            Room.name.label("room_name"),
            Topic.creator_id,
            CreatorAgent.c.display_name.label("creator_name"),
            Topic.message_count,
            Topic.created_at,
        )
        .outerjoin(Room, Room.room_id == Topic.room_id)
        .outerjoin(CreatorAgent, CreatorAgent.c.agent_id == Topic.creator_id)
        .where(Topic.created_at >= start, topic_base)
        .order_by(Topic.created_at.desc())
        .limit(cap)
    )
    for row in (await db.execute(created_stmt)).all():
        events.append({
            "type": "topic_created",
            "timestamp": row.created_at.isoformat() if row.created_at else None,
            "agent_id": row.creator_id,
            "agent_name": row.creator_name,
            "room_id": row.room_id,
            "room_name": row.room_name,
            "preview": None,
            "count": row.message_count,
            "meta": {"topic_id": row.topic_id, "topic_title": row.title},
        })

    # Closed topics (completed / failed / expired)
    closed_stmt = (
        select(
            Topic.topic_id,
            Topic.title,
            Topic.status,
            Topic.room_id,
            Room.name.label("room_name"),
            Topic.creator_id,
            CreatorAgent.c.display_name.label("creator_name"),
            Topic.message_count,
            Topic.closed_at,
            Topic.updated_at,
        )
        .outerjoin(Room, Room.room_id == Topic.room_id)
        .outerjoin(CreatorAgent, CreatorAgent.c.agent_id == Topic.creator_id)
        .where(
            Topic.status.in_([TopicStatus.completed, TopicStatus.failed, TopicStatus.expired]),
            Topic.updated_at >= start,
            topic_base,
        )
        .order_by(Topic.updated_at.desc())
        .limit(cap)
    )
    for row in (await db.execute(closed_stmt)).all():
        sv = row.status.value if hasattr(row.status, "value") else str(row.status)
        ts = row.closed_at or row.updated_at
        events.append({
            "type": f"topic_{sv}",
            "timestamp": ts.isoformat() if ts else None,
            "agent_id": row.creator_id,
            "agent_name": row.creator_name,
            "room_id": row.room_id,
            "room_name": row.room_name,
            "preview": None,
            "count": row.message_count,
            "meta": {"topic_id": row.topic_id, "topic_title": row.title},
        })

    # Sort by timestamp descending, paginate
    events.sort(key=lambda e: e["timestamp"] or "", reverse=True)
    page = events[offset : offset + limit]
    has_more = len(events) > offset + limit

    return {"items": page, "has_more": has_more}
