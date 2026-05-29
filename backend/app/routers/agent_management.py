"""Authenticated app API for owner-granted agent management permissions."""

from __future__ import annotations

import datetime
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    ALLOWED_MANAGEMENT_SCOPES,
    MANAGEMENT_SCOPE_DAEMON_AGENTS_PROVISION,
    RequestContext,
    require_user,
)
from hub.database import get_db
from hub.models import Agent, AgentManagementGrant, DaemonInstance

router = APIRouter(prefix="/api/agent-management", tags=["app-agent-management"])


class GrantCreateIn(BaseModel):
    agent_id: str = Field(min_length=1, max_length=32)
    scopes: list[str] = Field(min_length=1, max_length=10)
    expires_in_days: int = Field(default=30, ge=1, le=365)
    daemon_instance_id: str | None = Field(default=None, max_length=32)
    limits: dict[str, Any] | None = None

    @field_validator("scopes")
    @classmethod
    def _validate_scopes(cls, value: list[str]) -> list[str]:
        scopes = list(dict.fromkeys(value))
        unknown = [scope for scope in scopes if scope not in ALLOWED_MANAGEMENT_SCOPES]
        if unknown:
            raise ValueError(f"unsupported management scope(s): {', '.join(unknown)}")
        return scopes

    @field_validator("limits")
    @classmethod
    def _validate_limits(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        allowed = {"max_uses", "max_role_count", "allow_start_runs"}
        unknown = sorted(set(value) - allowed)
        if unknown:
            raise ValueError(f"unsupported limit key(s): {', '.join(unknown)}")
        max_uses = value.get("max_uses")
        if max_uses is not None and (
            not isinstance(max_uses, int) or isinstance(max_uses, bool) or max_uses < 0
        ):
            raise ValueError("limits.max_uses must be a non-negative integer")
        max_role_count = value.get("max_role_count")
        if max_role_count is not None and (
            not isinstance(max_role_count, int)
            or isinstance(max_role_count, bool)
            or max_role_count < 1
            or max_role_count > 5
        ):
            raise ValueError("limits.max_role_count must be an integer between 1 and 5")
        allow_start_runs = value.get("allow_start_runs")
        if allow_start_runs is not None and not isinstance(allow_start_runs, bool):
            raise ValueError("limits.allow_start_runs must be a boolean")
        return value


class GrantOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    agent_id: str
    scope: str
    daemon_instance_id: str | None
    limits: dict[str, Any]
    use_count: int
    expires_at: datetime.datetime | None
    revoked_at: datetime.datetime | None
    created_at: datetime.datetime | None


class GrantListOut(BaseModel):
    grants: list[GrantOut]


def _grant_out(grant: AgentManagementGrant) -> GrantOut:
    return GrantOut(
        id=grant.id,
        user_id=grant.user_id,
        agent_id=grant.agent_id,
        scope=grant.scope,
        daemon_instance_id=grant.daemon_instance_id,
        limits=grant.limits_json or {},
        use_count=grant.use_count,
        expires_at=grant.expires_at,
        revoked_at=grant.revoked_at,
        created_at=grant.created_at,
    )


async def _load_owned_agent(
    db: AsyncSession,
    *,
    ctx: RequestContext,
    agent_id: str,
) -> Agent:
    agent = await db.scalar(
        select(Agent).where(
            Agent.agent_id == agent_id,
            Agent.user_id == ctx.user_id,
            Agent.status == "active",
        )
    )
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.claimed_at is None:
        raise HTTPException(status_code=409, detail="Agent is not bound to this user")
    return agent


async def _ensure_owned_daemon(
    db: AsyncSession,
    *,
    ctx: RequestContext,
    daemon_instance_id: str | None,
) -> None:
    if daemon_instance_id is None:
        return
    daemon = await db.scalar(
        select(DaemonInstance).where(
            DaemonInstance.id == daemon_instance_id,
            DaemonInstance.user_id == ctx.user_id,
        )
    )
    if daemon is None or daemon.revoked_at is not None:
        raise HTTPException(status_code=404, detail="daemon_instance_not_found")


@router.get("/grants", response_model=GrantListOut)
async def list_agent_management_grants(
    agent_id: str | None = None,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> GrantListOut:
    conditions = [AgentManagementGrant.user_id == ctx.user_id]
    if agent_id:
        conditions.append(AgentManagementGrant.agent_id == agent_id)
    result = await db.execute(
        select(AgentManagementGrant)
        .where(*conditions)
        .order_by(AgentManagementGrant.created_at.desc())
    )
    return GrantListOut(grants=[_grant_out(grant) for grant in result.scalars().all()])


@router.post("/grants", response_model=GrantListOut, status_code=201)
async def create_agent_management_grant(
    body: GrantCreateIn,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> GrantListOut:
    if (
        MANAGEMENT_SCOPE_DAEMON_AGENTS_PROVISION in body.scopes
        and body.daemon_instance_id is None
    ):
        raise HTTPException(
            status_code=400,
            detail="daemon_agents:provision requires daemon_instance_id",
        )
    await _load_owned_agent(db, ctx=ctx, agent_id=body.agent_id)
    await _ensure_owned_daemon(db, ctx=ctx, daemon_instance_id=body.daemon_instance_id)

    now = datetime.datetime.now(datetime.timezone.utc)
    expires_at = now + datetime.timedelta(days=body.expires_in_days)
    grants: list[AgentManagementGrant] = []
    for scope in body.scopes:
        conditions = [
            AgentManagementGrant.user_id == ctx.user_id,
            AgentManagementGrant.agent_id == body.agent_id,
            AgentManagementGrant.scope == scope,
            AgentManagementGrant.revoked_at.is_(None),
        ]
        if body.daemon_instance_id is None:
            conditions.append(AgentManagementGrant.daemon_instance_id.is_(None))
        else:
            conditions.append(AgentManagementGrant.daemon_instance_id == body.daemon_instance_id)
        grant = await db.scalar(select(AgentManagementGrant).where(*conditions))
        if grant is None:
            grant = AgentManagementGrant(
                user_id=ctx.user_id,
                agent_id=body.agent_id,
                scope=scope,
                daemon_instance_id=body.daemon_instance_id,
                created_by_user_id=ctx.user_id,
            )
            db.add(grant)
        grant.expires_at = expires_at
        grant.limits_json = body.limits or {}
        grant.use_count = 0
        grants.append(grant)

    await db.commit()
    for grant in grants:
        await db.refresh(grant)
    return GrantListOut(grants=[_grant_out(grant) for grant in grants])


@router.delete("/grants/{grant_id}", response_model=GrantOut)
async def revoke_agent_management_grant(
    grant_id: uuid.UUID,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> GrantOut:
    grant = await db.scalar(
        select(AgentManagementGrant).where(
            AgentManagementGrant.id == grant_id,
            AgentManagementGrant.user_id == ctx.user_id,
        )
    )
    if grant is None:
        raise HTTPException(status_code=404, detail="Grant not found")
    if grant.revoked_at is None:
        grant.revoked_at = datetime.datetime.now(datetime.timezone.utc)
        await db.commit()
        await db.refresh(grant)
    return _grant_out(grant)
