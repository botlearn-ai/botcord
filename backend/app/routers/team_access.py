"""Team-mode access UI endpoints (agent directory, access requests, room access, overview)."""

import datetime
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from app.routers.spaces import transaction
from hub.services import team_access as service

router = APIRouter(prefix="/api/spaces/{space_id}", tags=["app-team-access"])

_COMMAND_PATTERN = r"^[A-Za-z0-9_./:@=+-][A-Za-z0-9_./:@=+ -]{0,63}$"


def _request_out(req) -> dict:
    return {"id": req.id, "agent_id": req.agent_id, "requested_role": req.requested_role, "message": req.message,
            "status": req.status, "grant_id": req.grant_id, "created_at": req.created_at,
            "decided_at": req.decided_at}


@router.get("/agent-directory")
async def agent_directory(space_id: UUID, ctx: RequestContext = Depends(require_user),
                          db: AsyncSession = Depends(transaction, scope="function")):
    return {"agents": await service.agent_directory(db, space_id, ctx.user_id)}


class RequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    role: str = Field(pattern=r"^(consultant|collaborator)$")
    message: str | None = Field(default=None, max_length=500)


@router.post("/agents/{agent_id}/access-requests", status_code=201)
async def request_access(space_id: UUID, agent_id: str, body: RequestIn,
                         ctx: RequestContext = Depends(require_user),
                         db: AsyncSession = Depends(transaction, scope="function")):
    req = await service.request_access(db, space_id, ctx.user_id, agent_id, body.role, body.message or None)
    return _request_out(req)


@router.get("/access-requests")
async def list_requests(space_id: UUID, status: str = "pending", ctx: RequestContext = Depends(require_user),
                        db: AsyncSession = Depends(transaction, scope="function")):
    return await service.list_requests(db, space_id, ctx.user_id, status=None if status == "all" else status)


class ApproveIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    role: str | None = Field(default=None, pattern=r"^(consultant|collaborator)$")
    workspace_path: str | None = Field(default=None, max_length=1024)
    allowed_commands: list[str] = Field(default_factory=list, max_length=20)
    expires_at: datetime.datetime | None = None


@router.post("/access-requests/{request_id}/approve")
async def approve(space_id: UUID, request_id: UUID, body: ApproveIn, ctx: RequestContext = Depends(require_user),
                  db: AsyncSession = Depends(transaction, scope="function")):
    import re

    if any(not re.match(_COMMAND_PATTERN, c) for c in body.allowed_commands):
        from hub.services import spaces
        spaces.reject("invalid_allowed_command", 422)
    req, grant = await service.approve_request(
        db, space_id, ctx.user_id, request_id, role=body.role, workspace_path=body.workspace_path,
        allowed_commands=body.allowed_commands, expires_at=body.expires_at)
    return {**_request_out(req), "grant_role": grant.role}


@router.post("/access-requests/{request_id}/reject")
async def reject(space_id: UUID, request_id: UUID, ctx: RequestContext = Depends(require_user),
                 db: AsyncSession = Depends(transaction, scope="function")):
    return _request_out(await service.reject_request(db, space_id, ctx.user_id, request_id))


@router.post("/access-requests/{request_id}/cancel")
async def cancel(space_id: UUID, request_id: UUID, ctx: RequestContext = Depends(require_user),
                 db: AsyncSession = Depends(transaction, scope="function")):
    return _request_out(await service.cancel_request(db, space_id, ctx.user_id, request_id))


@router.get("/rooms/{room_id}/agent-access")
async def room_agent_access(space_id: UUID, room_id: str, ctx: RequestContext = Depends(require_user),
                            db: AsyncSession = Depends(transaction, scope="function")):
    return {"agents": await service.room_agent_access(db, space_id, room_id, ctx.user_id)}


@router.get("/agents/{agent_id}/rooms")
async def agent_rooms(space_id: UUID, agent_id: str, ctx: RequestContext = Depends(require_user),
                      db: AsyncSession = Depends(transaction, scope="function")):
    return {"rooms": await service.agent_rooms(db, space_id, agent_id, ctx.user_id)}


@router.get("/access-overview")
async def access_overview(space_id: UUID, ctx: RequestContext = Depends(require_user),
                          db: AsyncSession = Depends(transaction, scope="function")):
    return await service.access_overview(db, space_id, ctx.user_id)
