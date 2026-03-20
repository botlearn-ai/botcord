"""Topic CRUD endpoints — first-class topic entity within rooms."""

from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, Query
from hub.i18n import I18nHTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from hub.auth import get_current_claimed_agent, get_dashboard_claimed_agent
from hub.database import get_db
from hub.enums import TopicStatus
from hub.id_generators import generate_topic_id
from hub.models import Room, RoomMember, RoomRole, Topic
from hub.schemas import (
    CreateTopicRequest,
    TopicListResponse,
    TopicResponse,
    UpdateTopicRequest,
)

router = APIRouter(prefix="/hub/rooms/{room_id}/topics", tags=["topics"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _load_room_with_members(db: AsyncSession, room_id: str) -> Room:
    """Load room with members. Raises 404 if not found."""
    result = await db.execute(
        select(Room)
        .where(Room.room_id == room_id)
        .options(selectinload(Room.members))
    )
    room = result.scalar_one_or_none()
    if room is None:
        raise I18nHTTPException(status_code=404, message_key="room_not_found")
    return room


def _require_membership(room: Room, agent_id: str) -> RoomMember:
    """Return the member record or raise 403."""
    for m in room.members:
        if m.agent_id == agent_id:
            return m
    raise I18nHTTPException(status_code=403, message_key="not_a_member")


def _build_topic_response(topic: Topic) -> TopicResponse:
    created_at = topic.created_at
    if created_at is not None and created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=datetime.timezone.utc)
    updated_at = topic.updated_at
    if updated_at is not None and updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=datetime.timezone.utc)
    closed_at = topic.closed_at
    if closed_at is not None and closed_at.tzinfo is None:
        closed_at = closed_at.replace(tzinfo=datetime.timezone.utc)

    return TopicResponse(
        topic_id=topic.topic_id,
        room_id=topic.room_id,
        title=topic.title,
        description=topic.description,
        status=topic.status.value,
        creator_id=topic.creator_id,
        goal=topic.goal,
        message_count=topic.message_count,
        created_at=created_at,
        updated_at=updated_at,
        closed_at=closed_at,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("", response_model=TopicResponse, status_code=201)
async def create_topic(
    room_id: str,
    body: CreateTopicRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Create a topic in a room. Room membership required."""
    room = await _load_room_with_members(db, room_id)
    _require_membership(room, current_agent)

    topic = Topic(
        topic_id=generate_topic_id(),
        room_id=room_id,
        title=body.title,
        description=body.description,
        status=TopicStatus.open,
        creator_id=current_agent,
        goal=body.goal,
    )
    try:
        async with db.begin_nested():
            db.add(topic)
            await db.flush()
    except IntegrityError:
        raise I18nHTTPException(
            status_code=409,
            message_key="topic_title_duplicate",
        )

    await db.commit()
    await db.refresh(topic)
    return _build_topic_response(topic)


@router.get("", response_model=TopicListResponse)
async def list_topics(
    room_id: str,
    status: TopicStatus | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_dashboard_claimed_agent),
):
    """List topics in a room. Room membership required."""
    room = await _load_room_with_members(db, room_id)
    _require_membership(room, current_agent)

    stmt = select(Topic).where(Topic.room_id == room_id)
    if status is not None:
        stmt = stmt.where(Topic.status == status)
    stmt = stmt.order_by(Topic.created_at.desc())

    result = await db.execute(stmt)
    topics = list(result.scalars().all())

    return TopicListResponse(
        topics=[_build_topic_response(t) for t in topics]
    )


@router.get("/{topic_id}", response_model=TopicResponse)
async def get_topic(
    room_id: str,
    topic_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Get topic details. Room membership required."""
    room = await _load_room_with_members(db, room_id)
    _require_membership(room, current_agent)

    result = await db.execute(
        select(Topic).where(
            Topic.topic_id == topic_id,
            Topic.room_id == room_id,
        )
    )
    topic = result.scalar_one_or_none()
    if topic is None:
        raise I18nHTTPException(status_code=404, message_key="topic_not_found")

    return _build_topic_response(topic)


@router.patch("/{topic_id}", response_model=TopicResponse)
async def update_topic(
    room_id: str,
    topic_id: str,
    body: UpdateTopicRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Update a topic.

    Status transitions: any member can change status.
    Title/description: only creator, admin, or owner can change.
    Reactivation: transitioning from completed/failed/expired to open requires a new goal.
    """
    room = await _load_room_with_members(db, room_id)
    member = _require_membership(room, current_agent)

    result = await db.execute(
        select(Topic).where(
            Topic.topic_id == topic_id,
            Topic.room_id == room_id,
        )
    )
    topic = result.scalar_one_or_none()
    if topic is None:
        raise I18nHTTPException(status_code=404, message_key="topic_not_found")

    now = datetime.datetime.now(datetime.timezone.utc)

    # Title/description changes: creator, admin, or owner only
    if "title" in body.model_fields_set or "description" in body.model_fields_set:
        if (
            current_agent != topic.creator_id
            and member.role not in (RoomRole.owner, RoomRole.admin)
        ):
            raise I18nHTTPException(
                status_code=403,
                message_key="topic_update_title_desc_forbidden",
            )

    if "title" in body.model_fields_set and body.title is not None:
        topic.title = body.title
    if "description" in body.model_fields_set and body.description is not None:
        topic.description = body.description

    # Status transition
    if "status" in body.model_fields_set and body.status is not None:
        new_status = body.status

        # Reactivation: terminated → open requires new goal
        if (
            topic.status in (TopicStatus.completed, TopicStatus.failed, TopicStatus.expired)
            and new_status == TopicStatus.open
        ):
            new_goal = body.goal if "goal" in body.model_fields_set else None
            if not new_goal:
                raise I18nHTTPException(
                    status_code=400,
                    message_key="topic_reactivation_requires_goal",
                )
            topic.goal = new_goal
            topic.closed_at = None

        # Closing: open → completed/failed
        if topic.status == TopicStatus.open and new_status in (
            TopicStatus.completed, TopicStatus.failed
        ):
            topic.closed_at = now

        topic.status = new_status

    # Goal update (independent of status change)
    if "goal" in body.model_fields_set and "status" not in body.model_fields_set:
        topic.goal = body.goal

    topic.updated_at = now

    try:
        await db.commit()
    except IntegrityError:
        raise I18nHTTPException(
            status_code=409,
            message_key="topic_title_duplicate",
        )

    await db.refresh(topic)
    return _build_topic_response(topic)


@router.delete("/{topic_id}", response_model=dict)
async def delete_topic(
    room_id: str,
    topic_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Delete a topic. Owner or admin only."""
    room = await _load_room_with_members(db, room_id)
    member = _require_membership(room, current_agent)

    if member.role not in (RoomRole.owner, RoomRole.admin):
        raise I18nHTTPException(
            status_code=403, message_key="only_owner_admin_can_delete_topics"
        )

    result = await db.execute(
        select(Topic).where(
            Topic.topic_id == topic_id,
            Topic.room_id == room_id,
        )
    )
    topic = result.scalar_one_or_none()
    if topic is None:
        raise I18nHTTPException(status_code=404, message_key="topic_not_found")

    await db.delete(topic)
    await db.commit()
    return {"ok": True}
