"""Dashboard user chat API — owner-agent direct messaging."""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
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
    Room,
    RoomJoinPolicy,
    RoomMember,
    RoomRole,
    RoomVisibility,
)
from hub.routers.hub import (
    notify_inbox,
    build_message_realtime_event,
    build_agent_realtime_event,
    _publish_agent_realtime_event,
)
from hub.i18n import I18nHTTPException

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard/chat", tags=["dashboard-chat"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class ChatSendRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


class ChatSendResponse(BaseModel):
    hub_msg_id: str
    room_id: str
    status: str


class ChatRoomResponse(BaseModel):
    room_id: str
    name: str
    agent_id: str


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
        return room_id

    room = Room(
        room_id=room_id,
        name=f"Chat with {agent_display_name}",
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
        return room_id

    # Add the agent as the sole member (owner-perspective).
    # The user is not an agent so they don't get a RoomMember row;
    # they interact exclusively via the dashboard chat API.
    db.add(RoomMember(room_id=room_id, agent_id=agent_id, role=RoomRole.owner))
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

    return ChatRoomResponse(room_id=room_id, name=f"Chat with {display_name}", agent_id=agent_id)


@router.post("/send", response_model=ChatSendResponse, status_code=202)
async def send_chat_message(
    body: ChatSendRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    agent_and_user: tuple[str, str | None] = Depends(get_dashboard_agent_with_user),
):
    """Send a message from the dashboard user to their own agent.

    Creates a MessageRecord with source_type='dashboard_user_chat' and delivers
    it into the agent's inbox so the plugin can pick it up.
    """
    agent_id, user_id = agent_and_user
    if not user_id:
        raise I18nHTTPException(status_code=400, message_key="user_id_required_for_chat")

    # Fetch agent display name
    agent_result = await db.execute(
        select(Agent.display_name).where(Agent.agent_id == agent_id)
    )
    agent_display_name = agent_result.scalar_one_or_none() or agent_id

    # Ensure room exists
    room_id = await _ensure_owner_chat_room(db, user_id, agent_id, agent_display_name)

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
        "reply_to": None,
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
    )
    try:
        async with db.begin_nested():
            db.add(record)
            await db.flush()
    except IntegrityError:
        raise I18nHTTPException(status_code=409, message_key="duplicate_message")

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
            sender_name=agent_display_name,
        ),
    )

    # Publish a typing indicator so the dashboard shows the agent is processing
    typing_event = build_agent_realtime_event(
        type="typing",
        agent_id=agent_id,
        room_id=room_id,
    )
    await _publish_agent_realtime_event(db, typing_event)

    return ChatSendResponse(
        hub_msg_id=hub_msg_id,
        room_id=room_id,
        status="queued",
    )
