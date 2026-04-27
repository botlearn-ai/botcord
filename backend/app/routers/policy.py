"""
[INPUT]: Authenticated user + their owned agent + Pydantic policy patches
[OUTPUT]: GET/PATCH /api/agents/{agent_id}/policy — read & update the agent's
          admission and default attention settings.
[POS]: BFF surface for the dashboard "Conversations & Replies" tab.
[PROTOCOL]: Only the user that owns the agent may read or write its policy.
"""

from __future__ import annotations

import json
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.enums import AttentionMode, ContactPolicy, MessagePolicy, RoomInvitePolicy
from hub.models import Agent
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

    # PR3: notify the daemon hosting this agent so its policyResolver drops
    # the stale cache entry. Best-effort — daemon offline / dispatch error
    # must not break the BFF response. We embed the post-update policy
    # inline so the daemon avoids a refetch.
    # TODO(pr3-merge): fire policy_updated from per-room endpoints once PR2
    # lands its PUT/DELETE/snooze surface.
    serialized = _serialize(agent)
    if agent.daemon_instance_id and is_daemon_online(agent.daemon_instance_id):
        try:
            await send_control_frame(
                agent.daemon_instance_id,
                "policy_updated",
                {
                    "agent_id": agent.agent_id,
                    "policy": {
                        "mode": serialized.default_attention,
                        "keywords": serialized.attention_keywords,
                    },
                },
            )
        except HTTPException as exc:
            logger.warning(
                "policy_updated dispatch failed: agent=%s daemon=%s detail=%s",
                agent.agent_id,
                agent.daemon_instance_id,
                exc.detail,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "policy_updated dispatch error: agent=%s daemon=%s err=%s",
                agent.agent_id,
                agent.daemon_instance_id,
                exc,
            )

    return serialized
