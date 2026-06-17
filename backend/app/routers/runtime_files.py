"""
[INPUT]: Authenticated user + owned daemon-hosted agent id
[OUTPUT]: GET /api/agents/{agent_id}/runtime-files — returns allowlisted local
          runtime/profile Markdown files through the daemon control plane.
[POS]: BFF surface for the dashboard agent settings "Files & Memory" tab.
[PROTOCOL]: Hub authorizes ownership; daemon resolves agent-local credentials
            and never accepts arbitrary filesystem paths.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
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
from hub.routers.daemon_control import is_daemon_online, send_control_frame
from hub.services.cloud_agent import CloudAgentError, CloudAgentService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["app-runtime-files"])

_CLOUD_RUNTIME_FILES_RESUME_WAIT_SECONDS = 20.0
_CLOUD_RUNTIME_FILES_RESUME_POLL_SECONDS = 0.5
_CLOUD_RUNTIME_FILES_DISPATCH_RETRY_CODES = {
    "cloud_daemon_offline",
    "cloud_daemon_disconnected",
    "cloud_daemon_send_failed",
}
_CLOUD_RUNTIME_FILES_DAEMON_RETRY_CODES = {
    "agent_credentials_missing",
    "agent_not_loaded",
}


class AgentRuntimeFileOut(BaseModel):
    id: str
    name: str
    scope: Literal["workspace", "memory", "hermes", "openclaw"]
    relativePath: str | None = None
    runtime: str | None = None
    profile: str | None = None
    size: int | None = None
    mtimeMs: float | None = None
    content: str | None = None
    truncated: bool | None = None
    error: str | None = None


class AgentRuntimeFilesOut(BaseModel):
    agentId: str
    runtime: str | None = None
    files: list[AgentRuntimeFileOut]


class _RuntimeFilesHost(BaseModel):
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


async def _load_runtime_files_host(
    db: AsyncSession,
    ctx: RequestContext,
    agent: Agent,
) -> _RuntimeFilesHost:
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
        return _RuntimeFilesHost(
            daemon_instance_id=binding.daemon_instance_id,
            cloud_daemon_instance_id=binding.cloud_daemon_instance_id,
        )

    if not agent.daemon_instance_id:
        raise HTTPException(status_code=409, detail="agent_not_daemon_hosted")
    return _RuntimeFilesHost(daemon_instance_id=agent.daemon_instance_id)


async def _send_runtime_files_control_frame(
    host: _RuntimeFilesHost,
    params: dict[str, Any],
    *,
    db: AsyncSession,
    ctx: RequestContext,
    agent: Agent,
) -> dict[str, Any]:
    if host.cloud_daemon_instance_id:
        await _ensure_cloud_runtime_files_host_online(db, ctx, agent, host)
        try:
            return await send_cloud_control_frame(
                host.cloud_daemon_instance_id,
                "list_agent_files",
                params,
                timeout_ms=5000,
            )
        except CloudDaemonDispatchError as exc:
            if exc.code in _CLOUD_RUNTIME_FILES_DISPATCH_RETRY_CODES:
                logger.warning(
                    "cloud runtime files dispatch lost connection; attempting resume and retry: "
                    "agent=%s cloud=%s code=%s err=%s",
                    agent.agent_id,
                    host.cloud_daemon_instance_id,
                    exc.code,
                    exc.message,
                )
                await _ensure_cloud_runtime_files_host_online(
                    db,
                    ctx,
                    agent,
                    host,
                    force_resume=True,
                )
                try:
                    return await send_cloud_control_frame(
                        host.cloud_daemon_instance_id,
                        "list_agent_files",
                        params,
                        timeout_ms=5000,
                    )
                except CloudDaemonDispatchError as retry_exc:
                    exc = retry_exc
            if exc.code in {
                "cloud_daemon_offline",
                "cloud_daemon_disconnected",
                "cloud_daemon_send_failed",
            }:
                raise HTTPException(status_code=409, detail="daemon_offline") from exc
            if exc.code == "cloud_daemon_ack_timeout":
                logger.warning(
                    "runtime files daemon ack timeout: agent=%s daemon=%s cloud=%s "
                    "frame=%s timeout_ms=%s",
                    agent.agent_id,
                    host.daemon_instance_id,
                    host.cloud_daemon_instance_id,
                    "list_agent_files",
                    5000,
                )
                raise HTTPException(status_code=504, detail="daemon_ack_timeout") from exc
            raise HTTPException(
                status_code=502,
                detail={"code": exc.code, "daemon_message": exc.message},
            ) from exc

    if not is_daemon_online(host.daemon_instance_id):
        raise HTTPException(status_code=409, detail="daemon_offline")
    try:
        return await send_control_frame(
            host.daemon_instance_id,
            "list_agent_files",
            params,
            timeout_ms=5000,
        )
    except HTTPException as exc:
        if exc.status_code == 504 and exc.detail == "daemon_ack_timeout":
            logger.warning(
                "runtime files daemon ack timeout: agent=%s daemon=%s cloud=%s "
                "frame=%s timeout_ms=%s",
                agent.agent_id,
                host.daemon_instance_id,
                host.cloud_daemon_instance_id,
                "list_agent_files",
                5000,
            )
        raise


async def _ensure_cloud_runtime_files_host_online(
    db: AsyncSession,
    ctx: RequestContext,
    agent: Agent,
    host: _RuntimeFilesHost,
    *,
    force_resume: bool = False,
) -> None:
    cloud_daemon_instance_id = host.cloud_daemon_instance_id
    if not cloud_daemon_instance_id:
        return

    if not force_resume and is_cloud_daemon_online(cloud_daemon_instance_id):
        return

    try:
        await CloudAgentService().resume_cloud_agent(
            db,
            user_id=ctx.user_id,
            agent_id=agent.agent_id,
        )
    except CloudAgentError as exc:
        logger.warning(
            "cloud runtime files resume failed: agent=%s cloud=%s code=%s err=%s",
            agent.agent_id,
            cloud_daemon_instance_id,
            exc.code,
            exc.message,
        )
        raise HTTPException(
            status_code=409 if exc.http_status == 409 else exc.http_status,
            detail="daemon_offline" if exc.http_status == 409 else exc.code,
        ) from exc

    deadline = time.monotonic() + _CLOUD_RUNTIME_FILES_RESUME_WAIT_SECONDS
    while time.monotonic() < deadline:
        if is_cloud_daemon_online(cloud_daemon_instance_id):
            return
        await asyncio.sleep(_CLOUD_RUNTIME_FILES_RESUME_POLL_SECONDS)

    raise HTTPException(status_code=409, detail="daemon_offline")


@router.get("/{agent_id}/runtime-files", response_model=AgentRuntimeFilesOut)
async def get_agent_runtime_files(
    agent_id: str,
    file_id: str | None = Query(default=None, max_length=256),
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> AgentRuntimeFilesOut:
    agent = await _load_owned_agent(db, ctx, agent_id)
    host = await _load_runtime_files_host(db, ctx, agent)

    params: dict[str, Any] = {"agentId": agent.agent_id}
    if file_id:
        params["fileId"] = file_id

    ack = await _send_runtime_files_control_frame(
        host,
        params,
        db=db,
        ctx=ctx,
        agent=agent,
    )
    if not isinstance(ack, dict) or not ack.get("ok"):
        err = ack.get("error") if isinstance(ack, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else None
        if (
            host.cloud_daemon_instance_id
            and code in _CLOUD_RUNTIME_FILES_DAEMON_RETRY_CODES
        ):
            logger.warning(
                "cloud runtime files daemon returned %s; forcing resume and retry: "
                "agent=%s daemon=%s cloud=%s",
                code,
                agent.agent_id,
                host.daemon_instance_id,
                host.cloud_daemon_instance_id,
            )
            await _ensure_cloud_runtime_files_host_online(
                db,
                ctx,
                agent,
                host,
                force_resume=True,
            )
            ack = await _send_runtime_files_control_frame(
                host,
                params,
                db=db,
                ctx=ctx,
                agent=agent,
            )
            err = ack.get("error") if isinstance(ack, dict) else None
            code = (err or {}).get("code") if isinstance(err, dict) else None
        message = (err or {}).get("message") if isinstance(err, dict) else None
        if isinstance(ack, dict) and ack.get("ok"):
            result = ack.get("result")
        else:
            raise HTTPException(
                status_code=502,
                detail={
                    "code": "daemon_runtime_files_failed",
                    "daemon_code": code,
                    "daemon_message": message,
                },
            )
    else:
        result = ack.get("result")

    if not isinstance(result, dict) or not isinstance(result.get("files"), list):
        raise HTTPException(
            status_code=502,
            detail={
                "code": "daemon_runtime_files_malformed",
                "daemon_message": "list_agent_files returned malformed result",
            },
        )
    try:
        return AgentRuntimeFilesOut.model_validate(result)
    except Exception as exc:  # noqa: BLE001
        logger.warning("runtime files result validation failed: agent=%s err=%s", agent_id, exc)
        raise HTTPException(
            status_code=502,
            detail={
                "code": "daemon_runtime_files_malformed",
                "daemon_message": "list_agent_files returned invalid file metadata",
            },
        )
