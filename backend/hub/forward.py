"""Shared helpers for envelope forwarding (used by hub router and retry loop)."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.constants import SESSION_KEY_NAMESPACE
from hub.models import Agent
from hub.schemas import MessageEnvelope


@dataclass
class RoomContext:
    """Lightweight room metadata attached to forwarded messages."""

    room_id: str
    name: str
    member_count: int
    rule: str | None = None
    member_names: list[str] = field(default_factory=list)
    my_role: str | None = None
    my_can_send: bool | None = None

_WAKE_TYPES = frozenset({"contact_request", "contact_request_response", "contact_removed"})

_INJECTION_PATTERNS = [
    (re.compile(r"<\/?\s*system(?:-reminder)?\s*>", re.IGNORECASE), "[⚠ stripped]"),
    (re.compile(r"<\|im_(?:start|end)\|>", re.IGNORECASE), "[⚠ stripped]"),
    (re.compile(r"\[/?INST\]", re.IGNORECASE), "[⚠ stripped]"),
    (re.compile(r"<</?SYS>>", re.IGNORECASE), "[⚠ stripped]"),
    (re.compile(r"<\s*\/?\|(?:system|user|assistant)\|?\s*>", re.IGNORECASE), "[⚠ stripped]"),
]


def _sanitize_room_rule(rule: str) -> str:
    """Strip common prompt-injection markers from a room rule string."""
    result = rule
    for pattern, replacement in _INJECTION_PATTERNS:
        result = pattern.sub(replacement, result)
    return result


def build_forward_url(base_url: str, envelope_type: str) -> str:
    """Append /botcord_inbox/agent or /botcord_inbox/wake sub-path based on envelope type."""
    base = base_url.rstrip("/")
    # Strip trailing sub-path if already present to avoid double-appending
    for suffix in ("/botcord_inbox/agent", "/botcord_inbox/wake"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    if envelope_type in _WAKE_TYPES:
        return f"{base}/botcord_inbox/wake"
    return f"{base}/botcord_inbox/agent"


def build_session_key(
    room_id: str | None = None,
    topic: str | None = None,
) -> str:
    """Derive a deterministic UUID v5 sessionKey from room_id and optional topic.

    Same (room_id, topic) pair always produces the same UUID — ensuring all
    messages in the same room/topic are routed to the same OpenClaw session.

    Fallback (no room_id) returns a fixed default UUID.
    """
    if room_id:
        seed = f"{room_id}:{topic}" if topic else room_id
    else:
        seed = "default"
    return f"botcord:{uuid.uuid5(SESSION_KEY_NAMESPACE, seed)}"


def _format_room_header(ctx: RoomContext) -> str:
    """Build a human-readable room context line, e.g. [群聊「My Room」(rm_xxx) | 3人: A, B, C | 权限: member, 可发言]."""
    parts = [f"群聊「{ctx.name}」({ctx.room_id})"]
    if ctx.member_names:
        names = ", ".join(ctx.member_names[:10])
        if len(ctx.member_names) > 10:
            names += f" 等{ctx.member_count}人"
        parts.append(f"{ctx.member_count}人: {names}")
    else:
        parts.append(f"{ctx.member_count}人")
    # Append permission info for the receiving agent
    if ctx.my_role is not None:
        can_send_label = "可发言" if ctx.my_can_send else "禁言中"
        parts.append(f"权限: {ctx.my_role}, {can_send_label}")
    return f"[{' | '.join(parts)}]"


def build_flat_text(
    envelope: MessageEnvelope,
    sender_display_name: str | None = None,
    room_context: RoomContext | None = None,
    mentioned: bool = False,
    topic_id: str | None = None,
) -> str:
    """Flatten an envelope into a human-readable string with optional room context.

    This is the single source of truth for message text rendering — used by both
    webhook delivery (convert_payload_for_openclaw) and inbox polling (/hub/inbox).
    """
    text = envelope.to_text(
        sender_name=sender_display_name,
        mentioned=mentioned,
        topic_id=topic_id,
    )
    prefix_lines: list[str] = []
    # Prepend room context header for group rooms (>2 members)
    if room_context and room_context.member_count > 2:
        prefix_lines.append(_format_room_header(room_context))
    if room_context and room_context.rule:
        sanitized_rule = _sanitize_room_rule(room_context.rule)
        prefix_lines.append(f"[房间规则] {sanitized_rule}")
        prefix_lines.append("[系统提示] 你在该群聊中的行为和回复必须遵循上述房间规则。")
    if prefix_lines:
        prefix_lines.append(text)
        text = "\n".join(prefix_lines)
    return text


def convert_payload_for_openclaw(
    forward_url: str,
    envelope: MessageEnvelope,
    sender_display_name: str | None = None,
    room_id: str | None = None,
    topic: str | None = None,
    topic_id: str | None = None,
    room_context: RoomContext | None = None,
) -> dict:
    """Convert a MessageEnvelope into the format expected by OpenClaw.

    - /agent path -> {"message": "...", "name": "...", "channel": "last", "sessionKey": "..."}
    - /wake  path -> {"body": "...", "mode": "now", "sessionKey": "..."}
    """
    text = build_flat_text(
        envelope,
        sender_display_name,
        room_context,
        topic_id=topic_id,
    )
    name = (
        f"{sender_display_name} ({envelope.from_})"
        if sender_display_name
        else envelope.from_
    )
    session_key = build_session_key(room_id=room_id, topic=topic)
    if forward_url.rstrip("/").endswith("/wake"):
        return {"body": text, "mode": "now", "sessionKey": session_key}
    return {"message": text, "name": name, "channel": "last", "sessionKey": session_key}


async def get_sender_display_name(agent_id: str, db: AsyncSession) -> str | None:
    """Look up agent display_name. Returns None if not found."""
    result = await db.execute(
        select(Agent.display_name).where(Agent.agent_id == agent_id)
    )
    return result.scalar_one_or_none()
