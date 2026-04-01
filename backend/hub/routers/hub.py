from __future__ import annotations

import asyncio
import datetime
import hashlib
import json
import logging
import time
from typing import Any
from collections import defaultdict, deque

from cachetools import TTLCache

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from hub.i18n import I18nHTTPException
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from hub.auth import get_current_claimed_agent, get_dashboard_claimed_agent, verify_agent_token
from hub.config import INBOX_POLL_MAX_TIMEOUT, PAIR_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_MINUTE
from hub.crypto import check_timestamp, verify_envelope_sig, verify_payload_hash
from hub.database import get_db
from hub.enums import TopicStatus
from hub.id_generators import generate_hub_msg_id, generate_topic_id
from hub.models import (
    Agent,
    Block,
    Contact,
    ContactRequest,
    ContactRequestState,
    KeyState,
    MessagePolicy,
    MessageRecord,
    MessageState,
    Room,
    RoomMember,
    RoomRole,
    RoomVisibility,
    SigningKey,
    Topic,
    User,
)
from hub.forward import (
    RoomContext as _RoomContext,
    build_flat_text as _build_flat_text,
)
from hub.prompt_guard import scan_content, InjectionRisk
from hub.schemas import (
    HistoryMessage,
    HistoryResponse,
    InboxAckRequest,
    InboxAckResponse,
    InboxMessage,
    InboxPollResponse,
    MessageEnvelope,
    MessageStatusResponse,
    MessageType,
    ReceiptResponse,
    SendResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hub", tags=["hub"])

# ---------------------------------------------------------------------------
# In-memory rate-limit state: agent_id → deque of timestamps
# ---------------------------------------------------------------------------
_rate_windows: dict[str, deque[float]] = defaultdict(deque)

# Per-pair rate limit: (sender, target) → deque of timestamps
# target is agent_id for DM, room_id for room messages
_pair_rate_windows: dict[tuple[str, str], deque[float]] = defaultdict(deque)

# ---------------------------------------------------------------------------
# Slow mode state: (room_id, agent_id) → last send monotonic timestamp
# TTL=1h, max 10k entries — entries expire naturally after inactivity
# ---------------------------------------------------------------------------
_slow_mode_last_send: TTLCache[tuple[str, str], float] = TTLCache(maxsize=10_000, ttl=3600)

# ---------------------------------------------------------------------------
# Duplicate content detection: (room_id, agent_id) → hash of last payload
# TTL=5min, max 10k entries — only blocks rapid consecutive duplicates
# ---------------------------------------------------------------------------
_last_msg_hash: TTLCache[tuple[str, str], str] = TTLCache(maxsize=10_000, ttl=300)

# ---------------------------------------------------------------------------
# In-memory inbox notification: agent_id → asyncio.Condition
# ---------------------------------------------------------------------------
_inbox_conditions: dict[str, asyncio.Condition] = {}

# ---------------------------------------------------------------------------
# In-memory WebSocket connections: agent_id → set of WebSocket
# ---------------------------------------------------------------------------
_ws_connections: dict[str, set[WebSocket]] = {}


def build_agent_realtime_topic(agent_id: str) -> str:
    return f"agent:{agent_id}"


def build_agent_realtime_event(
    *,
    type: str,
    agent_id: str,
    room_id: str | None = None,
    hub_msg_id: str | None = None,
    created_at: datetime.datetime | None = None,
    ext: dict[str, Any] | None = None,
) -> dict[str, Any]:
    event_time = created_at or datetime.datetime.now(datetime.timezone.utc)
    return {
        "type": type,
        "agent_id": agent_id,
        "room_id": room_id,
        "hub_msg_id": hub_msg_id,
        "created_at": event_time.isoformat(),
        "ext": ext or {},
    }


def _message_preview(payload: dict[str, Any]) -> str:
    return (payload.get("text") or payload.get("message") or "")[:160]


def build_message_realtime_event(
    *,
    type: str,
    agent_id: str,
    sender_id: str,
    room_id: str | None,
    hub_msg_id: str,
    created_at: datetime.datetime | None = None,
    topic_id: str | None = None,
    mentioned: bool = False,
    payload: dict[str, Any] | None = None,
    sender_name: str | None = None,
) -> dict[str, Any]:
    return build_agent_realtime_event(
        type=type,
        agent_id=agent_id,
        room_id=room_id,
        hub_msg_id=hub_msg_id,
        created_at=created_at,
        ext={
            "sender_id": sender_id,
            "sender_name": sender_name,
            "topic_id": topic_id,
            "preview": _message_preview(payload or {}),
            "mentioned": mentioned,
        },
    )


def build_receipt_realtime_event(
    *,
    type: str,
    agent_id: str,
    sender_id: str,
    room_id: str | None,
    hub_msg_id: str,
    created_at: datetime.datetime | None = None,
    topic_id: str | None = None,
    reply_to: str | None = None,
) -> dict[str, Any]:
    return build_agent_realtime_event(
        type=type,
        agent_id=agent_id,
        room_id=room_id,
        hub_msg_id=hub_msg_id,
        created_at=created_at,
        ext={
            "sender_id": sender_id,
            "topic_id": topic_id,
            "reply_to": reply_to,
        },
    )


def build_contact_event(
    *,
    type: str,
    agent_id: str,
    hub_msg_id: str,
    created_at: datetime.datetime | None = None,
    ext: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return build_agent_realtime_event(
        type=type,
        agent_id=agent_id,
        hub_msg_id=hub_msg_id,
        created_at=created_at,
        ext=ext,
    )


async def _publish_agent_realtime_event(
    db: AsyncSession,
    event: dict[str, Any],
) -> None:
    try:
        await db.execute(
            text(
                "select realtime.send(cast(:payload as jsonb), :event, :topic, true)"
            ),
            {
                "payload": json.dumps(event),
                "event": event["type"],
                "topic": build_agent_realtime_topic(event["agent_id"]),
            },
        )
        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.warning(
            "Supabase realtime publish skipped for agent=%s type=%s err=%s",
            event.get("agent_id"),
            event.get("type"),
            exc,
        )


async def notify_inbox(
    agent_id: str,
    *,
    db: AsyncSession | None = None,
    realtime_event: dict[str, Any] | None = None,
) -> None:
    """Wake up any long-polling readers and WebSocket connections waiting on this agent's inbox."""
    # Wake long-polling readers
    cond = _inbox_conditions.get(agent_id)
    if cond:
        async with cond:
            cond.notify_all()

    # Notify WebSocket connections
    ws_set = _ws_connections.get(agent_id)
    if ws_set:
        # Iterate a snapshot to avoid concurrent modification
        dead: list[WebSocket] = []
        for ws in list(ws_set):
            try:
                await ws.send_json({"type": "inbox_update"})
            except (WebSocketDisconnect, RuntimeError) as exc:
                # Permanent disconnect — mark connection as dead
                logger.debug(
                    "WS send failed (disconnect) for agent=%s: %s",
                    agent_id,
                    exc,
                )
                dead.append(ws)
            except Exception as exc:
                # Transient or unknown error — log warning but keep connection alive
                logger.warning(
                    "WS send failed (transient) for agent=%s: %s",
                    agent_id,
                    exc,
                )
        for ws in dead:
            ws_set.discard(ws)
        if not ws_set:
            _ws_connections.pop(agent_id, None)

    if db is not None and realtime_event is not None:
        await _publish_agent_realtime_event(db, realtime_event)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _check_rate_limit(agent_id: str, target_id: str | None = None) -> None:
    """Sliding-window rate limit (in-memory, per-worker). Raises 429.

    Checks two levels:
    1. Global: RATE_LIMIT_PER_MINUTE per agent (default 20/min)
    2. Per-pair: PAIR_RATE_LIMIT_PER_MINUTE per (sender, target) (default 5/min)
    """
    now = time.monotonic()

    # --- Global per-agent limit ---
    window = _rate_windows[agent_id]
    while window and window[0] <= now - 60:
        window.popleft()
    if len(window) >= RATE_LIMIT_PER_MINUTE:
        raise I18nHTTPException(status_code=429, message_key="rate_limit_exceeded")
    window.append(now)

    # --- Per-pair limit (sender → target) ---
    if target_id:
        pair_key = (agent_id, target_id)
        pair_window = _pair_rate_windows[pair_key]
        while pair_window and pair_window[0] <= now - 60:
            pair_window.popleft()
        if len(pair_window) >= PAIR_RATE_LIMIT_PER_MINUTE:
            raise I18nHTTPException(
                status_code=429,
                message_key="conversation_rate_limit_exceeded",
                limit=PAIR_RATE_LIMIT_PER_MINUTE,
            )
        pair_window.append(now)


async def _verify_envelope(envelope: MessageEnvelope, db: AsyncSession) -> None:
    """Verify signature, payload hash, and timestamp. Raises HTTPException on failure."""
    # Timestamp check
    if not check_timestamp(envelope.ts):
        raise I18nHTTPException(status_code=400, message_key="timestamp_out_of_range")

    # Payload hash check
    if not verify_payload_hash(envelope.payload, envelope.payload_hash):
        raise I18nHTTPException(status_code=400, message_key="payload_hash_mismatch")

    # Fetch sender's active signing key by key_id
    result = await db.execute(
        select(SigningKey).where(
            SigningKey.key_id == envelope.sig.key_id,
            SigningKey.state == KeyState.active,
        )
    )
    signing_key = result.scalar_one_or_none()
    if signing_key is None:
        raise I18nHTTPException(status_code=400, message_key="signing_key_not_found_or_inactive")

    # Verify sender owns this key
    if signing_key.agent_id != envelope.from_:
        raise I18nHTTPException(status_code=400, message_key="key_does_not_belong_to_sender")

    # Extract base64 pubkey
    pubkey_b64 = signing_key.pubkey[len("ed25519:"):]
    if not verify_envelope_sig(envelope, pubkey_b64):
        raise I18nHTTPException(status_code=400, message_key="signature_verification_failed")


# ---------------------------------------------------------------------------
# Topic resolution helper
# ---------------------------------------------------------------------------


async def _resolve_or_create_topic(
    db: AsyncSession,
    room_id: str,
    effective_topic: str,
    sender_id: str,
    msg_type: MessageType | str,
    goal: str | None = None,
) -> str:
    """Resolve an existing Topic by (room_id, title) or auto-create one.

    Returns the topic_id. Also handles lifecycle transitions:
    - msg_type result → mark completed
    - msg_type error → mark failed
    - terminated + new goal → reactivate to open
    Increments message_count and updates updated_at.
    """
    now = datetime.datetime.now(datetime.timezone.utc)

    result = await db.execute(
        select(Topic).where(
            Topic.room_id == room_id,
            Topic.title == effective_topic,
        )
    )
    topic = result.scalar_one_or_none()
    just_created = False

    if topic is None:
        # Auto-create
        topic = Topic(
            topic_id=generate_topic_id(),
            room_id=room_id,
            title=effective_topic,
            status=TopicStatus.open,
            creator_id=sender_id,
            goal=goal,
            message_count=1,
            updated_at=now,
        )
        try:
            async with db.begin_nested():
                db.add(topic)
                await db.flush()
            just_created = True
        except IntegrityError:
            # Race condition: another request created it first
            result = await db.execute(
                select(Topic).where(
                    Topic.room_id == room_id,
                    Topic.title == effective_topic,
                )
            )
            topic = result.scalar_one()
            # Fall through to update logic below

    # Lifecycle transitions on existing topic (skip if just created)
    if not just_created:
        # If terminated and message has new goal → reactivate
        if (
            topic.status in (TopicStatus.completed, TopicStatus.failed, TopicStatus.expired)
            and goal
        ):
            topic.status = TopicStatus.open
            topic.goal = goal
            topic.closed_at = None

        # result/error messages terminate the topic
        if msg_type == MessageType.result and topic.status == TopicStatus.open:
            topic.status = TopicStatus.completed
            topic.closed_at = now
        elif msg_type == MessageType.error and topic.status == TopicStatus.open:
            topic.status = TopicStatus.failed
            topic.closed_at = now

        topic.message_count = (topic.message_count or 0) + 1
        topic.updated_at = now

    return topic.topic_id


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


async def _ensure_dm_room(
    sender_id: str, receiver_id: str, db: AsyncSession
) -> str:
    """Ensure the DM room exists for a pair of agents. Return room_id.

    Note: Admission policy (message_policy) is enforced by the caller
    (_send_direct_message) before this function is called.
    """
    ids = sorted([sender_id, receiver_id])
    room_id = f"rm_dm_{ids[0]}_{ids[1]}"

    result = await db.execute(
        select(Room).where(Room.room_id == room_id)
    )
    if result.scalar_one_or_none() is not None:
        return room_id

    room = Room(
        room_id=room_id,
        name=f"DM {ids[0]} & {ids[1]}",
        owner_id=sender_id,
        visibility="private",
        join_policy="invite_only",
        max_members=2,
        default_send=True,
    )
    try:
        async with db.begin_nested():
            db.add(room)
            await db.flush()
    except IntegrityError:
        return room_id

    for aid in ids:
        db.add(RoomMember(room_id=room_id, agent_id=aid, role=RoomRole.member))
    await db.flush()

    return room_id


async def _send_direct_message(
    envelope: MessageEnvelope,
    request: Request,
    db: AsyncSession,
    topic: str | None = None,
    goal: str | None = None,
) -> SendResponse:
    """Handle sending a message to a single agent."""
    # Check receiver exists
    result = await db.execute(
        select(Agent).where(Agent.agent_id == envelope.to)
    )
    receiver = result.scalar_one_or_none()
    if receiver is None:
        raise I18nHTTPException(status_code=404, message_key="unknown_agent")

    # Block check: receiver blocked sender?
    block_result = await db.execute(
        select(Block).where(
            Block.owner_id == envelope.to,
            Block.blocked_agent_id == envelope.from_,
        )
    )
    if block_result.scalar_one_or_none() is not None:
        raise I18nHTTPException(status_code=403, message_key="blocked")

    # Policy check: contacts_only requires sender in receiver's contact list
    # contact_request type bypasses this check
    if receiver.message_policy == MessagePolicy.contacts_only:
        if envelope.type != MessageType.contact_request:
            contact_result = await db.execute(
                select(Contact).where(
                    Contact.owner_id == envelope.to,
                    Contact.contact_agent_id == envelope.from_,
                )
            )
            if contact_result.scalar_one_or_none() is None:
                raise I18nHTTPException(status_code=403, message_key="not_in_contacts")

    # Handle contact_request: create/update ContactRequest record
    if envelope.type == MessageType.contact_request:
        # Self-request not allowed
        if envelope.from_ == envelope.to:
            raise I18nHTTPException(status_code=400, message_key="cannot_send_contact_request_to_self")

        # Check if already in contacts
        contact_result = await db.execute(
            select(Contact).where(
                Contact.owner_id == envelope.to,
                Contact.contact_agent_id == envelope.from_,
            )
        )
        if contact_result.scalar_one_or_none() is not None:
            raise I18nHTTPException(status_code=409, message_key="already_in_contacts")

        # Check existing request
        existing_result = await db.execute(
            select(ContactRequest).where(
                ContactRequest.from_agent_id == envelope.from_,
                ContactRequest.to_agent_id == envelope.to,
            )
        )
        existing_req = existing_result.scalar_one_or_none()
        if existing_req is not None:
            if existing_req.state == ContactRequestState.pending:
                raise I18nHTTPException(status_code=409, message_key="contact_request_already_pending")
            elif existing_req.state == ContactRequestState.rejected:
                # Allow re-request: reset to pending
                existing_req.state = ContactRequestState.pending
                existing_req.resolved_at = None
                existing_req.message = envelope.payload.get("message")
            elif existing_req.state == ContactRequestState.accepted:
                raise I18nHTTPException(status_code=409, message_key="contact_request_already_accepted")
        else:
            cr = ContactRequest(
                from_agent_id=envelope.from_,
                to_agent_id=envelope.to,
                state=ContactRequestState.pending,
                message=envelope.payload.get("message"),
            )
            db.add(cr)
            await db.flush()

    # Resolve room_id: contact_request messages don't create a DM room
    room_id: str | None = None
    if envelope.type != MessageType.contact_request:
        room_id = await _ensure_dm_room(envelope.from_, envelope.to, db)

    # Resolve topic entity
    topic_id: str | None = None
    if topic and room_id:
        topic_id = await _resolve_or_create_topic(
            db, room_id, topic, envelope.from_, envelope.type, goal=goal,
        )

    # Create message record (dedup via unique (msg_id, receiver_id))
    hub_msg_id = generate_hub_msg_id()
    envelope_json = json.dumps(envelope.model_dump(by_alias=True))
    record = MessageRecord(
        hub_msg_id=hub_msg_id,
        msg_id=envelope.msg_id,
        sender_id=envelope.from_,
        receiver_id=envelope.to,
        room_id=room_id,
        topic=topic,
        topic_id=topic_id,
        goal=goal,
        state=MessageState.queued,
        envelope_json=envelope_json,
        ttl_sec=envelope.ttl_sec,
        mentioned=True,
    )
    try:
        async with db.begin_nested():
            db.add(record)
            await db.flush()
    except IntegrityError:
        # Duplicate — return existing record
        result = await db.execute(
            select(MessageRecord).where(
                MessageRecord.msg_id == envelope.msg_id,
                MessageRecord.receiver_id == envelope.to,
            )
        )
        existing = result.scalar_one()
        return SendResponse(
            queued=True,
            hub_msg_id=existing.hub_msg_id,
            status=existing.state.value,
            topic_id=existing.topic_id,
        )

    await db.commit()

    # Resolve sender display name for realtime event
    _sender_name_result = await db.execute(
        select(Agent.display_name).where(Agent.agent_id == envelope.from_)
    )
    _sender_display_name = _sender_name_result.scalar_one_or_none()

    # Notify inbox listeners
    await notify_inbox(
        envelope.to,
        db=db,
        realtime_event=build_message_realtime_event(
            type=envelope.type.value,
            agent_id=envelope.to,
            sender_id=envelope.from_,
            room_id=room_id,
            hub_msg_id=record.hub_msg_id,
            created_at=record.created_at,
            topic_id=topic_id,
            mentioned=True,
            payload=envelope.payload,
            sender_name=_sender_display_name,
        ),
    )

    return SendResponse(
        queued=True,
        hub_msg_id=record.hub_msg_id,
        status="queued",
        topic_id=topic_id,
    )


def _can_send(room: Room, member: RoomMember) -> bool:
    """Check if a member can send messages in a room.

    Resolution order:
      1. owner → always True (cannot be overridden)
      2. member.can_send is not None → use explicit per-member value
      3. admin → default True
      4. room.default_send
    """
    if member.role == RoomRole.owner:
        return True
    if member.can_send is not None:
        return member.can_send
    if member.role == RoomRole.admin:
        return True
    return room.default_send


def _check_slow_mode(room: Room, member: RoomMember) -> None:
    """Enforce slow mode interval. Owner/admin are exempt. Raises 429.

    Does NOT update the last-send timestamp — call _record_slow_mode_send()
    after all pre-send checks pass to avoid penalising rejected messages.
    """
    if not room.slow_mode_seconds:
        return
    if member.role in (RoomRole.owner, RoomRole.admin):
        return
    key = (room.room_id, member.agent_id)
    now = time.monotonic()
    last = _slow_mode_last_send.get(key)
    if last is not None:
        elapsed = now - last
        remaining = room.slow_mode_seconds - elapsed
        if remaining > 0:
            raise I18nHTTPException(
                status_code=429,
                message_key="slow_mode_wait",
                remaining=f"{remaining:.0f}",
            )


def _record_slow_mode_send(room_id: str, agent_id: str) -> None:
    """Record the timestamp after a room message passes all checks."""
    _slow_mode_last_send[(room_id, agent_id)] = time.monotonic()


def _check_duplicate_content(room_id: str, sender_id: str, payload: dict) -> None:
    """Reject consecutive identical messages from the same sender in a room. Raises 429."""
    key = (room_id, sender_id)
    payload_bytes = json.dumps(payload, sort_keys=True).encode()
    content_hash = hashlib.sha256(payload_bytes).hexdigest()
    if _last_msg_hash.get(key) == content_hash:
        raise I18nHTTPException(status_code=429, message_key="duplicate_content")
    _last_msg_hash[key] = content_hash


async def _send_room_message(
    envelope: MessageEnvelope,
    request: Request,
    db: AsyncSession,
    topic: str | None = None,
    goal: str | None = None,
) -> SendResponse:
    """Handle sending a message to a room (fan-out to all members except sender)."""
    room_id = envelope.to

    # Load room with members
    result = await db.execute(
        select(Room)
        .where(Room.room_id == room_id)
        .options(selectinload(Room.members))
    )
    room = result.scalar_one_or_none()
    if room is None:
        raise I18nHTTPException(status_code=404, message_key="room_not_found")

    # Verify sender is a member
    sender_member = None
    for m in room.members:
        if m.agent_id == envelope.from_:
            sender_member = m
            break
    if sender_member is None:
        raise I18nHTTPException(status_code=403, message_key="not_a_member")

    # Permission check
    if not _can_send(room, sender_member):
        raise I18nHTTPException(status_code=403, message_key="only_owner_admin_can_post")

    # Slow mode check (owner/admin exempt)
    _check_slow_mode(room, sender_member)

    # Duplicate content check
    _check_duplicate_content(room_id, envelope.from_, envelope.payload)

    # All anti-spam checks passed — record timestamp for slow mode
    _record_slow_mode_send(room_id, envelope.from_)

    # Block check: find members who have blocked the sender
    block_result = await db.execute(
        select(Block.owner_id).where(
            Block.owner_id.in_({m.agent_id for m in room.members}),
            Block.blocked_agent_id == envelope.from_,
        )
    )
    blocked_by = {row[0] for row in block_result.all()}

    # Resolve topic entity (once, before fan-out)
    topic_id: str | None = None
    if topic:
        topic_id = await _resolve_or_create_topic(
            db, room_id, topic, envelope.from_, envelope.type, goal=goal,
        )

    # Fan-out: create a MessageRecord for each member except sender, skip muted and blockers
    receivers = {
        m.agent_id for m in room.members
        if m.agent_id != envelope.from_ and not m.muted and m.agent_id not in blocked_by
    }

    # Resolve sender display name for realtime events
    _sender_name_result = await db.execute(
        select(Agent.display_name).where(Agent.agent_id == envelope.from_)
    )
    _sender_display_name = _sender_name_result.scalar_one_or_none()

    # When the sender is the only member (or all others are muted/blocking),
    # receivers would be empty.  Create a self-delivery record so the message
    # appears in room history, but skip inbox notification to avoid the plugin
    # re-processing its own message.
    _self_delivery = False
    if not receivers:
        receivers = {envelope.from_}
        _self_delivery = True

    logger.info(
        "ROOM fan-out msg_id=%s from=%s room=%s topic=%s receivers=%s owner_chat_self=%s",
        envelope.msg_id, envelope.from_, room_id, topic, receivers, _self_delivery,
    )
    envelope_json = json.dumps(envelope.model_dump(by_alias=True))

    first_hub_msg_id: str | None = None
    receiver_hub_msg_ids: dict[str, str] = {}

    # Parse mention set for per-receiver tagging
    mentioned_set = set(envelope.mentions) if envelope.mentions else set()

    for receiver_id in receivers:
        hub_msg_id = generate_hub_msg_id()
        if first_hub_msg_id is None:
            first_hub_msg_id = hub_msg_id
        receiver_hub_msg_ids[receiver_id] = hub_msg_id

        is_mentioned = bool(mentioned_set) and (
            receiver_id in mentioned_set or "@all" in mentioned_set
        )

        # Self-delivery records are marked as 'delivered' immediately so they
        # never appear in the agent's inbox poll.  They exist solely for room
        # history queries.
        _is_self_delivery = _self_delivery and receiver_id == envelope.from_
        record = MessageRecord(
            hub_msg_id=hub_msg_id,
            msg_id=envelope.msg_id,
            sender_id=envelope.from_,
            receiver_id=receiver_id,
            room_id=room_id,
            topic=topic,
            topic_id=topic_id,
            goal=goal,
            state=MessageState.delivered if _is_self_delivery else MessageState.queued,
            envelope_json=envelope_json,
            ttl_sec=envelope.ttl_sec,
            mentioned=is_mentioned,
        )
        try:
            async with db.begin_nested():
                db.add(record)
                await db.flush()
        except IntegrityError:
            result = await db.execute(
                select(MessageRecord).where(
                    MessageRecord.msg_id == envelope.msg_id,
                    MessageRecord.receiver_id == receiver_id,
                )
            )
            existing = result.scalar_one()
            if first_hub_msg_id is None:
                first_hub_msg_id = existing.hub_msg_id
            receiver_hub_msg_ids[receiver_id] = existing.hub_msg_id
            continue

    await db.commit()

    # Notify all receivers
    for receiver_id in receivers:
        rt_event = build_message_realtime_event(
            type=envelope.type.value,
            agent_id=receiver_id,
            sender_id=envelope.from_,
            room_id=envelope.to,
            hub_msg_id=receiver_hub_msg_ids.get(receiver_id, first_hub_msg_id),
            topic_id=topic_id,
            mentioned=receiver_id in (envelope.mentions or []) or "@all" in (envelope.mentions or []),
            payload=envelope.payload,
            sender_name=_sender_display_name,
        )
        if _self_delivery and receiver_id == envelope.from_:
            # Self-delivery: publish realtime event for the dashboard
            # frontend but do NOT wake the agent's inbox/WS to avoid
            # the plugin re-processing its own message.
            # Skip Supabase realtime for owner-chat rooms — the dedicated
            # WS path handles delivery; publishing here would cause
            # redundant polling from the Supabase realtime listener.
            if not room_id.startswith("rm_oc_"):
                await _publish_agent_realtime_event(db, rt_event)
        else:
            await notify_inbox(receiver_id, db=db, realtime_event=rt_event)

    # Push agent reply to owner-chat WS clients when applicable
    if _self_delivery and room_id.startswith("rm_oc_"):
        from hub.routers.owner_chat_ws import notify_oc_ws_message
        _oc_text = (envelope.payload or {}).get("text", "")
        await notify_oc_ws_message(
            room_id=room_id,
            hub_msg_id=first_hub_msg_id or "",
            sender_id=envelope.from_,
            text=_oc_text,
        )

    # Notify the sender's dashboard so the frontend refreshes in real-time
    # when the agent posts via plugin/API. Skip if self-delivery already
    # handled it above, and skip for DM where sender == receiver.
    if not _self_delivery and envelope.from_ not in receivers:
        sender_rt_event = build_message_realtime_event(
            type=envelope.type.value,
            agent_id=envelope.from_,
            sender_id=envelope.from_,
            room_id=envelope.to,
            hub_msg_id=first_hub_msg_id,
            topic_id=topic_id,
            mentioned=False,
            payload=envelope.payload,
            sender_name=_sender_display_name,
        )
        await _publish_agent_realtime_event(db, sender_rt_event)

    if first_hub_msg_id is None:
        return SendResponse(
            queued=False,
            hub_msg_id=generate_hub_msg_id(),
            status="no_receivers",
            topic_id=topic_id,
        )
    return SendResponse(
        queued=True,
        hub_msg_id=first_hub_msg_id,
        status="queued",
        topic_id=topic_id,
    )


@router.post("/send", response_model=SendResponse, status_code=202)
async def send_message(
    envelope: MessageEnvelope,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
    topic: str | None = Query(default=None),
):
    """Accept a message, verify it, attempt delivery or queue."""
    # Sender must match JWT
    if envelope.from_ != current_agent:
        raise I18nHTTPException(status_code=403, message_key="sender_does_not_match_token")

    # Allowed types: message, contact_request, result, error
    # result/error are topic termination signals that need room fan-out
    _SEND_ALLOWED_TYPES = (
        MessageType.message,
        MessageType.contact_request,
        MessageType.result,
        MessageType.error,
    )
    if envelope.type not in _SEND_ALLOWED_TYPES:
        raise I18nHTTPException(status_code=400, message_key="send_invalid_type")

    # Topic priority: envelope > query param
    effective_topic = envelope.topic or topic

    # Log send action
    payload_preview = json.dumps(envelope.payload, ensure_ascii=False)[:200]
    logger.info(
        "SEND from=%s to=%s type=%s msg_id=%s topic=%s goal=%s payload=%s",
        envelope.from_, envelope.to, envelope.type, envelope.msg_id,
        effective_topic, envelope.goal, payload_preview,
    )

    # Rate limit (counts as 1 regardless of fan-out)
    _check_rate_limit(current_agent, target_id=envelope.to)

    # Verify envelope
    await _verify_envelope(envelope, db)

    # Scan for prompt injection patterns (log-only, never block).
    # Check payload text (same fallback order as to_text()), plus topic/goal
    # which also appear in the rendered prompt.
    _pi_fields: list[str] = []
    if isinstance(envelope.payload, dict):
        _payload_text = (
            envelope.payload.get("text")
            or envelope.payload.get("body")
            or envelope.payload.get("message")
            or ""
        )
        if isinstance(_payload_text, str) and _payload_text:
            _pi_fields.append(_payload_text)
    for _extra in (envelope.topic, envelope.goal):
        if isinstance(_extra, str) and _extra:
            _pi_fields.append(_extra)
    if _pi_fields:
        _pi_combined = "\n".join(_pi_fields)
        risk, patterns = scan_content(_pi_combined)
        if risk != InjectionRisk.none:
            logger.warning(
                "prompt_injection_detected: sender=%s risk=%s msg_id=%s patterns=%s",
                envelope.from_,
                risk.value,
                envelope.msg_id,
                patterns,
            )

    # Branch: room / direct message
    if envelope.to.startswith("rm_"):
        return await _send_room_message(envelope, request, db, topic=effective_topic, goal=envelope.goal)
    else:
        return await _send_direct_message(envelope, request, db, topic=effective_topic, goal=envelope.goal)


@router.post("/receipt", response_model=ReceiptResponse)
async def receive_receipt(
    envelope: MessageEnvelope,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Accept ack/result/error receipt, update message record, forward to sender."""
    logger.info(
        "RECEIPT from=%s type=%s reply_to=%s msg_id=%s",
        envelope.from_, envelope.type, envelope.reply_to, envelope.msg_id,
    )
    if envelope.type not in (MessageType.ack, MessageType.result, MessageType.error):
        raise I18nHTTPException(status_code=400, message_key="receipt_invalid_type")

    # Verify envelope signature
    await _verify_envelope(envelope, db)

    # Find original message record via reply_to
    if not envelope.reply_to:
        raise I18nHTTPException(status_code=400, message_key="receipt_must_have_reply_to")

    result = await db.execute(
        select(MessageRecord).where(
            MessageRecord.msg_id == envelope.reply_to,
            MessageRecord.receiver_id == envelope.from_,
        )
    )
    record = result.scalar_one_or_none()
    if record is None:
        raise I18nHTTPException(status_code=404, message_key="original_message_not_found")

    # Update state based on receipt type
    now = datetime.datetime.now(datetime.timezone.utc)
    if envelope.type == MessageType.ack:
        record.state = MessageState.acked
        record.acked_at = now
    elif envelope.type == MessageType.result:
        record.state = MessageState.done
        record.acked_at = record.acked_at or now
    elif envelope.type == MessageType.error:
        record.state = MessageState.failed
        error_msg = envelope.payload.get("error", {}).get("code", "UNKNOWN")
        record.last_error = error_msg

    # Inherit topic_id from original record
    receipt_topic_id = record.topic_id

    # Update Topic entity status if result/error receipt and topic exists
    receipt_topic = envelope.topic or record.topic
    if receipt_topic_id and record.room_id and envelope.type in (MessageType.result, MessageType.error):
        topic_result = await db.execute(
            select(Topic).where(Topic.topic_id == receipt_topic_id)
        )
        topic_entity = topic_result.scalar_one_or_none()
        if topic_entity and topic_entity.status == TopicStatus.open:
            if envelope.type == MessageType.result:
                topic_entity.status = TopicStatus.completed
                topic_entity.closed_at = now
            elif envelope.type == MessageType.error:
                topic_entity.status = TopicStatus.failed
                topic_entity.closed_at = now
            topic_entity.message_count = (topic_entity.message_count or 0) + 1
            topic_entity.updated_at = now

    # Queue receipt forwarding to sender's inbox
    receipt_hub_msg_id = generate_hub_msg_id()
    receipt_json = json.dumps(envelope.model_dump(by_alias=True))
    # Carry topic/goal from the envelope (or inherit from original message)
    receipt_record = MessageRecord(
        hub_msg_id=receipt_hub_msg_id,
        msg_id=envelope.msg_id,
        sender_id=envelope.from_,
        receiver_id=record.sender_id,
        room_id=record.room_id,
        topic=receipt_topic,
        topic_id=receipt_topic_id,
        goal=envelope.goal,
        state=MessageState.queued,
        envelope_json=receipt_json,
        ttl_sec=envelope.ttl_sec,
    )
    try:
        async with db.begin_nested():
            db.add(receipt_record)
            await db.flush()
    except IntegrityError:
        return ReceiptResponse(received=True)

    await db.commit()

    # Notify sender that receipt is available in their inbox
    await notify_inbox(
        record.sender_id,
        db=db,
        realtime_event=build_receipt_realtime_event(
            type=envelope.type.value,
            agent_id=record.sender_id,
            sender_id=envelope.from_,
            room_id=record.room_id,
            hub_msg_id=receipt_record.hub_msg_id,
            created_at=receipt_record.created_at,
            topic_id=receipt_topic_id,
            reply_to=envelope.reply_to,
        ),
    )

    return ReceiptResponse(received=True)


@router.get("/status/{msg_id}", response_model=MessageStatusResponse)
async def get_message_status(
    msg_id: str,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
):
    """Query delivery status. Only the sender may query."""
    # Check message exists first (404), then check authorization (403)
    result = await db.execute(
        select(MessageRecord).where(MessageRecord.msg_id == msg_id)
    )
    all_records = list(result.scalars().all())
    if not all_records:
        raise I18nHTTPException(status_code=404, message_key="message_not_found")

    # Filter to records where current agent is the sender
    sender_records = [r for r in all_records if r.sender_id == current_agent]
    if not sender_records:
        raise I18nHTTPException(status_code=403, message_key="not_the_sender")

    record = sender_records[0]

    def _ts(dt: datetime.datetime | None) -> int | None:
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return int(dt.timestamp())

    ca = record.created_at
    if ca.tzinfo is None:
        ca = ca.replace(tzinfo=datetime.timezone.utc)

    return MessageStatusResponse(
        msg_id=record.msg_id,
        state=record.state.value,
        created_at=int(ca.timestamp()),
        delivered_at=_ts(record.delivered_at),
        acked_at=_ts(record.acked_at),
        last_error=record.last_error,
    )


# ---------------------------------------------------------------------------
# GET /hub/inbox — polling (with optional long-poll)
# ---------------------------------------------------------------------------


def _build_delivery_note(last_error: str | None) -> str | None:
    """Convert last_error into a human-readable delivery diagnostic note."""
    if not last_error:
        return None
    notes = {
        "TTL_EXPIRED": "消息在队列中过期，接收方未及时拉取。",
    }
    return notes.get(last_error)


async def _fetch_queued_messages(
    db: AsyncSession, agent_id: str, limit: int, room_id: str | None = None
) -> list[MessageRecord]:
    """Return up to *limit* queued messages for *agent_id*, ordered oldest first.

    Uses FOR UPDATE SKIP LOCKED on PostgreSQL to prevent concurrent polls from
    claiming the same rows. Falls back to a plain SELECT on SQLite (tests).
    """
    stmt = (
        select(MessageRecord)
        .where(
            MessageRecord.receiver_id == agent_id,
            MessageRecord.state == MessageState.queued,
        )
        .order_by(MessageRecord.created_at.asc())
        .limit(limit)
    )
    if room_id is not None:
        stmt = stmt.where(MessageRecord.room_id == room_id)
    # Atomic claim: skip rows already locked by a concurrent poll
    dialect = db.bind.dialect.name if db.bind else ""
    if dialect == "postgresql":
        stmt = stmt.with_for_update(skip_locked=True)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/inbox", response_model=InboxPollResponse)
async def poll_inbox(
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_dashboard_claimed_agent),
    limit: int = Query(default=10, ge=1, le=50),
    timeout: int = Query(default=0, ge=0, le=INBOX_POLL_MAX_TIMEOUT),
    ack: bool = Query(default=True),
    room_id: str | None = Query(default=None),
):
    """Poll for queued messages. Supports long-polling via *timeout* (seconds)."""
    # Fetch limit+1 to know if there are more
    rows = await _fetch_queued_messages(db, current_agent, limit + 1, room_id=room_id)

    # Long-poll: if nothing found and timeout > 0, wait for notification
    if not rows and timeout > 0:
        cond = _inbox_conditions.get(current_agent)
        if cond is None:
            cond = asyncio.Condition()
            _inbox_conditions[current_agent] = cond
        try:
            async with cond:
                await asyncio.wait_for(cond.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
        # Clean up to prevent unbounded memory growth
        _inbox_conditions.pop(current_agent, None)
        # Re-query after wakeup / timeout
        rows = await _fetch_queued_messages(db, current_agent, limit + 1, room_id=room_id)

    has_more = len(rows) > limit
    rows = rows[:limit]

    # Batch-load room context for all room messages
    all_room_ids = {rec.room_id for rec in rows if rec.room_id}
    room_info_map: dict[str, dict] = {}
    if all_room_ids:
        room_result = await db.execute(
            select(Room)
            .where(Room.room_id.in_(all_room_ids))
            .options(selectinload(Room.members))
        )
        for rm in room_result.scalars().all():
            member_ids = [m.agent_id for m in rm.members]
            agent_result = await db.execute(
                select(Agent.agent_id, Agent.display_name).where(
                    Agent.agent_id.in_(member_ids)
                )
            )
            agent_map = dict(agent_result.all())
            # Find current agent's membership for permission context
            my_role = None
            my_can_send = None
            for m in rm.members:
                if m.agent_id == current_agent:
                    my_role = m.role.value
                    my_can_send = _can_send(rm, m)
                    break
            room_info_map[rm.room_id] = {
                "name": rm.name,
                "rule": rm.rule,
                "member_count": len(rm.members),
                "member_names": [agent_map.get(aid, aid) for aid in member_ids],
                "my_role": my_role,
                "my_can_send": my_can_send,
            }

    # Batch-load sender display names
    sender_ids = {rec.sender_id for rec in rows if rec.sender_id}
    sender_name_map: dict[str, str | None] = {}
    if sender_ids:
        sender_result = await db.execute(
            select(Agent.agent_id, Agent.display_name).where(
                Agent.agent_id.in_(sender_ids)
            )
        )
        sender_name_map = dict(sender_result.all())

    # Batch-load dashboard user display names
    dashboard_user_ids = {
        rec.source_user_id
        for rec in rows
        if rec.source_type == "dashboard_user_chat" and rec.source_user_id
    }
    user_name_map: dict[str, str | None] = {}
    if dashboard_user_ids:
        user_result = await db.execute(
            select(User.supabase_user_id, User.display_name).where(
                User.supabase_user_id.in_(dashboard_user_ids)
            )
        )
        user_name_map = {str(uid): name for uid, name in user_result.all()}

    # Build response
    messages: list[InboxMessage] = []
    now = datetime.datetime.now(datetime.timezone.utc)
    for rec in rows:
        envelope_data = json.loads(rec.envelope_json)
        envelope = MessageEnvelope(**envelope_data)
        ri = room_info_map.get(rec.room_id) if rec.room_id else None

        # Build RoomContext for build_flat_text
        room_ctx = None
        if ri:
            room_ctx = _RoomContext(
                room_id=rec.room_id,
                name=ri["name"],
                member_count=ri["member_count"],
                rule=ri.get("rule"),
                member_names=ri["member_names"],
                my_role=ri.get("my_role"),
                my_can_send=ri.get("my_can_send"),
            )

        flat_text = _build_flat_text(
            envelope,
            sender_display_name=sender_name_map.get(rec.sender_id),
            room_context=room_ctx,
            mentioned=rec.mentioned,
            topic_id=rec.topic_id,
            include_sender=rec.source_type != "dashboard_user_chat",
        )

        messages.append(
            InboxMessage(
                hub_msg_id=rec.hub_msg_id,
                envelope=envelope,
                text=flat_text,
                room_id=rec.room_id,
                room_name=ri["name"] if ri else None,
                room_rule=ri.get("rule") if ri else None,
                room_member_count=ri["member_count"] if ri else None,
                room_member_names=ri["member_names"] if ri else None,
                my_role=ri.get("my_role") if ri else None,
                my_can_send=ri.get("my_can_send") if ri else None,
                topic=rec.topic,
                topic_id=rec.topic_id,
                goal=rec.goal,
                delivery_note=_build_delivery_note(rec.last_error),
                mentioned=rec.mentioned,
                source_type=rec.source_type,
                source_user_id=rec.source_user_id,
                source_user_name=user_name_map.get(rec.source_user_id) if rec.source_user_id else None,
                source_session_kind=rec.source_session_kind,
            )
        )
        if ack:
            rec.state = MessageState.delivered
            rec.delivered_at = now
            rec.next_retry_at = None  # prevent retry loop from picking it up
        else:
            # Two-phase ack: mark as processing so concurrent polls skip them.
            # Set next_retry_at as the processing timeout — the expiry loop will
            # revert stale processing records back to queued after this time.
            rec.state = MessageState.processing
            rec.next_retry_at = now + datetime.timedelta(seconds=120)

    if messages:
        await db.commit()

    return InboxPollResponse(
        messages=messages,
        count=len(messages),
        has_more=has_more,
    )


# ---------------------------------------------------------------------------
# POST /hub/inbox/ack — explicit message acknowledgement
# ---------------------------------------------------------------------------


@router.post("/inbox/ack", response_model=InboxAckResponse)
async def ack_inbox_messages(
    body: InboxAckRequest,
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_dashboard_claimed_agent),
):
    """Acknowledge specific messages by ID, marking them as delivered."""
    if not body.message_ids:
        return InboxAckResponse(acked=0)

    # Fetch processing (two-phase ack) or queued messages belonging to the agent
    stmt = (
        select(MessageRecord)
        .where(
            MessageRecord.receiver_id == current_agent,
            MessageRecord.hub_msg_id.in_(body.message_ids),
            MessageRecord.state.in_([MessageState.processing, MessageState.queued]),
        )
    )
    result = await db.execute(stmt)
    rows = list(result.scalars().all())

    if not rows:
        return InboxAckResponse(acked=0)

    now = datetime.datetime.now(datetime.timezone.utc)
    for rec in rows:
        rec.state = MessageState.delivered
        rec.delivered_at = now
        rec.next_retry_at = None

    await db.commit()
    logger.info(
        "Acked %d messages for agent=%s (requested %d)",
        len(rows),
        current_agent,
        len(body.message_ids),
    )
    return InboxAckResponse(acked=len(rows))


# ---------------------------------------------------------------------------
# GET /hub/history — chat history query
# ---------------------------------------------------------------------------


@router.get("/history", response_model=HistoryResponse)
async def query_history(
    db: AsyncSession = Depends(get_db),
    current_agent: str = Depends(get_current_claimed_agent),
    room_id: str | None = Query(default=None),
    topic: str | None = Query(default=None),
    topic_id: str | None = Query(default=None),
    peer: str | None = Query(default=None),
    before: str | None = Query(default=None),
    after: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
):
    """Query chat history. Returns messages where the current agent is sender or receiver."""
    from sqlalchemy import or_, and_

    # Optional: room_id filter with access control
    # For public rooms, members can see ALL room history (not just their own fan-out records).
    is_public_room = False
    if room_id is not None:
        # Load room + verify membership
        room_result = await db.execute(
            select(Room).where(Room.room_id == room_id)
        )
        room_obj = room_result.scalar_one_or_none()
        if room_obj is None:
            raise I18nHTTPException(status_code=404, message_key="room_not_found")

        member_result = await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room_id,
                RoomMember.agent_id == current_agent,
            )
        )
        if member_result.scalar_one_or_none() is None:
            raise I18nHTTPException(
                status_code=403,
                message_key="not_a_member",
            )
        is_public_room = room_obj.visibility == RoomVisibility.public

    if is_public_room:
        # Public room: show all messages in the room, not just the current agent's.
        # De-duplicate fan-out by selecting only the lowest-id record per msg_id.
        min_id_subq = (
            select(func.min(MessageRecord.id).label("min_id"))
            .where(
                MessageRecord.room_id == room_id,
                MessageRecord.state != MessageState.failed,
            )
            .group_by(MessageRecord.msg_id)
            .subquery()
        )
        stmt = select(MessageRecord).where(
            MessageRecord.id.in_(select(min_id_subq.c.min_id))
        )
    else:
        # Private room or no room_id: only show messages where current agent is sender or receiver
        stmt = select(MessageRecord).where(
            or_(
                MessageRecord.sender_id == current_agent,
                MessageRecord.receiver_id == current_agent,
            ),
            MessageRecord.state != MessageState.failed,
        )
        if room_id is not None:
            stmt = stmt.where(MessageRecord.room_id == room_id)

    # Optional: topic filter
    if topic is not None:
        stmt = stmt.where(MessageRecord.topic == topic)

    # Optional: topic_id filter
    if topic_id is not None:
        stmt = stmt.where(MessageRecord.topic_id == topic_id)

    # Optional: peer filter (only meaningful for non-public-room queries)
    if peer is not None and not is_public_room:
        stmt = stmt.where(
            or_(
                and_(
                    MessageRecord.sender_id == current_agent,
                    MessageRecord.receiver_id == peer,
                ),
                and_(
                    MessageRecord.sender_id == peer,
                    MessageRecord.receiver_id == current_agent,
                ),
            )
        )
    elif peer is not None and is_public_room:
        # In public room, filter by sender_id to find messages from a specific peer
        stmt = stmt.where(MessageRecord.sender_id == peer)

    # Cursor pagination using auto-increment id for stable ordering
    if before is not None:
        cursor_result = await db.execute(
            select(MessageRecord).where(MessageRecord.hub_msg_id == before)
        )
        cursor_rec = cursor_result.scalar_one_or_none()
        if cursor_rec is None:
            raise I18nHTTPException(status_code=400, message_key="invalid_cursor")
        stmt = stmt.where(MessageRecord.id < cursor_rec.id)
        stmt = stmt.order_by(MessageRecord.id.desc())
    elif after is not None:
        cursor_result = await db.execute(
            select(MessageRecord).where(MessageRecord.hub_msg_id == after)
        )
        cursor_rec = cursor_result.scalar_one_or_none()
        if cursor_rec is None:
            raise I18nHTTPException(status_code=400, message_key="invalid_cursor")
        stmt = stmt.where(MessageRecord.id > cursor_rec.id)
        stmt = stmt.order_by(MessageRecord.id.asc())
    else:
        stmt = stmt.order_by(MessageRecord.id.desc())

    # Fetch limit+1 for has_more detection
    stmt = stmt.limit(limit + 1)
    result = await db.execute(stmt)
    rows = list(result.scalars().all())

    has_more = len(rows) > limit
    rows = rows[:limit]

    messages: list[HistoryMessage] = []
    for rec in rows:
        envelope_data = json.loads(rec.envelope_json)
        ca = rec.created_at
        if ca is not None and ca.tzinfo is None:
            ca = ca.replace(tzinfo=datetime.timezone.utc)
        messages.append(
            HistoryMessage(
                hub_msg_id=rec.hub_msg_id,
                envelope=MessageEnvelope(**envelope_data),
                room_id=rec.room_id,
                topic=rec.topic,
                topic_id=rec.topic_id,
                goal=rec.goal,
                state=rec.state.value,
                created_at=ca,
                mentioned=rec.mentioned,
            )
        )

    return HistoryResponse(
        messages=messages,
        count=len(messages),
        has_more=has_more,
    )


# ---------------------------------------------------------------------------
# WebSocket /hub/ws — real-time inbox push
# ---------------------------------------------------------------------------

_WS_HEARTBEAT_INTERVAL = 30  # seconds


@router.websocket("/ws")
async def websocket_inbox(ws: WebSocket):
    """WebSocket endpoint for real-time inbox notifications.

    Protocol:
      1. Client connects to /hub/ws
      2. Client sends: {"type": "auth", "token": "<JWT>"}
      3. Server replies: {"type": "auth_ok", "agent_id": "ag_xxx"}
         or closes with 4001 on auth failure
      4. Server sends {"type": "inbox_update"} when new messages arrive
      5. Client fetches messages via GET /hub/inbox (reuses existing REST API)
      6. Server sends {"type": "heartbeat"} every 30s to keep connection alive
    """
    await ws.accept()
    agent_id: str | None = None

    try:
        # --- Auth phase: expect {"type": "auth", "token": "..."} ---
        try:
            auth_data = await asyncio.wait_for(ws.receive_json(), timeout=10)
        except asyncio.TimeoutError:
            await ws.close(code=4001, reason="Auth timeout")
            return

        token = auth_data.get("token", "")
        if not token:
            await ws.close(code=4001, reason="Missing token")
            return

        try:
            agent_id = verify_agent_token(token)
        except Exception:
            await ws.close(code=4001, reason="Invalid token")
            return

        await ws.send_json({"type": "auth_ok", "agent_id": agent_id})
        logger.info("WebSocket connected: agent=%s", agent_id)

        # --- Register this connection ---
        if agent_id not in _ws_connections:
            _ws_connections[agent_id] = set()
        _ws_connections[agent_id].add(ws)

        # --- Main loop: heartbeat + listen for client messages ---
        while True:
            try:
                # Wait for client message or heartbeat timeout
                msg = await asyncio.wait_for(
                    ws.receive_json(), timeout=_WS_HEARTBEAT_INTERVAL
                )
                # Handle client messages (ping/pong, future extensions)
                if msg.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
            except asyncio.TimeoutError:
                # No client message within interval — send heartbeat
                await ws.send_json({"type": "heartbeat"})

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected: agent=%s", agent_id)
    except Exception as e:
        logger.warning("WebSocket error: agent=%s err=%s", agent_id, e)
    finally:
        # --- Cleanup ---
        if agent_id:
            ws_set = _ws_connections.get(agent_id)
            if ws_set:
                ws_set.discard(ws)
                if not ws_set:
                    _ws_connections.pop(agent_id, None)
