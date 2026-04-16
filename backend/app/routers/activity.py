"""Activity / observability API routes under /api/dashboard/activity."""

import datetime
import logging

from fastapi import APIRouter, Depends, Query
from sqlalchemy import distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_active_agent
from hub.database import get_db
from hub.models import (
    Agent,
    MessageRecord,
    MessageState,
    Room,
    Topic,
    TopicStatus,
)

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboard", tags=["app-activity"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _period_start(period: str) -> datetime.datetime:
    """Return the UTC start time for the given period string."""
    now = datetime.datetime.now(datetime.timezone.utc)
    if period == "7d":
        return now - datetime.timedelta(days=7)
    if period == "30d":
        return now - datetime.timedelta(days=30)
    # Default: "today" — start of current UTC day
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


# ---------------------------------------------------------------------------
# 1. GET /api/dashboard/activity/stats
# ---------------------------------------------------------------------------


@router.get("/activity/stats")
async def get_activity_stats(
    period: str = Query(default="today", pattern="^(today|7d|30d)$"),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return overview statistics cards for the active agent."""
    agent_id = ctx.active_agent_id
    start = _period_start(period)

    # --- messages_sent (deduplicated by msg_id) ---
    sent_result = await db.execute(
        select(func.count(distinct(MessageRecord.msg_id))).where(
            MessageRecord.sender_id == agent_id,
            MessageRecord.created_at >= start,
        )
    )
    messages_sent = sent_result.scalar() or 0

    # --- messages_received ---
    received_result = await db.execute(
        select(func.count()).select_from(MessageRecord).where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.created_at >= start,
        )
    )
    messages_received = received_result.scalar() or 0

    # --- topics: find topic_ids where agent participates and updated within period ---
    # Agent participates if they are creator_id OR have sent/received messages with that topic_id.
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
        select(
            Topic.status,
            func.count().label("cnt"),
        )
        .where(
            Topic.updated_at >= start,
            or_(
                Topic.creator_id == agent_id,
                Topic.topic_id.in_(select(msg_topic_sub)),
            ),
        )
        .group_by(Topic.status)
    )
    topic_counts: dict[str, int] = {}
    for row in topic_counts_result.all():
        status_val = row[0].value if hasattr(row[0], "value") else str(row[0])
        topic_counts[status_val] = row[1]

    topics_open = topic_counts.get("open", 0)
    topics_completed = topic_counts.get("completed", 0)
    topics_failed = topic_counts.get("failed", 0)

    # --- delivery_success_rate & failed_messages ---
    # Count by state for messages sent by this agent within the period (deduplicated).
    # We use a subquery to first pick min(id) per msg_id for deduplication.
    dedup_sent = (
        select(
            MessageRecord.msg_id,
            func.min(MessageRecord.id).label("min_id"),
        )
        .where(
            MessageRecord.sender_id == agent_id,
            MessageRecord.created_at >= start,
        )
        .group_by(MessageRecord.msg_id)
        .subquery()
    )

    state_counts_result = await db.execute(
        select(
            MessageRecord.state,
            func.count().label("cnt"),
        )
        .where(MessageRecord.id.in_(select(dedup_sent.c.min_id)))
        .group_by(MessageRecord.state)
    )
    state_counts: dict[str, int] = {}
    for row in state_counts_result.all():
        state_val = row[0].value if hasattr(row[0], "value") else str(row[0])
        state_counts[state_val] = row[1]

    total_sent_records = sum(state_counts.values())
    success_states = state_counts.get("delivered", 0) + state_counts.get("acked", 0) + state_counts.get("done", 0)
    delivery_success_rate = round(success_states / total_sent_records, 3) if total_sent_records > 0 else 1.0
    failed_messages = state_counts.get("failed", 0)

    # --- active_rooms ---
    active_rooms_result = await db.execute(
        select(func.count(distinct(MessageRecord.room_id))).where(
            MessageRecord.room_id.isnot(None),
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
        "topics_open": topics_open,
        "topics_completed": topics_completed,
        "topics_failed": topics_failed,
        "delivery_success_rate": delivery_success_rate,
        "failed_messages": failed_messages,
        "active_rooms": active_rooms,
    }


# ---------------------------------------------------------------------------
# 2. GET /api/dashboard/activity/topics
# ---------------------------------------------------------------------------


@router.get("/activity/topics")
async def get_activity_topics(
    status: str | None = Query(default=None, pattern="^(open|completed|failed|expired)$"),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return recent topics the active agent participates in."""
    agent_id = ctx.active_agent_id

    # Subquery: topic_ids where the agent has sent/received messages
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

    # Base filter: agent is creator OR has messages in the topic
    base_filter = or_(
        Topic.creator_id == agent_id,
        Topic.topic_id.in_(select(msg_topic_sub)),
    )

    # Count total
    count_stmt = select(func.count()).select_from(Topic).where(base_filter)
    if status:
        count_stmt = count_stmt.where(Topic.status == status)
    total_result = await db.execute(count_stmt)
    total = total_result.scalar() or 0

    # Fetch topics with room name
    stmt = (
        select(Topic, Room.name.label("room_name"))
        .outerjoin(Room, Room.room_id == Topic.room_id)
        .where(base_filter)
    )
    if status:
        stmt = stmt.where(Topic.status == status)
    stmt = stmt.order_by(Topic.updated_at.desc()).offset(offset).limit(limit)

    result = await db.execute(stmt)
    rows = result.all()

    topics = []
    for t, room_name in rows:
        topics.append({
            "topic_id": t.topic_id,
            "title": t.title,
            "status": t.status.value if hasattr(t.status, "value") else str(t.status),
            "room_id": t.room_id,
            "room_name": room_name,
            "goal": t.goal,
            "message_count": t.message_count,
            "creator_id": t.creator_id,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
            "closed_at": t.closed_at.isoformat() if t.closed_at else None,
        })

    return {"topics": topics, "total": total}


# ---------------------------------------------------------------------------
# 3. GET /api/dashboard/activity/issues
# ---------------------------------------------------------------------------


@router.get("/activity/issues")
async def get_activity_issues(
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    """Return anomalies/issues that need attention for the active agent."""
    agent_id = ctx.active_agent_id
    now = datetime.datetime.now(datetime.timezone.utc)
    seven_days_ago = now - datetime.timedelta(days=7)
    one_hour_ago = now - datetime.timedelta(hours=1)

    # --- failed_messages: last 7 days, limit 50 ---
    # Join Agent for receiver_name, join Room for room_name
    ReceiverAgent = Agent.__table__.alias("receiver_agent")

    failed_stmt = (
        select(
            MessageRecord.hub_msg_id,
            MessageRecord.receiver_id,
            ReceiverAgent.c.display_name.label("receiver_name"),
            MessageRecord.room_id,
            Room.name.label("room_name"),
            MessageRecord.last_error,
            MessageRecord.retry_count,
            MessageRecord.created_at,
        )
        .outerjoin(ReceiverAgent, ReceiverAgent.c.agent_id == MessageRecord.receiver_id)
        .outerjoin(Room, Room.room_id == MessageRecord.room_id)
        .where(
            MessageRecord.sender_id == agent_id,
            MessageRecord.state == MessageState.failed,
            MessageRecord.created_at >= seven_days_ago,
        )
        .order_by(MessageRecord.created_at.desc())
        .limit(50)
    )
    failed_result = await db.execute(failed_stmt)
    failed_rows = failed_result.all()

    failed_messages = [
        {
            "hub_msg_id": row.hub_msg_id,
            "receiver_id": row.receiver_id,
            "receiver_name": row.receiver_name,
            "room_id": row.room_id,
            "room_name": row.room_name,
            "last_error": row.last_error,
            "retry_count": row.retry_count,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        }
        for row in failed_rows
    ]

    # --- stale_topics: open topics where agent participates, updated > 1 hour ago ---
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

    stale_stmt = (
        select(
            Topic.topic_id,
            Topic.title,
            Room.name.label("room_name"),
            Topic.status,
            Topic.message_count,
            Topic.updated_at,
        )
        .outerjoin(Room, Room.room_id == Topic.room_id)
        .where(
            Topic.status == TopicStatus.open,
            Topic.updated_at < one_hour_ago,
            or_(
                Topic.creator_id == agent_id,
                Topic.topic_id.in_(select(msg_topic_sub)),
            ),
        )
        .order_by(Topic.updated_at.asc())
        .limit(50)
    )
    stale_result = await db.execute(stale_stmt)
    stale_rows = stale_result.all()

    stale_topics = []
    for row in stale_rows:
        updated_at = row.updated_at
        hours_since = 0
        if updated_at:
            if updated_at.tzinfo is None:
                updated_at = updated_at.replace(tzinfo=datetime.timezone.utc)
            delta = now - updated_at
            hours_since = round(delta.total_seconds() / 3600, 1)

        stale_topics.append({
            "topic_id": row.topic_id,
            "title": row.title,
            "room_name": row.room_name,
            "status": row.status.value if hasattr(row.status, "value") else str(row.status),
            "message_count": row.message_count,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            "hours_since_update": hours_since,
        })

    return {
        "failed_messages": failed_messages,
        "stale_topics": stale_topics,
    }
