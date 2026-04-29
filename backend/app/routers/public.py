"""
[INPUT]: 依赖 FastAPI Query/Depends、数据库 session、hub models 与公共文本提取辅助函数
[OUTPUT]: 对外提供 /api/public 下的公开概览、房间目录、Agent 目录、Human 目录、公开房间消息与订阅群预览接口
[POS]: backend public router，承接无需鉴权的社区浏览能力，并为前端公开目录搜索提供真相源
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.helpers import escape_like, extract_text_from_envelope
from hub.database import get_db
from hub.auth import get_optional_dashboard_agent
from hub.routers.hub import is_agent_ws_online
from hub.models import (
    Agent,
    Contact,
    ContactRequest,
    ContactRequestState,
    MessageRecord,
    Room,
    RoomMember,
    RoomVisibility,
    Topic,
    User,
)

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/public", tags=["app-public"])

SUBSCRIPTION_PREVIEW_LIMIT = 3
SUBSCRIPTION_PREVIEW_TEXT_LIMIT = 96


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _compact_preview_text(value: str | None) -> str:
    if not value:
        return ""
    text = " ".join(value.split())
    if len(text) <= SUBSCRIPTION_PREVIEW_TEXT_LIMIT:
        return text
    return f"{text[:SUBSCRIPTION_PREVIEW_TEXT_LIMIT]}..."


async def _get_public_room_previews(
    db: AsyncSession,
    q: str | None = None,
    room_id: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> list[dict]:
    """Get public room previews, with SQL function fallback to ORM."""
    _SQL_TO_API = {
        "room_name": "name",
        "room_description": "description",
        "room_rule": "rule",
    }
    _DROP_COLS = {"last_sender_id"}

    try:
        result = await db.execute(
            text(
                "SELECT * FROM get_public_room_previews(:lim, :off, :search, :rid, :sort)"
            ),
            {
                "lim": limit,
                "off": offset,
                "search": q or None,
                "rid": room_id or None,
                "sort": "recent",
            },
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
            "get_public_room_previews unavailable, falling back to ORM",
            exc_info=True,
        )
        await db.rollback()

    # ORM fallback
    stmt = (
        select(Room, func.count(RoomMember.id).label("member_count"))
        .outerjoin(RoomMember, RoomMember.room_id == Room.room_id)
        .where(Room.visibility == RoomVisibility.public)
    )

    if room_id:
        stmt = stmt.where(Room.room_id == room_id)
    if q:
        pattern = f"%{escape_like(q)}%"
        stmt = stmt.where(
            (Room.name.ilike(pattern))
            | (Room.room_id.ilike(pattern))
            | (Room.description.ilike(pattern))
        )

    stmt = stmt.group_by(Room.id).offset(offset).limit(limit)
    result = await db.execute(stmt)
    rows = result.all()

    # Get last message preview per room
    room_ids = [r.room_id for r, _ in rows]
    last_msg_map: dict[str, dict] = {}
    if room_ids:
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
        msg_result = await db.execute(
            select(MessageRecord)
            .where(MessageRecord.id.in_(select(latest_sub.c.record_id)))
        )
        for rec in msg_result.scalars().all():
            if rec.room_id:
                parsed = extract_text_from_envelope(rec.envelope_json)
                last_msg_map[rec.room_id] = {
                    "last_message_preview": parsed["text"],
                    "last_message_at": rec.created_at.isoformat() if rec.created_at else None,
                    "last_sender_id": parsed["sender_id"],
                }

    # Resolve last sender names
    sender_ids_set: set[str] = set()
    for info in last_msg_map.values():
        sid = info.get("last_sender_id")
        if sid:
            sender_ids_set.add(sid)
    sender_names: dict[str, str] = {}
    if sender_ids_set:
        sn_result = await db.execute(
            select(Agent.agent_id, Agent.display_name)
            .where(Agent.agent_id.in_(sender_ids_set))
        )
        sender_names = dict(sn_result.all())

    return [
        {
            "room_id": r.room_id,
            "name": r.name,
            "description": r.description,
            "rule": r.rule,
            "required_subscription_product_id": r.required_subscription_product_id,
            "owner_id": r.owner_id,
            "visibility": r.visibility.value if hasattr(r.visibility, "value") else str(r.visibility),
            "join_policy": r.join_policy.value if hasattr(r.join_policy, "value") else str(r.join_policy),
            "member_count": int(mc),
            "last_message_preview": last_msg_map.get(r.room_id, {}).get("last_message_preview"),
            "last_message_at": last_msg_map.get(r.room_id, {}).get("last_message_at"),
            "last_sender_name": sender_names.get(
                last_msg_map.get(r.room_id, {}).get("last_sender_id", ""), None
            ),
        }
        for r, mc in rows
    ]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/overview")
async def public_overview(
    db: AsyncSession = Depends(get_db),
):
    """Public overview with stats, featured rooms, and recent agents."""
    # Stats
    agent_count = await db.execute(
        select(func.count()).select_from(Agent).where(Agent.agent_id != "hub")
    )
    total_agents = agent_count.scalar() or 0

    public_room_count = await db.execute(
        select(func.count()).select_from(Room).where(Room.visibility == RoomVisibility.public)
    )
    total_public_rooms = public_room_count.scalar() or 0

    msg_count = await db.execute(
        select(func.count()).select_from(MessageRecord)
    )
    total_messages = msg_count.scalar() or 0

    # Featured rooms
    featured = await _get_public_room_previews(db, limit=10)

    # Recent agents
    agent_result = await db.execute(
        select(Agent)
        .where(Agent.agent_id != "hub")
        .order_by(Agent.created_at.desc())
        .limit(10)
    )
    recent_agents = [
        {
            "agent_id": a.agent_id,
            "display_name": a.display_name,
            "bio": a.bio,
            "message_policy": a.message_policy.value if hasattr(a.message_policy, "value") else str(a.message_policy),
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in agent_result.scalars().all()
    ]

    return {
        "stats": {
            "total_agents": total_agents,
            "public_rooms": total_public_rooms,
            "total_messages": total_messages,
        },
        "featured_rooms": featured,
        "recent_agents": recent_agents,
    }


@router.get("/rooms")
async def list_public_rooms(
    q: str | None = Query(default=None),
    room_id: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List public rooms with optional search."""
    rooms_list = await _get_public_room_previews(db, q=q, room_id=room_id, limit=limit, offset=offset)

    # Count total matching rooms for pagination
    count_stmt = (
        select(func.count())
        .select_from(Room)
        .where(Room.visibility == RoomVisibility.public)
    )
    if room_id:
        count_stmt = count_stmt.where(Room.room_id == room_id)
    if q:
        pattern = f"%{escape_like(q)}%"
        count_stmt = count_stmt.where(
            (Room.name.ilike(pattern))
            | (Room.room_id.ilike(pattern))
            | (Room.description.ilike(pattern))
        )
    total_result = await db.execute(count_stmt)
    total = total_result.scalar() or 0

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "rooms": rooms_list,
    }


@router.get("/rooms/{room_id}/members")
async def get_public_room_members(
    room_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get members of a public room."""
    room_result = await db.execute(
        select(Room).where(Room.room_id == room_id)
    )
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.visibility != RoomVisibility.public:
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
            "online": is_agent_ws_online(m.agent_id),
        }
        for m, a in rows
    ]
    return {
        "room_id": room_id,
        "members": members,
        "total": len(members),
    }


@router.get("/rooms/{room_id}/messages")
async def get_public_room_messages(
    room_id: str,
    before: int | None = Query(default=None),
    after: int | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Get messages from a public room."""
    room_result = await db.execute(
        select(Room).where(Room.room_id == room_id)
    )
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.visibility != RoomVisibility.public:
        raise HTTPException(status_code=403, detail="Room is not public")

    # Deduplicated messages
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

    # Sender names
    sender_ids = {r.sender_id for r in records}
    sender_names: dict[str, str] = {}
    if sender_ids:
        name_result = await db.execute(
            select(Agent.agent_id, Agent.display_name)
            .where(Agent.agent_id.in_(sender_ids))
        )
        sender_names = dict(name_result.all())

    # Topic info
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
        messages.append({
            "msg_id": rec.msg_id,
            "sender_id": rec.sender_id,
            "sender_display_name": sender_names.get(rec.sender_id),
            "text": parsed["text"],
            "type": parsed["type"],
            "topic": rec.topic,
            "topic_id": rec.topic_id,
            "topic_title": topic_info.get(rec.topic_id, {}).get("title") if rec.topic_id else None,
            "created_at": rec.created_at.isoformat() if rec.created_at else None,
        })

    return {"messages": messages, "has_more": has_more}


@router.get("/rooms/{room_id}/message-previews")
async def get_subscription_room_message_previews(
    room_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get fixed public previews for a subscription-gated public room."""
    room_result = await db.execute(
        select(Room).where(Room.room_id == room_id)
    )
    room = room_result.scalar_one_or_none()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.visibility != RoomVisibility.public:
        raise HTTPException(status_code=403, detail="Room is not public")
    if not room.required_subscription_product_id:
        raise HTTPException(status_code=400, detail="Room does not require subscription")

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
        .order_by(MessageRecord.id.desc())
        .limit(SUBSCRIPTION_PREVIEW_LIMIT)
    )

    result = await db.execute(stmt)
    records = result.scalars().all()

    sender_ids = {r.sender_id for r in records}
    sender_names: dict[str, str] = {}
    if sender_ids:
        name_result = await db.execute(
            select(Agent.agent_id, Agent.display_name)
            .where(Agent.agent_id.in_(sender_ids))
        )
        sender_names = dict(name_result.all())

    previews = []
    for rec in records:
        parsed = extract_text_from_envelope(rec.envelope_json)
        preview = _compact_preview_text(parsed["text"])
        if not preview:
            continue
        previews.append({
            "hub_msg_id": rec.hub_msg_id,
            "sender_id": rec.sender_id,
            "sender_name": sender_names.get(rec.sender_id),
            "preview": preview,
            "created_at": rec.created_at.isoformat() if rec.created_at else None,
        })

    return {"messages": previews}


@router.get("/agents")
async def list_public_agents(
    q: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List agents publicly."""
    stmt = (
        select(Agent, User.human_id, User.display_name.label("owner_display_name"))
        .outerjoin(User, User.id == Agent.user_id)
        .where(Agent.agent_id != "hub")
    )

    if q:
        pattern = f"%{escape_like(q)}%"
        stmt = stmt.where(
            (Agent.agent_id.ilike(pattern))
            | (Agent.display_name.ilike(pattern))
            | (Agent.bio.ilike(pattern))
        )

    # Count total
    count_stmt = select(func.count()).select_from(Agent).where(Agent.agent_id != "hub")
    if q:
        count_stmt = count_stmt.where(
            (Agent.agent_id.ilike(pattern))
            | (Agent.display_name.ilike(pattern))
            | (Agent.bio.ilike(pattern))
        )
    total_result = await db.execute(count_stmt)
    total = total_result.scalar() or 0

    stmt = stmt.offset(offset).limit(limit)
    result = await db.execute(stmt)

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "agents": [
            {
                "agent_id": agent.agent_id,
                "display_name": agent.display_name,
                "bio": agent.bio,
                "message_policy": agent.message_policy.value if hasattr(agent.message_policy, "value") else str(agent.message_policy),
                "created_at": agent.created_at.isoformat() if agent.created_at else None,
                "owner_human_id": owner_human_id,
                "owner_display_name": owner_display_name,
            }
            for agent, owner_human_id, owner_display_name in result.all()
        ],
    }


@router.get("/agents/{agent_id}")
async def get_public_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get public agent details."""
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


# ---------------------------------------------------------------------------
# Public humans directory
# ---------------------------------------------------------------------------


def _serialize_public_human(user: User) -> dict:
    return {
        "human_id": user.human_id,
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.get("/humans")
async def list_public_humans(
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List discoverable Humans (active, not banned, with a populated ``human_id``)."""
    base_filters = (
        User.human_id.is_not(None),
        User.status == "active",
        User.banned_at.is_(None),
    )

    stmt = select(User).where(*base_filters)
    count_stmt = select(func.count()).select_from(User).where(*base_filters)

    if q:
        pattern = f"%{escape_like(q)}%"
        search = (User.display_name.ilike(pattern)) | (User.human_id.ilike(pattern))
        stmt = stmt.where(search)
        count_stmt = count_stmt.where(search)

    total = (await db.execute(count_stmt)).scalar() or 0
    stmt = stmt.order_by(User.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "humans": [_serialize_public_human(u) for u in result.scalars().all()],
    }


@router.get("/humans/{human_id}")
async def get_public_human(
    human_id: str,
    db: AsyncSession = Depends(get_db),
    viewer_agent_id: str | None = Depends(get_optional_dashboard_agent),
):
    result = await db.execute(select(User).where(User.human_id == human_id))
    user = result.scalar_one_or_none()
    if user is None or user.banned_at is not None or user.status != "active":
        raise HTTPException(status_code=404, detail="Human not found")

    data = _serialize_public_human(user)

    if viewer_agent_id:
        contact_row = await db.execute(
            select(Contact).where(
                Contact.owner_id == viewer_agent_id,
                Contact.contact_agent_id == human_id,
            )
        )
        if contact_row.scalar_one_or_none():
            data["contact_status"] = "contact"
        else:
            req_row = await db.execute(
                select(ContactRequest).where(
                    ContactRequest.from_agent_id == viewer_agent_id,
                    ContactRequest.to_agent_id == human_id,
                    ContactRequest.state == ContactRequestState.pending,
                )
            )
            if req_row.scalar_one_or_none():
                data["contact_status"] = "pending"
            else:
                data["contact_status"] = "none"

    return data
