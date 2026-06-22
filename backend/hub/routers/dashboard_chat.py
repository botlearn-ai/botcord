"""Dashboard user chat API — owner-agent direct messaging."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid

import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_dashboard_agent_with_user
from hub.database import get_db
from hub.enums import MessageType
from hub.id_generators import generate_hub_msg_id
from hub.models import (
    Agent,
    MessageRecord,
    MessageState,
    ParticipantType,
    Room,
    RoomJoinPolicy,
    RoomMember,
    RoomRole,
    RoomVisibility,
    User,
)
from hub.routers.hub import notify_inbox
from hub.services.cloud_agent_activity import bump_if_cloud_agent
from hub.i18n import I18nHTTPException

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard/chat", tags=["dashboard-chat"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class ChatSendRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str = Field(..., min_length=1, max_length=8000)
    reply_to: str | None = Field(default=None, alias="replyTo", max_length=64)


class ChatSendResponse(BaseModel):
    hub_msg_id: str
    room_id: str
    status: str


class ChatRoomResponse(BaseModel):
    room_id: str
    name: str
    agent_id: str


class StreamBlockEvent(BaseModel):
    seq: int | None = None
    kind: str | None = None
    created_at: str | None = None
    block: dict


class RunStreamBlocksResponse(BaseModel):
    trace_id: str
    status: str
    room_id: str | None = None
    agent_id: str | None = None
    events: list[StreamBlockEvent]


# ---------------------------------------------------------------------------
# Owner-agent chat room helpers
# ---------------------------------------------------------------------------

_OWNER_CHAT_ROOM_PREFIX = "rm_oc_"


def _build_owner_chat_room_id(user_id: str, agent_id: str) -> str:
    """Derive a deterministic room_id for an owner-agent chat.

    Uses a SHA-256 hash of (user_id + agent_id) to produce a stable,
    URL-safe room identifier.
    """
    seed = f"owner_chat:{user_id}:{agent_id}"
    digest = hashlib.sha256(seed.encode()).hexdigest()[:16]
    return f"{_OWNER_CHAT_ROOM_PREFIX}{digest}"


async def _resolve_owner_human_id(db: AsyncSession, user_id: str) -> str | None:
    try:
        user_uuid = uuid.UUID(user_id)
    except ValueError:
        return None

    result = await db.execute(select(User.human_id).where(User.id == user_uuid))
    return result.scalar_one_or_none()


async def _ensure_owner_chat_members(
    db: AsyncSession,
    room_id: str,
    user_id: str,
    agent_id: str,
) -> None:
    """Ensure owner-chat rooms expose both participants in RoomMember."""
    result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == agent_id,
        )
    )
    if result.scalar_one_or_none() is None:
        db.add(
            RoomMember(
                room_id=room_id,
                agent_id=agent_id,
                participant_type=ParticipantType.agent,
                role=RoomRole.owner,
            )
        )

    human_id = await _resolve_owner_human_id(db, user_id)
    if not human_id:
        return

    result = await db.execute(
        select(RoomMember).where(
            RoomMember.room_id == room_id,
            RoomMember.agent_id == human_id,
            RoomMember.participant_type == ParticipantType.human,
        )
    )
    if result.scalar_one_or_none() is None:
        db.add(
            RoomMember(
                room_id=room_id,
                agent_id=human_id,
                participant_type=ParticipantType.human,
                role=RoomRole.member,
            )
        )


async def _ensure_owner_chat_room(
    db: AsyncSession,
    user_id: str,
    agent_id: str,
    agent_display_name: str,
) -> str:
    """Create or return the stable owner-agent chat room."""
    room_id = _build_owner_chat_room_id(user_id, agent_id)

    result = await db.execute(select(Room).where(Room.room_id == room_id))
    if result.scalar_one_or_none() is not None:
        await _ensure_owner_chat_members(db, room_id, user_id, agent_id)
        await db.flush()
        return room_id

    room = Room(
        room_id=room_id,
        name=agent_display_name,
        owner_id=agent_id,
        visibility=RoomVisibility.private,
        join_policy=RoomJoinPolicy.invite_only,
        max_members=2,
        default_send=True,
    )
    try:
        async with db.begin_nested():
            db.add(room)
            await db.flush()
    except IntegrityError:
        # Race: another request created it first
        await _ensure_owner_chat_members(db, room_id, user_id, agent_id)
        await db.flush()
        return room_id

    await _ensure_owner_chat_members(db, room_id, user_id, agent_id)
    await db.flush()

    return room_id


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/room", response_model=ChatRoomResponse)
async def get_or_create_chat_room(
    db: AsyncSession = Depends(get_db),
    agent_and_user: tuple[str, str | None] = Depends(get_dashboard_agent_with_user),
):
    """Return (or create) the owner-agent chat room for the authenticated user."""
    agent_id, user_id = agent_and_user
    if not user_id:
        raise I18nHTTPException(status_code=400, message_key="user_id_required_for_chat")

    # Fetch agent display name
    result = await db.execute(
        select(Agent.display_name).where(Agent.agent_id == agent_id)
    )
    display_name = result.scalar_one_or_none() or agent_id

    room_id = await _ensure_owner_chat_room(db, user_id, agent_id, display_name)
    await db.commit()

    return ChatRoomResponse(room_id=room_id, name=display_name, agent_id=agent_id)


@router.post("/send", response_model=ChatSendResponse, status_code=202)
async def send_chat_message(
    body: ChatSendRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    agent_and_user: tuple[str, str | None] = Depends(get_dashboard_agent_with_user),
):
    """Send a message from the dashboard user to their own agent.

    Creates a MessageRecord with source_type='dashboard_user_chat' and delivers
    it into the agent's inbox so the connected agent can pick it up.
    """
    agent_id, user_id = agent_and_user
    if not user_id:
        raise I18nHTTPException(status_code=400, message_key="user_id_required_for_chat")

    # Fetch agent and wake/resume its cloud runtime when needed.
    agent_result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = agent_result.scalar_one_or_none()
    agent_display_name = agent.display_name if agent is not None else agent_id
    if agent is not None and agent.hosting_kind == "cloud":
        try:
            from hub.services.cloud_agent import CloudAgentError, CloudAgentService

            await CloudAgentService().resume_cloud_agent(
                db,
                user_id=uuid.UUID(user_id),
                agent_id=agent_id,
            )
        except (CloudAgentError, ValueError) as exc:
            code = getattr(exc, "code", "cloud_resume_failed")
            message = (
                "Cloud agent is still starting. Please retry in a moment."
                if code == "not_ready"
                else "Cloud agent is temporarily unavailable. Please retry in a moment."
            )
            logger.warning(
                "Dashboard chat cloud resume failed before enqueue: "
                "agent=%s code=%s err=%s",
                agent_id,
                code,
                exc,
            )
            raise HTTPException(
                status_code=getattr(exc, "http_status", 409),
                detail={
                    "code": code,
                    "message": message,
                    "retryable": True,
                },
            ) from exc
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Dashboard chat cloud resume failed: agent=%s err=%s",
                agent_id,
                exc,
                exc_info=True,
            )
            with sentry_sdk.new_scope() as scope:
                scope.set_tag("component", "dashboard_chat")
                scope.set_tag("agent_id", agent_id)
                scope.set_tag("dashboard_chat.error_code", "cloud_resume_failed")
                sentry_sdk.capture_exception(exc)
            raise HTTPException(
                status_code=502,
                detail={
                    "code": "cloud_resume_failed",
                    "message": "Cloud agent is temporarily unavailable. Please retry in a moment.",
                    "retryable": True,
                },
            ) from exc

    # Ensure room exists
    room_id = await _ensure_owner_chat_room(db, user_id, agent_id, agent_display_name)

    # Validate quote-reply target (same owner-chat room only). Persist the
    # canonical envelope msg_id even if the client gave a hub_msg_id.
    canonical_reply_msg_id: str | None = None
    if body.reply_to is not None:
        from hub.routers.hub import _load_reply_target
        target = await _load_reply_target(db, room_id=room_id, reply_to_value=body.reply_to)
        canonical_reply_msg_id = target.msg_id

    # Build a synthetic envelope JSON for the message record.
    # This isn't a real A2A envelope (no crypto signing), which is intentional —
    # the source_type field distinguishes it from real A2A traffic.
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
        "reply_to": canonical_reply_msg_id,
        "ttl_sec": 3600,
        "payload": payload,
        "payload_hash": "",
        "sig": {"alg": "ed25519", "key_id": "dashboard", "value": ""},
    }
    envelope_json = json.dumps(envelope_data)

    hub_msg_id = generate_hub_msg_id()
    # sender_id must be a valid agents.agent_id (FK constraint + VARCHAR(32)).
    # The real user identity is captured in source_user_id; sender_id uses
    # the agent_id so the record satisfies the FK and column-width constraints.
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
        reply_to_msg_id=canonical_reply_msg_id,
    )
    try:
        async with db.begin_nested():
            db.add(record)
            await db.flush()
    except IntegrityError:
        raise I18nHTTPException(status_code=409, message_key="duplicate_message")

    # Event 3: owner-chat send. The user is actively driving this agent
    # from the dashboard right now — count it as activity unconditionally
    # (attention policy doesn't apply: this is the owner's own room).
    await bump_if_cloud_agent(db, agent_id)

    await db.commit()

    # Register the in-flight trace + cache run metadata, exactly as the owner-chat
    # WS send path does. The dashboard sends over the WS when connected and falls
    # back to this REST endpoint otherwise (e.g. during WS reconnect after a page
    # refresh); without this, REST-sent messages would never route streamed blocks
    # to the owner's WS nor get cached for refresh/restore.
    from hub.routers.owner_chat_ws import register_owner_chat_run

    await register_owner_chat_run(
        hub_msg_id=hub_msg_id,
        user_id=user_id,
        agent_id=agent_id,
        room_id=room_id,
    )

    # Notify inbox listeners so connected agents pick up the message.
    # Skip Supabase realtime event — the dedicated owner-chat WS path
    # handles real-time delivery to the dashboard frontend.
    try:
        notified = await notify_inbox(agent_id, db=db)
        if notified == 0:
            from hub.routers.owner_chat_ws import _notify_inbox_with_retry
            asyncio.create_task(_notify_inbox_with_retry(agent_id))
    except Exception as exc:
        logger.error(
            "Dashboard chat notify_inbox failed: agent=%s hub_msg_id=%s err=%s",
            agent_id, hub_msg_id, exc, exc_info=True,
        )

    return ChatSendResponse(
        hub_msg_id=hub_msg_id,
        room_id=room_id,
        status="queued",
    )


@router.get(
    "/runs/{trace_id}/stream-blocks",
    response_model=RunStreamBlocksResponse,
)
async def get_run_stream_blocks(
    trace_id: str,
    agent_and_user: tuple[str, str | None] = Depends(get_dashboard_agent_with_user),
):
    """Restore in-flight owner-chat stream blocks for a trace from the Redis cache.

    Degrades gracefully: when Redis is disabled, the run is missing/expired, or
    the run does not belong to this owner's owner-chat room, returns 200 with
    status="completed" and an empty events list (never 404), so the frontend
    simply waits for the final message.
    """
    from hub import owner_chat_cache

    agent_id, user_id = agent_and_user

    empty = RunStreamBlocksResponse(
        trace_id=trace_id,
        status="completed",
        room_id=None,
        agent_id=agent_id,
        events=[],
    )

    if not user_id:
        return empty

    run = await owner_chat_cache.load_run(trace_id)
    if run is None:
        return empty

    # Authorization: the run must belong to this agent and this owner's room.
    expected_room = _build_owner_chat_room_id(user_id, agent_id)
    if run.get("agent_id") != agent_id or run.get("room_id") != expected_room:
        return empty

    return RunStreamBlocksResponse(
        trace_id=trace_id,
        status=run.get("status", "completed"),
        room_id=run.get("room_id"),
        agent_id=run.get("agent_id"),
        events=[StreamBlockEvent(**ev) for ev in run.get("events", [])],
    )
