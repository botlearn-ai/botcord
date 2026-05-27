"""
[INPUT]: Authenticated user + owned daemon-hosted agent id
[OUTPUT]: GET/POST /api/agents/{agent_id}/runtime-skills — read stored skill
          snapshot or ask daemon to re-scan runtime/workspace skills.
[POS]: BFF surface for the dashboard agent settings Skills tab.
[PROTOCOL]: Hub authorizes ownership; daemon resolves agent-local skill dirs.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.models import Agent, CloudAgentInstance
from hub.routers.cloud_daemon_control import (
    CloudDaemonDispatchError,
    is_cloud_daemon_online,
    send_cloud_control_frame,
)
from hub.routers.daemon_control import (
    _persist_agent_skill_snapshot,
    is_daemon_online,
    send_control_frame,
)
from hub.services.cloud_agent import CloudAgentError, CloudAgentService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["app-runtime-skills"])

_CLOUD_SKILLS_RESUME_WAIT_SECONDS = 20.0
_CLOUD_SKILLS_RESUME_POLL_SECONDS = 0.5
_REFRESH_SKILLS_TIMEOUT_MS = 5000


class AgentRuntimeSkillOut(BaseModel):
    name: str
    source: str
    description: str | None = None
    mtimeMs: float
    mtimeAt: str | None = None


class AgentRuntimeSkillsOut(BaseModel):
    agent_id: str
    agentId: str
    daemon_instance_id: str | None = None
    skills: list[AgentRuntimeSkillOut] | None = None
    runtime: str | None = None
    sniffed_at: datetime.datetime | None = None
    skills_probed_at: datetime.datetime | None = None


class _RuntimeSkillsHost(BaseModel):
    daemon_instance_id: str
    cloud_daemon_instance_id: str | None = None


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


async def _load_runtime_skills_host(
    db: AsyncSession,
    ctx: RequestContext,
    agent: Agent,
) -> _RuntimeSkillsHost:
    if agent.hosting_kind == "cloud":
        if not agent.daemon_instance_id:
            raise HTTPException(status_code=409, detail="agent_not_daemon_hosted")
        binding = await db.scalar(
            select(CloudAgentInstance).where(
                CloudAgentInstance.agent_id == agent.agent_id,
                CloudAgentInstance.user_id == ctx.user_id,
                CloudAgentInstance.status.notin_(("deleting", "deleted")),
            )
        )
        if binding is None:
            raise HTTPException(status_code=409, detail="agent_not_daemon_hosted")
        return _RuntimeSkillsHost(
            daemon_instance_id=binding.daemon_instance_id,
            cloud_daemon_instance_id=binding.cloud_daemon_instance_id,
        )

    if not agent.daemon_instance_id:
        raise HTTPException(status_code=409, detail="agent_not_daemon_hosted")
    return _RuntimeSkillsHost(daemon_instance_id=agent.daemon_instance_id)


async def _ensure_cloud_runtime_skills_host_online(
    db: AsyncSession,
    ctx: RequestContext,
    agent: Agent,
    host: _RuntimeSkillsHost,
) -> None:
    cloud_daemon_instance_id = host.cloud_daemon_instance_id
    if not cloud_daemon_instance_id:
        return
    if is_cloud_daemon_online(cloud_daemon_instance_id):
        return

    try:
        await CloudAgentService().resume_cloud_agent(
            db,
            user_id=ctx.user_id,
            agent_id=agent.agent_id,
        )
    except CloudAgentError as exc:
        logger.warning(
            "cloud runtime skills resume failed: agent=%s cloud=%s code=%s err=%s",
            agent.agent_id,
            cloud_daemon_instance_id,
            exc.code,
            exc.message,
        )
        raise HTTPException(
            status_code=409 if exc.http_status == 409 else exc.http_status,
            detail="daemon_offline" if exc.http_status == 409 else exc.code,
        ) from exc

    deadline = time.monotonic() + _CLOUD_SKILLS_RESUME_WAIT_SECONDS
    while time.monotonic() < deadline:
        if is_cloud_daemon_online(cloud_daemon_instance_id):
            return
        await asyncio.sleep(_CLOUD_SKILLS_RESUME_POLL_SECONDS)

    raise HTTPException(status_code=409, detail="daemon_offline")


async def _send_runtime_skills_control_frame(
    host: _RuntimeSkillsHost,
    params: dict[str, Any],
    *,
    db: AsyncSession,
    ctx: RequestContext,
    agent: Agent,
) -> dict[str, Any]:
    if host.cloud_daemon_instance_id:
        await _ensure_cloud_runtime_skills_host_online(db, ctx, agent, host)
        try:
            return await send_cloud_control_frame(
                host.cloud_daemon_instance_id,
                "list_agent_skills",
                params,
                timeout_ms=_REFRESH_SKILLS_TIMEOUT_MS,
            )
        except CloudDaemonDispatchError as exc:
            if exc.code in {
                "cloud_daemon_offline",
                "cloud_daemon_disconnected",
                "cloud_daemon_send_failed",
            }:
                raise HTTPException(status_code=409, detail="daemon_offline") from exc
            if exc.code == "cloud_daemon_ack_timeout":
                raise HTTPException(status_code=504, detail="daemon_ack_timeout") from exc
            raise HTTPException(
                status_code=502,
                detail={"code": exc.code, "daemon_message": exc.message},
            ) from exc

    if not is_daemon_online(host.daemon_instance_id):
        raise HTTPException(status_code=409, detail="daemon_offline")
    return await send_control_frame(
        host.daemon_instance_id,
        "list_agent_skills",
        params,
        timeout_ms=_REFRESH_SKILLS_TIMEOUT_MS,
    )


def _stored_response(agent: Agent) -> AgentRuntimeSkillsOut:
    return AgentRuntimeSkillsOut(
        agent_id=agent.agent_id,
        agentId=agent.agent_id,
        daemon_instance_id=agent.daemon_instance_id,
        skills=agent.skills_json if agent.skills_json else None,
        runtime=agent.runtime,
        sniffed_at=agent.skills_probed_at,
        skills_probed_at=agent.skills_probed_at,
    )


@router.get("/{agent_id}/skills", response_model=AgentRuntimeSkillsOut)
@router.get("/{agent_id}/runtime-skills", response_model=AgentRuntimeSkillsOut)
async def get_agent_runtime_skills(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> AgentRuntimeSkillsOut:
    agent = await _load_owned_agent(db, ctx, agent_id)
    return _stored_response(agent)


@router.post("/{agent_id}/skills/refresh", response_model=AgentRuntimeSkillsOut)
@router.post("/{agent_id}/runtime-skills/refresh", response_model=AgentRuntimeSkillsOut)
async def refresh_agent_runtime_skills(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> AgentRuntimeSkillsOut:
    agent = await _load_owned_agent(db, ctx, agent_id)
    host = await _load_runtime_skills_host(db, ctx, agent)

    ack = await _send_runtime_skills_control_frame(
        host,
        {"agentId": agent.agent_id},
        db=db,
        ctx=ctx,
        agent=agent,
    )
    if not isinstance(ack, dict) or not ack.get("ok"):
        err = ack.get("error") if isinstance(ack, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else None
        message = (err or {}).get("message") if isinstance(err, dict) else None
        raise HTTPException(
            status_code=502,
            detail={
                "code": "daemon_runtime_skills_failed",
                "daemon_code": code,
                "daemon_message": message,
            },
        )

    result = ack.get("result") if isinstance(ack.get("result"), dict) else None
    persisted = None
    if result is not None:
        persisted = await _persist_agent_skill_snapshot(
            db,
            daemon_instance_id=host.daemon_instance_id,
            params=result,
        )
    if persisted is None:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "daemon_runtime_skills_malformed",
                "daemon_message": "list_agent_skills returned malformed result",
            },
        )
    await db.commit()
    await db.refresh(agent)
    return _stored_response(agent)
