"""Per-message wake + execution decision for the inbox (docs/access-graph-model.md §4–§5, PR 4).

For every message delivered to an agent the Hub answers two questions and
ships the answer as ``InboxMessage.hub_decision``:

* ``wake`` — should the message wake the agent (attention / reply rules)?
* ``profile`` — how far may this message make the agent act:
  ``full`` | ``collaborator`` | ``consult`` | ``deny``.

Daemons that understand ``hub_decision`` execute it as-is (local config may
only tighten); older daemons ignore the field and keep their legacy behavior.
"""

from __future__ import annotations

import datetime
import json
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import AttentionMode
from hub.models import PUBLIC_PRINCIPAL_ID, AccessEdge, Agent, AgentSenderReplyRule
from hub.policy import EffectiveAttention, resolve_effective_attention
from hub.services.access_decide import decide_execution_many

OWNER_CHAT_PREFIX = "rm_oc_"
DM_PREFIX = "rm_dm_"
# source_type values that identify owner-issued inbound (mirrors the daemon).
OWNER_SOURCE_TYPES = {"dashboard_user_chat", "cloud_agent_run", "botcord_schedule", "cloud_gateway_ingress"}
_RANK = {"deny": 0, "consult": 1, "collaborator": 2, "full": 3}
_GRANT_PROFILE = {"collaborator": "collaborator", "consultant": "consult"}


@dataclass
class InboxItem:
    hub_msg_id: str
    sender_id: str
    room_id: str | None
    source_type: str | None
    mentioned: bool
    text: str


def _aware(ts):
    if ts is not None and ts.tzinfo is None:
        return ts.replace(tzinfo=datetime.timezone.utc)
    return ts


def _keywords(raw: str | None) -> list[str]:
    try:
        parsed = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []
    return [str(x) for x in parsed if isinstance(x, str)] if isinstance(parsed, list) else []


def scan_mention(text: str, agent_id: str, display_name: str | None) -> bool:
    """Same rule as the daemon's local scan: ``(ag_x)``, ``@ag_x`` or ``@<display name>``."""
    lower = (text or "").lower()
    if not lower:
        return False
    aid = agent_id.strip().lower()
    if f"({aid})" in lower or f"@{aid}" in lower:
        return True
    name = (display_name or "").strip().lower()
    return bool(name) and f"@{name}" in lower


def should_wake(eff: EffectiveAttention, *, mentioned: bool, text: str, sender_id: str,
                now: datetime.datetime) -> tuple[bool, str]:
    """Port of protocol-core ``shouldWake`` returning (wake, reason)."""
    if eff.muted_until is not None and _aware(eff.muted_until) > now:
        return False, "muted"
    mode = eff.mode.value if isinstance(eff.mode, AttentionMode) else str(eff.mode)
    if mode == "always":
        return True, "always"
    if mode == "mention_only":
        return (True, "mentioned") if mentioned else (False, "mention_required")
    if mode == "keyword":
        lower = (text or "").lower()
        hit = any(kw and kw.lower() in lower for kw in eff.keywords)
        return (True, "keyword") if hit else (False, "keyword_missing")
    if mode == "allowed_senders":
        return (True, "allowed_sender") if sender_id in eff.allowed_sender_ids else (False, "sender_not_allowed")
    return True, "unknown_mode"


def _rule_attention(rule: AgentSenderReplyRule, base: EffectiveAttention) -> EffectiveAttention:
    muted = _aware(rule.muted_until)
    return EffectiveAttention(
        mode=rule.attention_mode,
        keywords=_keywords(rule.keywords) if rule.keywords is not None else list(base.keywords),
        allowed_sender_ids=list(base.allowed_sender_ids),
        muted_until=muted,
        source="override",
    )


async def _attention_for(db: AsyncSession, agent: Agent, room_id: str | None, sender_id: str,
                         rules: dict[tuple[str, str], AgentSenderReplyRule],
                         cache: dict[str | None, EffectiveAttention]) -> EffectiveAttention:
    if room_id not in cache:
        cache[room_id] = await resolve_effective_attention(db, agent=agent, room_id=room_id)
    base = cache[room_id]
    if base.source == "dm_forced":
        return base
    if (rule := rules.get((sender_id, room_id or ""))) is not None and room_id:
        return _rule_attention(rule, base)
    if base.source == "override":
        return base
    if (rule := rules.get((sender_id, ""))) is not None:
        return _rule_attention(rule, base)
    return base


async def decide_inbox(
    db: AsyncSession, *, agent: Agent, items: list[InboxItem], access_contexts: dict[str, dict],
    now: datetime.datetime | None = None,
) -> dict[str, dict]:
    """Return ``hub_msg_id -> {"wake", "wake_reason", "profile", "basis"}``."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if not items:
        return {}
    senders = {i.sender_id for i in items}
    paths = await decide_execution_many(db, agent_id=agent.agent_id, sender_ids=senders, now=now)

    rooms = {i.room_id for i in items if i.room_id}
    room_caps = {e.to_id: (e.capability or "consult") for e in (await db.scalars(select(AccessEdge).where(
        AccessEdge.kind == "member", AccessEdge.status == "active", AccessEdge.from_id == agent.agent_id,
        AccessEdge.to_id.in_(rooms)))).all()} if rooms else {}
    conn_caps = {e.from_id: (e.capability or "consult") for e in (await db.scalars(select(AccessEdge).where(
        AccessEdge.kind == "connection", AccessEdge.status == "active", AccessEdge.to_id == agent.agent_id,
        AccessEdge.from_id.in_(senders)))).all()}
    offer = await db.scalar(select(AccessEdge).where(
        AccessEdge.kind == "offer", AccessEdge.status == "active", AccessEdge.from_id == PUBLIC_PRINCIPAL_ID,
        AccessEdge.to_id == agent.agent_id))
    offer_cap = (offer.capability or "consult") if offer is not None and (offer.terms or {}).get("direct") else None
    rules = {(r.sender_id, r.room_scope): r for r in (await db.scalars(select(AgentSenderReplyRule).where(
        AgentSenderReplyRule.agent_id == agent.agent_id, AgentSenderReplyRule.sender_id.in_(senders)))).all()}

    attention_cache: dict[str | None, EffectiveAttention] = {}
    out: dict[str, dict] = {}
    for item in items:
        room = item.room_id or ""
        is_dm = room.startswith(DM_PREFIX)
        path = paths.get(item.sender_id)
        ctx = access_contexts.get(item.sender_id)

        if room.startswith(OWNER_CHAT_PREFIX) or (item.source_type in OWNER_SOURCE_TYPES):
            profile, basis = "full", "owner_channel"
        elif path is not None and path.reason == "ownership":
            profile, basis = "full", "owner"
        elif path is not None and path.reason == "grant":
            profile, basis = _GRANT_PROFILE.get(path.capability or "", "consult"), "grant"
        elif ctx is not None and not ctx.get("active") and (is_dm or room == ""):
            profile, basis = "deny", "grant_inactive"
        elif room and not is_dm:
            profile, basis = room_caps.get(room, "consult"), "room"
        else:
            options = [(c, b) for c, b in ((conn_caps.get(item.sender_id), "connection"), (offer_cap, "offer")) if c]
            profile, basis = max(options, key=lambda o: _RANK[o[0]]) if options else ("consult", "no_path")

        if room.startswith(OWNER_CHAT_PREFIX) or is_dm or not room:
            wake, wake_reason = True, "direct"
        else:
            eff = await _attention_for(db, agent, item.room_id, item.sender_id, rules, attention_cache)
            mentioned = item.mentioned or scan_mention(item.text, agent.agent_id, agent.display_name)
            wake, wake_reason = should_wake(eff, mentioned=mentioned, text=item.text,
                                            sender_id=item.sender_id, now=now)
        out[item.hub_msg_id] = {"wake": wake, "wake_reason": wake_reason, "profile": profile, "basis": basis}
    return out
