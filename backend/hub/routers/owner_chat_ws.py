"""Owner-chat WebSocket — real-time user-agent chat with streamed execution blocks."""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import re
import time
import uuid
from collections import deque
from typing import Sequence

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import (
    get_current_agent,
    verify_supabase_token,
    _resolve_internal_user_id,
)
from hub.database import get_db, async_session
from hub.id_generators import generate_hub_msg_id
from hub.models import Agent, MessageRecord, MessageState
from hub.routers.dashboard_chat import (
    _build_owner_chat_room_id,
    _ensure_owner_chat_room,
    _OWNER_CHAT_ROOM_PREFIX,
)
from hub.routers.hub import (
    notify_inbox,
    build_message_realtime_event,
)

import jwt as pyjwt

logger = logging.getLogger(__name__)

router = APIRouter(tags=["owner-chat-ws"])

_WS_HEARTBEAT_INTERVAL = 30  # seconds

# Maximum stream blocks per trace before auto-discarding (W7: unbounded buffer)
_MAX_STREAM_BLOCKS_PER_TRACE = 200

# Strict regex for attachment URLs — must match /hub/files/f_{id}
_FILE_URL_RE = re.compile(r"^/hub/files/f_[a-zA-Z0-9_-]+$")

# ---------------------------------------------------------------------------
# In-memory connection & trace state
# ---------------------------------------------------------------------------

# Owner-chat WS connections: (user_id, agent_id) -> set[WebSocket]
_oc_ws_connections: dict[tuple[str, str], set[WebSocket]] = {}

# Stream block routing: trace_id -> (user_id, agent_id)
_oc_trace_subs: dict[str, tuple[str, str]] = {}

# Track block count per trace_id to enforce cap (W7)
_oc_trace_block_count: dict[str, int] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _register_ws(user_id: str, agent_id: str, ws: WebSocket) -> None:
    key = (user_id, agent_id)
    if key not in _oc_ws_connections:
        _oc_ws_connections[key] = set()
    _oc_ws_connections[key].add(ws)


def _unregister_ws(user_id: str, agent_id: str, ws: WebSocket) -> None:
    key = (user_id, agent_id)
    ws_set = _oc_ws_connections.get(key)
    if ws_set:
        ws_set.discard(ws)
        if not ws_set:
            _oc_ws_connections.pop(key, None)

    # W3: Clean up any trace subscriptions for this user/agent pair
    # when the last WS connection goes away.
    if not _oc_ws_connections.get(key):
        stale = [tid for tid, sub in _oc_trace_subs.items() if sub == key]
        for tid in stale:
            _oc_trace_subs.pop(tid, None)
            _oc_trace_block_count.pop(tid, None)


async def _send_to_oc_ws(
    user_id: str, agent_id: str, data: dict,
) -> None:
    """Send a JSON message to all owner-chat WS connections for (user_id, agent_id)."""
    key = (user_id, agent_id)
    ws_set = _oc_ws_connections.get(key)
    if not ws_set:
        return
    # W4: Snapshot the set to avoid mutation during async iteration.
    snapshot = list(ws_set)
    dead: list[WebSocket] = []
    for ws in snapshot:
        try:
            await ws.send_json(data)
        except Exception as exc:
            logger.warning(
                "Owner-chat WS send failed: user=%s agent=%s err=%s",
                user_id, agent_id, exc,
            )
            dead.append(ws)
    for ws in dead:
        ws_set.discard(ws)
    if not ws_set:
        _oc_ws_connections.pop(key, None)


def _cleanup_trace(trace_id: str) -> None:
    """Remove a trace subscription and its block counter."""
    _oc_trace_subs.pop(trace_id, None)
    _oc_trace_block_count.pop(trace_id, None)


# Retry backoff schedule (seconds) for notify_inbox when no WS connections are active.
_NOTIFY_RETRY_DELAYS: Sequence[float] = (1, 2, 4, 8)


async def _notify_inbox_with_retry(agent_id: str) -> None:
    """Background task: retry notify_inbox until the agent's WS reconnects or retries exhaust."""
    for delay in _NOTIFY_RETRY_DELAYS:
        await asyncio.sleep(delay)
        notified = await notify_inbox(agent_id)
        if notified > 0:
            logger.info("Owner-chat notify retry succeeded: agent=%s after %.0fs", agent_id, delay)
            return
    logger.warning(
        "Owner-chat notify retries exhausted: agent=%s (message awaits next poll)",
        agent_id,
    )


async def notify_oc_ws_message(
    *,
    room_id: str,
    hub_msg_id: str,
    sender_id: str,
    text: str,
    created_at: datetime.datetime | None = None,
) -> None:
    """Push an agent reply to connected owner-chat WS clients.

    Called from the room fan-out path when a message lands in an rm_oc_* room.
    Also cleans up any matching trace subscription.
    """
    target_keys: list[tuple[str, str]] = []
    for (uid, aid), ws_set in _oc_ws_connections.items():
        if ws_set and _build_owner_chat_room_id(uid, aid) == room_id:
            target_keys.append((uid, aid))

    if not target_keys:
        return

    ts = (
        created_at.isoformat() if created_at
        else datetime.datetime.now(datetime.timezone.utc).isoformat()
    )

    # W1: Pop ALL traces for the matching user/agent pairs, not just the first.
    # Attach the most recent one as trace_id in the message ext.
    matched_traces: list[str] = []
    for tid, sub in list(_oc_trace_subs.items()):
        if sub in target_keys:
            matched_traces.append(tid)

    # Use the most recent trace_id (last added)
    trace_id: str | None = matched_traces[-1] if matched_traces else None

    # Clean up all matched traces
    for tid in matched_traces:
        _cleanup_trace(tid)

    msg_data = {
        "type": "message",
        "hub_msg_id": hub_msg_id,
        "sender": "agent",
        "room_id": room_id,
        "text": text,
        "created_at": ts,
    }
    if trace_id:
        msg_data["ext"] = {"trace_id": trace_id}

    for uid, aid in target_keys:
        await _send_to_oc_ws(uid, aid, msg_data)


async def notify_oc_ws_typing(*, agent_id: str, room_id: str) -> None:
    """Push a typing indicator to owner-chat WS clients for a given agent.

    Called from POST /hub/typing fan-out when the target has an active
    owner-chat WS connection.  This lets the frontend show the typing
    indicator without waiting for Supabase Realtime.
    """
    # Snapshot keys to avoid RuntimeError if _send_to_oc_ws mutates the dict.
    targets = [
        (uid, aid)
        for (uid, aid), ws_set in _oc_ws_connections.items()
        if ws_set and aid == agent_id and _build_owner_chat_room_id(uid, aid) == room_id
    ]
    for uid, aid in targets:
        await _send_to_oc_ws(uid, aid, {"type": "typing", "room_id": room_id})


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@router.websocket("/dashboard/chat/ws")
async def owner_chat_ws(ws: WebSocket):
    """WebSocket for owner-chat real-time messaging and execution block streaming.

    Protocol:
      1. Client connects
      2. Client sends: {"type": "auth", "token": "<supabase_jwt>", "agent_id": "<ag_xxx>"}
      3. Server replies: {"type": "auth_ok", "agent_id": "...", "room_id": "..."}
      4. Client sends: {"type": "send", "text": "..."}
      5. Server echoes: {"type": "message", "sender": "user", ...}
      6. Server streams: {"type": "stream_block", ...} from plugin
      7. Server delivers: {"type": "message", "sender": "agent", ...} for final reply
    """
    # W5: Check Origin header before accepting the upgrade.
    # Allow same-origin and configured frontend origin; reject unknown origins.
    origin = ws.headers.get("origin")
    if origin:
        from hub.config import FRONTEND_BASE_URL
        allowed_origins: set[str] = set()
        if FRONTEND_BASE_URL:
            allowed_origins.add(FRONTEND_BASE_URL.rstrip("/"))
        # Always allow localhost for development
        allowed_origins.add("http://localhost:3000")
        allowed_origins.add("http://localhost:8000")
        if origin.rstrip("/") not in allowed_origins:
            await ws.close(code=4003, reason="Origin not allowed")
            return

    await ws.accept()
    agent_id: str | None = None
    user_id: str | None = None

    try:
        # --- Auth phase ---
        try:
            auth_data = await asyncio.wait_for(ws.receive_json(), timeout=10)
        except asyncio.TimeoutError:
            await ws.close(code=4001, reason="Auth timeout")
            return

        token = auth_data.get("token", "")
        req_agent_id = auth_data.get("agent_id", "")
        if not token or not req_agent_id:
            await ws.close(code=4001, reason="Missing token or agent_id")
            return

        # Verify Supabase JWT and resolve ownership
        try:
            supabase_uid = verify_supabase_token(token)
        except Exception as exc:
            logger.error("Owner-chat WS auth failed: %s: %s", type(exc).__name__, exc)
            await ws.close(code=4001, reason="Invalid token")
            return

        async with async_session() as db:
            internal_uid = await _resolve_internal_user_id(db, supabase_uid)
            if not internal_uid:
                await ws.close(code=4001, reason="User not found")
                return

            result = await db.execute(
                select(Agent).where(Agent.agent_id == req_agent_id)
            )
            agent = result.scalar_one_or_none()
            if not agent or agent.claimed_at is None:
                await ws.close(code=4001, reason="Agent not found or not claimed")
                return
            if str(agent.user_id) != internal_uid:
                await ws.close(code=4001, reason="Agent not owned by user")
                return

            agent_id = req_agent_id
            user_id = internal_uid
            display_name = agent.display_name or agent_id

            # Ensure owner-chat room exists
            room_id = await _ensure_owner_chat_room(db, user_id, agent_id, display_name)
            await db.commit()

        await ws.send_json({
            "type": "auth_ok",
            "agent_id": agent_id,
            "room_id": room_id,
        })
        logger.info("Owner-chat WS connected: user=%s agent=%s room=%s", user_id, agent_id, room_id)

        # --- Register connection ---
        _register_ws(user_id, agent_id, ws)

        # --- Main loop ---
        while True:
            try:
                msg = await asyncio.wait_for(
                    ws.receive_json(), timeout=_WS_HEARTBEAT_INTERVAL,
                )
            except asyncio.TimeoutError:
                await ws.send_json({"type": "heartbeat"})
                continue

            msg_type = msg.get("type")

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "send":
                text = (msg.get("text") or "").strip()
                client_msg_id = msg.get("client_msg_id") or None

                # Optional attachments (pre-uploaded via /api/dashboard/upload)
                raw_atts = msg.get("attachments") or []
                attachments: list[dict] = []
                skipped_atts = 0
                for att in raw_atts[:10]:
                    if isinstance(att, dict) and att.get("url") and att.get("filename"):
                        url_str = str(att["url"])
                        # Only allow /hub/files/f_* URLs — reject arbitrary external links
                        if not _FILE_URL_RE.match(url_str):
                            skipped_atts += 1
                            continue
                        attachments.append({
                            k: v for k, v in {
                                "filename": str(att["filename"])[:200],
                                "url": url_str,
                                "content_type": str(att["content_type"]) if att.get("content_type") else None,
                                "size_bytes": att.get("size_bytes") if isinstance(att.get("size_bytes"), int) else None,
                            }.items() if v is not None
                        })

                if skipped_atts > 0:
                    logger.warning(
                        "Owner-chat WS: skipped %d invalid attachment(s) for user=%s agent=%s",
                        skipped_atts, user_id, agent_id,
                    )

                # Must have text or attachments
                if not text and not attachments:
                    err_resp: dict = {"type": "error", "message": "Message must contain text or attachments"}
                    if client_msg_id:
                        err_resp["client_msg_id"] = str(client_msg_id)[:64]
                    await ws.send_json(err_resp)
                    continue
                if len(text) > 4000:
                    err_resp2: dict = {"type": "error", "message": "Text too long"}
                    if client_msg_id:
                        err_resp2["client_msg_id"] = str(client_msg_id)[:64]
                    await ws.send_json(err_resp2)
                    continue

                logger.info("Owner-chat WS recv: user=%s agent=%s text_len=%d attachments=%d", user_id, agent_id, len(text), len(attachments))

                # Create MessageRecord (same logic as dashboard_chat.send_chat_message)
                msg_id = str(uuid.uuid4())
                ts = int(time.time())
                payload: dict = {"text": text}
                if attachments:
                    payload["attachments"] = attachments
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
                )

                async with async_session() as db:
                    try:
                        async with db.begin_nested():
                            db.add(record)
                            await db.flush()
                    except IntegrityError as exc:
                        logger.warning(
                            "Owner-chat duplicate message: agent=%s msg_id=%s err=%s",
                            agent_id, msg_id, exc,
                        )
                        await ws.send_json({"type": "error", "message": "Duplicate message"})
                        continue

                    await db.commit()

                    # Register trace subscription so streamed blocks route here
                    _oc_trace_subs[hub_msg_id] = (user_id, agent_id)
                    _oc_trace_block_count[hub_msg_id] = 0

                    # Notify plugin inbox
                    notified = await notify_inbox(
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
                            sender_name=display_name,
                        ),
                    )
                    logger.info(
                        "Owner-chat WS forwarded: hub_msg_id=%s agent=%s room=%s ws_notified=%d",
                        hub_msg_id, agent_id, room_id, notified,
                    )

                    # If no active WS connections, spawn background retry so the
                    # plugin picks up the message when it reconnects shortly.
                    if notified == 0:
                        logger.warning(
                            "Owner-chat: no active WS for agent=%s, scheduling notify retry",
                            agent_id,
                        )
                        asyncio.create_task(_notify_inbox_with_retry(agent_id))

                # Echo user message back
                now = datetime.datetime.now(datetime.timezone.utc).isoformat()
                echo: dict = {
                    "type": "message",
                    "hub_msg_id": hub_msg_id,
                    "sender": "user",
                    "room_id": room_id,
                    "text": text,
                    "created_at": now,
                }
                if client_msg_id:
                    echo["client_msg_id"] = str(client_msg_id)[:64]
                if attachments:
                    echo["ext"] = {"attachments": attachments}
                await ws.send_json(echo)

    except WebSocketDisconnect:
        logger.info("Owner-chat WS disconnected: user=%s agent=%s", user_id, agent_id)
    except Exception as e:
        logger.error("Owner-chat WS error: user=%s agent=%s err=%s", user_id, agent_id, e, exc_info=True)
    finally:
        if user_id and agent_id:
            _unregister_ws(user_id, agent_id, ws)


# ---------------------------------------------------------------------------
# Stream block HTTP endpoint (called by plugin)
# ---------------------------------------------------------------------------


class StreamBlockBody(BaseModel):
    trace_id: str = Field(..., max_length=48)
    seq: int = Field(..., ge=1)
    block: dict


@router.post("/hub/stream-block", status_code=204)
async def receive_stream_block(
    body: StreamBlockBody,
    agent_id: str = Depends(get_current_agent),
):
    """Receive a streamed execution block from the plugin and forward to owner-chat WS."""
    sub = _oc_trace_subs.get(body.trace_id)
    if not sub:
        return

    user_id, sub_agent_id = sub
    if sub_agent_id != agent_id:
        return

    # W7: Enforce per-trace block count cap.
    count = _oc_trace_block_count.get(body.trace_id, 0)
    if count >= _MAX_STREAM_BLOCKS_PER_TRACE:
        return
    _oc_trace_block_count[body.trace_id] = count + 1

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    await _send_to_oc_ws(user_id, sub_agent_id, {
        "type": "stream_block",
        "trace_id": body.trace_id,
        "seq": body.seq,
        "block": body.block,
        "created_at": now,
    })


# ---------------------------------------------------------------------------
# Notify owner HTTP endpoint (called by plugin)
# ---------------------------------------------------------------------------


class NotifyOwnerBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


# Rate limit: max 10 notify-owner calls per minute per agent
_NOTIFY_OWNER_RATE_LIMIT = 10
_notify_owner_windows: dict[str, deque[float]] = {}


@router.post("/hub/notify-owner", status_code=204)
async def notify_owner(
    body: NotifyOwnerBody,
    agent_id: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Push a notification to the agent's owner via owner-chat WebSocket.

    The plugin calls this when the agent uses botcord_notify so the owner
    also sees the notification in the dashboard chat, in addition to any
    external channel (Telegram, Discord, etc.).

    Best-effort delivery: if the owner has no active WebSocket connection,
    the notification is silently dropped (not persisted).
    """
    # Sliding-window rate limit
    now_mono = time.monotonic()
    window = _notify_owner_windows.setdefault(agent_id, deque())
    while window and window[0] <= now_mono - 60:
        window.popleft()
    if len(window) >= _NOTIFY_OWNER_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Notify rate limit exceeded")
    window.append(now_mono)

    # Look up the agent's bound user
    result = await db.execute(
        select(Agent).where(Agent.agent_id == agent_id)
    )
    agent = result.scalar_one_or_none()
    if not agent or not agent.user_id:
        # Agent not bound to a user — silently skip
        return

    user_id = str(agent.user_id)
    room_id = _build_owner_chat_room_id(user_id, agent_id)
    text = body.text.strip()

    # Persist notification as a MessageRecord so it survives page refresh
    msg_id = str(uuid.uuid4())
    ts = int(time.time())
    payload = {"text": text}
    envelope_data = {
        "v": "a2a/0.1",
        "msg_id": msg_id,
        "ts": ts,
        "from": agent_id,
        "to": agent_id,
        "type": "notification",
        "reply_to": None,
        "ttl_sec": 3600,
        "payload": payload,
        "payload_hash": "",
        "sig": {"alg": "ed25519", "key_id": "agent", "value": ""},
    }
    envelope_json = json.dumps(envelope_data)

    hub_msg_id = generate_hub_msg_id()
    record = MessageRecord(
        hub_msg_id=hub_msg_id,
        msg_id=msg_id,
        sender_id=agent_id,
        receiver_id=agent_id,
        room_id=room_id,
        state=MessageState.delivered,
        envelope_json=envelope_json,
        ttl_sec=3600,
        source_type="agent_notification",
    )

    try:
        async with db.begin_nested():
            db.add(record)
            await db.flush()
        await db.commit()
    except IntegrityError:
        logger.warning(
            "Notify-owner duplicate message: agent=%s msg_id=%s",
            agent_id, msg_id,
        )
        await db.rollback()

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    await _send_to_oc_ws(user_id, agent_id, {
        "type": "notification",
        "hub_msg_id": hub_msg_id,
        "text": text,
        "created_at": now,
    })
