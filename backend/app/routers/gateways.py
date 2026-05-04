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
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
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
_CONFIG_KEYS = {"baseUrl", "allowedSenderIds", "allowedChatIds", "splitAt", "tokenPreview"}


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


class GatewayCreate(BaseModel):
    provider: ProviderLit
    label: str | None = Field(default=None, max_length=128)
    enabled: bool = True
    # Telegram only — fresh bot token. Forwarded once to the daemon, never stored.
    bot_token: str | None = Field(default=None, max_length=512)
    # WeChat only — references a previously-confirmed daemon login session.
    login_id: str | None = Field(default=None, max_length=128)
    config: _ConfigPatch | None = None

    @field_validator("label")
    @classmethod
    def _strip_label(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        return v or None


class GatewayPatch(BaseModel):
    label: str | None = None
    enabled: bool | None = None
    bot_token: str | None = Field(default=None, max_length=512)
    config: _ConfigPatch | None = None

    @field_validator("label")
    @classmethod
    def _strip_label(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        return v or None


class WechatLoginStartIn(BaseModel):
    base_url: str | None = Field(default=None, max_length=256)
    gateway_id: str | None = Field(default=None, max_length=128)


class WechatLoginStatusIn(BaseModel):
    login_id: str = Field(..., min_length=4, max_length=128)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _serialize(row: AgentGatewayConnection) -> GatewayOut:
    return GatewayOut(
        id=row.id,
        agent_id=row.agent_id,
        daemon_instance_id=row.daemon_instance_id,
        provider=row.provider,  # type: ignore[arg-type]
        label=row.label,
        status=row.status,  # type: ignore[arg-type]
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

    ack = await send_control_frame(daemon_id, "upsert_gateway", params)
    result = _ack_or_raise(ack)

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

    await db.commit()
    await db.refresh(row)
    return _serialize(row)


@router.delete("/{agent_id}/gateways/{gateway_id}", status_code=204)
async def delete_gateway(
    agent_id: str,
    gateway_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    _, row = await _load_owned_connection(db, ctx, agent_id, gateway_id)
    daemon_id = row.daemon_instance_id
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
    agent = await _load_daemon_agent_or_422(db, ctx, agent_id)
    daemon_id = agent.daemon_instance_id
    assert daemon_id is not None
    _require_online(daemon_id)

    ack = await send_control_frame(
        daemon_id,
        "gateway_login_status",
        {"provider": "wechat", "loginId": body.login_id},
    )
    result = _ack_or_raise(ack)
    return {
        "status": result.get("status"),
        "baseUrl": result.get("baseUrl"),
        "tokenPreview": result.get("tokenPreview"),
    }
