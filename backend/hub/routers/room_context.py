"""Room context endpoints for agent-facing retrieve / search.

These endpoints give agents structured access to room history, summaries,
and full-text search — all operating on logical (deduplicated) messages.
"""

from __future__ import annotations

import datetime
import json

from fastapi import APIRouter, Depends, Query
from hub.i18n import I18nHTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_claimed_agent
from hub.database import get_db
from hub.models import (
    Agent,
    MessageRecord,
    MessageState,
    Room,
    RoomMember,
    Topic,
)
from hub.enums import TopicStatus
from hub.schemas import (
    RoomContextInfo,
    RoomContextMember,
    RoomContextMessage,
    RoomContextStats,
    RoomContextTopic,
    RoomMessagesResponse,
    RoomSearchResponse,
    RoomSearchResult,
    RoomSummaryResponse,
    RoomsOverviewItem,
    RoomsOverviewResponse,
)

router = APIRouter(prefix="/hub", tags=["room-context"])

# Phase 1 search: scan up to this many deduped rows and filter in Python.
# Phase 2 can replace with PostgreSQL FTS via tsvector.
_SEARCH_SCAN_LIMIT = 500


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc(dt: datetime.datetime | None) -> datetime.datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def _extract_text(envelope_json: str) -> tuple[str, str, str]:
    """Return (sender_id, text, msg_type) from stored envelope JSON."""
    data = json.loads(envelope_json)
    sender_id = data.get("from", "")
    msg_type = data.get("type", "message")
    payload = data.get("payload", {})
    if not isinstance(payload, dict):
        payload = {}
    text = payload.get("text") or payload.get("body") or payload.get("message") or ""
    if not isinstance(text, str):
        text = str(text)
    return sender_id, text, msg_type


def _snippet(text: str, query: str, max_len: int = 240) -> str:
    """Return a window of *text* centred on the first hit of *query*."""
    if not text:
        return ""
    lower = text.lower()
    q_lower = query.lower()
    idx = lower.find(q_lower)
    if idx == -1:
        return text[:max_len] + ("..." if len(text) > max_len else "")
    start = max(0, idx - 60)
    end = min(len(text), idx + len(query) + max_len - 60)
    snippet = text[start:end]
    if start > 0:
        snippet = "..." + snippet
    if end < len(text):
        snippet = snippet + "..."
    return snippet


def _dedup_subquery(room_ids: str | list[str]):
    """Subquery selecting min(id) per msg_id across one or more rooms."""
    if isinstance(room_ids, str):
        where = MessageRecord.room_id == room_ids
    else:
        where = MessageRecord.room_id.in_(room_ids)
    return (
        select(func.min(MessageRecord.id).label("min_id"))
        .where(where, MessageRecord.state != MessageState.failed)
        .group_by(MessageRecord.msg_id)
        .subquery()
    )


async def _require_room_membership(
    db: AsyncSession, room_id: str, agent_id: str
) -> Room:
    """Load room and verify the agent is a member."""
    result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = result.scalar_one_or_none()
    if room is None:
        raise I18nHTTPException(status_code=404, message_key="room_not_found")

    member_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == agent_id,
        )
    )
    if member_result.scalar_one_or_none() is None:
        raise I18nHTTPException(status_code=403, message_key="not_a_member")

    return room


async def _resolve_cursor(
    db: AsyncSession, hub_msg_id: str, room_id: str | None = None
) -> int:
    """Resolve a hub_msg_id cursor to its internal id. Raises 400 on miss."""
    stmt = select(MessageRecord.id).where(MessageRecord.hub_msg_id == hub_msg_id)
    if room_id is not None:
        stmt = stmt.where(MessageRecord.room_id == room_id)
    cursor_id = (await db.execute(stmt)).scalar_one_or_none()
    if cursor_id is None:
        raise I18nHTTPException(status_code=400, message_key="invalid_cursor")
    return cursor_id


async def _resolve_sender_names(
    db: AsyncSession, sender_ids: set[str]
) -> dict[str, str]:
    sender_ids.discard("")
    if not sender_ids:
        return {}
    result = await db.execute(
        select(Agent.agent_id, Agent.display_name).where(
            Agent.agent_id.in_(sender_ids)
        )
    )
    return dict(result.all())


async def _resolve_topic_titles(
    db: AsyncSession, topic_ids: set[str]
) -> dict[str, str]:
    topic_ids.discard("")
    topic_ids.discard(None)  # type: ignore[arg-type]
    if not topic_ids:
        return {}
    result = await db.execute(
        select(Topic.topic_id, Topic.title).where(Topic.topic_id.in_(topic_ids))
    )
    return dict(result.all())


def _rows_to_messages(
    rows: list[MessageRecord],
    sender_names: dict[str, str],
    topic_titles: dict[str, str],
) -> list[RoomContextMessage]:
    messages: list[RoomContextMessage] = []
    for rec in rows:
        sender_id, text, msg_type = _extract_text(rec.envelope_json)
        messages.append(
            RoomContextMessage(
                hub_msg_id=rec.hub_msg_id,
                **{"from": sender_id},
                from_name=sender_names.get(sender_id, sender_id),
                text=text,
                type=msg_type,
                ts=_utc(rec.created_at),  # type: ignore[arg-type]
                topic_id=rec.topic_id,
                topic_title=topic_titles.get(rec.topic_id, None) if rec.topic_id else None,
            )
        )
    return messages


# -- Shared search logic used by both room_search and global_search ----------


async def _search_messages(
    db: AsyncSession,
    q: str,
    room_ids: str | list[str],
    limit: int,
    before: str | None = None,
    topic_id: str | None = None,
    sender_id: str | None = None,
) -> RoomSearchResponse:
    """Scan deduped messages for *q* and return search results with snippets."""
    dedup_sub = _dedup_subquery(room_ids)
    stmt = select(MessageRecord).where(
        MessageRecord.id.in_(select(dedup_sub.c.min_id))
    )

    if topic_id is not None:
        stmt = stmt.where(MessageRecord.topic_id == topic_id)
    if sender_id is not None:
        stmt = stmt.where(MessageRecord.sender_id == sender_id)
    if before is not None:
        cursor_id = await _resolve_cursor(db, before)
        stmt = stmt.where(MessageRecord.id < cursor_id)

    stmt = stmt.order_by(MessageRecord.id.desc()).limit(_SEARCH_SCAN_LIMIT)
    result = await db.execute(stmt)
    all_rows = list(result.scalars().all())

    # Application-level text match with early exit
    q_lower = q.lower()
    # Store (rec, sender_id, text, score) to avoid re-parsing envelope
    matched: list[tuple[MessageRecord, str, str, float]] = []
    for rec in all_rows:
        sid, text, _ = _extract_text(rec.envelope_json)
        if q_lower in text.lower():
            score = 1.0 / max(len(text), 1) * 1000
            matched.append((rec, sid, text, score))
        if len(matched) >= limit + 1:
            break

    has_more = len(matched) > limit
    matched = matched[:limit]

    # Batch-resolve names
    sender_ids = {sid for _, sid, _, _ in matched}
    topic_ids_set = {rec.topic_id for rec, _, _, _ in matched if rec.topic_id}
    room_ids_set = {rec.room_id for rec, _, _, _ in matched if rec.room_id}

    sender_names = await _resolve_sender_names(db, sender_ids)
    topic_titles = await _resolve_topic_titles(db, topic_ids_set)

    room_names: dict[str, str] = {}
    if room_ids_set:
        rn_result = await db.execute(
            select(Room.room_id, Room.name).where(Room.room_id.in_(room_ids_set))
        )
        room_names = dict(rn_result.all())

    results: list[RoomSearchResult] = []
    for rec, sid, text, score in matched:
        results.append(
            RoomSearchResult(
                hub_msg_id=rec.hub_msg_id,
                **{"from": sid},
                from_name=sender_names.get(sid, sid),
                room_id=rec.room_id,
                room_name=room_names.get(rec.room_id) if rec.room_id else None,
                topic_id=rec.topic_id,
                topic_title=topic_titles.get(rec.topic_id) if rec.topic_id else None,
                snippet=_snippet(text, q),
                ts=_utc(rec.created_at),  # type: ignore[arg-type]
                score=round(score, 4),
            )
        )

    return RoomSearchResponse(query=q, results=results, has_more=has_more)


# ---------------------------------------------------------------------------
# 1. GET /hub/rooms/overview
# ---------------------------------------------------------------------------
# NOTE: registered BEFORE the parametric /hub/rooms/{room_id}/* routes so
# FastAPI matches the literal path first.


@router.get("/rooms/overview", response_model=RoomsOverviewResponse)
async def rooms_overview(
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
    limit: int = Query(default=50, ge=1, le=100),
):
    """Return a summary list of rooms the current agent has joined."""

    member_result = await db.execute(
        select(RoomMember.room_id).where(RoomMember.agent_id == current_agent)
    )
    my_room_ids = [r[0] for r in member_result.all()]
    if not my_room_ids:
        return RoomsOverviewResponse(rooms=[])

    rooms_result = await db.execute(
        select(Room).where(Room.room_id.in_(my_room_ids))
    )
    rooms_by_id = {r.room_id: r for r in rooms_result.scalars().all()}

    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff_24h = now - datetime.timedelta(hours=24)

    # 24h message counts (deduplicated)
    msg_count_sub = (
        select(
            MessageRecord.room_id,
            MessageRecord.msg_id,
            func.min(MessageRecord.id).label("min_id"),
        )
        .where(
            MessageRecord.room_id.in_(my_room_ids),
            MessageRecord.state != MessageState.failed,
            MessageRecord.created_at >= cutoff_24h,
        )
        .group_by(MessageRecord.room_id, MessageRecord.msg_id)
        .subquery()
    )
    count_result = await db.execute(
        select(msg_count_sub.c.room_id, func.count()).group_by(msg_count_sub.c.room_id)
    )
    msg_counts_24h: dict[str, int] = dict(count_result.all())

    # Open topic counts
    topic_result = await db.execute(
        select(Topic.room_id, func.count()).where(
            Topic.room_id.in_(my_room_ids),
            Topic.status == TopicStatus.open,
        ).group_by(Topic.room_id)
    )
    open_topic_counts: dict[str, int] = dict(topic_result.all())

    # Latest message per room (for preview + last_active)
    last_msg_sub = (
        select(
            MessageRecord.room_id,
            MessageRecord.msg_id,
            func.min(MessageRecord.id).label("min_id"),
        )
        .where(
            MessageRecord.room_id.in_(my_room_ids),
            MessageRecord.state != MessageState.failed,
        )
        .group_by(MessageRecord.room_id, MessageRecord.msg_id)
        .subquery()
    )
    latest_result = await db.execute(
        select(
            last_msg_sub.c.room_id,
            func.max(last_msg_sub.c.min_id).label("latest_id"),
        ).group_by(last_msg_sub.c.room_id)
    )
    latest_ids_by_room: dict[str, int] = dict(latest_result.all())

    all_latest_ids = list(latest_ids_by_room.values())
    latest_records: dict[str, MessageRecord] = {}
    if all_latest_ids:
        recs_result = await db.execute(
            select(MessageRecord).where(MessageRecord.id.in_(all_latest_ids))
        )
        for rec in recs_result.scalars().all():
            latest_records[rec.room_id] = rec

    items: list[RoomsOverviewItem] = []
    for rid in my_room_ids:
        room = rooms_by_id.get(rid)
        if room is None:
            continue
        latest_rec = latest_records.get(rid)
        preview = None
        last_active = None
        if latest_rec:
            _, preview_text, _ = _extract_text(latest_rec.envelope_json)
            preview = preview_text[:200] if preview_text else None
            last_active = _utc(latest_rec.created_at)

        items.append(
            RoomsOverviewItem(
                room_id=rid,
                name=room.name,
                message_count_24h=msg_counts_24h.get(rid, 0),
                open_topic_count=open_topic_counts.get(rid, 0),
                last_active=last_active,
                latest_message_preview=preview,
            )
        )

    items.sort(
        key=lambda x: x.last_active or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc),
        reverse=True,
    )
    return RoomsOverviewResponse(rooms=items[:limit])


# ---------------------------------------------------------------------------
# 2. GET /hub/rooms/{room_id}/summary
# ---------------------------------------------------------------------------


@router.get("/rooms/{room_id}/summary", response_model=RoomSummaryResponse)
async def room_summary(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
    recent_limit: int = Query(default=8, ge=1, le=20),
):
    """Return a structured summary of a room for agent context."""
    room = await _require_room_membership(db, room_id, current_agent)

    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff_24h = now - datetime.timedelta(hours=24)

    room_info = RoomContextInfo(
        room_id=room.room_id,
        name=room.name,
        description=room.description,
        rule=room.rule,
        visibility=room.visibility.value,
        join_policy=room.join_policy.value,
    )

    # Members
    members_result = await db.execute(
        select(RoomMember, Agent.display_name)
        .join(Agent, Agent.agent_id == RoomMember.agent_id)
        .where(RoomMember.room_id == room_id)
    )
    members = [
        RoomContextMember(
            agent_id=rm.agent_id,
            name=display_name,
            role=rm.role.value,
            last_active=_utc(rm.last_viewed_at),
        )
        for rm, display_name in members_result.all()
    ]

    # Active topics
    topics_result = await db.execute(
        select(Topic)
        .where(Topic.room_id == room_id, Topic.status == TopicStatus.open)
        .order_by(Topic.updated_at.desc())
    )
    active_topics = [
        RoomContextTopic(
            topic_id=t.topic_id,
            title=t.title,
            goal=t.goal,
            status=t.status.value,
            last_activity=_utc(t.updated_at),
        )
        for t in topics_result.scalars().all()
    ]

    # Stats
    dedup_sub = _dedup_subquery(room_id)

    total_result = await db.execute(
        select(func.count()).select_from(dedup_sub)
    )
    total_messages = total_result.scalar() or 0

    dedup_24h_sub = (
        select(func.min(MessageRecord.id).label("min_id"))
        .where(
            MessageRecord.room_id == room_id,
            MessageRecord.state != MessageState.failed,
            MessageRecord.created_at >= cutoff_24h,
        )
        .group_by(MessageRecord.msg_id)
        .subquery()
    )
    message_count_24h = (await db.execute(
        select(func.count()).select_from(dedup_24h_sub)
    )).scalar() or 0

    active_senders_sub = (
        select(MessageRecord.sender_id)
        .where(
            MessageRecord.room_id == room_id,
            MessageRecord.state != MessageState.failed,
            MessageRecord.created_at >= cutoff_24h,
        )
        .group_by(MessageRecord.sender_id)
        .subquery()
    )
    active_members_24h = (await db.execute(
        select(func.count()).select_from(active_senders_sub)
    )).scalar() or 0

    last_active_row = (await db.execute(
        select(MessageRecord.created_at)
        .where(MessageRecord.id.in_(select(dedup_sub.c.min_id)))
        .order_by(MessageRecord.id.desc())
        .limit(1)
    )).scalar_one_or_none()

    stats = RoomContextStats(
        message_count_24h=message_count_24h,
        active_members_24h=active_members_24h,
        open_topic_count=len(active_topics),
        total_messages=total_messages,
        last_active=_utc(last_active_row),
    )

    # Recent messages (deduped, newest first)
    recent_result = await db.execute(
        select(MessageRecord)
        .where(MessageRecord.id.in_(select(dedup_sub.c.min_id)))
        .order_by(MessageRecord.id.desc())
        .limit(recent_limit)
    )
    rows = list(recent_result.scalars().all())

    sender_ids = set()
    topic_ids = set()
    for rec in rows:
        sid, _, _ = _extract_text(rec.envelope_json)
        sender_ids.add(sid)
        if rec.topic_id:
            topic_ids.add(rec.topic_id)

    sender_names = await _resolve_sender_names(db, sender_ids)
    topic_titles = await _resolve_topic_titles(db, topic_ids)
    recent_messages = _rows_to_messages(rows, sender_names, topic_titles)

    return RoomSummaryResponse(
        room=room_info,
        stats=stats,
        members=members,
        active_topics=active_topics,
        recent_messages=recent_messages,
    )


# ---------------------------------------------------------------------------
# 3. GET /hub/rooms/{room_id}/messages
# ---------------------------------------------------------------------------


@router.get("/rooms/{room_id}/messages", response_model=RoomMessagesResponse)
async def room_messages(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
    limit: int = Query(default=20, ge=1, le=50),
    before: str | None = Query(default=None),
    after: str | None = Query(default=None),
    topic_id: str | None = Query(default=None),
    sender_id: str | None = Query(default=None),
):
    """Return paginated logical messages for a room."""
    if before is not None and after is not None:
        raise I18nHTTPException(status_code=400, message_key="before_after_exclusive")

    await _require_room_membership(db, room_id, current_agent)

    dedup_sub = _dedup_subquery(room_id)
    stmt = select(MessageRecord).where(
        MessageRecord.id.in_(select(dedup_sub.c.min_id))
    )

    if topic_id is not None:
        stmt = stmt.where(MessageRecord.topic_id == topic_id)
    if sender_id is not None:
        stmt = stmt.where(MessageRecord.sender_id == sender_id)

    if before is not None:
        cursor_id = await _resolve_cursor(db, before, room_id)
        stmt = stmt.where(MessageRecord.id < cursor_id)
    elif after is not None:
        cursor_id = await _resolve_cursor(db, after, room_id)
        stmt = stmt.where(MessageRecord.id > cursor_id)

    stmt = stmt.order_by(MessageRecord.id.desc()).limit(limit + 1)
    result = await db.execute(stmt)
    rows = list(result.scalars().all())

    has_more = len(rows) > limit
    rows = rows[:limit]

    sender_ids = set()
    topic_ids_set = set()
    for rec in rows:
        sid, _, _ = _extract_text(rec.envelope_json)
        sender_ids.add(sid)
        if rec.topic_id:
            topic_ids_set.add(rec.topic_id)

    sender_names = await _resolve_sender_names(db, sender_ids)
    topic_titles = await _resolve_topic_titles(db, topic_ids_set)
    messages = _rows_to_messages(rows, sender_names, topic_titles)

    return RoomMessagesResponse(messages=messages, has_more=has_more)


# ---------------------------------------------------------------------------
# 4. GET /hub/rooms/{room_id}/search
# ---------------------------------------------------------------------------


@router.get("/rooms/{room_id}/search", response_model=RoomSearchResponse)
async def room_search(
    room_id: str,
    q: str = Query(..., min_length=1, max_length=200),
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
    limit: int = Query(default=10, ge=1, le=20),
    before: str | None = Query(default=None),
    topic_id: str | None = Query(default=None),
    sender_id: str | None = Query(default=None),
):
    """Full-text search within a single room's logical messages."""
    await _require_room_membership(db, room_id, current_agent)
    return await _search_messages(
        db, q, room_id, limit,
        before=before, topic_id=topic_id, sender_id=sender_id,
    )


# ---------------------------------------------------------------------------
# 5. GET /hub/search  (cross-room)
# ---------------------------------------------------------------------------


@router.get("/search", response_model=RoomSearchResponse)
async def global_search(
    q: str = Query(..., min_length=1, max_length=200),
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
    limit: int = Query(default=10, ge=1, le=20),
    room_id: str | None = Query(default=None),
    topic_id: str | None = Query(default=None),
    sender_id: str | None = Query(default=None),
    before: str | None = Query(default=None),
):
    """Cross-room full-text search across all rooms the agent has joined."""
    if room_id is not None:
        await _require_room_membership(db, room_id, current_agent)
        search_room_ids: str | list[str] = room_id
    else:
        member_result = await db.execute(
            select(RoomMember.room_id).where(RoomMember.agent_id == current_agent)
        )
        search_room_ids = [r[0] for r in member_result.all()]
        if not search_room_ids:
            return RoomSearchResponse(query=q, results=[], has_more=False)

    return await _search_messages(
        db, q, search_room_ids, limit,
        before=before, topic_id=topic_id, sender_id=sender_id,
    )
