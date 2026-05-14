"""Room-scoped capability helpers used by the dashboard BFF.

After PR #352 made rooms polymorphic (owner_id / owner_type can be ag_* or
hu_*), authorization for owner-only operations is no longer "active_agent ==
room.owner_id". The viewer's user might own the bot that owns the room, or
the room's owner might be the viewer's own human identity. These helpers
collapse those cases.
"""

from __future__ import annotations

from typing import Literal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext
from hub.enums import ParticipantType, RoomRole
from hub.models import Agent, Room, RoomMember


RoomCapability = Literal["owner", "admin"]

_ROLE_RANK = {
    RoomRole.member: 0,
    RoomRole.admin: 1,
    RoomRole.owner: 2,
}


def _coerce_room_role(role: RoomRole | str | None) -> RoomRole | None:
    if role is None:
        return None
    if isinstance(role, RoomRole):
        return role
    try:
        return RoomRole(str(role))
    except ValueError:
        return None


def strongest_room_role(roles: list[RoomRole | str | None]) -> RoomRole | None:
    """Return the highest room role from a set of candidate roles."""
    best: RoomRole | None = None
    for raw_role in roles:
        role = _coerce_room_role(raw_role)
        if role is None:
            continue
        if best is None or _ROLE_RANK[role] > _ROLE_RANK[best]:
            best = role
    return best


async def load_owned_agent_ids(db: AsyncSession, user_id) -> set[str]:
    """Return the user's owned bot ids."""
    if user_id is None:
        return set()
    result = await db.execute(select(Agent.agent_id).where(Agent.user_id == user_id))
    return {row[0] for row in result.all()}


async def effective_human_room_role(
    db: AsyncSession,
    *,
    room: Room,
    human_role: RoomRole | str | None,
    user_id,
    owned_agent_ids: set[str] | None = None,
) -> RoomRole | None:
    """Resolve a human viewer's strongest effective role in ``room``.

    The viewer keeps their own Human RoomMember role and also inherits the
    strongest role held by any bot owned by the same user in that room. If the
    room itself is owned by one of those bots, the effective role is owner.
    """
    owned_ids = owned_agent_ids
    if owned_ids is None:
        owned_ids = await load_owned_agent_ids(db, user_id)

    candidates: list[RoomRole | str | None] = [human_role]
    if room.owner_type == ParticipantType.agent and room.owner_id in owned_ids:
        candidates.append(RoomRole.owner)

    if owned_ids:
        result = await db.execute(
            select(RoomMember.role).where(
                RoomMember.room_id == room.room_id,
                RoomMember.participant_type == ParticipantType.agent,
                RoomMember.agent_id.in_(owned_ids),
            )
        )
        candidates.extend(row[0] for row in result.all())

    return strongest_room_role(candidates)


async def viewer_can_admin_room(
    db: AsyncSession,
    ctx: RequestContext,
    room: Room,
) -> RoomCapability | None:
    """Return the strongest capability the JWT viewer has on ``room``.

    - ``"owner"`` — viewer can perform owner-only operations
      (visibility, join_policy, plan, dissolve, ...). Cases:
        * room is agent-owned and viewer's active agent IS the owner agent;
        * room is agent-owned and the owner agent's ``user_id`` ==
          ``ctx.user_id`` (transitive — viewer's user owns the bot);
        * room is human-owned and ``ctx.human_id`` matches ``room.owner_id``.
        * RoomMember.role == owner under the viewer's active agent.
    - ``"admin"`` — viewer has an admin RoomMember row through their active
      agent or any other bot owned by the same user.
    - ``None`` — no capability.
    """
    owned_agent_ids: set[str] = set()
    if room.owner_type == ParticipantType.agent:
        if ctx.active_agent_id and ctx.active_agent_id == room.owner_id:
            return "owner"
        owner_agent = (
            await db.execute(
                select(Agent).where(Agent.agent_id == room.owner_id)
            )
        ).scalar_one_or_none()
        if owner_agent is not None and ctx.user_id is not None and owner_agent.user_id == ctx.user_id:
            return "owner"
        owned_agent_ids = await load_owned_agent_ids(db, ctx.user_id)
    elif room.owner_type == ParticipantType.human:
        if ctx.human_id and ctx.human_id == room.owner_id:
            return "owner"
        owned_agent_ids = await load_owned_agent_ids(db, ctx.user_id)

    # Admin-via-RoomMember — explicitly filter participant_type=agent so we
    # don't depend on ID prefixes as a discriminator inside auth code.
    if ctx.active_agent_id:
        member = (
            await db.execute(
                select(RoomMember).where(
                    RoomMember.room_id == room.room_id,
                    RoomMember.agent_id == ctx.active_agent_id,
                    RoomMember.participant_type == ParticipantType.agent,
                )
            )
        ).scalar_one_or_none()
        if member is not None and member.role in (RoomRole.owner, RoomRole.admin):
            return "owner" if member.role == RoomRole.owner else "admin"

    if owned_agent_ids:
        inherited_role = strongest_room_role(
            list(
                (
                    await db.execute(
                        select(RoomMember.role).where(
                            RoomMember.room_id == room.room_id,
                            RoomMember.participant_type == ParticipantType.agent,
                            RoomMember.agent_id.in_(owned_agent_ids),
                        )
                    )
                ).scalars().all()
            )
        )
        if inherited_role in (RoomRole.owner, RoomRole.admin):
            return "owner" if inherited_role == RoomRole.owner else "admin"

    return None


async def resolve_provider_agent_for_room(
    db: AsyncSession,
    ctx: RequestContext,
    room: Room,
    *,
    requested_provider_agent_id: str | None,
) -> str:
    """Pick the agent that should receive subscription payments for ``room``.

    - Agent-owned room → the owner agent (request body field is ignored).
    - Human-owned room → ``requested_provider_agent_id`` is required, must
      belong to ``ctx.user_id``, and must be active. We deliberately do NOT
      fall back to ``X-Active-Agent`` because the human dashboard path does
      not send it.
    """
    if room.owner_type == ParticipantType.agent:
        return room.owner_id

    if not requested_provider_agent_id:
        raise HTTPException(
            status_code=400,
            detail="provider_agent_id is required for human-owned rooms",
        )
    agent = (
        await db.execute(
            select(Agent).where(Agent.agent_id == requested_provider_agent_id)
        )
    ).scalar_one_or_none()
    if agent is None or ctx.user_id is None or agent.user_id != ctx.user_id:
        raise HTTPException(
            status_code=403,
            detail="Provider agent does not belong to this user",
        )
    # `Agent.status` is a string in the schema; treat anything other than
    # "active" as ineligible. If the column is missing on a row (legacy data),
    # don't block here — the wallet transfer path will surface real failures.
    status = getattr(agent, "status", None)
    if status is not None and str(status) != "active":
        raise HTTPException(
            status_code=400,
            detail="Provider agent is not active",
        )
    return requested_provider_agent_id
