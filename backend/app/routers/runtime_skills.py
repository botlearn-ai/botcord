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
from pydantic import BaseModel, ConfigDict, Field, field_validator
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
_CLOUD_SKILLS_DISPATCH_RETRY_CODES = {
    "cloud_daemon_offline",
    "cloud_daemon_disconnected",
    "cloud_daemon_send_failed",
}
_CLOUD_SKILLS_DISPATCH_RETRY_FRAME_TYPES = {"list_agent_skills"}
_REFRESH_SKILLS_TIMEOUT_MS = 5000
_INSTALL_SKILL_TIMEOUT_MS = 30000
_INSTALL_SKILL_AGENT_LOAD_WAIT_SECONDS = 10.0
_INSTALL_SKILL_AGENT_LOAD_POLL_SECONDS = 0.5
_SUPPORTED_SKILL_TARGET_RUNTIMES = {"claude-code", "codex"}
_TRUSTED_VERCEL_PACKAGE_SPECS = {
    "https://github.com/vercel-labs/skills",
    "github:vercel-labs/skills",
    "vercel-labs/skills",
}


class AgentRuntimeSkillOut(BaseModel):
    name: str
    source: str
    sourceDetail: str | None = None
    runtime: str | None = None
    path: str | None = None
    profile: str | None = None
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


class AgentRuntimeSkillFileIn(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    content: str | None = Field(default=None, max_length=262144)
    sourcePath: str | None = Field(default=None, max_length=512)


class AgentRuntimeSkillManifestIn(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    id: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=4096)
    skillMd: str | None = Field(default=None, max_length=262144)
    markdown: str | None = Field(default=None, max_length=262144)
    files: list[AgentRuntimeSkillFileIn] | None = Field(default=None, max_length=32)
    targetRuntimes: list[str] | None = Field(default=None, max_length=4)

    @field_validator("targetRuntimes")
    @classmethod
    def _validate_target_runtimes(cls, value: list[str] | None) -> list[str] | None:
        return _validate_skill_target_runtimes(value)


class AgentRuntimeSkillArchiveManifestIn(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    id: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=4096)
    skillMd: str | None = Field(default=None, max_length=262144)
    markdown: str | None = Field(default=None, max_length=262144)
    files: list[AgentRuntimeSkillFileIn] | None = Field(default=None, max_length=32)
    skills: list[AgentRuntimeSkillManifestIn] | None = Field(default=None, max_length=16)
    targetRuntimes: list[str] | None = Field(default=None, max_length=4)

    @field_validator("targetRuntimes")
    @classmethod
    def _validate_target_runtimes(cls, value: list[str] | None) -> list[str] | None:
        return _validate_skill_target_runtimes(value)


class AgentRuntimeSkillVercelIn(BaseModel):
    packageSpec: str = Field(min_length=1, max_length=256)
    skills: list[str] | None = Field(default=None, max_length=32)

    @field_validator("packageSpec")
    @classmethod
    def _validate_package_spec(cls, value: str) -> str:
        cleaned = value.strip()
        if cleaned not in _TRUSTED_VERCEL_PACKAGE_SPECS:
            raise ValueError("unsupported vercel skills packageSpec")
        return cleaned


class AgentRuntimeSkillInstallIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    manifest: AgentRuntimeSkillManifestIn | None = None
    archiveManifest: AgentRuntimeSkillArchiveManifestIn | None = None
    vercel: AgentRuntimeSkillVercelIn | None = None


class _RuntimeSkillsHost(BaseModel):
    daemon_instance_id: str
    cloud_daemon_instance_id: str | None = None


def _validate_skill_target_runtimes(value: list[str] | None) -> list[str] | None:
    if value is None:
        return None
    normalized: list[str] = []
    for item in value:
        if item not in _SUPPORTED_SKILL_TARGET_RUNTIMES:
            raise ValueError(f"unsupported skill target runtime: {item}")
        if item not in normalized:
            normalized.append(item)
    if not normalized:
        raise ValueError("at least one target runtime is required")
    return normalized


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
    frame_type: str,
    params: dict[str, Any],
    *,
    db: AsyncSession,
    ctx: RequestContext,
    agent: Agent,
    timeout_ms: int = _REFRESH_SKILLS_TIMEOUT_MS,
) -> dict[str, Any]:
    if host.cloud_daemon_instance_id:
        await _ensure_cloud_runtime_skills_host_online(db, ctx, agent, host)
        try:
            return await send_cloud_control_frame(
                host.cloud_daemon_instance_id,
                frame_type,
                params,
                timeout_ms=timeout_ms,
            )
        except CloudDaemonDispatchError as exc:
            can_retry_dispatch = (
                frame_type in _CLOUD_SKILLS_DISPATCH_RETRY_FRAME_TYPES
                and exc.code in _CLOUD_SKILLS_DISPATCH_RETRY_CODES
            )
            if can_retry_dispatch:
                logger.warning(
                    "cloud runtime skills dispatch lost connection; attempting resume and retry: "
                    "agent=%s cloud=%s frame=%s code=%s err=%s",
                    agent.agent_id,
                    host.cloud_daemon_instance_id,
                    frame_type,
                    exc.code,
                    exc.message,
                )
                await _ensure_cloud_runtime_skills_host_online(
                    db,
                    ctx,
                    agent,
                    host,
                    force_resume=True,
                )
                try:
                    return await send_cloud_control_frame(
                        host.cloud_daemon_instance_id,
                        frame_type,
                        params,
                        timeout_ms=timeout_ms,
                    )
                except CloudDaemonDispatchError as retry_exc:
                    exc = retry_exc
            elif (
                frame_type in _CLOUD_SKILLS_DISPATCH_RETRY_FRAME_TYPES
                and exc.code == "cloud_daemon_ack_timeout"
            ):
                logger.warning(
                    "cloud runtime skills daemon ack timed out during startup; retrying once: "
                    "agent=%s daemon=%s cloud=%s frame=%s timeout_ms=%s",
                    agent.agent_id,
                    host.daemon_instance_id,
                    host.cloud_daemon_instance_id,
                    frame_type,
                    timeout_ms,
                )
                try:
                    return await send_cloud_control_frame(
                        host.cloud_daemon_instance_id,
                        frame_type,
                        params,
                        timeout_ms=timeout_ms,
                    )
                except CloudDaemonDispatchError as retry_exc:
                    exc = retry_exc
            if exc.code in _CLOUD_SKILLS_DISPATCH_RETRY_CODES:
                raise HTTPException(status_code=409, detail="daemon_offline") from exc
            if exc.code == "cloud_daemon_ack_timeout":
                logger.warning(
                    "runtime skills daemon ack timeout: agent=%s daemon=%s cloud=%s "
                    "frame=%s timeout_ms=%s",
                    agent.agent_id,
                    host.daemon_instance_id,
                    host.cloud_daemon_instance_id,
                    frame_type,
                    timeout_ms,
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
            frame_type,
            params,
            timeout_ms=timeout_ms,
        )
    except HTTPException as exc:
        if exc.status_code == 504 and exc.detail == "daemon_ack_timeout":
            logger.warning(
                "runtime skills daemon ack timeout: agent=%s daemon=%s cloud=%s "
                "frame=%s timeout_ms=%s",
                agent.agent_id,
                host.daemon_instance_id,
                host.cloud_daemon_instance_id,
                frame_type,
                timeout_ms,
            )
        raise


def _install_params(agent_id: str, body: AgentRuntimeSkillInstallIn) -> dict[str, Any]:
    modes = [body.manifest, body.archiveManifest, body.vercel]
    if len([mode for mode in modes if mode is not None]) != 1:
        raise HTTPException(
            status_code=400,
            detail="exactly one of manifest, archiveManifest, or vercel is required",
        )
    params: dict[str, Any] = {"agentId": agent_id}
    if body.manifest is not None:
        params["manifest"] = body.manifest.model_dump(exclude_none=True)
    if body.archiveManifest is not None:
        params["archiveManifest"] = body.archiveManifest.model_dump(exclude_none=True)
    if body.vercel is not None:
        params["vercel"] = body.vercel.model_dump(exclude_none=True)
    return params


async def install_agent_runtime_skill_for_agent(
    *,
    agent_id: str,
    body: AgentRuntimeSkillInstallIn,
    ctx: RequestContext,
    db: AsyncSession,
) -> AgentRuntimeSkillsOut:
    agent = await _load_owned_agent(db, ctx, agent_id)
    host = await _load_runtime_skills_host(db, ctx, agent)

    params = _install_params(agent.agent_id, body)
    deadline = time.monotonic() + _INSTALL_SKILL_AGENT_LOAD_WAIT_SECONDS
    while True:
        ack = await _send_runtime_skills_control_frame(
            host,
            "install_agent_skill",
            params,
            db=db,
            ctx=ctx,
            agent=agent,
            timeout_ms=_INSTALL_SKILL_TIMEOUT_MS,
        )
        err = ack.get("error") if isinstance(ack, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else None
        if isinstance(ack, dict) and ack.get("ok"):
            break
        if code != "agent_not_loaded" or time.monotonic() >= deadline:
            break
        await asyncio.sleep(_INSTALL_SKILL_AGENT_LOAD_POLL_SECONDS)

    if not isinstance(ack, dict) or not ack.get("ok"):
        err = ack.get("error") if isinstance(ack, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else None
        message = (err or {}).get("message") if isinstance(err, dict) else None
        raise HTTPException(
            status_code=502,
            detail={
                "code": "daemon_runtime_skill_install_failed",
                "daemon_code": code,
                "daemon_message": message,
            },
        )

    result = ack.get("result") if isinstance(ack.get("result"), dict) else None
    snapshot = result.get("snapshot") if isinstance(result, dict) else None
    persisted = None
    if isinstance(snapshot, dict):
        persisted = await _persist_agent_skill_snapshot(
            db,
            daemon_instance_id=host.daemon_instance_id,
            params=snapshot,
        )
    if persisted is None:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "daemon_runtime_skill_install_malformed",
                "daemon_message": "install_agent_skill returned malformed result",
            },
        )
    await db.commit()
    await db.refresh(agent)
    return _stored_response(agent)


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
        "list_agent_skills",
        {"agentId": agent.agent_id},
        db=db,
        ctx=ctx,
        agent=agent,
    )
    if not isinstance(ack, dict) or not ack.get("ok"):
        err = ack.get("error") if isinstance(ack, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else None
        if host.cloud_daemon_instance_id and code == "agent_not_loaded":
            logger.warning(
                "cloud runtime skills daemon returned agent_not_loaded; forcing resume and retry: "
                "agent=%s daemon=%s cloud=%s",
                agent.agent_id,
                host.daemon_instance_id,
                host.cloud_daemon_instance_id,
            )
            await _ensure_cloud_runtime_skills_host_online(
                db,
                ctx,
                agent,
                host,
                force_resume=True,
            )
            ack = await _send_runtime_skills_control_frame(
                host,
                "list_agent_skills",
                {"agentId": agent.agent_id},
                db=db,
                ctx=ctx,
                agent=agent,
            )
            err = ack.get("error") if isinstance(ack, dict) else None
            code = (err or {}).get("code") if isinstance(err, dict) else None
        message = (err or {}).get("message") if isinstance(err, dict) else None
        if isinstance(ack, dict) and ack.get("ok"):
            result = ack.get("result") if isinstance(ack.get("result"), dict) else None
        else:
            raise HTTPException(
                status_code=502,
                detail={
                    "code": "daemon_runtime_skills_failed",
                    "daemon_code": code,
                    "daemon_message": message,
                },
            )
    else:
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


@router.post("/{agent_id}/skills/install", response_model=AgentRuntimeSkillsOut)
@router.post("/{agent_id}/runtime-skills/install", response_model=AgentRuntimeSkillsOut)
async def install_agent_runtime_skill(
    agent_id: str,
    body: AgentRuntimeSkillInstallIn,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> AgentRuntimeSkillsOut:
    return await install_agent_runtime_skill_for_agent(
        agent_id=agent_id,
        body=body,
        ctx=ctx,
        db=db,
    )
