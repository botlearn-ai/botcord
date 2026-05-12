"""
[INPUT]: Agent admission policies (contact / room-invite) + sender identity
[OUTPUT]: check_direct_admission / check_room_invite_admission helpers
[POS]: Centralizes admission decisions previously scattered across hub.py /
       room.py / dashboard.py / humans.py — every call site delegates here so
       new policy axes (whitelist, closed, allow_*_sender) ship at one diff.
[PROTOCOL]: Raise I18nHTTPException(403, ...) on deny, return None on allow.
"""

import datetime
import json
from dataclasses import dataclass, field
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import (
    AttentionMode,
    ContactPolicy,
    MessagePolicy,
    MessageType,
    ParticipantType,
    RoomInvitePolicy,
)
from hub.i18n import I18nHTTPException
from hub.models import Agent, AgentRoomPolicyOverride, Block, Contact, RoomMember


@dataclass(frozen=True)
class Principal:
    """A polymorphic identity — Agents (ag_*) and Humans (hu_*) collide on the
    string id space, so callers must carry the discriminator explicitly."""

    id: str
    type: ParticipantType


async def _is_blocked(
    db: AsyncSession,
    *,
    owner_id: str,
    target: Principal,
) -> bool:
    result = await db.execute(
        select(Block).where(
            Block.owner_id == owner_id,
            Block.blocked_agent_id == target.id,
            Block.blocked_type == target.type,
        )
    )
    return result.scalar_one_or_none() is not None


async def _is_contact(
    db: AsyncSession,
    *,
    owner_id: str,
    peer: Principal,
) -> bool:
    result = await db.execute(
        select(Contact).where(
            Contact.owner_id == owner_id,
            Contact.contact_agent_id == peer.id,
            Contact.peer_type == peer.type,
        )
    )
    return result.scalar_one_or_none() is not None


async def _shares_room(
    db: AsyncSession,
    *,
    receiver_agent_id: str,
    sender: Principal,
) -> bool:
    """True iff sender and receiver are co-members of any room. Used by
    `contacts_only` to allow same-room messaging without a contacts edge."""
    result = await db.execute(
        select(RoomMember.room_id).where(
            RoomMember.agent_id == receiver_agent_id,
            RoomMember.participant_type == ParticipantType.agent,
            RoomMember.room_id.in_(
                select(RoomMember.room_id).where(
                    RoomMember.agent_id == sender.id,
                    RoomMember.participant_type == sender.type,
                )
            ),
        )
    )
    return result.first() is not None


def _effective_contact_policy(agent: Agent) -> ContactPolicy:
    """Resolve the effective contact policy.

    During the legacy `message_policy` migration window we honor the legacy
    value when the new field still holds its default — so existing
    `message_policy=open` agents stay open after a column add even if the
    server_default backfilled `contacts_only`. Explicit tighter values
    (`whitelist` / `closed`) always win."""
    raw = getattr(agent, "contact_policy", None)
    if raw is None:
        if agent.message_policy == MessagePolicy.open:
            return ContactPolicy.open
        return ContactPolicy.contacts_only
    contact = raw if isinstance(raw, ContactPolicy) else ContactPolicy(raw)
    if (
        contact == ContactPolicy.contacts_only
        and agent.message_policy == MessagePolicy.open
    ):
        return ContactPolicy.open
    return contact


def _effective_room_invite_policy(agent: Agent) -> RoomInvitePolicy:
    raw = getattr(agent, "room_invite_policy", None)
    if raw is None:
        return (
            RoomInvitePolicy.open
            if agent.message_policy == MessagePolicy.open
            else RoomInvitePolicy.contacts_only
        )
    invite = raw if isinstance(raw, RoomInvitePolicy) else RoomInvitePolicy(raw)
    if (
        invite == RoomInvitePolicy.contacts_only
        and agent.message_policy == MessagePolicy.open
    ):
        return RoomInvitePolicy.open
    return invite


async def check_direct_admission(
    db: AsyncSession,
    *,
    sender: Principal,
    receiver: Agent,
    message_type: MessageType | None = None,
    allow_same_room_bypass: bool = True,
) -> None:
    """Gate direct sends and Human→Room speech.

    Raises I18nHTTPException(403) on deny. ``contact_request`` always passes
    so that ``closed`` / ``whitelist`` agents can still receive friend
    requests through the standard flow.
    """
    if await _is_blocked(db, owner_id=receiver.agent_id, target=sender):
        raise I18nHTTPException(status_code=403, message_key="blocked")

    if message_type == MessageType.contact_request:
        return

    if sender.type == ParticipantType.agent and not getattr(receiver, "allow_agent_sender", True):
        raise I18nHTTPException(status_code=403, message_key="agent_senders_disabled")
    if sender.type == ParticipantType.human and not getattr(receiver, "allow_human_sender", True):
        raise I18nHTTPException(status_code=403, message_key="human_senders_disabled")

    policy = _effective_contact_policy(receiver)
    if policy == ContactPolicy.open:
        return
    if policy == ContactPolicy.contacts_only:
        if await _is_contact(db, owner_id=receiver.agent_id, peer=sender):
            return
        if allow_same_room_bypass and await _shares_room(
            db, receiver_agent_id=receiver.agent_id, sender=sender
        ):
            return
        raise I18nHTTPException(status_code=403, message_key="not_in_contacts")
    if policy == ContactPolicy.whitelist:
        # Reuse contacts as the whitelist source — see design doc §8.1.
        if await _is_contact(db, owner_id=receiver.agent_id, peer=sender):
            return
        raise I18nHTTPException(status_code=403, message_key="not_in_whitelist")
    if policy == ContactPolicy.closed:
        raise I18nHTTPException(status_code=403, message_key="agent_closed_to_new_contacts")


async def check_room_invite_admission(
    db: AsyncSession,
    *,
    inviter: Principal,
    invitee: Agent,
) -> None:
    """Gate room-invite paths (room create initial members, add member,
    Human→Room invite). Reads ``room_invite_policy`` and the sender-class
    toggles. ``contact_request`` does not apply here."""
    if await _is_blocked(db, owner_id=invitee.agent_id, target=inviter):
        raise I18nHTTPException(status_code=403, message_key="blocked")

    if inviter.type == ParticipantType.agent and not getattr(invitee, "allow_agent_sender", True):
        raise I18nHTTPException(status_code=403, message_key="agent_senders_disabled")
    if inviter.type == ParticipantType.human and not getattr(invitee, "allow_human_sender", True):
        raise I18nHTTPException(status_code=403, message_key="human_senders_disabled")

    policy = _effective_room_invite_policy(invitee)
    if policy == RoomInvitePolicy.open:
        return
    if policy == RoomInvitePolicy.contacts_only:
        if await _is_contact(db, owner_id=invitee.agent_id, peer=inviter):
            return
        raise I18nHTTPException(
            status_code=403, message_key="room_invite_requires_contact"
        )
    if policy == RoomInvitePolicy.closed:
        raise I18nHTTPException(status_code=403, message_key="agent_closed_to_room_invites")


# ---------------------------------------------------------------------------
# Effective attention resolver (consumed by daemon attention gate in PR3)
# ---------------------------------------------------------------------------


EffectiveSource = Literal["global", "override", "dm_forced"]


@dataclass(frozen=True)
class EffectiveAttention:
    mode: AttentionMode
    keywords: list[str] = field(default_factory=list)
    allowed_sender_ids: list[str] = field(default_factory=list)
    muted_until: datetime.datetime | None = None
    source: EffectiveSource = "global"


def _is_dm_room(room_id: str | None) -> bool:
    return bool(room_id and room_id.startswith("rm_dm_"))


def _decode_keywords(raw: str | None) -> list[str]:
    """Defensive JSON parse for stored keyword lists. Return ``[]`` on garbage
    so a malformed row never breaks the daemon dispatch path."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(x) for x in parsed if isinstance(x, str)]


def _agent_default_attention(agent: Agent) -> AttentionMode:
    raw = getattr(agent, "default_attention", None)
    if raw is None:
        return AttentionMode.always
    return raw if isinstance(raw, AttentionMode) else AttentionMode(raw)


async def resolve_effective_attention(
    db: AsyncSession,
    *,
    agent: Agent,
    room_id: str | None,
) -> EffectiveAttention:
    """Resolve the effective attention policy for ``agent`` in ``room_id``.

    Rules:
      * DM rooms (``rm_dm_*``) force ``always`` regardless of any stored
        override — see design §4.2 special case. UI must hide the controls.
      * Otherwise: per-axis inheritance — a NULL column on the override row
        falls back to the agent's global default.
      * ``muted_until`` only applies if it's in the future. Past timestamps
        are treated as expired and dropped from the result.
    """
    if _is_dm_room(room_id):
        return EffectiveAttention(
            mode=AttentionMode.always,
            keywords=[],
            allowed_sender_ids=[],
            muted_until=None,
            source="dm_forced",
        )

    default_mode = _agent_default_attention(agent)
    default_keywords = _decode_keywords(getattr(agent, "attention_keywords", None))

    override: AgentRoomPolicyOverride | None = None
    if room_id is not None:
        result = await db.execute(
            select(AgentRoomPolicyOverride).where(
                AgentRoomPolicyOverride.agent_id == agent.agent_id,
                AgentRoomPolicyOverride.room_id == room_id,
            )
        )
        override = result.scalar_one_or_none()

    if override is None:
        return EffectiveAttention(
            mode=default_mode,
            keywords=list(default_keywords),
            allowed_sender_ids=[],
            muted_until=None,
            source="global",
        )

    # Per-axis inherit: NULL → fall back to agent default.
    if override.attention_mode is None:
        mode = default_mode
    else:
        mode = (
            override.attention_mode
            if isinstance(override.attention_mode, AttentionMode)
            else AttentionMode(override.attention_mode)
        )
    keywords = (
        _decode_keywords(override.keywords)
        if override.keywords is not None
        else list(default_keywords)
    )
    allowed_sender_ids = _decode_keywords(override.allowed_sender_ids)

    muted_until = override.muted_until
    if muted_until is not None:
        # Tolerate naive timestamps from SQLite — assume UTC.
        now = datetime.datetime.now(datetime.timezone.utc)
        if muted_until.tzinfo is None:
            muted_until = muted_until.replace(tzinfo=datetime.timezone.utc)
        if muted_until <= now:
            muted_until = None

    return EffectiveAttention(
        mode=mode,
        keywords=keywords,
        allowed_sender_ids=allowed_sender_ids,
        muted_until=muted_until,
        source="override",
    )
