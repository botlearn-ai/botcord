"""Thin lifecycle API for the ``gateway-ingress`` service.

The cloud-gateway ingress is an always-on observer that owns provider
secrets, cursors, dedupe state, and the runtime-session WS to the cloud
daemon. It must not touch the Hub message data path; the Hub in turn must
not see provider message bodies. This module exposes the *only* surface
the ingress needs from the Hub:

- ``POST /internal/cloud-gateway/agents/{agent_id}/ensure-running``
  Ask the Hub to resume the agent's cloud sandbox. The body carries
  no message payload — only the ingress gateway id, a free-form reason,
  and an optional durable event id for log correlation.

- ``GET  /internal/cloud-gateway/agents/{agent_id}/runtime``
  Fetch fresh runtime-session metadata for an already-running agent.
  Useful for reconnect without forcing a resume cycle.

- ``POST /internal/cloud-gateway/agents/{agent_id}/touch``
  Best-effort "ingress saw activity" ping. Helps the idle-pause loop
  account for third-party traffic without exposing message bodies.

Auth accepts either ``CLOUD_GATEWAY_INGRESS_SECRET`` or
``INTERNAL_API_SECRET`` (so operators can hit the same endpoints from
runbooks); both require ``ALLOW_PRIVATE_ENDPOINTS``.

Runtime-session tokens are short-lived JWTs (kind=
``cloud-gateway-runtime``) scoped to one agent + one gateway + one event.
They grant nothing beyond the ingress→cloud-daemon runtime WS upgrade.

See ``docs/cloud-gateway-ingress-technical-design.md`` §7 for the full
contract.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import time
from typing import Any

import jwt as pyjwt
from fastapi import APIRouter, Depends, Header, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub import config as hub_config
from hub.database import get_db
from hub.i18n import I18nHTTPException
from hub.models import Agent, CloudAgentInstance, CloudDaemonInstance
from hub.routers.cloud_daemon_control import is_cloud_daemon_online
from hub.routers.cloud_daemon_control import send_cloud_control_frame
from hub.services.cloud_agent import (
    CloudAgentError,
    CloudAgentService,
)

logger = logging.getLogger(__name__)


internal_router = APIRouter(
    prefix="/internal/cloud-gateway", tags=["cloud-gateway-internal"]
)
runtime_router = APIRouter(tags=["cloud-gateway-runtime"])


# ---------------------------------------------------------------------------
# Runtime session token
# ---------------------------------------------------------------------------


_RUNTIME_TOKEN_KIND = "cloud-gateway-runtime"
_RUNTIME_TOKEN_ISSUER = "botcord-cloud-gateway"


def _mint_runtime_session_token(
    *,
    agent_id: str,
    gateway_id: str,
    cloud_daemon_instance_id: str,
    event_id: str | None,
) -> tuple[str, int]:
    """Create a short-lived JWT scoped to the runtime WS upgrade.

    Token cannot be used as an agent JWT (different ``kind``/``iss``) and
    cannot be replayed against the Hub control plane (no ``cloud_daemon``
    claim shape match). ``event_id`` is recorded only for traceability.
    """
    ttl = hub_config.CLOUD_GATEWAY_RUNTIME_TOKEN_TTL_SECONDS
    now = int(time.time())
    payload: dict[str, Any] = {
        "kind": _RUNTIME_TOKEN_KIND,
        "iss": _RUNTIME_TOKEN_ISSUER,
        "sub": agent_id,
        "agent_id": agent_id,
        "gateway_id": gateway_id,
        "cloud_daemon_instance_id": cloud_daemon_instance_id,
        "iat": now,
        "exp": now + ttl,
    }
    if event_id:
        payload["event_id"] = event_id
    token = pyjwt.encode(
        payload, hub_config.JWT_SECRET, algorithm=hub_config.JWT_ALGORITHM
    )
    return token, ttl


def verify_runtime_session_token(token: str) -> dict[str, Any]:
    """Decode and validate a runtime-session JWT minted by this module.

    Used by the cloud-daemon runtime WS upgrade and by gateway-ingress
    tests. Raises ``ValueError`` on any signature / type / lifetime
    failure so callers can map that to whichever transport error suits
    their layer.
    """
    try:
        claims = pyjwt.decode(
            token, hub_config.JWT_SECRET, algorithms=[hub_config.JWT_ALGORITHM]
        )
    except pyjwt.ExpiredSignatureError as exc:  # pragma: no cover - covered by tests
        raise ValueError("runtime_token_expired") from exc
    except pyjwt.InvalidTokenError as exc:
        raise ValueError("invalid_runtime_token") from exc
    if claims.get("kind") != _RUNTIME_TOKEN_KIND:
        raise ValueError("invalid_runtime_token_kind")
    if claims.get("iss") != _RUNTIME_TOKEN_ISSUER:
        raise ValueError("invalid_runtime_token_issuer")
    if not claims.get("agent_id") or not claims.get("gateway_id"):
        raise ValueError("invalid_runtime_token_claims")
    return claims


def _runtime_ws_token(ws: WebSocket) -> str | None:
    auth_header = ws.headers.get("authorization") or ws.headers.get("Authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[len("Bearer ") :].strip()
    token = ws.query_params.get("token")
    return token.strip() if token else None


async def _send_runtime_rejection(
    ws: WebSocket,
    *,
    event_id: str,
    code: str,
    message: str,
) -> None:
    await ws.send_text(
        json.dumps(
            {
                "type": "gateway_inbound_ack",
                "event_id": event_id,
                "accepted": False,
                "error": {"code": code, "message": message},
            }
        )
    )


# ---------------------------------------------------------------------------
# DTOs (mirror packages/protocol-core/src/runtime-frame.ts)
# ---------------------------------------------------------------------------


class EnsureRunningRequest(BaseModel):
    gateway_id: str = Field(..., min_length=1, max_length=128)
    reason: str = Field(default="third_party_inbound", max_length=64)
    event_id: str | None = Field(default=None, max_length=128)


class RuntimeSessionMetadata(BaseModel):
    session_endpoint: str
    session_token: str
    expires_in: int


class EnsureRunningResponse(BaseModel):
    agent_id: str
    status: str
    cloud_daemon_instance_id: str | None = None
    runtime: RuntimeSessionMetadata | None = None
    error: dict[str, str] | None = None


class TouchRequest(BaseModel):
    gateway_id: str = Field(..., min_length=1, max_length=128)
    reason: str | None = Field(default=None, max_length=64)


class TouchResponse(BaseModel):
    agent_id: str
    acknowledged_at: int


# ---------------------------------------------------------------------------
# In-flight runtime WS registry
#
# Holds the live ingress runtime WS for every event currently being
# processed by a cloud daemon. The cloud daemon emits a best-effort
# ``cloud_gateway_runtime_status`` control frame mid-turn (e.g. typing);
# the cloud_daemon_control handler looks the WS up here and forwards the
# matching ``gateway_outbound_typing`` frame so the third-party provider
# can render a typing indicator before the final reply arrives.
#
# Keyed on (cloud_daemon_instance_id, event_id) — both come from the
# ingress runtime token so collisions across daemons are impossible.
# ---------------------------------------------------------------------------


_InflightKey = tuple[str, str]
_INFLIGHT_RUNTIME_WS: dict[_InflightKey, WebSocket] = {}
_INFLIGHT_LOCK = asyncio.Lock()


async def _register_inflight_runtime_ws(
    key: _InflightKey, ws: WebSocket
) -> None:
    async with _INFLIGHT_LOCK:
        _INFLIGHT_RUNTIME_WS[key] = ws


async def _unregister_inflight_runtime_ws(
    key: _InflightKey, ws: WebSocket
) -> None:
    async with _INFLIGHT_LOCK:
        current = _INFLIGHT_RUNTIME_WS.get(key)
        if current is ws:
            _INFLIGHT_RUNTIME_WS.pop(key, None)


async def relay_runtime_status_to_ingress(
    *, cloud_daemon_instance_id: str, params: dict[str, Any]
) -> bool:
    """Forward a daemon-emitted runtime status frame to the live ingress WS.

    Best-effort: returns ``False`` silently if the event has already
    finished, the WS has been torn down, or required fields are missing.
    """
    event_id = str(params.get("eventId") or "")
    kind = str(params.get("kind") or "")
    if not event_id or kind != "typing":
        return False
    async with _INFLIGHT_LOCK:
        ws = _INFLIGHT_RUNTIME_WS.get((cloud_daemon_instance_id, event_id))
    if ws is None:
        return False
    phase = str(params.get("phase") or "started")
    if phase not in ("started", "stopped"):
        phase = "started"
    frame = {
        "type": "gateway_outbound_typing",
        "event_id": event_id,
        "turn_id": str(params.get("turnId") or f"turn_{event_id}"),
        "gateway_id": str(params.get("gatewayId") or ""),
        "agent_id": str(params.get("agentId") or ""),
        "conversation_id": str(params.get("conversationId") or ""),
        "phase": phase,
        "trace_id": params.get("traceId"),
    }
    try:
        await ws.send_text(json.dumps(frame))
        return True
    except Exception as exc:  # noqa: BLE001 — relay is best-effort
        logger.debug(
            "cloud-gateway runtime status relay failed: cloud=%s event=%s err=%s",
            cloud_daemon_instance_id,
            event_id,
            exc,
        )
        return False


# ---------------------------------------------------------------------------
# Runtime relay WebSocket
# ---------------------------------------------------------------------------


@runtime_router.websocket("/cloud-gateway/runtime")
async def cloud_gateway_runtime_ws(ws: WebSocket) -> None:
    """Relay gateway-ingress runtime frames to the online cloud daemon.

    This is the MVP transport for the design's "runtime direct session"
    contract. The Hub authenticates the short-lived runtime token and then
    relays payloads through the cloud daemon control connection without
    storing or inspecting provider message bodies beyond the frame metadata
    needed for routing and validation.
    """
    token = _runtime_ws_token(ws)
    if not token:
        await ws.close(code=4401, reason="missing bearer")
        return
    try:
        claims = verify_runtime_session_token(token)
    except ValueError as exc:
        await ws.close(code=4401, reason=str(exc))
        return

    agent_id = str(claims["agent_id"])
    gateway_id = str(claims["gateway_id"])
    cloud_daemon_instance_id = str(claims["cloud_daemon_instance_id"])
    token_event_id = claims.get("event_id")

    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await _send_runtime_rejection(
                    ws,
                    event_id=str(token_event_id or ""),
                    code="bad_json",
                    message="runtime frame must be JSON",
                )
                continue

            if not isinstance(frame, dict):
                await _send_runtime_rejection(
                    ws,
                    event_id=str(token_event_id or ""),
                    code="bad_frame",
                    message="runtime frame must be an object",
                )
                continue
            frame_type = frame.get("type")
            if frame_type == "runtime_heartbeat":
                await ws.send_text(json.dumps({"type": "runtime_heartbeat", "ts": int(time.time() * 1000)}))
                continue
            event_id = str(frame.get("event_id") or token_event_id or "")
            if frame_type != "gateway_inbound":
                await _send_runtime_rejection(
                    ws,
                    event_id=event_id,
                    code="bad_frame_type",
                    message=f"unsupported runtime frame type {frame_type!r}",
                )
                continue
            if frame.get("agent_id") != agent_id or frame.get("gateway_id") != gateway_id:
                await _send_runtime_rejection(
                    ws,
                    event_id=event_id,
                    code="runtime_token_scope_mismatch",
                    message="runtime frame does not match token scope",
                )
                continue

            inflight_key = (cloud_daemon_instance_id, event_id) if event_id else None
            if inflight_key is not None:
                await _register_inflight_runtime_ws(inflight_key, ws)
            try:
                ack = await send_cloud_control_frame(
                    cloud_daemon_instance_id,
                    "cloud_gateway_runtime_inbound",
                    {"frame": frame},
                    timeout_ms=30 * 60 * 1000,
                )
            except Exception as exc:  # noqa: BLE001 - transport-specific failures become frame errors
                logger.warning(
                    "cloud-gateway runtime relay failed: cloud=%s agent=%s gateway=%s err=%s",
                    cloud_daemon_instance_id,
                    agent_id,
                    gateway_id,
                    exc,
                )
                await _send_runtime_rejection(
                    ws,
                    event_id=event_id,
                    code="cloud_daemon_unavailable",
                    message=str(exc),
                )
                continue
            finally:
                # Deregister as soon as the daemon ack returns (or fails):
                # typing frames after this point belong to a different turn.
                if inflight_key is not None:
                    await _unregister_inflight_runtime_ws(inflight_key, ws)

            result = ack.get("result") if isinstance(ack, dict) else None
            if not isinstance(ack, dict) or ack.get("ok") is not True or not isinstance(result, dict):
                err = ack.get("error") if isinstance(ack, dict) else None
                code = err.get("code") if isinstance(err, dict) else "daemon_rejected"
                message = err.get("message") if isinstance(err, dict) else "daemon rejected runtime frame"
                await _send_runtime_rejection(
                    ws,
                    event_id=event_id,
                    code=str(code),
                    message=str(message),
                )
                continue

            turn_id = str(result.get("turnId") or f"turn_{event_id}")
            conversation_id = str(
                result.get("conversationId")
                or (frame.get("message") or {}).get("conversation", {}).get("id")
                or ""
            )
            await ws.send_text(
                json.dumps(
                    {
                        "type": "gateway_inbound_ack",
                        "event_id": event_id,
                        "accepted": bool(result.get("accepted", True)),
                        "runtime_session_id": turn_id,
                    }
                )
            )
            outbound = result.get("outbound")
            if isinstance(outbound, dict):
                await ws.send_text(
                    json.dumps(
                        {
                            "type": "gateway_outbound_complete",
                            "event_id": event_id,
                            "turn_id": turn_id,
                            "gateway_id": gateway_id,
                            "agent_id": agent_id,
                            "conversation_id": conversation_id,
                            "final_text": str(outbound.get("finalText") or ""),
                            "provider_message_id": outbound.get("providerMessageId"),
                        }
                    )
                )
            else:
                await ws.send_text(
                    json.dumps(
                        {
                            "type": "gateway_outbound_error",
                            "event_id": event_id,
                            "turn_id": turn_id,
                            "gateway_id": gateway_id,
                            "agent_id": agent_id,
                            "conversation_id": conversation_id,
                            "code": "no_outbound",
                            "message": "runtime completed without an outbound message",
                            "retryable": False,
                        }
                    )
                )
    except WebSocketDisconnect:
        return


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _require_ingress_or_internal_secret(authorization: str | None) -> None:
    """Verify the ingress shared secret (or the operator secret as fallback).

    Mirrors ``hub.routers.cloud_agent_internal._require_internal_secret``
    but accepts either ``CLOUD_GATEWAY_INGRESS_SECRET`` or
    ``INTERNAL_API_SECRET``. Both require ``ALLOW_PRIVATE_ENDPOINTS`` to
    keep dev-only deployments locked down.
    """
    if not hub_config.ALLOW_PRIVATE_ENDPOINTS:
        raise I18nHTTPException(
            status_code=403, message_key="internal_endpoints_disabled"
        )
    expected_secrets = [
        s for s in (
            hub_config.CLOUD_GATEWAY_INGRESS_SECRET,
            hub_config.INTERNAL_API_SECRET,
        ) if s
    ]
    if not expected_secrets:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise I18nHTTPException(
            status_code=401, message_key="missing_internal_api_secret"
        )
    provided = authorization.removeprefix("Bearer ").strip()
    if provided not in expected_secrets:
        raise I18nHTTPException(
            status_code=401, message_key="invalid_internal_api_secret"
        )


# ---------------------------------------------------------------------------
# Service dependency (test-overridable)
# ---------------------------------------------------------------------------


_DEFAULT_SERVICE = CloudAgentService()


def get_cloud_agent_service() -> CloudAgentService:
    """FastAPI dependency exposing the cloud-agent lifecycle orchestrator."""
    return _DEFAULT_SERVICE


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------


async def _load_cloud_agent(
    db: AsyncSession, agent_id: str
) -> tuple[Agent, CloudAgentInstance, CloudDaemonInstance]:
    """Load the agent + binding rows. Raise 404 on missing / non-cloud."""
    agent = await db.scalar(select(Agent).where(Agent.agent_id == agent_id))
    if agent is None or agent.deleted_at is not None:
        raise I18nHTTPException(
            status_code=404, message_key="agent_not_found"
        )
    if agent.hosting_kind != "cloud":
        raise I18nHTTPException(
            status_code=409,
            message_key="cloud_gateway_agent_not_cloud_hosted",
            detail=f"agent {agent_id!r} is not cloud-hosted",
        )
    cai = await db.scalar(
        select(CloudAgentInstance).where(CloudAgentInstance.agent_id == agent_id)
    )
    if cai is None:
        raise I18nHTTPException(
            status_code=404, message_key="cloud_agent_binding_not_found"
        )
    cdi = await db.scalar(
        select(CloudDaemonInstance).where(
            CloudDaemonInstance.id == cai.cloud_daemon_instance_id
        )
    )
    if cdi is None:
        raise I18nHTTPException(
            status_code=404, message_key="cloud_daemon_not_found"
        )
    return agent, cai, cdi


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _runtime_metadata(
    *,
    agent_id: str,
    gateway_id: str,
    cloud_daemon_instance_id: str,
    event_id: str | None,
) -> RuntimeSessionMetadata:
    token, ttl = _mint_runtime_session_token(
        agent_id=agent_id,
        gateway_id=gateway_id,
        cloud_daemon_instance_id=cloud_daemon_instance_id,
        event_id=event_id,
    )
    return RuntimeSessionMetadata(
        session_endpoint=hub_config.CLOUD_GATEWAY_RUNTIME_ENDPOINT,
        session_token=token,
        expires_in=ttl,
    )


@internal_router.post(
    "/agents/{agent_id}/ensure-running",
    response_model=EnsureRunningResponse,
    status_code=200,
)
async def ensure_running(
    agent_id: str,
    req: EnsureRunningRequest,
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(get_cloud_agent_service),
    authorization: str | None = Header(default=None),
) -> EnsureRunningResponse:
    """Resume (or create) the agent's cloud sandbox and return runtime metadata.

    The handler is intentionally body-light: the ingress never sends the
    message content. Only ``gateway_id`` (for log correlation), ``reason``
    (taxonomy of why we're waking) and an optional durable ``event_id``
    are accepted.

    Responses:
        - ``status="ready"`` carries a ``runtime`` metadata block with a
          short-lived JWT and the runtime WS endpoint.
        - ``status="provisioning"`` carries no runtime token; the ingress
          polls ``GET /runtime`` after a brief delay.
        - ``status="failed"`` carries an ``error`` block and no runtime
          token; the ingress should retry on a later event.
    """
    _require_ingress_or_internal_secret(authorization)
    agent, cai, cdi = await _load_cloud_agent(db, agent_id)

    if cai.status in {"deleted", "deleting"}:
        raise I18nHTTPException(
            status_code=409,
            message_key="cloud_gateway_agent_unavailable",
            detail=f"cloud agent {agent_id!r} is {cai.status!r}",
        )

    try:
        view = await service.resume_cloud_agent(
            db, user_id=agent.user_id, agent_id=agent_id
        )
    except CloudAgentError as exc:
        logger.warning(
            "cloud-gateway ensure-running resume failed: agent=%s gateway=%s code=%s",
            agent_id,
            req.gateway_id,
            exc.code,
        )
        if exc.http_status == 404:
            raise I18nHTTPException(
                status_code=404,
                message_key="cloud_gateway_agent_unavailable",
                detail=exc.message,
            ) from exc
        return EnsureRunningResponse(
            agent_id=agent_id,
            status="failed",
            cloud_daemon_instance_id=cai.cloud_daemon_instance_id,
            error={"code": exc.code, "message": exc.message},
        )

    runtime_block: RuntimeSessionMetadata | None = None
    if view.status == "ready" and is_cloud_daemon_online(view.cloud_daemon_instance_id):
        runtime_block = _runtime_metadata(
            agent_id=agent_id,
            gateway_id=req.gateway_id,
            cloud_daemon_instance_id=view.cloud_daemon_instance_id,
            event_id=req.event_id,
        )
    elif view.status == "ready":
        # ``resume_cloud_agent`` reported ready without the control WS being
        # registered yet — surface as provisioning so the ingress polls.
        view.status = "provisioning"

    return EnsureRunningResponse(
        agent_id=agent_id,
        status=view.status,
        cloud_daemon_instance_id=view.cloud_daemon_instance_id,
        runtime=runtime_block,
        error=(
            {"code": view.error_code, "message": view.error_message}
            if view.status == "failed" and view.error_code
            else None
        ),
    )


@internal_router.get(
    "/agents/{agent_id}/runtime",
    response_model=EnsureRunningResponse,
    status_code=200,
)
async def get_runtime_metadata(
    agent_id: str,
    gateway_id: str,
    event_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> EnsureRunningResponse:
    """Return fresh runtime metadata without triggering a resume.

    Use this for reconnect-after-token-expiry. Returns ``status`` as one of
    ``ready`` / ``paused`` / ``provisioning`` / ``failed`` so the ingress
    can decide whether to call ``ensure-running``.
    """
    _require_ingress_or_internal_secret(authorization)
    _agent, cai, cdi = await _load_cloud_agent(db, agent_id)

    is_online = is_cloud_daemon_online(cdi.id)
    if cai.status == "ready" and is_online:
        return EnsureRunningResponse(
            agent_id=agent_id,
            status="ready",
            cloud_daemon_instance_id=cdi.id,
            runtime=_runtime_metadata(
                agent_id=agent_id,
                gateway_id=gateway_id,
                cloud_daemon_instance_id=cdi.id,
                event_id=event_id,
            ),
        )

    # Map service-internal statuses to the coarser ingress vocabulary.
    if cai.status in {"deleted", "deleting"}:
        status_out = "deleted"
    elif cai.status == "failed":
        status_out = "failed"
    elif cai.status == "paused" or not is_online:
        status_out = "paused"
    else:
        status_out = "provisioning"

    return EnsureRunningResponse(
        agent_id=agent_id,
        status=status_out,
        cloud_daemon_instance_id=cdi.id,
        runtime=None,
        error=(
            {"code": cai.error_code or "failed", "message": cai.error_message or ""}
            if status_out == "failed"
            else None
        ),
    )


@internal_router.post(
    "/agents/{agent_id}/touch",
    response_model=TouchResponse,
    status_code=200,
)
async def touch_runtime(
    agent_id: str,
    req: TouchRequest,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> TouchResponse:
    """Record that the ingress saw activity for this agent.

    Today this just refreshes ``CloudAgentInstance.last_run_at`` so the
    idle-pause loop accounts for third-party traffic without exposing the
    message body. Returns the server timestamp so ingress can log a
    canonical "ack" instant.
    """
    _require_ingress_or_internal_secret(authorization)
    _agent, cai, _cdi = await _load_cloud_agent(db, agent_id)

    now = datetime.datetime.now(datetime.timezone.utc)
    cai.last_run_at = now
    await db.commit()
    return TouchResponse(
        agent_id=agent_id,
        acknowledged_at=int(now.timestamp() * 1000),
    )
