"""
[INPUT]: Inbound / outbound / owner-chat / gateway events on a Cloud Agent.
[OUTPUT]: Stamp ``cloud_agent_instances.last_active_at`` so the idle-pause
          sweep recognizes ongoing use.
[POS]: Sits between the routers and ``hub.services.cloud_agent`` —
       routers call ``maybe_bump_*`` helpers; the sweep reads the column
       via ``_cloud_agent_last_activity_at``.
[PROTOCOL]: All helpers are best-effort; they swallow lookup / commit
            failures because dropping an activity stamp must never abort
            the host request. The cost of a dropped stamp is one extra
            idle-pause cycle, not data loss.
"""

from __future__ import annotations

import datetime
import logging
from typing import Iterable

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import AttentionMode, MessageType
from hub.models import Agent, CloudAgentInstance
from hub.policy import resolve_effective_attention

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Attention judgement (hub-side mirror of protocol-core/should-wake)
# ---------------------------------------------------------------------------


# Receipt-only envelope types that never wake a runtime — they only update
# delivery state on the sender's side. We exclude these from the inbound
# activity bump so a busy "result/error/ack" loop doesn't keep a sandbox
# alive indefinitely.
_NON_WAKING_MESSAGE_TYPES: frozenset[str] = frozenset(
    {
        MessageType.ack.value,
        MessageType.result.value,
        MessageType.error.value,
        MessageType.contact_request_response.value,
        MessageType.contact_removed.value,
    }
)


async def would_wake_runtime(
    db: AsyncSession,
    *,
    receiver: Agent,
    room_id: str | None,
    text: str | None,
    mentioned: bool,
    sender_id: str | None,
    message_type: str | None,
) -> bool:
    """Return True iff an inbound message would wake ``receiver``'s runtime.

    Hub-side mirror of ``packages/protocol-core/src/should-wake.ts`` so the
    idle-pause sweep can agree with the daemon's attention gate without
    round-tripping through the sandbox. Fail-open on unknown modes so a
    forward-compat policy from a newer Hub doesn't silently silence the
    activity signal.
    """
    if message_type and message_type in _NON_WAKING_MESSAGE_TYPES:
        return False

    eff = await resolve_effective_attention(db, agent=receiver, room_id=room_id)
    now = datetime.datetime.now(datetime.timezone.utc)

    if eff.muted_until is not None and eff.muted_until > now:
        return False

    if eff.mode == AttentionMode.muted:
        return False
    if eff.mode == AttentionMode.always:
        return True
    if eff.mode == AttentionMode.mention_only:
        return bool(mentioned)
    if eff.mode == AttentionMode.keyword:
        if not text or not eff.keywords:
            return False
        low = text.lower()
        return any(kw and kw.lower() in low for kw in eff.keywords)
    if eff.mode == AttentionMode.allowed_senders:
        if not sender_id:
            return False
        return sender_id in eff.allowed_sender_ids

    return True


# ---------------------------------------------------------------------------
# Bump helpers
# ---------------------------------------------------------------------------


async def _stamp_active(db: AsyncSession, agent_id: str) -> bool:
    """Issue the UPDATE that bumps ``last_active_at``. Returns ``True`` when
    a cloud_agent_instances row exists for ``agent_id``."""
    now = datetime.datetime.now(datetime.timezone.utc)
    result = await db.execute(
        update(CloudAgentInstance)
        .where(CloudAgentInstance.agent_id == agent_id)
        .values(last_active_at=now)
    )
    return bool(result.rowcount)


async def bump_if_cloud_agent(db: AsyncSession, agent_id: str | None) -> None:
    """Stamp ``last_active_at`` for ``agent_id`` when the underlying Agent
    is cloud-hosted. Other agents (daemon / openclaw / cli) are no-ops.

    Used by:
      * outbound /hub/send (sender is a cloud agent actively working)
      * owner-chat send + reply (user actively driving the agent)
      * gateway control frames (user actively binding a gateway)
    """
    if not agent_id:
        return
    try:
        agent = await db.scalar(
            select(Agent).where(Agent.agent_id == agent_id)
        )
        if agent is None or agent.hosting_kind != "cloud":
            return
        bumped = await _stamp_active(db, agent_id)
        if not bumped:
            # Cloud-hosted Agent rows must always have a paired
            # cloud_agent_instances row; if missing, the agent was probably
            # deleted mid-flight. Log and move on.
            logger.debug(
                "cloud activity bump: no instance row for cloud agent %s",
                agent_id,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "cloud activity bump failed: agent=%s err=%s",
            agent_id,
            exc,
        )


async def maybe_bump_for_inbound(
    db: AsyncSession,
    *,
    receiver_id: str,
    sender_id: str | None,
    room_id: str | None,
    text: str | None,
    mentioned: bool,
    message_type: str | None,
) -> None:
    """Inbound messages count as activity only when the agent's attention
    policy would actually wake the runtime (design §4.2).

    Failing to stamp a real wake just causes one extra idle-pause cycle —
    cheap. Stamping when the agent will not wake would defeat the whole
    point of attention gating, so we err on the side of *not* stamping
    when the policy is unclear.
    """
    if not receiver_id:
        return
    try:
        agent = await db.scalar(
            select(Agent).where(Agent.agent_id == receiver_id)
        )
        if agent is None or agent.hosting_kind != "cloud":
            return
        if not await would_wake_runtime(
            db,
            receiver=agent,
            room_id=room_id,
            text=text,
            mentioned=mentioned,
            sender_id=sender_id,
            message_type=message_type,
        ):
            return
        await _stamp_active(db, receiver_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "cloud activity bump (inbound) failed: receiver=%s err=%s",
            receiver_id,
            exc,
        )


async def maybe_bump_for_inbound_many(
    db: AsyncSession,
    *,
    receiver_ids: Iterable[str],
    sender_id: str | None,
    room_id: str | None,
    text: str | None,
    mentioned_set: set[str] | None,
    message_type: str | None,
) -> None:
    """Room fan-out variant: one ``would_wake_runtime`` evaluation per
    receiver. Receivers outside ``mentioned_set`` (and ``@all`` if present)
    are treated as not mentioned."""
    if not receiver_ids:
        return
    has_all_mention = bool(mentioned_set and "@all" in mentioned_set)
    for rid in receiver_ids:
        per_mentioned = has_all_mention or (
            bool(mentioned_set) and rid in mentioned_set
        )
        await maybe_bump_for_inbound(
            db,
            receiver_id=rid,
            sender_id=sender_id,
            room_id=room_id,
            text=text,
            mentioned=per_mentioned,
            message_type=message_type,
        )
