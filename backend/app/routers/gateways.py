"""
[INPUT]: Authenticated user + their owned daemon/cloud-hosted agent + Pydantic
         third-party gateway connection requests.
[OUTPUT]: GET/POST/PATCH/DELETE /api/agents/{agent_id}/gateways*  +
          POST /api/agents/{agent_id}/gateways/wechat/login/{start,status} —
          BFF surface for the dashboard "Channels" (接入) tab.
[POS]: BFF wrapper around the daemon control-frame contract for
       Telegram / WeChat third-party channel adapters.
[PROTOCOL]: User must own the agent; agent must be hosted by a local daemon or
            a cloud daemon with a non-null ``daemon_instance_id``. Daemon must
            be online for write/login/test calls; reads of saved rows are
            allowed offline.
            Bot tokens never persist in Hub DB — they are forwarded once to
            the daemon (Telegram) or pulled by the daemon from a local login
            session (WeChat) and written to the daemon's local secret store.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import re
import time
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from app.clients import cloud_gateway_ingress_client as ingress_client
from hub import config as hub_config
from hub.database import get_db
from hub.id_generators import generate_gateway_connection_id
from hub.models import Agent, AgentGatewayConnection, CloudAgentInstance
from hub.routers.daemon_control import is_daemon_online, send_control_frame
from hub.routers.cloud_daemon_control import (
    CloudDaemonDispatchError,
    is_cloud_daemon_online,
    send_cloud_control_frame,
)
from hub.services.cloud_agent import CloudAgentError, CloudAgentService
from hub.services.cloud_agent_activity import bump_if_cloud_agent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["app-gateways"])


ProviderLit = Literal["telegram", "wechat", "feishu"]
StatusLit = Literal["pending", "active", "disabled", "error"]

_ALLOWED_PROVIDERS: set[str] = {"telegram", "wechat", "feishu"}
# config_json keys we accept from the dashboard. Anything else is dropped to
# avoid arbitrary blob storage / leaking secrets.
# W4: tokenPreview is server-managed (overwritten with the daemon-returned
# value on create/patch); never accept it from the caller.
_CONFIG_KEYS = {
    "baseUrl",
    "domain",
    "allowedSenderIds",
    "allowedChatIds",
    "splitAt",
}


# ---------------------------------------------------------------------------
# Pydantic shapes
# ---------------------------------------------------------------------------


class GatewayOut(BaseModel):
    id: str
    agent_id: str
    daemon_instance_id: str
    provider: ProviderLit
    label: str | None = None
    status: StatusLit
    enabled: bool
    config: dict[str, Any]
    last_error: str | None = None
    created_at: datetime.datetime
    updated_at: datetime.datetime


class GatewayListOut(BaseModel):
    gateways: list[GatewayOut]


class _ConfigPatch(BaseModel):
    baseUrl: str | None = None
    domain: Literal["feishu", "lark"] | None = None
    allowedSenderIds: list[str] | None = None
    allowedChatIds: list[str] | None = None
    splitAt: int | None = Field(default=None, ge=64, le=8192)


class _SecretIn(BaseModel):
    """Nested ``secret: {botToken}`` envelope — what the dashboard posts."""

    model_config = ConfigDict(populate_by_name=True)
    bot_token: str | None = Field(default=None, alias="botToken", max_length=512)


class GatewayCreate(BaseModel):
    # Accept camelCase aliases (dashboard) AND snake_case (existing tests/CLI).
    model_config = ConfigDict(populate_by_name=True)

    provider: ProviderLit
    label: str | None = Field(default=None, max_length=128)
    enabled: bool = True
    # Telegram only — fresh bot token. Forwarded once to the daemon, never stored.
    # The frontend posts ``secret: {botToken}``; older callers used flat
    # ``bot_token`` / ``botToken``. ``_normalize_secret`` collapses both.
    bot_token: str | None = Field(default=None, alias="botToken", max_length=512)
    secret: _SecretIn | None = None
    # WeChat/Feishu only — references a previously-confirmed daemon login session.
    login_id: str | None = Field(default=None, alias="loginId", max_length=128)
    config: _ConfigPatch | None = None

    @field_validator("label")
    @classmethod
    def _strip_label(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        return v or None

    @model_validator(mode="after")
    def _normalize_secret(self) -> "GatewayCreate":
        if not self.bot_token and self.secret and self.secret.bot_token:
            self.bot_token = self.secret.bot_token
        return self


class GatewayPatch(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    label: str | None = None
    enabled: bool | None = None
    bot_token: str | None = Field(default=None, alias="botToken", max_length=512)
    secret: _SecretIn | None = None
    config: _ConfigPatch | None = None

    @field_validator("label")
    @classmethod
    def _strip_label(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        return v or None

    @model_validator(mode="after")
    def _normalize_secret(self) -> "GatewayPatch":
        if not self.bot_token and self.secret and self.secret.bot_token:
            self.bot_token = self.secret.bot_token
        return self


class WechatLoginStartIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    base_url: str | None = Field(default=None, alias="baseUrl", max_length=256)
    gateway_id: str | None = Field(default=None, alias="gatewayId", max_length=128)
    domain: Literal["feishu", "lark"] | None = None


class WechatLoginStatusIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    login_id: str = Field(..., alias="loginId", min_length=4, max_length=128)


class WechatSenderDiscoveryIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    login_id: str = Field(..., alias="loginId", min_length=4, max_length=128)
    timeout_seconds: int = Field(default=0, alias="timeoutSeconds", ge=0, le=10)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _serialize(row: AgentGatewayConnection) -> GatewayOut:
    # W10: explicit narrowing replaces the previous `# type: ignore` casts so a
    # future schema drift surfaces as a clear 500 instead of silently emitting
    # an out-of-spec literal.
    if row.provider not in ("telegram", "wechat", "feishu"):
        raise ValueError(f"unexpected gateway provider in DB: {row.provider!r}")
    if row.status not in ("pending", "active", "disabled", "error"):
        raise ValueError(f"unexpected gateway status in DB: {row.status!r}")
    provider: ProviderLit = row.provider  # type: checker now sees a literal
    status: StatusLit = row.status
    return GatewayOut(
        id=row.id,
        agent_id=row.agent_id,
        daemon_instance_id=row.daemon_instance_id,
        provider=provider,
        label=row.label,
        status=status,
        enabled=row.enabled,
        config=dict(row.config_json or {}),
        last_error=row.last_error,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _load_owned_agent(
    db: AsyncSession, ctx: RequestContext, agent_id: str
) -> Agent:
    result = await db.execute(
        select(Agent).where(
            Agent.agent_id == agent_id,
            Agent.user_id == ctx.user_id,
            Agent.status == "active",
        )
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="agent_not_found")
    return agent


class _GatewayHost(BaseModel):
    daemon_instance_id: str
    cloud_daemon_instance_id: str | None = None


async def _load_gateway_host_or_422(
    db: AsyncSession, ctx: RequestContext, agent_id: str
) -> tuple[Agent, _GatewayHost]:
    """Resolve agent + the control-plane target for gateway operations."""
    agent = await _load_owned_agent(db, ctx, agent_id)
    if agent.hosting_kind == "daemon" and agent.daemon_instance_id:
        return agent, _GatewayHost(daemon_instance_id=agent.daemon_instance_id)
    if agent.hosting_kind == "cloud" and agent.daemon_instance_id:
        binding = await db.scalar(
            select(CloudAgentInstance).where(
                CloudAgentInstance.agent_id == agent_id,
                CloudAgentInstance.user_id == ctx.user_id,
                CloudAgentInstance.status.notin_(("deleting", "deleted")),
            )
        )
        if binding is None:
            raise HTTPException(status_code=422, detail="agent_not_daemon_hosted")
        return agent, _GatewayHost(
            daemon_instance_id=binding.daemon_instance_id,
            cloud_daemon_instance_id=binding.cloud_daemon_instance_id,
        )
    raise HTTPException(status_code=422, detail="agent_not_daemon_hosted")


async def _load_owned_connection(
    db: AsyncSession, ctx: RequestContext, agent_id: str, gateway_id: str
) -> tuple[Agent, _GatewayHost, AgentGatewayConnection]:
    agent, host = await _load_gateway_host_or_422(db, ctx, agent_id)
    result = await db.execute(
        select(AgentGatewayConnection).where(
            AgentGatewayConnection.id == gateway_id,
            AgentGatewayConnection.agent_id == agent_id,
            AgentGatewayConnection.user_id == ctx.user_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="gateway_not_found")
    return agent, host, row


def _require_online(host: _GatewayHost) -> None:
    online = (
        is_cloud_daemon_online(host.cloud_daemon_instance_id)
        if host.cloud_daemon_instance_id
        else is_daemon_online(host.daemon_instance_id)
    )
    if not online:
        raise HTTPException(status_code=409, detail="daemon_offline")


_CLOUD_GATEWAY_RESUME_WAIT_SECONDS = 20.0
_CLOUD_GATEWAY_RESUME_POLL_SECONDS = 0.5
_CLOUD_GATEWAY_DISPATCH_RETRY_CODES = {
    "cloud_daemon_offline",
    "cloud_daemon_disconnected",
    "cloud_daemon_send_failed",
}


async def _ensure_gateway_host_online(
    db: AsyncSession,
    ctx: RequestContext,
    agent: Agent,
    host: _GatewayHost,
) -> None:
    """Ensure the daemon target is reachable before a gateway write.

    Local daemon-hosted agents still require an already-connected user daemon.
    Cloud agents are different: their sandbox may have been paused by idle
    management, so a gateway action is user intent to resume it.
    """
    if not host.cloud_daemon_instance_id:
        _require_online(host)
        return

    if is_cloud_daemon_online(host.cloud_daemon_instance_id):
        return

    try:
        await CloudAgentService().resume_cloud_agent(
            db,
            user_id=ctx.user_id,
            agent_id=agent.agent_id,
        )
    except CloudAgentError as exc:
        logger.warning(
            "cloud gateway resume failed: agent=%s cloud=%s code=%s err=%s",
            agent.agent_id,
            host.cloud_daemon_instance_id,
            exc.code,
            exc.message,
        )
        raise HTTPException(
            status_code=409 if exc.http_status == 409 else exc.http_status,
            detail="daemon_offline" if exc.http_status == 409 else exc.code,
        ) from exc

    deadline = time.monotonic() + _CLOUD_GATEWAY_RESUME_WAIT_SECONDS
    while time.monotonic() < deadline:
        if is_cloud_daemon_online(host.cloud_daemon_instance_id):
            return
        await asyncio.sleep(_CLOUD_GATEWAY_RESUME_POLL_SECONDS)

    raise HTTPException(status_code=409, detail="daemon_offline")


async def _stamp_cloud_activity(
    db: AsyncSession | None,
    agent: Agent | None,
) -> None:
    """Event 4: a gateway control frame succeeded — that's the user actively
    operating this agent's gateway plumbing right now. Best-effort: stamp the
    cloud_agent_instances row so the idle-pause sweep keeps the sandbox warm.
    Failures are swallowed so the gateway response path stays clean."""
    if db is None or agent is None or agent.hosting_kind != "cloud":
        return
    try:
        await bump_if_cloud_agent(db, agent.agent_id)
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "gateway activity stamp failed: agent=%s err=%s",
            agent.agent_id,
            exc,
        )


async def _send_gateway_control_frame(
    host: _GatewayHost,
    type_: str,
    params: dict[str, Any],
    *,
    db: AsyncSession | None = None,
    ctx: RequestContext | None = None,
    agent: Agent | None = None,
    retry_cloud_disconnect: bool = False,
) -> dict[str, Any]:
    if not host.cloud_daemon_instance_id:
        ack = await send_control_frame(host.daemon_instance_id, type_, params)
        await _stamp_cloud_activity(db, agent)
        return ack
    try:
        ack = await send_cloud_control_frame(host.cloud_daemon_instance_id, type_, params)
        await _stamp_cloud_activity(db, agent)
        return ack
    except CloudDaemonDispatchError as exc:
        if (
            retry_cloud_disconnect
            and exc.code in _CLOUD_GATEWAY_DISPATCH_RETRY_CODES
            and db is not None
            and ctx is not None
            and agent is not None
        ):
            logger.warning(
                "cloud gateway dispatch lost connection; attempting resume and retry: "
                "agent=%s cloud=%s type=%s code=%s err=%s",
                agent.agent_id,
                host.cloud_daemon_instance_id,
                type_,
                exc.code,
                exc.message,
            )
            await _ensure_gateway_host_online(db, ctx, agent, host)
            try:
                ack = await send_cloud_control_frame(
                    host.cloud_daemon_instance_id,
                    type_,
                    params,
                )
                await _stamp_cloud_activity(db, agent)
                return ack
            except CloudDaemonDispatchError as retry_exc:
                exc = retry_exc
        if exc.code == "cloud_daemon_offline":
            raise HTTPException(status_code=409, detail="daemon_offline") from exc
        if exc.code == "cloud_daemon_disconnected":
            raise HTTPException(status_code=409, detail="daemon_offline") from exc
        if exc.code == "cloud_daemon_send_failed":
            raise HTTPException(status_code=409, detail="daemon_offline") from exc
        if exc.code == "cloud_daemon_ack_timeout":
            raise HTTPException(status_code=504, detail="daemon_ack_timeout") from exc
        raise HTTPException(
            status_code=502,
            detail={"code": exc.code, "daemon_message": exc.message},
        ) from exc


def _log_setup_event(
    *,
    agent: Agent | None,
    host: _GatewayHost | None,
    provider: str,
    login_id: str | None,
    outcome: str,
    error_code: str | None = None,
    ctx: RequestContext | None = None,
    setup_owner: str = "daemon",
) -> None:
    """Emit a structured log line for cloud-gateway setup paths.

    Phase 0 diagnostic instrumentation per
    ``docs/cloud-gateway-ingress-remediation-plan.md`` §9. Every setup-path
    request emits at least an ``started`` line and either an ``ok`` or
    ``error`` line — fields stay flat so they survive JSON log shipping.
    Secrets (botToken / appSecret / qrcode / cookie) never appear here.

    ``setup_owner`` defaults to ``"daemon"`` for the legacy control-frame
    path; cloud-agent routes that proxy to gateway-ingress pass
    ``setup_owner="gateway-ingress"`` so the same dashboard log queries
    keep working across the Phase 2 cutover.
    """
    extra: dict[str, Any] = {
        "agent_id": getattr(agent, "agent_id", None),
        "provider": provider,
        "login_id": login_id,
        "hosting_kind": getattr(agent, "hosting_kind", None),
        "daemon_instance_id": getattr(host, "daemon_instance_id", None),
        "cloud_daemon_instance_id": getattr(host, "cloud_daemon_instance_id", None),
        "setup_owner": setup_owner,
        "outcome": outcome,
        "error_code": error_code,
    }
    request_id = getattr(ctx, "request_id", None) if ctx is not None else None
    if request_id:
        extra["request_id"] = request_id
    logger.info("cloud-gateway setup event", extra=extra)


def _extract_error_code(exc: HTTPException) -> str | None:
    """Pull the daemon error code (if any) out of an HTTPException raised by
    ``_ack_or_raise`` / ``_send_gateway_control_frame``."""
    detail = exc.detail
    if isinstance(detail, dict):
        code = (
            detail.get("daemon_code")
            or detail.get("ingress_code")
            or detail.get("code")
        )
        if isinstance(code, str):
            return code
    if isinstance(detail, str):
        return detail
    return None


# ---------------------------------------------------------------------------
# Cloud-agent ingress proxy helpers (Phase 2)
# ---------------------------------------------------------------------------
#
# The 5 setup routes + 4 CRUD routes share the same scaffolding: rate-limit,
# load agent, decide branch, log start, call ingress, log ok/error. We keep
# that scaffolding in the route bodies (so each route still owns its
# request/response shape) but pull the shared "extract mirror-safe fields"
# out here so we never accidentally persist a botToken / appSecret / cookie.

# config_json keys we'll persist for cloud-mirror rows. Any key not in this
# set is dropped — this is the security boundary that keeps provider secrets
# inside gateway-ingress.
_CLOUD_MIRROR_SAFE_CONFIG_KEYS = {
    "baseUrl",
    "domain",
    "allowedSenderIds",
    "allowedChatIds",
    "splitAt",
    # Server-mastered display-only fields returned by ingress. None of these
    # are secrets — tokenFingerprint/tokenPreview are masked digests, the
    # rest are public provider metadata.
    "tokenPreview",
    "tokenFingerprint",
    "appId",
    "userOpenId",
}


def _filter_mirror_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    return {
        k: v
        for k, v in raw.items()
        if k in _CLOUD_MIRROR_SAFE_CONFIG_KEYS and v is not None
    }


def _coerce_status(value: Any, *, default: str = "pending") -> str:
    if isinstance(value, str) and value in ("pending", "active", "disabled", "error"):
        return value
    return default


# --- Phase 4: warning → mirror.last_error sync ---
#
# Belt-and-suspenders redaction: gateway-ingress already scrubs warning
# messages, but Hub does its own pass before persisting so a regression on
# the ingress side cannot leak a bot token / app secret into the dashboard
# DB. Patterns:
#   - Telegram bot tokens look like ``<digits>:<base64-ish>`` (≥30 chars).
#   - Long base64 / base32 runs ≥40 chars get nuked too.
_TELEGRAM_TOKEN_RE = re.compile(r"\b\d{6,}:[A-Za-z0-9_-]{20,}\b")
_LONG_OPAQUE_RE = re.compile(r"\b[A-Za-z0-9_\-]{40,}\b")


def _scrub_ingress_warning_message(message: str | None) -> str | None:
    if not message:
        return None
    scrubbed = _TELEGRAM_TOKEN_RE.sub("[REDACTED]", message)
    scrubbed = _LONG_OPAQUE_RE.sub("[REDACTED]", scrubbed)
    return scrubbed[:1000]  # bound DB write — last_error column is not unlimited


def _extract_warning_message(
    response_body: Any,
) -> str | None:
    """Pull ``warning.message`` out of an ingress create/patch response."""
    if not isinstance(response_body, dict):
        return None
    warning = response_body.get("warning")
    if not isinstance(warning, dict):
        return None
    message = warning.get("message")
    if not isinstance(message, str) or not message:
        return None
    return _scrub_ingress_warning_message(message)


async def _upsert_mirror_from_ingress(
    db: AsyncSession,
    *,
    agent: Agent,
    user_id: Any,
    ingress_connection: dict[str, Any],
    existing_row: AgentGatewayConnection | None = None,
    warning_message: str | None = None,
) -> AgentGatewayConnection:
    """Apply an ingress create/patch response to Hub's mirror table.

    Mirror rules:
      - id / agent_id / user_id / provider / label / status / enabled come
        straight from ingress.
      - config_json is filtered through ``_CLOUD_MIRROR_SAFE_CONFIG_KEYS``,
        which excludes botToken / appSecret / refreshToken / cookies.
      - daemon_instance_id is the FK to ``daemon_instances`` — it's NOT NULL
        in the schema, so we reuse ``agent.daemon_instance_id`` (every cloud
        agent already has one wired by ``CloudAgentService.provision``).
    """
    gateway_id = ingress_connection.get("id")
    if not isinstance(gateway_id, str) or not gateway_id:
        raise HTTPException(
            status_code=502,
            detail={"code": "cloud_gateway_ingress_unavailable"},
        )
    provider = ingress_connection.get("provider") or ingress_connection.get("type")
    if provider not in ("telegram", "wechat", "feishu"):
        raise HTTPException(
            status_code=502,
            detail={"code": "cloud_gateway_ingress_unavailable"},
        )
    label = ingress_connection.get("label")
    enabled_raw = ingress_connection.get("enabled")
    enabled = bool(enabled_raw) if enabled_raw is not None else True
    status_value = _coerce_status(
        ingress_connection.get("status"),
        default="active" if enabled else "disabled",
    )
    # redactConnection() in ingress returns the live field name `config`;
    # older callers used `config_json`. Try both before falling back to
    # top-level metadata.
    config_source = ingress_connection.get("config_json")
    if not isinstance(config_source, dict):
        config_source = ingress_connection.get("config")
    config = _filter_mirror_config(config_source if isinstance(config_source, dict) else None)
    if not config:
        config = _filter_mirror_config(ingress_connection)

    # ``daemon_instance_id`` is NOT NULL with an FK to ``daemon_instances``.
    # Cloud agents always have one bound at provision time; if for some
    # reason this agent doesn't, surface a clear 500 instead of inserting a
    # broken row.
    daemon_instance_id = agent.daemon_instance_id
    if not daemon_instance_id:
        raise HTTPException(
            status_code=500,
            detail="cloud_agent_missing_daemon_instance",
        )

    if existing_row is None:
        existing_row = await db.scalar(
            select(AgentGatewayConnection).where(
                AgentGatewayConnection.id == gateway_id
            )
        )

    if existing_row is None:
        row = AgentGatewayConnection(
            id=gateway_id,
            user_id=user_id,
            agent_id=agent.agent_id,
            daemon_instance_id=daemon_instance_id,
            provider=provider,
            label=label,
            enabled=enabled,
            status=status_value,
            config_json=config,
            last_error=warning_message,
        )
        db.add(row)
    else:
        existing_row.label = label
        existing_row.enabled = enabled
        existing_row.status = status_value
        existing_row.config_json = config
        # Phase 4: ingress warning → mirror.last_error. When the ingress
        # returns no warning we clear any prior staleness instead of leaving
        # it lingering after a successful repair.
        existing_row.last_error = warning_message
        row = existing_row
    await db.commit()
    await db.refresh(row)
    return row


def _request_id_for(ctx: RequestContext) -> str | None:
    # RequestContext currently has no ``request_id`` attribute; the ingress
    # client mints one on the fly when this is None. Threaded through anyway
    # so we can flip it on later without touching every call site.
    return getattr(ctx, "request_id", None)


def _ack_or_raise(ack: Any) -> dict[str, Any]:
    """Translate a daemon ack envelope into either ``result`` or HTTPException."""
    if not isinstance(ack, dict) or not ack.get("ok"):
        err = ack.get("error") if isinstance(ack, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else None
        message = (err or {}).get("message") if isinstance(err, dict) else None
        if code == "provider_auth_failed":
            raise HTTPException(
                status_code=400,
                detail={"code": "provider_auth_failed", "daemon_message": message},
            )
        raise HTTPException(
            status_code=502,
            detail={
                "code": "daemon_gateway_failed",
                "daemon_code": code,
                "daemon_message": message,
            },
        )
    result = ack.get("result")
    return result if isinstance(result, dict) else {}


def _allowed_base_hosts() -> set[str]:
    """W9: explicit allowlist of acceptable baseUrl hosts.

    Blocklists miss internal hostnames (``metadata.google.internal``, ``*.svc
    .cluster.local``); switching to allowlist closes that pivot. The test host
    is added only when running under pytest / NODE_ENV=test.
    """
    hosts = {"api.telegram.org", "ilinkai.weixin.qq.com"}
    if os.environ.get("PYTEST_CURRENT_TEST") or os.environ.get("NODE_ENV") == "test":
        hosts.add("botcord-test.local")
    return hosts


def _validate_base_url(value: str | None) -> None:
    """W9: allowlist-based SSRF guard for user-supplied baseUrl.

    Only well-known third-party API hosts are accepted. Anything else — including
    GCP/AWS metadata hosts, internal cluster DNS, RFC1918 IPs — is rejected.
    """
    if value is None:
        return
    if not value or not isinstance(value, str):
        raise HTTPException(status_code=400, detail="invalid_base_url")
    try:
        parsed = urlparse(value)
    except Exception as exc:  # pragma: no cover — urlparse rarely throws
        raise HTTPException(status_code=400, detail="invalid_base_url") from exc
    if parsed.scheme != "https":
        raise HTTPException(status_code=400, detail="invalid_base_url_scheme")
    host = (parsed.hostname or "").lower()
    if not host:
        raise HTTPException(status_code=400, detail="invalid_base_url_host")
    if host not in _allowed_base_hosts():
        raise HTTPException(status_code=400, detail="forbidden_base_url_host")


# W4: per-(user, action) token bucket rate limiter.
# Action-specific burst caps:
#   wechat-login: 1 req/s, burst 5
#   gateway-write: 1 req/s, burst 10
#   gateway-test:  1 req/s, burst 5
_RATE_BUCKETS: dict[tuple[str, str], tuple[float, float]] = {}
_RATE_RATE = 1.0  # tokens per second (all actions)
_RATE_BURST: dict[str, float] = {
    "wechat-login": 5.0,
    "gateway-write": 10.0,
    "gateway-test": 5.0,
}
_RATE_BURST_DEFAULT = 5.0

# W2: stale-entry sweep — drop entries older than 10 minutes.
# Trade-off: running the O(n) dict scan on every call wastes cycles under
# steady load. Instead, use a call counter and sweep only every 256th call —
# memory stays bounded (at most 256 stale entries linger) while the per-call
# overhead is zero 255 out of 256 times.
_RATE_SWEEP_THRESHOLD = 600.0  # seconds
_rate_check_count = 0


def _rate_limit(user_id: Any, action: str) -> None:
    global _rate_check_count
    key = (str(user_id), action)
    now = time.monotonic()
    burst = _RATE_BURST.get(action, _RATE_BURST_DEFAULT)
    tokens, last = _RATE_BUCKETS.get(key, (burst, now))
    _rate_check_count += 1
    if _rate_check_count % 256 == 0:
        stale_keys = [k for k, (_, t) in _RATE_BUCKETS.items() if now - t > _RATE_SWEEP_THRESHOLD]
        for sk in stale_keys:
            _RATE_BUCKETS.pop(sk, None)
    tokens = min(burst, tokens + (now - last) * _RATE_RATE)
    if tokens < 1.0:
        _RATE_BUCKETS[key] = (tokens, now)
        raise HTTPException(status_code=429, detail="rate_limited")
    _RATE_BUCKETS[key] = (tokens - 1.0, now)


def _filter_config(patch: _ConfigPatch | None) -> dict[str, Any]:
    if patch is None:
        return {}
    raw = patch.model_dump(exclude_none=True)
    return {k: v for k, v in raw.items() if k in _CONFIG_KEYS}


def _build_settings(config: dict[str, Any]) -> dict[str, Any]:
    """Project the user-facing config into the daemon ``settings`` envelope."""
    out: dict[str, Any] = {}
    for k in ("baseUrl", "domain", "allowedSenderIds", "allowedChatIds", "splitAt"):
        if k in config and config[k] is not None:
            out[k] = config[k]
    return out


def _ingress_sync_secret() -> str | None:
    return hub_config.CLOUD_GATEWAY_INGRESS_SECRET or hub_config.INTERNAL_API_SECRET


async def _sync_cloud_gateway_ingress_upsert(
    host: _GatewayHost,
    *,
    gateway_id: str,
    user_id: Any,
    agent_id: str,
    provider: str,
    label: str | None,
    enabled: bool,
    status: str,
    config: dict[str, Any],
    secret: dict[str, Any] | None = None,
) -> None:
    if not host.cloud_daemon_instance_id or not hub_config.CLOUD_GATEWAY_INGRESS_ADMIN_URL:
        return
    auth_secret = _ingress_sync_secret()
    if not auth_secret:
        raise HTTPException(status_code=500, detail="ingress_sync_secret_missing")
    payload: dict[str, Any] = {
        "id": gateway_id,
        "agentId": agent_id,
        "userId": str(user_id),
        "provider": provider,
        "label": label,
        "enabled": enabled,
        "status": status,
        "config": config,
    }
    if secret is not None:
        payload["secret"] = secret
    url = f"{hub_config.CLOUD_GATEWAY_INGRESS_ADMIN_URL}/admin/gateways/{gateway_id}"
    try:
        async with httpx.AsyncClient(
            timeout=hub_config.CLOUD_GATEWAY_INGRESS_ADMIN_TIMEOUT_SECONDS
        ) as client:
            resp = await client.put(
                url,
                headers={"Authorization": f"Bearer {auth_secret}"},
                json=payload,
            )
    except httpx.HTTPError as exc:
        logger.warning(
            "cloud gateway ingress upsert sync failed: gateway=%s err=%s",
            gateway_id,
            exc,
        )
        raise HTTPException(status_code=502, detail="ingress_sync_failed") from exc
    if resp.status_code >= 400:
        logger.warning(
            "cloud gateway ingress upsert sync rejected: gateway=%s status=%s",
            gateway_id,
            resp.status_code,
        )
        raise HTTPException(status_code=502, detail="ingress_sync_rejected")


async def _sync_cloud_gateway_ingress_delete(
    host: _GatewayHost,
    *,
    gateway_id: str,
) -> None:
    if not host.cloud_daemon_instance_id or not hub_config.CLOUD_GATEWAY_INGRESS_ADMIN_URL:
        return
    auth_secret = _ingress_sync_secret()
    if not auth_secret:
        raise HTTPException(status_code=500, detail="ingress_sync_secret_missing")
    url = f"{hub_config.CLOUD_GATEWAY_INGRESS_ADMIN_URL}/admin/gateways/{gateway_id}"
    try:
        async with httpx.AsyncClient(
            timeout=hub_config.CLOUD_GATEWAY_INGRESS_ADMIN_TIMEOUT_SECONDS
        ) as client:
            resp = await client.delete(
                url,
                headers={"Authorization": f"Bearer {auth_secret}"},
            )
    except httpx.HTTPError as exc:
        logger.warning(
            "cloud gateway ingress delete sync failed: gateway=%s err=%s",
            gateway_id,
            exc,
        )
        raise HTTPException(status_code=502, detail="ingress_sync_failed") from exc
    if resp.status_code >= 400:
        logger.warning(
            "cloud gateway ingress delete sync rejected: gateway=%s status=%s",
            gateway_id,
            resp.status_code,
        )
        raise HTTPException(status_code=502, detail="ingress_sync_rejected")


def _list_has_value(config: dict[str, Any], key: str) -> bool:
    value = config.get(key)
    return isinstance(value, list) and any(
        isinstance(item, str) and item.strip() for item in value
    )


def _require_whitelist(provider: str, config: dict[str, Any]) -> None:
    if provider == "telegram":
        if _list_has_value(config, "allowedChatIds") and _list_has_value(
            config, "allowedSenderIds"
        ):
            return
        raise HTTPException(status_code=400, detail="missing_gateway_whitelist")
    if provider == "wechat" and not _list_has_value(config, "allowedSenderIds"):
        raise HTTPException(status_code=400, detail="missing_gateway_whitelist")
    if provider == "feishu" and not _list_has_value(config, "allowedSenderIds"):
        raise HTTPException(status_code=400, detail="missing_gateway_whitelist")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/{agent_id}/gateways", response_model=GatewayListOut)
async def list_gateways(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> GatewayListOut:
    """List saved third-party gateway connections for the user's agent.

    Read-only — works even when the daemon is offline (Hub metadata is the
    source of truth).
    """
    await _load_owned_agent(db, ctx, agent_id)
    rows = (
        await db.execute(
            select(AgentGatewayConnection)
            .where(
                AgentGatewayConnection.agent_id == agent_id,
                AgentGatewayConnection.user_id == ctx.user_id,
            )
            .order_by(AgentGatewayConnection.created_at.asc())
        )
    ).scalars().all()
    return GatewayListOut(gateways=[_serialize(r) for r in rows])


@router.post("/{agent_id}/gateways", response_model=GatewayOut)
async def create_gateway(
    agent_id: str,
    body: GatewayCreate,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> GatewayOut:
    _rate_limit(ctx.user_id, "gateway-write")
    if body.provider not in _ALLOWED_PROVIDERS:
        raise HTTPException(status_code=422, detail="unsupported_provider")

    agent = await _load_owned_agent(db, ctx, agent_id)
    if agent.hosting_kind not in ("daemon", "cloud"):
        # OpenClaw / other hosting kinds never had third-party gateway support;
        # surface the same 422 the daemon-only loader produced before Phase 2.
        raise HTTPException(status_code=422, detail="agent_not_daemon_hosted")

    if body.provider == "telegram" and not body.bot_token:
        raise HTTPException(status_code=400, detail="missing_bot_token")
    if body.provider == "wechat" and not body.login_id:
        raise HTTPException(status_code=400, detail="missing_login_id")
    if body.provider == "feishu" and not body.login_id:
        raise HTTPException(status_code=400, detail="missing_login_id")

    config = _filter_config(body.config)
    _validate_base_url(config.get("baseUrl"))

    # ----- Cloud agent: proxy create to gateway-ingress -----
    if agent.hosting_kind == "cloud":
        _require_whitelist(body.provider, config)

        login_id_for_create = body.login_id
        # Telegram cloud path: the dashboard posts botToken directly (there is
        # no scan-then-confirm flow). Ingress finalize requires a loginId, so
        # mint one server-side by running login_start (which validates the
        # token via getMe and creates a setup session). The botToken stays
        # inside gateway-ingress' setup session + secret store — never the Hub.
        if body.provider == "telegram":
            try:
                start_result = await ingress_client.login_start(
                    agent_id,
                    "telegram",
                    user_id=ctx.user_id,
                    request_id=_request_id_for(ctx),
                    body={"botToken": body.bot_token},
                )
            except HTTPException as exc:
                _log_setup_event(
                    agent=agent, host=None, provider=body.provider,
                    login_id=None, outcome="error",
                    error_code=_extract_error_code(exc), ctx=ctx,
                    setup_owner="gateway-ingress",
                )
                raise
            login_id_for_create = start_result.get("loginId") if isinstance(start_result.get("loginId"), str) else None
            if not login_id_for_create:
                raise HTTPException(
                    status_code=502,
                    detail={"code": "cloud_gateway_ingress_unavailable"},
                )

        ingress_body: dict[str, Any] = {
            "provider": body.provider,
            "label": body.label,
            "enabled": body.enabled,
            "config": dict(config),
            "loginId": login_id_for_create,
        }

        _log_setup_event(
            agent=agent, host=None, provider=body.provider,
            login_id=login_id_for_create, outcome="started", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        try:
            result = await ingress_client.create_gateway(
                agent_id,
                user_id=ctx.user_id,
                request_id=_request_id_for(ctx),
                body=ingress_body,
            )
        except HTTPException as exc:
            _log_setup_event(
                agent=agent, host=None, provider=body.provider,
                login_id=login_id_for_create, outcome="error",
                error_code=_extract_error_code(exc), ctx=ctx,
                setup_owner="gateway-ingress",
            )
            raise

        connection = result.get("connection") if isinstance(result.get("connection"), dict) else result
        warning_message = _extract_warning_message(result)
        row = await _upsert_mirror_from_ingress(
            db,
            agent=agent,
            user_id=ctx.user_id,
            ingress_connection=connection,
            warning_message=warning_message,
        )
        _log_setup_event(
            agent=agent, host=None, provider=body.provider,
            login_id=login_id_for_create, outcome="ok", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        return _serialize(row)

    # ----- daemon branch (unchanged) -----
    agent, host = await _load_gateway_host_or_422(db, ctx, agent_id)
    await _ensure_gateway_host_online(db, ctx, agent, host)
    _require_whitelist(body.provider, config)
    gateway_id = generate_gateway_connection_id(body.provider)

    params: dict[str, Any] = {
        "id": gateway_id,
        "type": body.provider,
        "accountId": agent_id,
        "label": body.label,
        "enabled": body.enabled,
        "settings": _build_settings(config),
    }
    if body.provider == "telegram":
        params["secret"] = {"botToken": body.bot_token}
    if body.provider in ("wechat", "feishu"):
        params["loginId"] = body.login_id

    ack = await _send_gateway_control_frame(
        host,
        "upsert_gateway",
        params,
        db=db,
        ctx=ctx,
        agent=agent,
        retry_cloud_disconnect=True,
    )
    result = _ack_or_raise(ack)

    token_preview = result.get("tokenPreview")
    if isinstance(token_preview, str) and token_preview:
        # Hub stores only the masked preview; secret hygiene is enforced here
        # so no caller-supplied tokenPreview can sneak in via ``config``.
        config["tokenPreview"] = token_preview
    else:
        config.pop("tokenPreview", None)
    for key in ("appId", "domain", "userOpenId"):
        value = result.get(key)
        if isinstance(value, str) and value:
            config[key] = value

    daemon_status = result.get("status") if isinstance(result.get("status"), dict) else None
    status_value: str = "active" if body.enabled else "disabled"
    if isinstance(daemon_status, dict) and daemon_status.get("running") is False and body.enabled:
        status_value = "pending"

    sync_secret: dict[str, Any] | None = None
    if body.provider == "telegram" and body.bot_token:
        sync_secret = {"botToken": body.bot_token}
    await _sync_cloud_gateway_ingress_upsert(
        host,
        gateway_id=gateway_id,
        user_id=ctx.user_id,
        agent_id=agent_id,
        provider=body.provider,
        label=body.label,
        enabled=body.enabled,
        status=status_value,
        config=config,
        secret=sync_secret,
    )

    row = AgentGatewayConnection(
        id=gateway_id,
        user_id=ctx.user_id,
        agent_id=agent_id,
        daemon_instance_id=host.daemon_instance_id,
        provider=body.provider,
        label=body.label,
        enabled=body.enabled,
        status=status_value,
        config_json=config,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _serialize(row)


@router.patch("/{agent_id}/gateways/{gateway_id}", response_model=GatewayOut)
async def patch_gateway(
    agent_id: str,
    gateway_id: str,
    body: GatewayPatch,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> GatewayOut:
    _rate_limit(ctx.user_id, "gateway-write")

    agent = await _load_owned_agent(db, ctx, agent_id)

    # ----- Cloud agent: forward PATCH to gateway-ingress -----
    if agent.hosting_kind == "cloud":
        existing = await db.scalar(
            select(AgentGatewayConnection).where(
                AgentGatewayConnection.id == gateway_id,
                AgentGatewayConnection.agent_id == agent_id,
                AgentGatewayConnection.user_id == ctx.user_id,
            )
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="gateway_not_found")

        # Validate the user-visible diff before we send it to ingress; that
        # way SSRF/whitelist guards fire even when the source of truth lives
        # on the other side of the network.
        fields = body.model_fields_set
        merged_config = dict(existing.config_json or {})
        if "config" in fields:
            merged_config.update(_filter_config(body.config))
        _validate_base_url(merged_config.get("baseUrl"))
        _require_whitelist(existing.provider, merged_config)

        ingress_body: dict[str, Any] = {}
        if "label" in fields:
            ingress_body["label"] = body.label
        if "enabled" in fields and body.enabled is not None:
            ingress_body["enabled"] = body.enabled
        if "config" in fields:
            ingress_body["config"] = _filter_config(body.config)
        if existing.provider == "telegram" and body.bot_token:
            # Rotation: forward the new token to ingress, never persisted here.
            ingress_body["secret"] = {"botToken": body.bot_token}

        _log_setup_event(
            agent=agent, host=None, provider=existing.provider,
            login_id=None, outcome="started", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        try:
            result = await ingress_client.patch_gateway(
                agent_id, gateway_id,
                user_id=ctx.user_id,
                request_id=_request_id_for(ctx),
                body=ingress_body,
            )
        except HTTPException as exc:
            _log_setup_event(
                agent=agent, host=None, provider=existing.provider,
                login_id=None, outcome="error",
                error_code=_extract_error_code(exc), ctx=ctx,
                setup_owner="gateway-ingress",
            )
            raise

        connection = result.get("connection") if isinstance(result.get("connection"), dict) else result
        warning_message = _extract_warning_message(result)
        row = await _upsert_mirror_from_ingress(
            db,
            agent=agent,
            user_id=ctx.user_id,
            ingress_connection=connection,
            existing_row=existing,
            warning_message=warning_message,
        )
        _log_setup_event(
            agent=agent, host=None, provider=existing.provider,
            login_id=None, outcome="ok", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        return _serialize(row)

    # ----- daemon branch (unchanged) -----
    agent, host, row = await _load_owned_connection(db, ctx, agent_id, gateway_id)
    await _ensure_gateway_host_online(db, ctx, agent, host)

    fields = body.model_fields_set
    if "label" in fields:
        row.label = body.label
    if "enabled" in fields and body.enabled is not None:
        row.enabled = body.enabled

    if "config" in fields:
        merged = dict(row.config_json or {})
        merged.update(_filter_config(body.config))
        row.config_json = merged

    config = dict(row.config_json or {})
    _validate_base_url(config.get("baseUrl"))
    _require_whitelist(row.provider, config)
    params: dict[str, Any] = {
        "id": row.id,
        "type": row.provider,
        "accountId": row.agent_id,
        "label": row.label,
        "enabled": row.enabled,
        "settings": _build_settings(config),
    }
    # Only forward a Telegram token rotation when explicitly supplied; never
    # include WeChat tokens (the daemon owns them via login session).
    if row.provider == "telegram" and body.bot_token:
        params["secret"] = {"botToken": body.bot_token}

    # W6: flush the pending row mutations to the DB BEFORE pushing to the
    # daemon. If the flush fails (constraint, schema drift, etc.) we surface
    # an HTTP error without the daemon having accepted the new metadata. We
    # only commit AFTER the daemon ack — and roll back if the daemon rejects.
    try:
        await db.flush()
    except Exception:
        await db.rollback()
        raise

    try:
        ack = await _send_gateway_control_frame(host, "upsert_gateway", params)
        result = _ack_or_raise(ack)
    except Exception:
        await db.rollback()
        raise

    token_preview = result.get("tokenPreview")
    if isinstance(token_preview, str) and token_preview:
        config["tokenPreview"] = token_preview
        row.config_json = config

    daemon_status = result.get("status") if isinstance(result.get("status"), dict) else None
    if isinstance(daemon_status, dict):
        running = daemon_status.get("running")
        if row.enabled is False:
            row.status = "disabled"
        elif running is True:
            row.status = "active"
        elif running is False:
            row.status = "pending"
    else:
        row.status = "active" if row.enabled else "disabled"

    sync_secret: dict[str, Any] | None = None
    if row.provider == "telegram" and body.bot_token:
        sync_secret = {"botToken": body.bot_token}
    await _sync_cloud_gateway_ingress_upsert(
        host,
        gateway_id=row.id,
        user_id=ctx.user_id,
        agent_id=row.agent_id,
        provider=row.provider,
        label=row.label,
        enabled=row.enabled,
        status=row.status,
        config=config,
        secret=sync_secret,
    )

    try:
        # trade-off: rare commit failure leaves Hub stale; daemon hot-plug already applied. list_gateways will reconcile on next refresh.
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    await db.refresh(row)
    return _serialize(row)


@router.delete("/{agent_id}/gateways/{gateway_id}", status_code=204)
async def delete_gateway(
    agent_id: str,
    gateway_id: str,
    force: bool = False,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    agent = await _load_owned_agent(db, ctx, agent_id)

    # ----- Cloud agent: forward DELETE to gateway-ingress -----
    if agent.hosting_kind == "cloud":
        row = await db.scalar(
            select(AgentGatewayConnection).where(
                AgentGatewayConnection.id == gateway_id,
                AgentGatewayConnection.agent_id == agent_id,
                AgentGatewayConnection.user_id == ctx.user_id,
            )
        )
        if row is None:
            raise HTTPException(status_code=404, detail="gateway_not_found")

        if force:
            logger.warning(
                "delete_gateway force=true (cloud): dropping Hub mirror without ingress ack",
                extra={"agent_id": agent_id, "gateway_id": row.id},
            )
        else:
            _log_setup_event(
                agent=agent, host=None, provider=row.provider,
                login_id=None, outcome="started", ctx=ctx,
                setup_owner="gateway-ingress",
            )
            try:
                await ingress_client.delete_gateway(
                    agent_id, gateway_id,
                    user_id=ctx.user_id,
                    request_id=_request_id_for(ctx),
                )
            except HTTPException as exc:
                _log_setup_event(
                    agent=agent, host=None, provider=row.provider,
                    login_id=None, outcome="error",
                    error_code=_extract_error_code(exc), ctx=ctx,
                    setup_owner="gateway-ingress",
                )
                raise
            _log_setup_event(
                agent=agent, host=None, provider=row.provider,
                login_id=None, outcome="ok", ctx=ctx,
                setup_owner="gateway-ingress",
            )

        await db.delete(row)
        await db.commit()
        return Response(status_code=204)

    # ----- daemon branch (unchanged) -----
    agent, host, row = await _load_owned_connection(db, ctx, agent_id, gateway_id)
    if force:
        # C1: operator opt-in escape hatch — daemon is permanently dead and the
        # row would otherwise be orphaned. Skip the daemon round-trip entirely.
        logger.warning(
            "delete_gateway force=true: deleting Hub row without daemon ack",
            extra={"daemon_instance_id": host.daemon_instance_id, "gateway_id": row.id},
        )
    else:
        await _ensure_gateway_host_online(db, ctx, agent, host)

        ack = await _send_gateway_control_frame(
            host,
            "remove_gateway",
            {"id": row.id},
            db=db,
            ctx=ctx,
            agent=agent,
            retry_cloud_disconnect=True,
        )
        _ack_or_raise(ack)

    await _sync_cloud_gateway_ingress_delete(host, gateway_id=row.id)
    await db.delete(row)
    await db.commit()
    return Response(status_code=204)


@router.post("/{agent_id}/gateways/{gateway_id}/test")
async def test_gateway(
    agent_id: str,
    gateway_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _rate_limit(ctx.user_id, "gateway-test")
    agent = await _load_owned_agent(db, ctx, agent_id)

    # ----- Cloud agent: forward TEST to gateway-ingress -----
    if agent.hosting_kind == "cloud":
        existing = await db.scalar(
            select(AgentGatewayConnection).where(
                AgentGatewayConnection.id == gateway_id,
                AgentGatewayConnection.agent_id == agent_id,
                AgentGatewayConnection.user_id == ctx.user_id,
            )
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="gateway_not_found")
        result = await ingress_client.test_gateway(
            agent_id, gateway_id,
            user_id=ctx.user_id,
            request_id=_request_id_for(ctx),
        )
        # ingress shape is the same ``{"ok": True, "result": ...}`` envelope
        # the daemon path already returns, so the dashboard handles both.
        if isinstance(result, dict) and "ok" in result and "result" in result:
            return result
        return {"ok": True, "result": result}

    # ----- daemon branch (unchanged) -----
    agent, host, row = await _load_owned_connection(db, ctx, agent_id, gateway_id)
    await _ensure_gateway_host_online(db, ctx, agent, host)

    ack = await _send_gateway_control_frame(
        host,
        "test_gateway",
        {"id": row.id},
        db=db,
        ctx=ctx,
        agent=agent,
        retry_cloud_disconnect=True,
    )
    result = _ack_or_raise(ack)
    return {"ok": True, "result": result}


# ---------------------------------------------------------------------------
# WeChat scan-to-login proxies
# ---------------------------------------------------------------------------


@router.post("/{agent_id}/gateways/wechat/login/start")
async def wechat_login_start(
    agent_id: str,
    body: WechatLoginStartIn,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Proxy ``gateway_login_start`` (provider=wechat) to the daemon or
    gateway-ingress depending on hosting kind.

    Returns ``{loginId, qrcode, qrcodeUrl, expiresAt}``. Does NOT persist
    anything — the bot token never leaves the setup owner's secret store
    until the user calls ``POST /gateways`` with the matching ``loginId``.
    """
    _rate_limit(ctx.user_id, "wechat-login")
    if body.base_url:
        _validate_base_url(body.base_url)
    agent = await _load_owned_agent(db, ctx, agent_id)

    if agent.hosting_kind == "cloud":
        _log_setup_event(
            agent=agent, host=None, provider="wechat",
            login_id=None, outcome="started", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        ingress_body: dict[str, Any] = {}
        if body.gateway_id:
            ingress_body["gatewayId"] = body.gateway_id
        if body.base_url:
            ingress_body["baseUrl"] = body.base_url
        try:
            result = await ingress_client.login_start(
                agent_id, "wechat",
                user_id=ctx.user_id,
                request_id=_request_id_for(ctx),
                body=ingress_body,
            )
        except HTTPException as exc:
            _log_setup_event(
                agent=agent, host=None, provider="wechat",
                login_id=None, outcome="error",
                error_code=_extract_error_code(exc), ctx=ctx,
                setup_owner="gateway-ingress",
            )
            raise
        login_id = result.get("loginId") if isinstance(result.get("loginId"), str) else None
        _log_setup_event(
            agent=agent, host=None, provider="wechat",
            login_id=login_id, outcome="ok", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        # ingress wraps provider-specific fields under publicPayload; the
        # daemon path returned them flat, so unwrap here to keep the
        # dashboard contract identical across hosting kinds.
        public = result.get("publicPayload") if isinstance(result.get("publicPayload"), dict) else {}
        return {
            "loginId": result.get("loginId"),
            "qrcode": public.get("qrcode"),
            "qrcodeUrl": public.get("qrcodeUrl"),
            "expiresAt": result.get("expiresAt"),
        }

    # daemon branch — unchanged behavior
    agent, host = await _load_gateway_host_or_422(db, ctx, agent_id)
    await _ensure_gateway_host_online(db, ctx, agent, host)

    _log_setup_event(
        agent=agent, host=host, provider="wechat",
        login_id=None, outcome="started", ctx=ctx,
    )

    params: dict[str, Any] = {
        "provider": "wechat",
        "accountId": agent_id,
    }
    if body.gateway_id:
        params["gatewayId"] = body.gateway_id
    if body.base_url:
        params["baseUrl"] = body.base_url

    try:
        ack = await _send_gateway_control_frame(
            host,
            "gateway_login_start",
            params,
            db=db,
            ctx=ctx,
            agent=agent,
            retry_cloud_disconnect=True,
        )
        result = _ack_or_raise(ack)
    except HTTPException as exc:
        _log_setup_event(
            agent=agent, host=host, provider="wechat",
            login_id=None, outcome="error",
            error_code=_extract_error_code(exc), ctx=ctx,
        )
        raise

    login_id = result.get("loginId") if isinstance(result.get("loginId"), str) else None
    _log_setup_event(
        agent=agent, host=host, provider="wechat",
        login_id=login_id, outcome="ok", ctx=ctx,
    )
    return {
        "loginId": result.get("loginId"),
        "qrcode": result.get("qrcode"),
        "qrcodeUrl": result.get("qrcodeUrl"),
        "expiresAt": result.get("expiresAt"),
    }


@router.post("/{agent_id}/gateways/wechat/login/status")
async def wechat_login_status(
    agent_id: str,
    body: WechatLoginStatusIn,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _rate_limit(ctx.user_id, "wechat-login")
    agent = await _load_owned_agent(db, ctx, agent_id)

    if agent.hosting_kind == "cloud":
        _log_setup_event(
            agent=agent, host=None, provider="wechat",
            login_id=body.login_id, outcome="started", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        try:
            result = await ingress_client.login_status(
                agent_id, "wechat",
                user_id=ctx.user_id,
                request_id=_request_id_for(ctx),
                login_id=body.login_id,
            )
        except HTTPException as exc:
            _log_setup_event(
                agent=agent, host=None, provider="wechat",
                login_id=body.login_id, outcome="error",
                error_code=_extract_error_code(exc), ctx=ctx,
                setup_owner="gateway-ingress",
            )
            raise
        _log_setup_event(
            agent=agent, host=None, provider="wechat",
            login_id=body.login_id, outcome="ok", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        public = result.get("publicPayload") if isinstance(result.get("publicPayload"), dict) else {}
        return {
            "status": result.get("status"),
            "baseUrl": public.get("baseUrl"),
            "tokenPreview": public.get("tokenPreview"),
        }

    agent, host = await _load_gateway_host_or_422(db, ctx, agent_id)
    await _ensure_gateway_host_online(db, ctx, agent, host)

    _log_setup_event(
        agent=agent, host=host, provider="wechat",
        login_id=body.login_id, outcome="started", ctx=ctx,
    )

    try:
        ack = await _send_gateway_control_frame(
            host,
            "gateway_login_status",
            {"provider": "wechat", "loginId": body.login_id, "accountId": agent_id},
            db=db,
            ctx=ctx,
            agent=agent,
            retry_cloud_disconnect=True,
        )
        result = _ack_or_raise(ack)
    except HTTPException as exc:
        _log_setup_event(
            agent=agent, host=host, provider="wechat",
            login_id=body.login_id, outcome="error",
            error_code=_extract_error_code(exc), ctx=ctx,
        )
        raise

    _log_setup_event(
        agent=agent, host=host, provider="wechat",
        login_id=body.login_id, outcome="ok", ctx=ctx,
    )
    return {
        "status": result.get("status"),
        "baseUrl": result.get("baseUrl"),
        "tokenPreview": result.get("tokenPreview"),
    }


@router.post("/{agent_id}/gateways/feishu/login/start")
async def feishu_login_start(
    agent_id: str,
    body: WechatLoginStartIn,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _rate_limit(ctx.user_id, "wechat-login")
    agent = await _load_owned_agent(db, ctx, agent_id)

    if agent.hosting_kind == "cloud":
        _log_setup_event(
            agent=agent, host=None, provider="feishu",
            login_id=None, outcome="started", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        ingress_body: dict[str, Any] = {}
        if body.gateway_id:
            ingress_body["gatewayId"] = body.gateway_id
        if body.domain:
            ingress_body["domain"] = body.domain
        try:
            result = await ingress_client.login_start(
                agent_id, "feishu",
                user_id=ctx.user_id,
                request_id=_request_id_for(ctx),
                body=ingress_body,
            )
        except HTTPException as exc:
            _log_setup_event(
                agent=agent, host=None, provider="feishu",
                login_id=None, outcome="error",
                error_code=_extract_error_code(exc), ctx=ctx,
                setup_owner="gateway-ingress",
            )
            raise
        login_id = result.get("loginId") if isinstance(result.get("loginId"), str) else None
        _log_setup_event(
            agent=agent, host=None, provider="feishu",
            login_id=login_id, outcome="ok", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        public = result.get("publicPayload") if isinstance(result.get("publicPayload"), dict) else {}
        return {
            "loginId": result.get("loginId"),
            "qrcode": public.get("qrcode"),
            "qrcodeUrl": public.get("qrcodeUrl"),
            "expiresAt": result.get("expiresAt"),
        }

    agent, host = await _load_gateway_host_or_422(db, ctx, agent_id)
    await _ensure_gateway_host_online(db, ctx, agent, host)

    _log_setup_event(
        agent=agent, host=host, provider="feishu",
        login_id=None, outcome="started", ctx=ctx,
    )

    params: dict[str, Any] = {
        "provider": "feishu",
        "accountId": agent_id,
    }
    if body.gateway_id:
        params["gatewayId"] = body.gateway_id
    if body.domain:
        params["domain"] = body.domain

    try:
        ack = await _send_gateway_control_frame(
            host,
            "gateway_login_start",
            params,
            db=db,
            ctx=ctx,
            agent=agent,
            retry_cloud_disconnect=True,
        )
        result = _ack_or_raise(ack)
    except HTTPException as exc:
        _log_setup_event(
            agent=agent, host=host, provider="feishu",
            login_id=None, outcome="error",
            error_code=_extract_error_code(exc), ctx=ctx,
        )
        raise

    login_id = result.get("loginId") if isinstance(result.get("loginId"), str) else None
    _log_setup_event(
        agent=agent, host=host, provider="feishu",
        login_id=login_id, outcome="ok", ctx=ctx,
    )
    return {
        "loginId": result.get("loginId"),
        "qrcode": result.get("qrcode"),
        "qrcodeUrl": result.get("qrcodeUrl"),
        "expiresAt": result.get("expiresAt"),
    }


@router.post("/{agent_id}/gateways/feishu/login/status")
async def feishu_login_status(
    agent_id: str,
    body: WechatLoginStatusIn,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _rate_limit(ctx.user_id, "wechat-login")
    agent = await _load_owned_agent(db, ctx, agent_id)

    if agent.hosting_kind == "cloud":
        _log_setup_event(
            agent=agent, host=None, provider="feishu",
            login_id=body.login_id, outcome="started", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        try:
            result = await ingress_client.login_status(
                agent_id, "feishu",
                user_id=ctx.user_id,
                request_id=_request_id_for(ctx),
                login_id=body.login_id,
            )
        except HTTPException as exc:
            _log_setup_event(
                agent=agent, host=None, provider="feishu",
                login_id=body.login_id, outcome="error",
                error_code=_extract_error_code(exc), ctx=ctx,
                setup_owner="gateway-ingress",
            )
            raise
        _log_setup_event(
            agent=agent, host=None, provider="feishu",
            login_id=body.login_id, outcome="ok", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        public = result.get("publicPayload") if isinstance(result.get("publicPayload"), dict) else {}
        return {
            "status": result.get("status"),
            "appId": public.get("appId"),
            "domain": public.get("domain"),
            "userOpenId": public.get("userOpenId"),
            "tokenPreview": public.get("tokenPreview"),
        }

    agent, host = await _load_gateway_host_or_422(db, ctx, agent_id)
    await _ensure_gateway_host_online(db, ctx, agent, host)

    _log_setup_event(
        agent=agent, host=host, provider="feishu",
        login_id=body.login_id, outcome="started", ctx=ctx,
    )

    try:
        ack = await _send_gateway_control_frame(
            host,
            "gateway_login_status",
            {"provider": "feishu", "loginId": body.login_id, "accountId": agent_id},
            db=db,
            ctx=ctx,
            agent=agent,
            retry_cloud_disconnect=True,
        )
        result = _ack_or_raise(ack)
    except HTTPException as exc:
        _log_setup_event(
            agent=agent, host=host, provider="feishu",
            login_id=body.login_id, outcome="error",
            error_code=_extract_error_code(exc), ctx=ctx,
        )
        raise

    _log_setup_event(
        agent=agent, host=host, provider="feishu",
        login_id=body.login_id, outcome="ok", ctx=ctx,
    )
    return {
        "status": result.get("status"),
        "appId": result.get("appId"),
        "domain": result.get("domain"),
        "userOpenId": result.get("userOpenId"),
        "tokenPreview": result.get("tokenPreview"),
    }


@router.post("/{agent_id}/gateways/wechat/senders")
async def wechat_recent_senders(
    agent_id: str,
    body: WechatSenderDiscoveryIn,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Proxy recent WeChat sender discovery to the daemon login session or
    to gateway-ingress for cloud agents.

    The dashboard calls this after scan confirmation, before the gateway row is
    saved, so users can whitelist a sender without knowing ``xxx@im.wechat``.
    """
    _rate_limit(ctx.user_id, "wechat-login")
    agent = await _load_owned_agent(db, ctx, agent_id)

    if agent.hosting_kind == "cloud":
        _log_setup_event(
            agent=agent, host=None, provider="wechat",
            login_id=body.login_id, outcome="started", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        try:
            result = await ingress_client.discover(
                agent_id, "wechat",
                user_id=ctx.user_id,
                request_id=_request_id_for(ctx),
                body={
                    "loginId": body.login_id,
                    "timeoutSeconds": body.timeout_seconds,
                },
            )
        except HTTPException as exc:
            _log_setup_event(
                agent=agent, host=None, provider="wechat",
                login_id=body.login_id, outcome="error",
                error_code=_extract_error_code(exc), ctx=ctx,
                setup_owner="gateway-ingress",
            )
            raise
        _log_setup_event(
            agent=agent, host=None, provider="wechat",
            login_id=body.login_id, outcome="ok", ctx=ctx,
            setup_owner="gateway-ingress",
        )
        # ingress returns `candidates` (DiscoverResult shape); daemon path used
        # `senders` / legacy `users`. Try ingress first, then fall back.
        senders = result.get("candidates")
        if not isinstance(senders, list):
            senders = result.get("senders")
        if not isinstance(senders, list):
            senders = result.get("users")
        return {"senders": senders if isinstance(senders, list) else []}

    agent, host = await _load_gateway_host_or_422(db, ctx, agent_id)
    await _ensure_gateway_host_online(db, ctx, agent, host)

    _log_setup_event(
        agent=agent, host=host, provider="wechat",
        login_id=body.login_id, outcome="started", ctx=ctx,
    )

    try:
        ack = await _send_gateway_control_frame(
            host,
            "gateway_recent_senders",
            {
                "provider": "wechat",
                "loginId": body.login_id,
                "accountId": agent_id,
                "timeoutSeconds": body.timeout_seconds,
            },
            db=db,
            ctx=ctx,
            agent=agent,
            retry_cloud_disconnect=True,
        )
        result = _ack_or_raise(ack)
    except HTTPException as exc:
        _log_setup_event(
            agent=agent, host=host, provider="wechat",
            login_id=body.login_id, outcome="error",
            error_code=_extract_error_code(exc), ctx=ctx,
        )
        raise

    _log_setup_event(
        agent=agent, host=host, provider="wechat",
        login_id=body.login_id, outcome="ok", ctx=ctx,
    )
    senders = result.get("senders")
    if not isinstance(senders, list):
        senders = result.get("users")
    return {"senders": senders if isinstance(senders, list) else []}
