"""Agent sharing P1: owner-issued grants that let an org member call an agent.

The agent owner grants one active member of an organization the right to call
one of the owner's agents that has joined the same organization. The grantee
talks to the agent through the ordinary human↔agent DM room; the Hub then
attaches an ``access_context`` to the agent's inbox so the daemon enforces the
grant's execution profile (``consultant`` read-only, ``collaborator`` edits in
a per-grant worktree).

Callers commit once after a successful mutation (same convention as
``hub.services.spaces``).
"""

from __future__ import annotations

import datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import AgentAccessGrant, Space, SpaceAgentMembership, SpaceUserMembership, User
from hub.services import spaces

ROLES = ("consultant", "collaborator")


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _aware(value: datetime.datetime | None) -> datetime.datetime | None:
    # SQLite drops tzinfo; treat naive values as UTC.
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=datetime.timezone.utc)
    return value


async def _require_owned_org_agent(db: AsyncSession, space_id: UUID, owner_id: UUID, agent_id: str):
    """Agent is an active member of the org and ``owner_id`` is its owner."""
    membership = await spaces.require_agent_membership(db, space_id, agent_id)
    sponsor = await db.get(SpaceUserMembership, membership.sponsor_user_membership_id)
    if sponsor is None or sponsor.user_id != owner_id:
        spaces.reject("agent_owner_required")
    return membership


async def create_grant(
    db: AsyncSession,
    space_id: UUID,
    actor_id: UUID,
    agent_id: str,
    grantee_user_id: UUID,
    role: str,
    *,
    expires_at: datetime.datetime | None = None,
    workspace_path: str | None = None,
    allowed_commands: list[str] | None = None,
) -> AgentAccessGrant:
    if role not in ROLES:
        spaces.reject("invalid_role", 422)
    await spaces.organization_space(db, space_id)
    await spaces.require_membership(db, space_id, actor_id)
    agent_membership = await _require_owned_org_agent(db, space_id, actor_id, agent_id)
    if grantee_user_id == actor_id:
        spaces.reject("cannot_grant_self", 422)
    try:
        grantee_membership = await spaces.require_membership(db, space_id, grantee_user_id)
    except HTTPException:
        spaces.reject("grantee_not_member", 404)
    expires_at = _aware(expires_at)
    if expires_at is not None and expires_at <= _now():
        spaces.reject("expires_in_past", 422)

    # One live grant per (space, agent, grantee): a new grant replaces the old.
    await db.execute(
        update(AgentAccessGrant)
        .where(
            AgentAccessGrant.space_id == space_id,
            AgentAccessGrant.agent_id == agent_id,
            AgentAccessGrant.grantee_user_id == grantee_user_id,
            AgentAccessGrant.revoked_at.is_(None),
        )
        .values(revoked_at=_now())
    )
    grant = AgentAccessGrant(
        space_id=space_id,
        agent_id=agent_id,
        agent_membership_id=agent_membership.id,
        agent_membership_version=agent_membership.version,
        grantee_user_id=grantee_user_id,
        grantee_membership_id=grantee_membership.id,
        grantee_membership_version=grantee_membership.version,
        role=role,
        workspace_path=workspace_path or None,
        allowed_commands=list(allowed_commands or []),
        expires_at=expires_at,
        created_by_user_id=actor_id,
    )
    db.add(grant)
    await db.flush()
    spaces.audit(db, space_id, actor_id, "agent_access.granted", grant.id,
                 agent_id=agent_id, grantee_user_id=str(grantee_user_id), role=role)
    return grant


async def list_grants(db: AsyncSession, space_id: UUID, actor_id: UUID, agent_id: str) -> list[AgentAccessGrant]:
    await spaces.require_membership(db, space_id, actor_id)
    await _require_owned_org_agent(db, space_id, actor_id, agent_id)
    rows = await db.scalars(
        select(AgentAccessGrant)
        .where(
            AgentAccessGrant.space_id == space_id,
            AgentAccessGrant.agent_id == agent_id,
            AgentAccessGrant.revoked_at.is_(None),
        )
        .order_by(AgentAccessGrant.created_at)
    )
    return list(rows.all())


async def revoke_grant(db: AsyncSession, space_id: UUID, actor_id: UUID, grant_id: UUID) -> AgentAccessGrant:
    grant = await db.get(AgentAccessGrant, grant_id)
    if grant is None or grant.space_id != space_id:
        spaces.reject("grant_not_found", 404)
    await spaces.require_membership(db, space_id, actor_id)
    if grant.created_by_user_id != actor_id:
        # Only the agent owner who issued the grant may revoke it in P1.
        spaces.reject("agent_owner_required")
    if grant.revoked_at is None:
        grant.revoked_at = _now()
        spaces.audit(db, space_id, actor_id, "agent_access.revoked", grant.id, agent_id=grant.agent_id)
    return grant


async def grant_is_valid(db: AsyncSession, grant: AgentAccessGrant) -> bool:
    """Non-raising lifecycle check used on every send and inbox poll."""
    if grant.revoked_at is not None:
        return False
    expires_at = _aware(grant.expires_at)
    if expires_at is not None and expires_at <= _now():
        return False
    space = await db.get(Space, grant.space_id)
    if space is None or space.kind != "organization" or space.status != "active":
        return False
    grantee = await db.get(SpaceUserMembership, grant.grantee_membership_id)
    if (grantee is None or grantee.status != "active"
            or grantee.version != grant.grantee_membership_version):
        return False
    grantee_user = await db.get(User, grant.grantee_user_id)
    if grantee_user is None or grantee_user.status != "active" or grantee_user.banned_at is not None:
        return False
    agent_membership = await db.get(SpaceAgentMembership, grant.agent_membership_id)
    if (agent_membership is None or agent_membership.status != "active"
            or agent_membership.version != grant.agent_membership_version):
        return False
    try:
        await _require_owned_org_agent(db, grant.space_id, grant.created_by_user_id, grant.agent_id)
    except HTTPException:
        return False
    return True


async def latest_grant_for_pair(db: AsyncSession, agent_id: str, grantee_user_id: UUID) -> AgentAccessGrant | None:
    """Most recent grant (live or not) between this agent and grantee."""
    return await db.scalar(
        select(AgentAccessGrant)
        .where(AgentAccessGrant.agent_id == agent_id, AgentAccessGrant.grantee_user_id == grantee_user_id)
        .order_by(AgentAccessGrant.created_at.desc(), AgentAccessGrant.id.desc())
        .limit(1)
    )


async def active_grant_for_pair(db: AsyncSession, agent_id: str, grantee_user_id: UUID) -> AgentAccessGrant | None:
    grant = await latest_grant_for_pair(db, agent_id, grantee_user_id)
    if grant is not None and await grant_is_valid(db, grant):
        return grant
    return None


async def list_shared_agents(db: AsyncSession, space_id: UUID, user_id: UUID) -> list[AgentAccessGrant]:
    """Live grants issued to ``user_id`` in this organization."""
    await spaces.require_membership(db, space_id, user_id)
    rows = await db.scalars(
        select(AgentAccessGrant)
        .where(
            AgentAccessGrant.space_id == space_id,
            AgentAccessGrant.grantee_user_id == user_id,
            AgentAccessGrant.revoked_at.is_(None),
        )
        .order_by(AgentAccessGrant.created_at)
    )
    return [grant for grant in rows.all() if await grant_is_valid(db, grant)]


def access_context(grant: AgentAccessGrant, *, active: bool, requester_id: str) -> dict:
    """Inbox payload the daemon uses to enforce the grant."""
    return {
        "grant_id": str(grant.id),
        "space_id": str(grant.space_id),
        "role": grant.role,
        "active": active,
        "requester_id": requester_id,
        "workspace_path": grant.workspace_path,
        "allowed_commands": list(grant.allowed_commands or []),
    }
