"""Dispatch BotLearn course-session profile controls to local/cloud daemons."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import Agent, CloudAgentInstance
from hub.routers.cloud_daemon_control import (
    CloudDaemonDispatchError,
    is_cloud_daemon_online,
    send_cloud_control_frame,
)
from hub.routers.daemon_control import is_daemon_online, send_control_frame
from hub.services.cloud_agent import CloudAgentError, CloudAgentService

logger = logging.getLogger(__name__)

_PROFILE_CONTROL_TIMEOUT_MS = 15_000
_AGENT_LOAD_WAIT_SECONDS = 12.0
_AGENT_LOAD_POLL_SECONDS = 0.4


class SessionProfileDispatchError(RuntimeError):
    def __init__(self, code: str, message: str, *, http_status: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


@dataclass(frozen=True)
class _SessionProfileHost:
    agent: Agent
    daemon_instance_id: str
    cloud_daemon_instance_id: str | None = None


async def apply_botlearn_session_profile(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    agent_id: str,
    session_key: str,
    room_id: str,
    runtime_profile: dict[str, Any],
    ttl_seconds: int,
) -> dict[str, Any]:
    params = {
        "agentId": agent_id,
        "sessionKey": session_key,
        "roomId": room_id,
        **runtime_profile,
        "ttlSeconds": ttl_seconds,
    }
    return await _dispatch_with_agent_load_retry(
        db,
        user_id=user_id,
        agent_id=agent_id,
        frame_type="apply_session_profile",
        params=params,
    )


async def get_botlearn_session_profile(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    agent_id: str,
    session_key: str,
    room_id: str,
    profile_id: str,
    profile_hash: str,
) -> dict[str, Any]:
    return await _dispatch_with_agent_load_retry(
        db,
        user_id=user_id,
        agent_id=agent_id,
        frame_type="get_session_profile",
        params={
            "agentId": agent_id,
            "sessionKey": session_key,
            "roomId": room_id,
            "profileId": profile_id,
            "profileHash": profile_hash,
        },
    )


async def _dispatch_with_agent_load_retry(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    agent_id: str,
    frame_type: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    host = await _load_host(db, user_id=user_id, agent_id=agent_id)
    await _ensure_host_online(db, user_id=user_id, host=host)
    deadline = time.monotonic() + _AGENT_LOAD_WAIT_SECONDS
    while True:
        ack = await _send(host, frame_type, params)
        error = ack.get("error") if isinstance(ack, dict) else None
        daemon_code = error.get("code") if isinstance(error, dict) else None
        if isinstance(ack, dict) and ack.get("ok"):
            result = ack.get("result")
            if isinstance(result, dict):
                return result
            raise SessionProfileDispatchError(
                "profile_apply_failed",
                f"{frame_type} returned a malformed result",
            )
        if daemon_code != "agent_not_loaded" or time.monotonic() >= deadline:
            message = error.get("message") if isinstance(error, dict) else None
            raise SessionProfileDispatchError(
                str(daemon_code or "profile_apply_failed"),
                str(message or f"daemon rejected {frame_type}"),
            )
        await asyncio.sleep(_AGENT_LOAD_POLL_SECONDS)


async def _load_host(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    agent_id: str,
) -> _SessionProfileHost:
    agent = await db.scalar(
        select(Agent).where(
            Agent.agent_id == agent_id,
            Agent.user_id == user_id,
            Agent.status == "active",
        )
    )
    if agent is None or not agent.daemon_instance_id:
        raise SessionProfileDispatchError(
            "agent_not_daemon_hosted",
            "BotLearn Agent is not bound to an active daemon",
            http_status=409,
        )
    if agent.hosting_kind != "cloud":
        return _SessionProfileHost(
            agent=agent,
            daemon_instance_id=agent.daemon_instance_id,
        )

    binding = await db.scalar(
        select(CloudAgentInstance).where(
            CloudAgentInstance.agent_id == agent.agent_id,
            CloudAgentInstance.user_id == user_id,
            CloudAgentInstance.status.notin_(("deleting", "deleted")),
        )
    )
    if binding is None:
        raise SessionProfileDispatchError(
            "agent_not_daemon_hosted",
            "BotLearn Cloud Agent has no active daemon binding",
            http_status=409,
        )
    return _SessionProfileHost(
        agent=agent,
        daemon_instance_id=binding.daemon_instance_id,
        cloud_daemon_instance_id=binding.cloud_daemon_instance_id,
    )


async def _ensure_host_online(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    host: _SessionProfileHost,
) -> None:
    cloud_id = host.cloud_daemon_instance_id
    if cloud_id is None:
        if not is_daemon_online(host.daemon_instance_id):
            raise SessionProfileDispatchError(
                "daemon_offline",
                "Agent daemon is offline",
                http_status=409,
            )
        return
    if is_cloud_daemon_online(cloud_id):
        return
    try:
        await CloudAgentService().resume_cloud_agent(
            db,
            user_id=user_id,
            agent_id=host.agent.agent_id,
        )
    except CloudAgentError as exc:
        raise SessionProfileDispatchError(
            exc.code,
            exc.message,
            http_status=exc.http_status,
        ) from exc

    deadline = time.monotonic() + _AGENT_LOAD_WAIT_SECONDS
    while time.monotonic() < deadline:
        if is_cloud_daemon_online(cloud_id):
            return
        await asyncio.sleep(_AGENT_LOAD_POLL_SECONDS)
    raise SessionProfileDispatchError(
        "daemon_offline",
        "Cloud Agent daemon did not become ready in time",
        http_status=409,
    )


async def _send(
    host: _SessionProfileHost,
    frame_type: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    if host.cloud_daemon_instance_id:
        try:
            return await send_cloud_control_frame(
                host.cloud_daemon_instance_id,
                frame_type,
                params,
                timeout_ms=_PROFILE_CONTROL_TIMEOUT_MS,
            )
        except CloudDaemonDispatchError as exc:
            raise SessionProfileDispatchError(exc.code, exc.message) from exc
    try:
        return await send_control_frame(
            host.daemon_instance_id,
            frame_type,
            params,
            timeout_ms=_PROFILE_CONTROL_TIMEOUT_MS,
        )
    except Exception as exc:  # send_control_frame maps transport failures to HTTPException
        detail = getattr(exc, "detail", None)
        raise SessionProfileDispatchError(
            "daemon_dispatch_failed",
            str(detail or exc),
        ) from exc
