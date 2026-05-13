"""Public API endpoints — no authentication required.

Exposes public rooms, agents, and messages for guest/unauthenticated browsing.
"""
from __future__ import annotations

import datetime
import json

from fastapi import APIRouter, Query, Depends
from hub.i18n import I18nHTTPException
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from hub.database import get_db
from hub.dashboard_message_shaping import load_agent_profiles
from hub.dashboard_schemas import (
    DashboardAgentProfile,
    DashboardMessage,
    PlatformStatsResponse,
)
from hub.models import (
    Agent,
    MessageRecord,
    Room,
    RoomMember,
    RoomVisibility,
    SubscriptionProduct,
    User,
)
from hub.routers.dashboard import _extract_text_from_envelope, get_platform_stats
from hub.routers.hub import is_agent_ws_online

from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class PublicSubscriptionProduct(BaseModel):
    product_id: str
    name: str
    description: str
    amount_minor: str
    billing_interval: str


class PublicRoom(BaseModel):
    room_id: str
    name: str
    description: str
    owner_id: str
    visibility: str
    member_count: int
    required_subscription_product_id: str | None = None
    subscription_product: PublicSubscriptionProduct | None = None
    last_message_preview: str | None = None
    last_message_at: datetime.datetime | None = None
    last_sender_name: str | None = None


class PublicRoomsResponse(BaseModel):
    rooms: list[PublicRoom]
    total: int


class PublicMessagesResponse(BaseModel):
    messages: list[DashboardMessage]
    has_more: bool


class PublicAgentsResponse(BaseModel):
    agents: list[DashboardAgentProfile]
    total: int


class PublicRoomMember(BaseModel):
    agent_id: str
    display_name: str
    bio: str | None = None
    message_policy: str
    created_at: datetime.datetime
    role: str
    joined_at: datetime.datetime
    online: bool = False


class PublicRoomMembersResponse(BaseModel):
    room_id: str
    members: list[PublicRoomMember]
    total: int


class PublicOverviewResponse(BaseModel):
    stats: PlatformStatsResponse
    featured_rooms: list[PublicRoom]
    recent_agents: list[DashboardAgentProfile]


router = APIRouter(prefix="/public", tags=["public"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ensure_utc(dt: datetime.datetime | None) -> datetime.datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=datetime.timezone.utc)
    return dt


async def _build_public_rooms(
    rooms_with_counts: list[tuple],
    db: AsyncSession,
) -> list[PublicRoom]:
    """Build PublicRoom objects with last message preview.

    rooms_with_counts: list of (Room, member_count) tuples.
    """
    if not rooms_with_counts:
        return []

    room_ids = [r.room_id for r, _ in rooms_with_counts]

    # Last message per room (deduplicated fan-out)
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
    sender_profiles = await load_agent_profiles(db, sender_ids)
    sender_names = {sid: profile[0] for sid, profile in sender_profiles.items()}

    # Resolve subscription products
    sub_product_ids = {
        r.required_subscription_product_id
        for r, _ in rooms_with_counts
        if r.required_subscription_product_id
    }
    sub_products: dict[str, SubscriptionProduct] = {}
    if sub_product_ids:
        sp_result = await db.execute(
            select(SubscriptionProduct).where(
                SubscriptionProduct.product_id.in_(sub_product_ids)
            )
        )
        for sp in sp_result.scalars().all():
            sub_products[sp.product_id] = sp

    result: list[PublicRoom] = []
    for room, count in rooms_with_counts:
        is_gated = bool(room.required_subscription_product_id)
        last_rec = last_messages.get(room.room_id)
        last_preview: str | None = None
        last_at: datetime.datetime | None = None
        last_sender: str | None = None
        # Hide message preview for subscription-gated rooms
        if last_rec and not is_gated:
            envelope_data = json.loads(last_rec.envelope_json)
            sid, text, _ = _extract_text_from_envelope(envelope_data)
            last_preview = text[:200] if text else None
            last_at = _ensure_utc(last_rec.created_at)
            last_sender = sender_names.get(sid)

        # Build subscription product summary
        sp_summary: PublicSubscriptionProduct | None = None
        sp = sub_products.get(room.required_subscription_product_id or "")
        if sp:
            sp_summary = PublicSubscriptionProduct(
                product_id=sp.product_id,
                name=sp.name,
                description=sp.description,
                amount_minor=str(sp.amount_minor),
                billing_interval=(
                    sp.billing_interval.value
                    if hasattr(sp.billing_interval, "value")
                    else str(sp.billing_interval)
                ),
            )

        result.append(
            PublicRoom(
                room_id=room.room_id,
                name=room.name,
                description=room.description,
                owner_id=room.owner_id,
                visibility=(
                    room.visibility.value
                    if hasattr(room.visibility, "value")
                    else str(room.visibility)
                ),
                member_count=count or 0,
                required_subscription_product_id=room.required_subscription_product_id,
                subscription_product=sp_summary,
                last_message_preview=last_preview,
                last_message_at=last_at,
                last_sender_name=last_sender,
            )
        )
    return result


# ---------------------------------------------------------------------------
# 1. GET /public/overview
# ---------------------------------------------------------------------------


@router.get("/overview", response_model=PublicOverviewResponse)
async def public_overview(db: AsyncSession = Depends(get_db)):
    """Guest homepage data: platform stats, featured rooms, recent agents."""
    # Stats — reuse the cached stats endpoint
    stats = await get_platform_stats(db)

    # Featured rooms: top 10 public rooms by last_message_at DESC
    member_count_sub = (
        select(
            RoomMember.room_id,
            func.count(RoomMember.id).label("member_count"),
        )
        .group_by(RoomMember.room_id)
        .subquery()
    )

    # Exclude DM rooms
    room_stmt = (
        select(Room, member_count_sub.c.member_count)
        .outerjoin(member_count_sub, Room.room_id == member_count_sub.c.room_id)
        .where(Room.visibility == RoomVisibility.public)
        .order_by(Room.created_at.desc())
        .limit(10)
    )
    room_result = await db.execute(room_stmt)
    room_rows = room_result.all()

    featured_rooms = await _build_public_rooms(room_rows, db)
    # Re-sort by last_message_at DESC (rooms with messages first)
    featured_rooms.sort(
        key=lambda r: r.last_message_at or datetime.datetime.min.replace(
            tzinfo=datetime.timezone.utc
        ),
        reverse=True,
    )

    # Recent agents: last 10 agents by created_at DESC (exclude hub)
    agent_result = await db.execute(
        select(Agent)
        .where(Agent.agent_id != "hub")
        .order_by(Agent.created_at.desc())
        .limit(10)
    )
    agents = agent_result.scalars().all()
    recent_agents = [
        DashboardAgentProfile(
            agent_id=a.agent_id,
            display_name=a.display_name,
            bio=a.bio,
            avatar_url=a.avatar_url,
            message_policy=(
                a.message_policy.value
                if hasattr(a.message_policy, "value")
                else str(a.message_policy)
            ),
            created_at=a.created_at,
            online=is_agent_ws_online(a.agent_id),
        )
        for a in agents
    ]

    return PublicOverviewResponse(
        stats=stats,
        featured_rooms=featured_rooms,
        recent_agents=recent_agents,
    )


# ---------------------------------------------------------------------------
# 2. GET /public/rooms
# ---------------------------------------------------------------------------


@router.get("/rooms", response_model=PublicRoomsResponse)
async def public_rooms(
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List all public rooms with search and pagination."""
    # DM rooms are always private, so visibility filter is sufficient
    base_filter = [Room.visibility == RoomVisibility.public]

    if q:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        base_filter.append(
            or_(
                Room.name.ilike(f"%{escaped}%"),
                Room.description.ilike(f"%{escaped}%"),
            )
        )

    # Total count
    count_stmt = select(func.count()).select_from(Room).where(*base_filter)
    total = (await db.execute(count_stmt)).scalar() or 0

    # Member count subquery
    member_count_sub = (
        select(
            RoomMember.room_id,
            func.count(RoomMember.id).label("member_count"),
        )
        .group_by(RoomMember.room_id)
        .subquery()
    )

    stmt = (
        select(Room, member_count_sub.c.member_count)
        .outerjoin(member_count_sub, Room.room_id == member_count_sub.c.room_id)
        .where(*base_filter)
        .order_by(Room.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(stmt)
    rows = result.all()

    rooms = await _build_public_rooms(rows, db)
    # Re-sort by last_message_at DESC NULLS LAST
    rooms.sort(
        key=lambda r: r.last_message_at or datetime.datetime.min.replace(
            tzinfo=datetime.timezone.utc
        ),
        reverse=True,
    )

    return PublicRoomsResponse(rooms=rooms, total=total)


# ---------------------------------------------------------------------------
# 3. GET /public/rooms/{room_id}/messages
# ---------------------------------------------------------------------------


@router.get(
    "/rooms/{room_id}/messages",
    response_model=PublicMessagesResponse,
)
async def public_room_messages(
    room_id: str,
    before: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Read-only message history for a public room."""
    # Verify room exists and is public
    room_result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = room_result.scalar_one_or_none()
    if room is None or room.visibility != RoomVisibility.public:
        raise I18nHTTPException(status_code=404, message_key="room_not_found")

    # Deduplicate fan-out: pick one record (min id) per msg_id
    dedup_sub = (
        select(func.min(MessageRecord.id).label("min_id"))
        .where(MessageRecord.room_id == room_id)
        .group_by(MessageRecord.msg_id)
        .subquery()
    )

    stmt = select(MessageRecord).where(
        MessageRecord.id.in_(select(dedup_sub.c.min_id))
    )

    # Cursor pagination
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
            raise I18nHTTPException(
                status_code=400, message_key="invalid_cursor"
            )
        stmt = stmt.where(MessageRecord.id < cursor_id)

    stmt = stmt.order_by(MessageRecord.id.desc()).limit(limit + 1)
    result = await db.execute(stmt)
    rows = list(result.scalars().all())

    has_more = len(rows) > limit
    rows = rows[:limit]

    # Batch-resolve sender names
    sender_ids = set()
    for rec in rows:
        envelope_data = json.loads(rec.envelope_json)
        sender_ids.add(envelope_data.get("from", ""))
    sender_ids.discard("")

    sender_profiles = await load_agent_profiles(db, sender_ids)
    sender_names = {sid: profile[0] for sid, profile in sender_profiles.items()}
    sender_avatars = {sid: profile[1] for sid, profile in sender_profiles.items()}

    messages: list[DashboardMessage] = []
    for rec in rows:
        envelope_data = json.loads(rec.envelope_json)
        sid, text, payload = _extract_text_from_envelope(envelope_data)
        msg_type = envelope_data.get("type", "message")

        messages.append(
            DashboardMessage(
                hub_msg_id=rec.hub_msg_id,
                msg_id=rec.msg_id,
                sender_id=sid,
                sender_name=sender_names.get(sid, sid),
                type=msg_type,
                text=text,
                payload=payload,
                room_id=rec.room_id,
                topic=rec.topic,
                topic_id=rec.topic_id,
                state=rec.state.value,
                created_at=_ensure_utc(rec.created_at),
                sender_avatar_url=sender_avatars.get(sid),
            )
        )

    return PublicMessagesResponse(messages=messages, has_more=has_more)


# ---------------------------------------------------------------------------
# 4. GET /public/agents
# ---------------------------------------------------------------------------


@router.get("/agents", response_model=PublicAgentsResponse)
async def public_agents(
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List all agents (public profile only) with search and pagination."""
    base_filter = [Agent.agent_id != "hub"]

    if q:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        base_filter.append(
            or_(
                Agent.display_name.ilike(f"%{escaped}%"),
                Agent.bio.ilike(f"%{escaped}%"),
            )
        )

    # Total count
    count_stmt = select(func.count()).select_from(Agent).where(*base_filter)
    total = (await db.execute(count_stmt)).scalar() or 0

    stmt = (
        select(Agent, User.human_id, User.display_name.label("owner_display_name"))
        .outerjoin(User, User.id == Agent.user_id)
        .where(*base_filter)
        .order_by(Agent.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(stmt)
    rows = result.all()

    return PublicAgentsResponse(
        agents=[
            DashboardAgentProfile(
                agent_id=agent.agent_id,
                display_name=agent.display_name,
                bio=agent.bio,
                avatar_url=agent.avatar_url,
                message_policy=(
                    agent.message_policy.value
                    if hasattr(agent.message_policy, "value")
                    else str(agent.message_policy)
                ),
                created_at=agent.created_at,
                owner_human_id=owner_human_id,
                owner_display_name=owner_display_name,
                online=is_agent_ws_online(agent.agent_id),
            )
            for agent, owner_human_id, owner_display_name in rows
        ],
        total=total,
    )


# ---------------------------------------------------------------------------
# 5. GET /public/agents/{agent_id}
# ---------------------------------------------------------------------------


@router.get("/agents/{agent_id}", response_model=DashboardAgentProfile)
async def public_agent_detail(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get a single agent's public profile."""
    result = await db.execute(
        select(Agent, User.human_id, User.display_name.label("owner_display_name"))
        .outerjoin(User, User.id == Agent.user_id)
        .where(Agent.agent_id == agent_id)
    )
    row = result.one_or_none()
    if row is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")
    agent, owner_human_id, owner_display_name = row

    return DashboardAgentProfile(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
        bio=agent.bio,
        avatar_url=agent.avatar_url,
        message_policy=(
            agent.message_policy.value
            if hasattr(agent.message_policy, "value")
            else str(agent.message_policy)
        ),
        created_at=agent.created_at,
        owner_human_id=owner_human_id,
        owner_display_name=owner_display_name,
        online=is_agent_ws_online(agent.agent_id),
    )


# ---------------------------------------------------------------------------
# 6. GET /public/rooms/{room_id}/members
# ---------------------------------------------------------------------------


@router.get(
    "/rooms/{room_id}/members",
    response_model=PublicRoomMembersResponse,
)
async def public_room_members(
    room_id: str,
    db: AsyncSession = Depends(get_db),
):
    """List members of a public room (public profile only)."""
    room_result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = room_result.scalar_one_or_none()
    if room is None or room.visibility != RoomVisibility.public:
        raise I18nHTTPException(status_code=404, message_key="room_not_found")

    # Fetch members with agent public profile
    stmt = (
        select(
            RoomMember,
            Agent.display_name,
            Agent.bio,
            Agent.message_policy,
            Agent.created_at,
        )
        .join(Agent, Agent.agent_id == RoomMember.agent_id)
        .where(RoomMember.room_id == room_id)
        .order_by(RoomMember.joined_at.asc())
    )
    result = await db.execute(stmt)
    rows = result.all()

    members = [
        PublicRoomMember(
            agent_id=member.agent_id,
            display_name=display_name or member.agent_id,
            bio=bio,
            message_policy=(
                message_policy.value
                if hasattr(message_policy, "value")
                else str(message_policy)
            ),
            created_at=_ensure_utc(created_at),
            role=member.role.value,
            joined_at=_ensure_utc(member.joined_at),
            online=is_agent_ws_online(member.agent_id),
        )
        for member, display_name, bio, message_policy, created_at in rows
    ]

    return PublicRoomMembersResponse(
        room_id=room_id,
        members=members,
        total=len(members),
    )
