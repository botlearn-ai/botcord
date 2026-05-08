"""
[INPUT]: Authenticated user + their owned daemon-hosted agent + Pydantic
         third-party gateway connection requests.
[OUTPUT]: GET/POST/PATCH/DELETE /api/agents/{agent_id}/gateways*  +
          POST /api/agents/{agent_id}/gateways/wechat/login/{start,status} —
          BFF surface for the dashboard "Channels" (接入) tab.
[POS]: BFF wrapper around the daemon control-frame contract for
       Telegram / WeChat third-party channel adapters.
[PROTOCOL]: User must own the agent; agent must be ``hosting_kind == 'daemon'``
            with a non-null ``daemon_instance_id``. Daemon must be online for
            write/login/test calls; reads of saved rows are allowed offline.
            Bot tokens never persist in Hub DB — they are forwarded once to
            the daemon (Telegram) or pulled by the daemon from a local login
            session (WeChat) and written to the daemon's local secret store.
"""

from __future__ import annotations

import datetime
import logging
import os
import time
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.id_generators import generate_gateway_connection_id
from hub.models import Agent, AgentGatewayConnection
from hub.routers.daemon_control import is_daemon_online, send_control_frame

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["app-gateways"])


ProviderLit = Literal["telegram", "wechat"]
StatusLit = Literal["pending", "active", "disabled", "error"]

_ALLOWED_PROVIDERS: set[str] = {"telegram", "wechat"}
# config_json keys we accept from the dashboard. Anything else is dropped to
# avoid arbitrary blob storage / leaking secrets.
# W4: tokenPreview is server-managed (overwritten with the daemon-returned
# value on create/patch); never accept it from the caller.
_CONFIG_KEYS = {"baseUrl", "allowedSenderIds", "allowedChatIds", "splitAt"}


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
    # WeChat only — references a previously-confirmed daemon login session.
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
    if row.provider not in ("telegram", "wechat"):
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


async def _load_daemon_agent_or_422(
    db: AsyncSession, ctx: RequestContext, agent_id: str
) -> Agent:
    """Resolve agent + assert it is daemon-hosted with a bound daemon."""
    agent = await _load_owned_agent(db, ctx, agent_id)
    if agent.hosting_kind != "daemon" or not agent.daemon_instance_id:
        raise HTTPException(status_code=422, detail="agent_not_daemon_hosted")
    return agent


async def _load_owned_connection(
    db: AsyncSession, ctx: RequestContext, agent_id: str, gateway_id: str
) -> tuple[Agent, AgentGatewayConnection]:
    agent = await _load_owned_agent(db, ctx, agent_id)
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
    return agent, row


def _require_online(daemon_instance_id: str) -> None:
    if not is_daemon_online(daemon_instance_id):
        raise HTTPException(status_code=409, detail="daemon_offline")


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
    for k in ("baseUrl", "allowedSenderIds", "allowedChatIds", "splitAt"):
        if k in config and config[k] is not None:
            out[k] = config[k]
    return out


def _list_has_value(config: dict[str, Any], key: str) -> bool:
    value = config.get(key)
    return isinstance(value, list) and any(
        isinstance(item, str) and item.strip() for item in value
    )


def _require_whitelist(provider: str, config: dict[str, Any]) -> None:
    if provider == "telegram":
        if _list_has_value(config, "allowedChatIds") or _list_has_value(
            config, "allowedSenderIds"
        ):
            return
        raise HTTPException(status_code=400, detail="missing_gateway_whitelist")
    if provider == "wechat" and not _list_has_value(config, "allowedSenderIds"):
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

    agent = await _load_daemon_agent_or_422(db, ctx, agent_id)
    daemon_id = agent.daemon_instance_id
    assert daemon_id is not None  # narrow for the type checker
    _require_online(daemon_id)

    if body.provider == "telegram" and not body.bot_token:
        raise HTTPException(status_code=400, detail="missing_bot_token")
    if body.provider == "wechat" and not body.login_id:
        raise HTTPException(status_code=400, detail="missing_login_id")

    gateway_id = generate_gateway_connection_id(body.provider)
    config = _filter_config(body.config)
    _validate_base_url(config.get("baseUrl"))
    _require_whitelist(body.provider, config)

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
    if body.provider == "wechat":
        params["loginId"] = body.login_id

    ack = await send_control_frame(daemon_id, "upsert_gateway", params)
    result = _ack_or_raise(ack)

    token_preview = result.get("tokenPreview")
    if isinstance(token_preview, str) and token_preview:
        # Hub stores only the masked preview; secret hygiene is enforced here
        # so no caller-supplied tokenPreview can sneak in via ``config``.
        config["tokenPreview"] = token_preview
    else:
        config.pop("tokenPreview", None)

    daemon_status = result.get("status") if isinstance(result.get("status"), dict) else None
    status_value: str = "active" if body.enabled else "disabled"
    if isinstance(daemon_status, dict) and daemon_status.get("running") is False and body.enabled:
        status_value = "pending"

    row = AgentGatewayConnection(
        id=gateway_id,
        user_id=ctx.user_id,
        agent_id=agent_id,
        daemon_instance_id=daemon_id,
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
    agent, row = await _load_owned_connection(db, ctx, agent_id, gateway_id)
    daemon_id = row.daemon_instance_id
    _require_online(daemon_id)

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
        ack = await send_control_frame(daemon_id, "upsert_gateway", params)
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
    _, row = await _load_owned_connection(db, ctx, agent_id, gateway_id)
    daemon_id = row.daemon_instance_id
    if force:
        # C1: operator opt-in escape hatch — daemon is permanently dead and the
        # row would otherwise be orphaned. Skip the daemon round-trip entirely.
        logger.warning(
            "delete_gateway force=true: deleting Hub row without daemon ack",
            extra={"daemon_instance_id": daemon_id, "gateway_id": row.id},
        )
    else:
        _require_online(daemon_id)

        ack = await send_control_frame(daemon_id, "remove_gateway", {"id": row.id})
        _ack_or_raise(ack)

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
    _, row = await _load_owned_connection(db, ctx, agent_id, gateway_id)
    daemon_id = row.daemon_instance_id
    _require_online(daemon_id)

    ack = await send_control_frame(daemon_id, "test_gateway", {"id": row.id})
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
    """Proxy ``gateway_login_start`` (provider=wechat) to the daemon.

    Returns ``{loginId, qrcode, qrcodeUrl, expiresAt}``. Does NOT persist
    anything — the bot token never leaves the daemon's process memory until
    the user calls ``POST /gateways`` with the matching ``loginId``.
    """
    _rate_limit(ctx.user_id, "wechat-login")
    agent = await _load_daemon_agent_or_422(db, ctx, agent_id)
    daemon_id = agent.daemon_instance_id
    assert daemon_id is not None
    _require_online(daemon_id)

    params: dict[str, Any] = {
        "provider": "wechat",
        "accountId": agent_id,
    }
    if body.gateway_id:
        params["gatewayId"] = body.gateway_id
    if body.base_url:
        _validate_base_url(body.base_url)
        params["baseUrl"] = body.base_url

    ack = await send_control_frame(daemon_id, "gateway_login_start", params)
    result = _ack_or_raise(ack)
    # Surface the daemon-reported envelope verbatim — the dashboard already
    # speaks `{loginId, qrcode, qrcodeUrl, expiresAt}` per the design doc.
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
    agent = await _load_daemon_agent_or_422(db, ctx, agent_id)
    daemon_id = agent.daemon_instance_id
    assert daemon_id is not None
    _require_online(daemon_id)

    ack = await send_control_frame(
        daemon_id,
        "gateway_login_status",
        {"provider": "wechat", "loginId": body.login_id, "accountId": agent_id},
    )
    result = _ack_or_raise(ack)
    return {
        "status": result.get("status"),
        "baseUrl": result.get("baseUrl"),
        "tokenPreview": result.get("tokenPreview"),
    }


@router.post("/{agent_id}/gateways/wechat/senders")
async def wechat_recent_senders(
    agent_id: str,
    body: WechatSenderDiscoveryIn,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Proxy recent WeChat sender discovery to the daemon login session.

    The dashboard calls this after scan confirmation, before the gateway row is
    saved, so users can whitelist a sender without knowing ``xxx@im.wechat``.
    """
    _rate_limit(ctx.user_id, "wechat-login")
    agent = await _load_daemon_agent_or_422(db, ctx, agent_id)
    daemon_id = agent.daemon_instance_id
    assert daemon_id is not None
    _require_online(daemon_id)

    ack = await send_control_frame(
        daemon_id,
        "gateway_recent_senders",
        {
            "provider": "wechat",
            "loginId": body.login_id,
            "accountId": agent_id,
            "timeoutSeconds": body.timeout_seconds,
        },
    )
    result = _ack_or_raise(ack)
    senders = result.get("senders")
    if not isinstance(senders, list):
        senders = result.get("users")
    return {"senders": senders if isinstance(senders, list) else []}
