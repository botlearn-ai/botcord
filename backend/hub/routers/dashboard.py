from __future__ import annotations

import datetime
import json
import time

from fastapi import APIRouter, Depends, Query
from hub.i18n import I18nHTTPException
from sqlalchemy import select, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_agent, get_dashboard_agent
from hub.database import get_db
from hub.dashboard_schemas import (
    CreateShareResponse,
    DashboardAgentProfile,
    DashboardAgentSearchResponse,
    DashboardContactInfo,
    DashboardConversationListResponse,
    DashboardMessage,
    DashboardMessageResponse,
    DashboardOverviewResponse,
    DashboardRoom,
    DiscoverRoom,
    DiscoverRoomsResponse,
    JoinRoomResponse,
    PlatformStatsResponse,
    SharedMessage,
    SharedRoomInfo,
    SharedRoomResponse,
)
from hub.id_generators import generate_share_id
from hub.enums import SubscriptionStatus
from hub.models import (
    Agent,
    AgentSubscription,
    Contact,
    ContactRequest,
    ContactRequestState,
    MessageRecord,
    Room,
    RoomJoinPolicy,
    RoomMember,
    RoomRole,
    RoomVisibility,
    Share,
    ShareMessage,
)
from hub.share_payloads import room_entry_type, share_create_payload, share_public_payload

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_text_from_envelope(envelope_data: dict) -> tuple[str, str, dict]:
    """Extract sender_id, text preview and payload from a parsed envelope."""
    sender_id = envelope_data.get("from", "")
    msg_type = envelope_data.get("type", "message")
    payload = envelope_data.get("payload", {})
    if not isinstance(payload, dict):
        payload = {}

    text = payload.get("text") or payload.get("body") or payload.get("message") or ""
    if text is not None and not isinstance(text, str):
        text = str(text)
    if not text and msg_type == "contact_request":
        text = payload.get("message", "")
        if text is not None and not isinstance(text, str):
            text = str(text)
    return sender_id, text, payload

async def _build_dashboard_rooms(
    room_ids: list[str],
    current_agent: str,
    db: AsyncSession,
) -> list[DashboardRoom]:
    """Build DashboardRoom objects for a list of room_ids."""
    if not room_ids:
        return []

    # Load rooms
    result = await db.execute(
        select(Room).where(Room.room_id.in_(room_ids))
    )
    rooms = {r.room_id: r for r in result.scalars().all()}

    # Member counts per room
    count_result = await db.execute(
        select(RoomMember.room_id, func.count(RoomMember.id))
        .where(RoomMember.room_id.in_(room_ids))
        .group_by(RoomMember.room_id)
    )
    member_counts = dict(count_result.all())

    # My role per room
    role_result = await db.execute(
        select(RoomMember.room_id, RoomMember.role)
        .where(
            RoomMember.room_id.in_(room_ids),
            RoomMember.agent_id == current_agent,
        )
    )
    my_roles = {row[0]: row[1].value for row in role_result.all()}

    # Last message per room: get the most recent MessageRecord per room_id.
    # Use a subquery to find max(id) grouped by (room_id, msg_id) first,
    # then max of those per room_id.
    # Simplified: for each room, get the record with the highest id
    # (one per msg_id via subquery to deduplicate fan-out).
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

    # Resolve sender names for last messages
    sender_ids = {rec.sender_id for rec in last_messages.values()}
    sender_names: dict[str, str] = {}
    if sender_ids:
        agent_result = await db.execute(
            select(Agent.agent_id, Agent.display_name)
            .where(Agent.agent_id.in_(sender_ids))
        )
        sender_names = dict(agent_result.all())

    dashboard_rooms: list[DashboardRoom] = []
    for rid in room_ids:
        room = rooms.get(rid)
        if room is None:
            continue
        last_rec = last_messages.get(rid)
        last_preview: str | None = None
        last_at = None
        last_sender: str | None = None
        if last_rec:
            envelope_data = json.loads(last_rec.envelope_json)
            sid, text, _ = _extract_text_from_envelope(envelope_data)
            last_preview = text[:200] if text else None
            last_at = last_rec.created_at
            if last_at is not None and last_at.tzinfo is None:
                last_at = last_at.replace(tzinfo=datetime.timezone.utc)
            last_sender = sender_names.get(sid)

        room_created_at = room.created_at
        if room_created_at is not None and room_created_at.tzinfo is None:
            room_created_at = room_created_at.replace(tzinfo=datetime.timezone.utc)

        dashboard_rooms.append(
            DashboardRoom(
                room_id=room.room_id,
                name=room.name,
                description=room.description,
                rule=room.rule,
                owner_id=room.owner_id,
                visibility=room.visibility.value if hasattr(room.visibility, "value") else str(room.visibility),
                member_count=member_counts.get(rid, 0),
                my_role=my_roles.get(rid, "member"),
                created_at=room_created_at,
                last_message_preview=last_preview,
                last_message_at=last_at,
                last_sender_name=last_sender,
            )
        )
    dashboard_rooms.sort(
        key=lambda room: room.last_message_at or room.created_at or datetime.datetime.min.replace(
            tzinfo=datetime.timezone.utc
        ),
        reverse=True,
    )
    return dashboard_rooms


# ---------------------------------------------------------------------------
# 1. GET /dashboard/overview
# ---------------------------------------------------------------------------


@router.get("/overview", response_model=DashboardOverviewResponse)
async def get_overview(
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_dashboard_agent),
):
    """Return the current agent's dashboard overview."""
    # Agent profile
    result = await db.execute(
        select(Agent).where(Agent.agent_id == current_agent)
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    agent_profile = DashboardAgentProfile(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
        bio=agent.bio,
        message_policy=agent.message_policy.value if hasattr(agent.message_policy, "value") else str(agent.message_policy),
        created_at=agent.created_at,
    )

    # Rooms where current agent is a member
    member_result = await db.execute(
        select(RoomMember.room_id).where(RoomMember.agent_id == current_agent)
    )
    room_ids = [row[0] for row in member_result.all()]
    dashboard_rooms = await _build_dashboard_rooms(room_ids, current_agent, db)

    # Contacts with display names
    contact_result = await db.execute(
        select(Contact, Agent.display_name)
        .outerjoin(Agent, Agent.agent_id == Contact.contact_agent_id)
        .where(Contact.owner_id == current_agent)
    )
    contacts = [
        DashboardContactInfo(
            contact_agent_id=c.contact_agent_id,
            alias=c.alias,
            display_name=dn or c.contact_agent_id,
            created_at=c.created_at,
        )
        for c, dn in contact_result.all()
    ]

    # Pending contact request count
    pending_result = await db.execute(
        select(func.count())
        .select_from(ContactRequest)
        .where(
            ContactRequest.to_agent_id == current_agent,
            ContactRequest.state == ContactRequestState.pending,
        )
    )
    pending_count = pending_result.scalar() or 0

    return DashboardOverviewResponse(
        agent=agent_profile,
        rooms=dashboard_rooms,
        contacts=contacts,
        pending_requests=pending_count,
    )


# ---------------------------------------------------------------------------
# 2. GET /dashboard/rooms/{room_id}/messages
# ---------------------------------------------------------------------------


@router.get("/rooms/{room_id}/messages", response_model=DashboardMessageResponse)
async def get_room_messages(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_dashboard_agent),
    before: str | None = Query(default=None),
    after: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
):
    """Return paginated messages for a room. Deduplicates fan-out records."""
    if before is not None and after is not None:
        raise I18nHTTPException(status_code=400, message_key="before_after_exclusive")

    # Verify membership
    member_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == current_agent,
        )
    )
    if member_result.scalar_one_or_none() is None:
        raise I18nHTTPException(status_code=403, message_key="not_a_member")

    # Deduplicate fan-out: pick one record (min id) per msg_id in this room
    dedup_sub = (
        select(func.min(MessageRecord.id).label("min_id"))
        .where(MessageRecord.room_id == room_id)
        .group_by(MessageRecord.msg_id)
        .subquery()
    )

    stmt = select(MessageRecord).where(
        MessageRecord.id.in_(select(dedup_sub.c.min_id))
    )

    # Cursor pagination (always return newest-first / descending)
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
            raise I18nHTTPException(status_code=400, message_key="invalid_cursor")
        stmt = stmt.where(MessageRecord.id < cursor_id)
    elif after is not None:
        cursor_result = await db.execute(
            select(MessageRecord.id).where(
                MessageRecord.hub_msg_id == after,
                MessageRecord.room_id == room_id,
                MessageRecord.id.in_(select(dedup_sub.c.min_id)),
            )
        )
        cursor_id = cursor_result.scalar_one_or_none()
        if cursor_id is None:
            raise I18nHTTPException(status_code=400, message_key="invalid_cursor")
        stmt = stmt.where(MessageRecord.id > cursor_id)
    stmt = stmt.order_by(MessageRecord.id.desc())

    # Fetch limit+1 for has_more detection
    stmt = stmt.limit(limit + 1)
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

    sender_names: dict[str, str] = {}
    if sender_ids:
        agent_result = await db.execute(
            select(Agent.agent_id, Agent.display_name)
            .where(Agent.agent_id.in_(sender_ids))
        )
        sender_names = dict(agent_result.all())

    # Batch-resolve state counts for all messages in this page
    msg_ids = [rec.msg_id for rec in rows]
    state_counts_map: dict[str, dict[str, int]] = {}
    if msg_ids:
        sc_result = await db.execute(
            select(
                MessageRecord.msg_id,
                MessageRecord.state,
                func.count().label("cnt"),
            )
            .where(
                MessageRecord.room_id == room_id,
                MessageRecord.msg_id.in_(msg_ids),
            )
            .group_by(MessageRecord.msg_id, MessageRecord.state)
        )
        for mid, st, cnt in sc_result.all():
            state_counts_map.setdefault(mid, {})[st.value if hasattr(st, "value") else st] = cnt

    # Build response messages
    messages: list[DashboardMessage] = []
    for rec in rows:
        envelope_data = json.loads(rec.envelope_json)
        sid, text, payload = _extract_text_from_envelope(envelope_data)
        msg_type = envelope_data.get("type", "message")

        ca = rec.created_at
        if ca is not None and ca.tzinfo is None:
            ca = ca.replace(tzinfo=datetime.timezone.utc)

        counts = state_counts_map.get(rec.msg_id)

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
                goal=rec.goal,
                state=rec.state.value,
                state_counts=counts,
                created_at=ca,
                source_type=rec.source_type,
            )
        )

    return DashboardMessageResponse(
        messages=messages,
        has_more=has_more,
    )


# ---------------------------------------------------------------------------
# 3. GET /dashboard/agents/search
# ---------------------------------------------------------------------------


@router.get("/agents/search", response_model=DashboardAgentSearchResponse)
async def search_agents(
    q: str = Query(..., min_length=1),
    db: AsyncSession = Depends(get_db),
    _current_agent: str = Depends(get_dashboard_agent),
):
    """Search agents by agent_id or display_name."""
    stmt = (
        select(Agent)
        .where(
            or_(
                Agent.agent_id.ilike(f"%{q}%"),
                Agent.display_name.ilike(f"%{q}%"),
            )
        )
        .limit(20)
    )
    result = await db.execute(stmt)
    agents = result.scalars().all()

    return DashboardAgentSearchResponse(
        agents=[
            DashboardAgentProfile(
                agent_id=a.agent_id,
                display_name=a.display_name,
                bio=a.bio,
                message_policy=a.message_policy.value if hasattr(a.message_policy, "value") else str(a.message_policy),
                created_at=a.created_at,
            )
            for a in agents
        ]
    )


# ---------------------------------------------------------------------------
# 4. GET /dashboard/agents/{agent_id}
# ---------------------------------------------------------------------------


@router.get("/agents/{agent_id}", response_model=DashboardAgentProfile)
async def get_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _current_agent: str = Depends(get_dashboard_agent),
):
    """Look up a single agent by agent_id."""
    result = await db.execute(
        select(Agent).where(Agent.agent_id == agent_id)
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    return DashboardAgentProfile(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
        bio=agent.bio,
        message_policy=agent.message_policy.value if hasattr(agent.message_policy, "value") else str(agent.message_policy),
        created_at=agent.created_at,
    )


# ---------------------------------------------------------------------------
# 5. GET /dashboard/agents/{agent_id}/conversations
# ---------------------------------------------------------------------------


@router.get(
    "/agents/{agent_id}/conversations",
    response_model=DashboardConversationListResponse,
)
async def get_agent_conversations(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_dashboard_agent),
):
    """Find rooms where both current_agent and target agent_id are members."""
    target_result = await db.execute(
        select(Agent.agent_id).where(Agent.agent_id == agent_id)
    )
    if target_result.scalar_one_or_none() is None:
        raise I18nHTTPException(status_code=404, message_key="agent_not_found")

    # Subquery: rooms where current_agent is member
    my_rooms = (
        select(RoomMember.room_id)
        .where(RoomMember.agent_id == current_agent)
        .subquery()
    )
    # Subquery: rooms where target agent is member
    their_rooms = (
        select(RoomMember.room_id)
        .where(RoomMember.agent_id == agent_id)
        .subquery()
    )
    # Intersection
    shared_room_ids_result = await db.execute(
        select(my_rooms.c.room_id).intersect(select(their_rooms.c.room_id))
    )
    shared_room_ids = [row[0] for row in shared_room_ids_result.all()]

    conversations = await _build_dashboard_rooms(shared_room_ids, current_agent, db)

    return DashboardConversationListResponse(conversations=conversations)


# ---------------------------------------------------------------------------
# 6. POST /dashboard/rooms/{room_id}/share
# ---------------------------------------------------------------------------


@router.post(
    "/rooms/{room_id}/share",
    response_model=CreateShareResponse,
    status_code=201,
)
async def create_share(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_dashboard_agent),
):
    """Create a snapshot share link for a room's messages."""
    # Verify room exists
    room_result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = room_result.scalar_one_or_none()
    if room is None:
        raise I18nHTTPException(status_code=404, message_key="room_not_found")

    # Verify membership
    member_result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == current_agent,
        )
    )
    if member_result.scalar_one_or_none() is None:
        raise I18nHTTPException(status_code=403, message_key="not_a_member")

    # Get current agent display_name
    agent_result = await db.execute(
        select(Agent.display_name).where(Agent.agent_id == current_agent)
    )
    shared_by_name = agent_result.scalar_one_or_none() or current_agent

    share_id = generate_share_id()

    # Deduplicate fan-out: pick one record (min id) per msg_id
    dedup_sub = (
        select(func.min(MessageRecord.id).label("min_id"))
        .where(MessageRecord.room_id == room_id)
        .group_by(MessageRecord.msg_id)
        .subquery()
    )
    msg_result = await db.execute(
        select(MessageRecord)
        .where(MessageRecord.id.in_(select(dedup_sub.c.min_id)))
        .order_by(MessageRecord.id.asc())
    )
    records = msg_result.scalars().all()

    # Batch-resolve sender names
    sender_ids = set()
    for rec in records:
        envelope_data = json.loads(rec.envelope_json)
        sender_ids.add(envelope_data.get("from", ""))
    sender_ids.discard("")

    sender_names: dict[str, str] = {}
    if sender_ids:
        name_result = await db.execute(
            select(Agent.agent_id, Agent.display_name)
            .where(Agent.agent_id.in_(sender_ids))
        )
        sender_names = dict(name_result.all())

    # Create Share record
    share = Share(
        share_id=share_id,
        room_id=room_id,
        shared_by_agent_id=current_agent,
        shared_by_name=shared_by_name,
    )
    db.add(share)

    # Snapshot messages
    for rec in records:
        envelope_data = json.loads(rec.envelope_json)
        sid, text, payload = _extract_text_from_envelope(envelope_data)
        msg_type = envelope_data.get("type", "message")

        ca = rec.created_at
        if ca is not None and ca.tzinfo is None:
            ca = ca.replace(tzinfo=datetime.timezone.utc)

        db.add(ShareMessage(
            share_id=share_id,
            hub_msg_id=rec.hub_msg_id,
            msg_id=rec.msg_id,
            sender_id=sid,
            sender_name=sender_names.get(sid, sid),
            type=msg_type,
            text=text,
            payload_json=json.dumps(payload),
            created_at=ca,
        ))

    await db.commit()
    await db.refresh(share)

    ca = share.created_at
    if ca is not None and ca.tzinfo is None:
        ca = ca.replace(tzinfo=datetime.timezone.utc)

    return CreateShareResponse(**share_create_payload(
        share_id=share_id,
        room=room,
        created_at=ca.isoformat() if ca else None,
        expires_at=share.expires_at.isoformat() if share.expires_at else None,
    ))


# ---------------------------------------------------------------------------
# 7. GET /dashboard/rooms/discover
# ---------------------------------------------------------------------------


@router.get("/rooms/discover", response_model=DiscoverRoomsResponse)
async def discover_rooms(
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_dashboard_agent),
):
    """Discover public rooms the current agent has NOT joined."""
    # Subquery: rooms where current agent is already a member
    my_rooms_sub = (
        select(RoomMember.room_id)
        .where(RoomMember.agent_id == current_agent)
        .subquery()
    )

    # Base filter: public rooms not already joined
    base_filter = [
        Room.visibility == RoomVisibility.public,
        Room.room_id.notin_(select(my_rooms_sub.c.room_id)),
    ]

    # Optional text search with LIKE wildcard escaping
    if q is not None:
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

    # Main query: join with RoomMember to get member_count, order by popularity
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
        .order_by(member_count_sub.c.member_count.desc().nulls_last())
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(stmt)
    rows = result.all()

    rooms = [
        DiscoverRoom(
            room_id=room.room_id,
            name=room.name,
            description=room.description,
            rule=room.rule,
            owner_id=room.owner_id,
            visibility=room.visibility.value if hasattr(room.visibility, "value") else str(room.visibility),
            member_count=count or 0,
            required_subscription_product_id=room.required_subscription_product_id,
        )
        for room, count in rows
    ]

    return DiscoverRoomsResponse(rooms=rooms, total=total)


# ---------------------------------------------------------------------------
# 8. POST /dashboard/rooms/{room_id}/join
# ---------------------------------------------------------------------------


@router.post("/rooms/{room_id}/join", response_model=JoinRoomResponse, status_code=200)
async def join_room(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_dashboard_agent),
):
    """Join a public, open room."""
    # Load room
    result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = result.scalar_one_or_none()
    if room is None:
        raise I18nHTTPException(status_code=404, message_key="room_not_found")

    # Subscription-gated rooms: subscribers can self-join regardless of join_policy,
    # but room must still be public.
    has_subscription_access = False
    if room.required_subscription_product_id and room.visibility == RoomVisibility.public:
        sub_result = await db.execute(
            select(AgentSubscription).where(
                AgentSubscription.product_id == room.required_subscription_product_id,
                AgentSubscription.subscriber_agent_id == current_agent,
                AgentSubscription.status == SubscriptionStatus.active,
            )
        )
        has_subscription_access = sub_result.scalar_one_or_none() is not None
    if not has_subscription_access:
        if room.visibility != RoomVisibility.public or room.join_policy != RoomJoinPolicy.open:
            raise I18nHTTPException(
                status_code=403,
                message_key="self_join_public_open_only",
            )

    # Check max_members
    member_count_result = await db.execute(
        select(func.count(RoomMember.id)).where(RoomMember.room_id == room_id)
    )
    current_count = member_count_result.scalar() or 0
    if room.max_members is not None and current_count >= room.max_members:
        raise I18nHTTPException(status_code=400, message_key="room_is_full")

    # Add member
    new_member = RoomMember(
        room_id=room.room_id,
        agent_id=current_agent,
        role=RoomRole.member,
    )
    try:
        async with db.begin_nested():
            db.add(new_member)
            await db.flush()
    except IntegrityError:
        raise I18nHTTPException(status_code=409, message_key="already_a_member")

    await db.commit()

    # Get updated member count
    updated_count_result = await db.execute(
        select(func.count(RoomMember.id)).where(RoomMember.room_id == room_id)
    )
    updated_count = updated_count_result.scalar() or 0

    return JoinRoomResponse(
        room_id=room.room_id,
        name=room.name,
        description=room.description,
        rule=room.rule,
        owner_id=room.owner_id,
        visibility=room.visibility.value if hasattr(room.visibility, "value") else str(room.visibility),
        member_count=updated_count,
        my_role="member",
    )


# ---------------------------------------------------------------------------
# Public share router (mounted at root, no auth)
# ---------------------------------------------------------------------------

share_public_router = APIRouter(tags=["share"])


@share_public_router.get("/share/{share_id}", response_model=SharedRoomResponse)
async def get_shared_room(
    share_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Public endpoint to view a shared room snapshot."""
    # Look up share
    share_result = await db.execute(
        select(Share).where(Share.share_id == share_id)
    )
    share = share_result.scalar_one_or_none()
    if share is None:
        raise I18nHTTPException(status_code=404, message_key="share_not_found")

    # Check expiration
    if share.expires_at is not None:
        now = datetime.datetime.now(datetime.timezone.utc)
        expires = share.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=datetime.timezone.utc)
        if now > expires:
            raise I18nHTTPException(status_code=404, message_key="share_expired")

    # Room info
    room_result = await db.execute(
        select(Room).where(Room.room_id == share.room_id)
    )
    room = room_result.scalar_one_or_none()
    room_name = room.name if room else "Deleted Room"
    room_desc = room.description if room else ""

    # Member count
    count_result = await db.execute(
        select(func.count(RoomMember.id)).where(RoomMember.room_id == share.room_id)
    )
    member_count = count_result.scalar() or 0

    # Snapshot messages
    msg_result = await db.execute(
        select(ShareMessage)
        .where(ShareMessage.share_id == share_id)
        .order_by(ShareMessage.created_at.asc())
    )
    share_messages = msg_result.scalars().all()

    messages = []
    for sm in share_messages:
        ca = sm.created_at
        if ca is not None and ca.tzinfo is None:
            ca = ca.replace(tzinfo=datetime.timezone.utc)
        messages.append(SharedMessage(
            hub_msg_id=sm.hub_msg_id,
            msg_id=sm.msg_id,
            sender_id=sm.sender_id,
            sender_name=sm.sender_name,
            type=sm.type,
            text=sm.text,
            payload=json.loads(sm.payload_json) if sm.payload_json else {},
            created_at=ca,
        ))

    shared_at = share.created_at
    if shared_at is not None and shared_at.tzinfo is None:
        shared_at = shared_at.replace(tzinfo=datetime.timezone.utc)

    return SharedRoomResponse(**share_public_payload(
        share_id=share.share_id,
        room_id=share.room_id,
        room_name=room_name,
        room_description=room_desc,
        member_count=member_count,
        shared_by=share.shared_by_name,
        shared_at=shared_at.isoformat() if shared_at else None,
        messages=[message.model_dump(mode="json") for message in messages],
        room=room,
    ))


# ---------------------------------------------------------------------------
# Public platform stats
# ---------------------------------------------------------------------------


_stats_cache: PlatformStatsResponse | None = None
_stats_cache_ts: float = 0.0
_STATS_CACHE_TTL = 60.0  # seconds


@share_public_router.get("/stats", response_model=PlatformStatsResponse)
async def get_platform_stats(db: AsyncSession = Depends(get_db)):
    """Public endpoint returning aggregate platform statistics."""
    global _stats_cache, _stats_cache_ts

    now = time.monotonic()
    if _stats_cache is not None and (now - _stats_cache_ts) < _STATS_CACHE_TTL:
        return _stats_cache

    total_agents = (await db.execute(
        select(func.count(Agent.id)).where(Agent.agent_id != "hub")
    )).scalar() or 0
    total_rooms = (await db.execute(select(func.count(Room.id)))).scalar() or 0
    public_rooms = (
        await db.execute(
            select(func.count(Room.id)).where(Room.visibility == RoomVisibility.public)
        )
    ).scalar() or 0
    total_messages = (await db.execute(select(func.count(MessageRecord.id)))).scalar() or 0

    _stats_cache = PlatformStatsResponse(
        total_agents=total_agents,
        total_rooms=total_rooms,
        public_rooms=public_rooms,
        total_messages=total_messages,
    )
    _stats_cache_ts = now
    return _stats_cache
