"""Agent sharing P1: owner grants an org member access to call an agent."""

import datetime
import re
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from app.routers.spaces import transaction
from hub.models import Agent, AgentAccessGrant, User
from hub.services import agent_access as service
from hub.services import spaces

router = APIRouter(prefix="/api", tags=["app-agent-access"])

_COMMAND_PATTERN = r"^[A-Za-z0-9_./:@=+-][A-Za-z0-9_./:@=+ -]{0,63}$"


class GrantIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    user_id: UUID | None = None
    human_id: str | None = Field(default=None, pattern=r"^hu_[a-zA-Z0-9]+$", max_length=32)
    role: str = Field(pattern=r"^(consultant|collaborator)$")
    expires_at: datetime.datetime | None = None
    workspace_path: str | None = Field(default=None, max_length=1024)
    allowed_commands: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_fields(self):
        if (self.user_id is None) == (self.human_id is None):
            raise ValueError("Provide exactly one of user_id or human_id")
        if self.workspace_path and not self.workspace_path.startswith(("/", "~/")):
            raise ValueError("workspace_path must be absolute or start with ~/")
        for command in self.allowed_commands:
            if not re.match(_COMMAND_PATTERN, command):
                raise ValueError(f"invalid allowed command: {command!r}")
        return self


async def _grant_out(db: AsyncSession, grant: AgentAccessGrant) -> dict:
    grantee = await db.get(User, grant.grantee_user_id)
    agent = await db.scalar(select(Agent).where(Agent.agent_id == grant.agent_id))
    return {
        "id": grant.id,
        "space_id": grant.space_id,
        "agent_id": grant.agent_id,
        "agent_name": agent.display_name if agent else None,
        "grantee_user_id": grant.grantee_user_id,
        "grantee_human_id": grantee.human_id if grantee else None,
        "grantee_name": grantee.display_name if grantee else None,
        "role": grant.role,
        "workspace_path": grant.workspace_path,
        "allowed_commands": list(grant.allowed_commands or []),
        "expires_at": grant.expires_at,
        "revoked_at": grant.revoked_at,
        "created_at": grant.created_at,
    }


async def _resolve_user_id(db: AsyncSession, body: GrantIn) -> UUID:
    if body.user_id is not None:
        return body.user_id
    user_id = await db.scalar(select(User.id).where(User.human_id == body.human_id))
    if user_id is None:
        spaces.reject("grantee_not_member", 404)
    return user_id


@router.post("/spaces/{space_id}/agents/{agent_id}/access-grants", status_code=201)
async def create_grant(space_id: UUID, agent_id: str, body: GrantIn,
                       ctx: RequestContext = Depends(require_user),
                       db: AsyncSession = Depends(transaction, scope="function")):
    grantee_user_id = await _resolve_user_id(db, body)
    grant = await service.create_grant(
        db, space_id, ctx.user_id, agent_id, grantee_user_id, body.role,
        expires_at=body.expires_at, workspace_path=body.workspace_path,
        allowed_commands=body.allowed_commands,
    )
    return await _grant_out(db, grant)


@router.get("/spaces/{space_id}/agents/{agent_id}/access-grants")
async def list_grants(space_id: UUID, agent_id: str,
                      ctx: RequestContext = Depends(require_user),
                      db: AsyncSession = Depends(transaction, scope="function")):
    grants = await service.list_grants(db, space_id, ctx.user_id, agent_id)
    return {"grants": [await _grant_out(db, g) for g in grants]}


@router.delete("/spaces/{space_id}/access-grants/{grant_id}")
async def revoke_grant(space_id: UUID, grant_id: UUID,
                       ctx: RequestContext = Depends(require_user),
                       db: AsyncSession = Depends(transaction, scope="function")):
    grant = await service.revoke_grant(db, space_id, ctx.user_id, grant_id)
    return await _grant_out(db, grant)


@router.get("/spaces/{space_id}/shared-agents")
async def shared_agents(space_id: UUID,
                        ctx: RequestContext = Depends(require_user),
                        db: AsyncSession = Depends(transaction, scope="function")):
    """Agents other members have shared with the caller in this organization."""
    grants = await service.list_shared_agents(db, space_id, ctx.user_id)
    return {"agents": [await _grant_out(db, g) for g in grants]}
