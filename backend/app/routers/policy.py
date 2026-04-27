"""
[INPUT]: Authenticated user + their owned agent + Pydantic policy patches
[OUTPUT]: GET/PATCH /api/agents/{agent_id}/policy — read & update the agent's
          admission and default attention settings.
[POS]: BFF surface for the dashboard "Conversations & Replies" tab.
[PROTOCOL]: Only the user that owns the agent may read or write its policy.
"""

from __future__ import annotations

import datetime
import json
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.enums import AttentionMode, ContactPolicy, MessagePolicy, RoomInvitePolicy
from hub.i18n import I18nHTTPException
from hub.models import Agent, AgentRoomPolicyOverride, Room
from hub.policy import EffectiveAttention, resolve_effective_attention
from hub.routers.daemon_control import is_daemon_online, send_control_frame

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["app-policy"])


ContactPolicyLit = Literal["open", "contacts_only", "whitelist", "closed"]
RoomInviteLit = Literal["open", "contacts_only", "closed"]
AttentionLit = Literal["always", "mention_only", "keyword", "muted"]


class AgentPolicyOut(BaseModel):
    contact_policy: ContactPolicyLit
    allow_agent_sender: bool
    allow_human_sender: bool
    room_invite_policy: RoomInviteLit
    default_attention: AttentionLit
    attention_keywords: list[str]


class AgentPolicyPatch(BaseModel):
    contact_policy: ContactPolicyLit | None = None
    allow_agent_sender: bool | None = None
    allow_human_sender: bool | None = None
    room_invite_policy: RoomInviteLit | None = None
    default_attention: AttentionLit | None = None
    attention_keywords: list[str] | None = Field(default=None, max_length=64)

    @field_validator("attention_keywords")
    @classmethod
    def _validate_keywords(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        cleaned: list[str] = []
        for kw in v:
            if not isinstance(kw, str):
                raise ValueError("keyword must be a string")
            kw = kw.strip()
            if not kw:
                continue
            if len(kw) > 128:
                raise ValueError("keyword too long (max 128 chars)")
            cleaned.append(kw)
        return cleaned


def _decode_keywords(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(x) for x in parsed if isinstance(x, str)]


def _serialize(agent: Agent) -> AgentPolicyOut:
    contact = agent.contact_policy
    if isinstance(contact, ContactPolicy):
        contact_value = contact.value
    else:
        contact_value = str(contact) if contact else ContactPolicy.contacts_only.value
    invite = agent.room_invite_policy
    if isinstance(invite, RoomInvitePolicy):
        invite_value = invite.value
    else:
        invite_value = str(invite) if invite else RoomInvitePolicy.contacts_only.value
    attention = agent.default_attention
    if isinstance(attention, AttentionMode):
        attention_value = attention.value
    else:
        attention_value = str(attention) if attention else AttentionMode.always.value
    return AgentPolicyOut(
        contact_policy=contact_value,  # type: ignore[arg-type]
        allow_agent_sender=bool(agent.allow_agent_sender),
        allow_human_sender=bool(agent.allow_human_sender),
        room_invite_policy=invite_value,  # type: ignore[arg-type]
        default_attention=attention_value,  # type: ignore[arg-type]
        attention_keywords=_decode_keywords(agent.attention_keywords),
    )


async def _load_owned_agent(db: AsyncSession, ctx: RequestContext, agent_id: str) -> Agent:
    result = await db.execute(
        select(Agent).where(
            Agent.agent_id == agent_id,
            Agent.user_id == ctx.user_id,
            Agent.status == "active",
        )
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.get("/{agent_id}/policy", response_model=AgentPolicyOut)
async def get_policy(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    agent = await _load_owned_agent(db, ctx, agent_id)
    return _serialize(agent)


@router.patch("/{agent_id}/policy", response_model=AgentPolicyOut)
async def patch_policy(
    agent_id: str,
    body: AgentPolicyPatch,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    agent = await _load_owned_agent(db, ctx, agent_id)

    if body.contact_policy is not None:
        new_contact = ContactPolicy(body.contact_policy)
        agent.contact_policy = new_contact
        # Dual-write the legacy `message_policy` field so older readers stay
        # consistent. Anything stricter than `open` collapses to `contacts_only`.
        agent.message_policy = (
            MessagePolicy.open if new_contact == ContactPolicy.open else MessagePolicy.contacts_only
        )
    if body.allow_agent_sender is not None:
        agent.allow_agent_sender = body.allow_agent_sender
    if body.allow_human_sender is not None:
        agent.allow_human_sender = body.allow_human_sender
    if body.room_invite_policy is not None:
        agent.room_invite_policy = RoomInvitePolicy(body.room_invite_policy)
    if body.default_attention is not None:
        agent.default_attention = AttentionMode(body.default_attention)
    if body.attention_keywords is not None:
        agent.attention_keywords = json.dumps(body.attention_keywords)

    await db.commit()
    await db.refresh(agent)

    serialized = _serialize(agent)
    await _dispatch_policy_updated(
        agent,
        policy={
            "mode": serialized.default_attention,
            "keywords": serialized.attention_keywords,
        },
    )
    return serialized


# ---------------------------------------------------------------------------
# policy_updated control-frame dispatch helper (PR3 plumbing)
# ---------------------------------------------------------------------------


async def _dispatch_policy_updated(
    agent: Agent,
    *,
    room_id: str | None = None,
    policy: dict | None = None,
) -> None:
    """Best-effort: tell the daemon to invalidate its cached policy.

    Daemon offline / dispatch error must never break the BFF response. The
    inline ``policy`` blob lets the daemon avoid a refetch when the global
    policy is the only thing that changed. For per-room edits we omit
    ``policy`` and pass ``room_id`` so the daemon refetches just that key
    when PR2/PR4 wires the room-aware fetcher.
    """
    if not agent.daemon_instance_id or not is_daemon_online(agent.daemon_instance_id):
        return
    payload: dict = {"agent_id": agent.agent_id}
    if room_id is not None:
        payload["room_id"] = room_id
    if policy is not None:
        payload["policy"] = policy
    try:
        await send_control_frame(agent.daemon_instance_id, "policy_updated", payload)
    except HTTPException as exc:
        logger.warning(
            "policy_updated dispatch failed: agent=%s daemon=%s room=%s detail=%s",
            agent.agent_id,
            agent.daemon_instance_id,
            room_id,
            exc.detail,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "policy_updated dispatch error: agent=%s daemon=%s room=%s err=%s",
            agent.agent_id,
            agent.daemon_instance_id,
            room_id,
            exc,
        )


# ---------------------------------------------------------------------------
# Per-room attention override (design §3.2 + §5)
# ---------------------------------------------------------------------------


def _is_dm_room(room_id: str) -> bool:
    return room_id.startswith("rm_dm_")


async def _ensure_room_exists(db: AsyncSession, room_id: str) -> Room:
    result = await db.execute(select(Room).where(Room.room_id == room_id))
    room = result.scalar_one_or_none()
    if room is None:
        raise I18nHTTPException(status_code=404, message_key="room_not_found")
    return room


async def _load_override(
    db: AsyncSession, agent_id: str, room_id: str
) -> AgentRoomPolicyOverride | None:
    result = await db.execute(
        select(AgentRoomPolicyOverride).where(
            AgentRoomPolicyOverride.agent_id == agent_id,
            AgentRoomPolicyOverride.room_id == room_id,
        )
    )
    return result.scalar_one_or_none()


class EffectiveAttentionOut(BaseModel):
    mode: AttentionLit
    keywords: list[str]
    muted_until: datetime.datetime | None
    source: Literal["global", "override", "dm_forced"]


class RoomOverrideOut(BaseModel):
    attention_mode: AttentionLit | None
    keywords: list[str] | None
    muted_until: datetime.datetime | None
    updated_at: datetime.datetime


class RoomPolicyOut(BaseModel):
    effective: EffectiveAttentionOut
    override: RoomOverrideOut | None
    inherits_global: bool


class RoomPolicyPut(BaseModel):
    """Upsert payload — only the explicitly-provided keys touch the row.

    ``None`` for ``attention_mode``/``keywords`` clears that axis (NULL =
    inherit from the agent default). Omit a key to leave it unchanged.
    Use ``model_fields_set`` to discriminate omitted vs explicit-null."""

    attention_mode: AttentionLit | None = None
    keywords: list[str] | None = Field(default=None, max_length=64)

    @field_validator("keywords")
    @classmethod
    def _validate_keywords(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        cleaned: list[str] = []
        for kw in v:
            if not isinstance(kw, str):
                raise ValueError("keyword must be a string")
            kw = kw.strip()
            if not kw:
                continue
            if len(kw) > 128:
                raise ValueError("keyword too long (max 128 chars)")
            cleaned.append(kw)
        return cleaned


class SnoozeIn(BaseModel):
    minutes: int = Field(..., ge=0, le=43200)  # 0 clears; max 30 days


def _serialize_effective(eff: EffectiveAttention) -> EffectiveAttentionOut:
    return EffectiveAttentionOut(
        mode=eff.mode.value,  # type: ignore[arg-type]
        keywords=list(eff.keywords),
        muted_until=eff.muted_until,
        source=eff.source,
    )


def _serialize_override(row: AgentRoomPolicyOverride) -> RoomOverrideOut:
    mode_value: AttentionLit | None
    if row.attention_mode is None:
        mode_value = None
    else:
        mode_obj = (
            row.attention_mode
            if isinstance(row.attention_mode, AttentionMode)
            else AttentionMode(row.attention_mode)
        )
        mode_value = mode_obj.value  # type: ignore[assignment]
    keywords: list[str] | None
    if row.keywords is None:
        keywords = None
    else:
        try:
            parsed = json.loads(row.keywords)
            keywords = (
                [str(x) for x in parsed if isinstance(x, str)]
                if isinstance(parsed, list)
                else []
            )
        except json.JSONDecodeError:
            keywords = []
    return RoomOverrideOut(
        attention_mode=mode_value,
        keywords=keywords,
        muted_until=row.muted_until,
        updated_at=row.updated_at,
    )


@router.get(
    "/{agent_id}/rooms/{room_id}/policy",
    response_model=RoomPolicyOut,
)
async def get_room_policy(
    agent_id: str,
    room_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    agent = await _load_owned_agent(db, ctx, agent_id)
    await _ensure_room_exists(db, room_id)
    override = await _load_override(db, agent.agent_id, room_id)
    eff = await resolve_effective_attention(db, agent=agent, room_id=room_id)
    return RoomPolicyOut(
        effective=_serialize_effective(eff),
        override=_serialize_override(override) if override is not None else None,
        inherits_global=override is None,
    )


@router.put(
    "/{agent_id}/rooms/{room_id}/policy",
    response_model=RoomPolicyOut,
)
async def put_room_policy(
    agent_id: str,
    room_id: str,
    body: RoomPolicyPut,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    agent = await _load_owned_agent(db, ctx, agent_id)
    await _ensure_room_exists(db, room_id)
    if _is_dm_room(room_id):
        raise I18nHTTPException(
            status_code=400, message_key="attention_override_not_allowed_in_dm"
        )
    # Note: we don't require room membership — the agent might be added to the
    # room later, and the user may want the override staged ahead of time.
    override = await _load_override(db, agent.agent_id, room_id)
    if override is None:
        override = AgentRoomPolicyOverride(agent_id=agent.agent_id, room_id=room_id)
        db.add(override)

    fields_set = body.model_fields_set
    if "attention_mode" in fields_set:
        override.attention_mode = (
            AttentionMode(body.attention_mode)
            if body.attention_mode is not None
            else None
        )
    if "keywords" in fields_set:
        override.keywords = (
            json.dumps(body.keywords) if body.keywords is not None else None
        )
    await db.commit()
    await db.refresh(override)

    eff = await resolve_effective_attention(db, agent=agent, room_id=room_id)
    return RoomPolicyOut(
        effective=_serialize_effective(eff),
        override=_serialize_override(override),
        inherits_global=False,
    )


@router.delete(
    "/{agent_id}/rooms/{room_id}/policy",
    status_code=204,
)
async def delete_room_policy(
    agent_id: str,
    room_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    agent = await _load_owned_agent(db, ctx, agent_id)
    await _ensure_room_exists(db, room_id)
    override = await _load_override(db, agent.agent_id, room_id)
    if override is not None:
        await db.delete(override)
        await db.commit()
        await _dispatch_policy_updated(agent, room_id=room_id)
    # Idempotent: 204 either way.
    return Response(status_code=204)


@router.post(
    "/{agent_id}/rooms/{room_id}/snooze",
    response_model=RoomPolicyOut,
)
async def snooze_room(
    agent_id: str,
    room_id: str,
    body: SnoozeIn,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    agent = await _load_owned_agent(db, ctx, agent_id)
    await _ensure_room_exists(db, room_id)
    if _is_dm_room(room_id):
        raise I18nHTTPException(
            status_code=400, message_key="attention_override_not_allowed_in_dm"
        )
    override = await _load_override(db, agent.agent_id, room_id)
    if override is None:
        override = AgentRoomPolicyOverride(agent_id=agent.agent_id, room_id=room_id)
        db.add(override)

    if body.minutes == 0:
        override.muted_until = None
    else:
        override.muted_until = datetime.datetime.now(
            datetime.timezone.utc
        ) + datetime.timedelta(minutes=body.minutes)
    await db.commit()
    await db.refresh(override)

    eff = await resolve_effective_attention(db, agent=agent, room_id=room_id)
    await _dispatch_policy_updated(agent, room_id=room_id)
    return RoomPolicyOut(
        effective=_serialize_effective(eff),
        override=_serialize_override(override),
        inherits_global=False,
    )
