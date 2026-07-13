"""BotLearn first-party browser integration (PR 9).

Two surfaces, both gated by ``BOTLEARN_INTEGRATION_ENABLED`` and an Origin
allowlist:

- ``POST /api/integrations/botlearn/session`` — verify a BotLearn login token,
  JIT-create/bind the BotCord user, select/create a default Cloud Agent, record
  the ``botlearn_installations`` authorization, and mint a short-lived session
  token. The browser never receives a long-term BotCord API key.
- ``GET /api/integrations/botlearn/ws`` — ``botcord-agent-session/0.1`` WS that
  accepts the session token and exposes only the Cloud Run public subset.
  ``cloud_run.create`` reuses ``CloudAgentService.create_run`` so it cannot
  bypass quota preflight / reservation / settlement.

See docs/cloud-agent-technical-design.md §3.4 / §4.5 / §6.4.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import re
import uuid as _uuid
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request, WebSocket
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import _load_user_and_roles
from app.botlearn_auth import (
    BOTLEARN_METHOD_REQUIRED_SCOPE,
    BOTLEARN_WS_PROTOCOL,
    DEFAULT_BOTLEARN_SCOPES,
    BotlearnAuthError,
    BotlearnIdentity,
    botcord_supabase_id_for_botlearn,
    is_botlearn_origin_allowed,
    issue_botlearn_session_token,
    verify_botlearn_id_token,
    verify_botlearn_session_token,
)
from app.routers import cloud_agents as _cloud_agents_router
from hub.config import (
    BOTLEARN_INTEGRATION_ENABLED,
    BOTLEARN_WS_URL,
    HUB_PUBLIC_BASE_URL,
)
from hub.database import async_session, get_db
from hub.id_generators import generate_botlearn_installation_id
from hub.models import BotlearnInstallation, User
from hub.services.cloud_agent import (
    CloudAgentError,
    CloudAgentService,
    CreateCloudAgentInput,
    CreateRunInput,
    RunBudget,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/integrations/botlearn", tags=["botlearn-integration"])

_INACTIVE_CLOUD_AGENT_STATUSES = {"deleted", "deleting", "failed"}


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _botlearn_ws_url() -> str:
    if BOTLEARN_WS_URL:
        return BOTLEARN_WS_URL
    base = HUB_PUBLIC_BASE_URL
    if base.startswith("https://"):
        base = "wss://" + base[len("https://"):]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://"):]
    return base.rstrip("/") + "/api/integrations/botlearn/ws"


def _auth_error_to_http(exc: BotlearnAuthError) -> HTTPException:
    return HTTPException(
        status_code=exc.http_status,
        detail={"code": exc.code, "message": exc.message},
    )


# ---------------------------------------------------------------------------
# Session exchange
# ---------------------------------------------------------------------------


_BOTLEARN_SESSION_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,180}$")


class BotlearnSessionIn(BaseModel):
    session_key: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class BotlearnSessionOut(BaseModel):
    access_token: str
    expires_in: int
    agent_id: str
    installation_id: str
    ws_url: str


def _normalize_botlearn_session_key(raw: Any) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_session_key", "message": "session_key must be a string"},
        )
    value = raw.strip()
    if not value:
        return None
    if not _BOTLEARN_SESSION_KEY_RE.fullmatch(value):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_session_key",
                "message": "session_key may only contain letters, digits, '.', '_', ':', and '-'",
            },
        )
    return value


def _resolve_botlearn_session_key(payload: BotlearnSessionIn | None) -> str | None:
    if payload is None:
        return None
    explicit = _normalize_botlearn_session_key(payload.session_key)
    if explicit:
        return explicit
    course_run_id = payload.metadata.get("course_run_id") or payload.metadata.get("courseRunId")
    if course_run_id:
        return _normalize_botlearn_session_key(f"course_run:{course_run_id}")
    return None


async def _find_or_create_user(
    db: AsyncSession, identity: BotlearnIdentity
) -> User:
    """JIT-create or reattach the BotCord user behind a BotLearn identity.

    Reuses ``app.auth._load_user_and_roles`` so the email-reattach + member
    role + beta handling stays identical to the dashboard login path.
    """
    supabase_id = botcord_supabase_id_for_botlearn(identity.subject)
    jwt_payload = {
        "email": identity.email,
        "email_verified": identity.email_verified,
        "user_metadata": {
            "full_name": identity.name,
            "email_verified": identity.email_verified,
        },
        "app_metadata": {"provider": "email"} if identity.email_verified else {},
    }
    user, _roles = await _load_user_and_roles(
        str(supabase_id), db, jwt_payload=jwt_payload
    )
    return user


async def _select_default_cloud_agent(
    db: AsyncSession, service: CloudAgentService, user: User
) -> str:
    """Return the user's default Cloud Agent, creating one when needed.

    Failures (quota, feature flag, provisioning) propagate as
    ``CloudAgentError`` so the session exchange returns a 4xx/5xx and never
    hands out a usable session token.
    """
    views = await service.list_cloud_agents(db, user_id=user.id)
    active = [v for v in views if v.status not in _INACTIVE_CLOUD_AGENT_STATUSES]
    if active:
        chosen = next((v for v in active if v.status == "ready"), active[0])
        return chosen.agent_id
    view = await service.create_cloud_agent(
        db,
        user_id=user.id,
        body=CreateCloudAgentInput(name="BotLearn Agent"),
    )
    return view.agent_id


async def _upsert_installation(
    db: AsyncSession,
    *,
    user: User,
    identity: BotlearnIdentity,
    agent_id: str,
) -> BotlearnInstallation:
    existing = await db.scalar(
        select(BotlearnInstallation).where(
            BotlearnInstallation.botlearn_subject == identity.subject,
            BotlearnInstallation.agent_id == agent_id,
        )
    )
    now = _now()
    if existing is not None:
        existing.user_id = user.id
        existing.botlearn_email = identity.email
        existing.scopes_json = list(DEFAULT_BOTLEARN_SCOPES)
        existing.last_used_at = now
        return existing
    installation = BotlearnInstallation(
        id=generate_botlearn_installation_id(),
        user_id=user.id,
        botlearn_subject=identity.subject,
        botlearn_email=identity.email,
        agent_id=agent_id,
        scopes_json=list(DEFAULT_BOTLEARN_SCOPES),
        limits_json={},
        last_used_at=now,
    )
    db.add(installation)
    return installation


async def _find_revoked_installation_for_subject(
    db: AsyncSession,
    *,
    identity: BotlearnIdentity,
) -> BotlearnInstallation | None:
    return await db.scalar(
        select(BotlearnInstallation)
        .where(
            BotlearnInstallation.botlearn_subject == identity.subject,
            BotlearnInstallation.revoked_at.is_not(None),
        )
        .order_by(BotlearnInstallation.revoked_at.desc())
        .limit(1)
    )


@router.post("/session", response_model=BotlearnSessionOut)
async def create_botlearn_session(
    request: Request,
    payload: BotlearnSessionIn | None = Body(default=None),
    db: AsyncSession = Depends(get_db),
    service: CloudAgentService = Depends(
        _cloud_agents_router.get_cloud_agent_service
    ),
) -> BotlearnSessionOut:
    if not BOTLEARN_INTEGRATION_ENABLED:
        raise HTTPException(
            status_code=403,
            detail={"code": "botlearn_disabled", "message": "BotLearn integration is not enabled"},
        )

    origin = request.headers.get("origin")
    if not is_botlearn_origin_allowed(origin):
        raise HTTPException(
            status_code=403,
            detail={"code": "origin_not_allowed", "message": "Origin not allowed"},
        )

    authorization = request.headers.get("authorization")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail={"code": "unauthorized", "message": "Missing BotLearn token"},
        )

    try:
        identity = verify_botlearn_id_token(authorization[len("Bearer "):])
    except BotlearnAuthError as exc:
        raise _auth_error_to_http(exc) from exc

    revoked_installation = await _find_revoked_installation_for_subject(
        db, identity=identity
    )
    if revoked_installation is not None:
        await db.rollback()
        raise HTTPException(
            status_code=403,
            detail={"code": "installation_revoked", "message": "BotLearn installation is revoked"},
        )

    user = await _find_or_create_user(db, identity)

    # Default Cloud Agent (create on first use). Quota / feature failures must
    # abort before any token is issued.
    try:
        agent_id = await _select_default_cloud_agent(db, service, user)
    except CloudAgentError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=exc.http_status,
            detail={"code": exc.code, "message": exc.message},
        ) from exc

    installation = await _upsert_installation(
        db, user=user, identity=identity, agent_id=agent_id
    )
    if installation.revoked_at is not None:
        await db.rollback()
        raise HTTPException(
            status_code=403,
            detail={"code": "installation_revoked", "message": "BotLearn installation is revoked"},
        )
    await db.commit()

    session_key = _resolve_botlearn_session_key(payload)
    access_token, expires_in = issue_botlearn_session_token(
        user_id=user.id,
        botlearn_subject=identity.subject,
        agent_id=agent_id,
        installation_id=installation.id,
        scopes=list(installation.scopes_json or DEFAULT_BOTLEARN_SCOPES),
        session_key=session_key,
    )
    return BotlearnSessionOut(
        access_token=access_token,
        expires_in=expires_in,
        agent_id=agent_id,
        installation_id=installation.id,
        ws_url=_botlearn_ws_url(),
    )


# ---------------------------------------------------------------------------
# App-facing WebSocket — botcord-agent-session/0.1
# ---------------------------------------------------------------------------


_WS_HEARTBEAT_INTERVAL = 30  # seconds
_WS_AUTH_TIMEOUT = 10  # seconds


async def _installation_is_active(installation_id: str) -> BotlearnInstallation | None:
    """Re-read the installation and return it only if still authorized."""
    async with async_session() as db:
        inst = await db.scalar(
            select(BotlearnInstallation).where(
                BotlearnInstallation.id == installation_id
            )
        )
        if inst is None or inst.revoked_at is not None:
            return None
        return inst


def _res(req_id, *, ok: bool, result=None, code: str | None = None, message: str | None = None) -> dict:
    frame: dict = {"type": "res", "id": req_id, "ok": ok}
    if ok:
        frame["result"] = result or {}
    else:
        frame["error"] = {"code": code or "error", "message": message or ""}
    return frame


async def _dispatch_method(
    *,
    service: CloudAgentService,
    method: str,
    params: dict,
    user_id: _uuid.UUID,
    agent_id: str,
) -> dict:
    """Run one Cloud Run public-subset method against a fresh DB session.

    Returns the ``result`` payload. Raises ``CloudAgentError`` on a handled
    service-level failure (mapped to a ``res ok=false`` by the caller).
    """
    async with async_session() as db:
        if method == "cloud_agent.get":
            view = await service.get_cloud_agent(db, user_id=user_id, agent_id=agent_id)
            return {
                "agent_id": view.agent_id,
                "name": view.name,
                "status": view.status,
                "runtime": view.runtime,
                "model_profile": view.model_profile,
            }
        if method == "cloud_run.create":
            budget_in = params.get("budget") or {}
            budget = None
            if budget_in:
                budget = RunBudget(
                    max_wall_time_seconds=int(
                        budget_in.get("max_wall_time_seconds", 600)
                    ),
                    max_tool_calls=int(budget_in.get("max_tool_calls", 30)),
                )
            view = await service.create_run(
                db,
                user_id=user_id,
                agent_id=agent_id,
                body=CreateRunInput(
                    prompt=str(params.get("prompt", "")),
                    room_id=params.get("room_id"),
                    topic=params.get("topic"),
                    budget=budget,
                ),
            )
            return {
                "run_id": view.run_id,
                "agent_id": view.agent_id,
                "room_id": view.room_id,
                "status": view.status,
                "budget": {
                    "max_wall_time_seconds": view.budget.max_wall_time_seconds,
                    "max_tool_calls": view.budget.max_tool_calls,
                },
            }
        if method == "cloud_run.get":
            run_id = str(params.get("run_id", ""))
            view = await service.get_run(
                db, user_id=user_id, agent_id=agent_id, run_id=run_id
            )
            return _run_status_payload(view)
        if method == "cloud_run.cancel":
            run_id = str(params.get("run_id", ""))
            view = await service.cancel_run(
                db, user_id=user_id, agent_id=agent_id, run_id=run_id
            )
            return _run_status_payload(view)
        if method == "cloud_usage.get":
            view = await service.get_usage(db, user_id=user_id, agent_id=agent_id)
            return {
                "agent_id": view.agent_id,
                "included_credits": view.included_credits,
                "used_credits": view.used_credits,
                "reserved_credits": view.reserved_credits,
                "available_credits": view.available_credits,
                "included_sandbox_seconds": view.included_sandbox_seconds,
                "used_sandbox_seconds": view.used_sandbox_seconds,
                "available_sandbox_seconds": view.available_sandbox_seconds,
            }
        raise CloudAgentError("method_not_allowed", f"unknown method {method!r}", http_status=400)


def _run_status_payload(view) -> dict:
    return {
        "run_id": view.run_id,
        "agent_id": view.agent_id,
        "status": view.status,
        "reserved_credits": view.reserved_credits,
        "reserved_sandbox_seconds": view.reserved_sandbox_seconds,
        "credits_charged": view.credits_charged,
    }


@router.websocket("/ws")
async def botlearn_ws(ws: WebSocket):
    """``botcord-agent-session/0.1`` — Cloud Run public subset for BotLearn.

    The session token rides in the first ``hello`` frame (browser WebSocket
    clients cannot set an Authorization header). Origin allowlist is enforced
    before the upgrade.
    """
    origin = ws.headers.get("origin")
    if not BOTLEARN_INTEGRATION_ENABLED or not is_botlearn_origin_allowed(origin):
        await ws.close(code=4003, reason="Origin not allowed")
        return

    await ws.accept()

    # --- hello / auth ---
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=_WS_AUTH_TIMEOUT)
    except (asyncio.TimeoutError, Exception):
        await ws.close(code=4001, reason="Auth timeout")
        return

    if not isinstance(hello, dict) or hello.get("type") != "hello":
        await ws.close(code=4001, reason="Expected hello")
        return

    token = hello.get("token") or ""
    if not token:
        await ws.close(code=4001, reason="Missing token")
        return

    try:
        claims = verify_botlearn_session_token(token)
    except BotlearnAuthError:
        await ws.close(code=4001, reason="Invalid session token")
        return

    installation_id = claims["installation_id"]
    inst = await _installation_is_active(installation_id)
    if inst is None:
        await ws.close(code=4001, reason="Installation revoked")
        return

    try:
        user_id = _uuid.UUID(str(claims["user_id"]))
    except ValueError:
        await ws.close(code=4001, reason="Invalid session token")
        return
    agent_id = str(claims["agent_id"])
    scopes = set(claims.get("scopes") or [])

    await ws.send_json(
        {
            "type": "hello_ok",
            "protocol": BOTLEARN_WS_PROTOCOL,
            "agent_id": agent_id,
            "scopes": sorted(scopes),
        }
    )
    logger.info(
        "BotLearn WS connected: installation=%s user=%s agent=%s",
        installation_id,
        user_id,
        agent_id,
    )

    service = _cloud_agents_router.get_cloud_agent_service()

    # --- request loop ---
    try:
        while True:
            try:
                msg = await asyncio.wait_for(
                    ws.receive_json(), timeout=_WS_HEARTBEAT_INTERVAL
                )
            except asyncio.TimeoutError:
                await ws.send_json({"type": "event", "event": "heartbeat"})
                continue

            if not isinstance(msg, dict):
                continue
            msg_type = msg.get("type")

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})
                continue
            if msg_type != "req":
                continue

            req_id = msg.get("id")
            method = msg.get("method")
            params = msg.get("params") or {}
            if not isinstance(params, dict):
                params = {}

            required_scope = BOTLEARN_METHOD_REQUIRED_SCOPE.get(method)
            if required_scope is None:
                await ws.send_json(
                    _res(req_id, ok=False, code="method_not_allowed", message=f"method {method!r} not allowed")
                )
                continue
            if required_scope not in scopes:
                await ws.send_json(
                    _res(req_id, ok=False, code="insufficient_scope", message=f"missing scope {required_scope}")
                )
                continue

            # Re-check revocation on every privileged call so a revoke takes
            # effect mid-session, not just at connect.
            if await _installation_is_active(installation_id) is None:
                await ws.send_json(
                    _res(req_id, ok=False, code="installation_revoked", message="installation revoked")
                )
                await ws.close(code=4001, reason="Installation revoked")
                return

            try:
                result = await _dispatch_method(
                    service=service,
                    method=method,
                    params=params,
                    user_id=user_id,
                    agent_id=agent_id,
                )
            except CloudAgentError as exc:
                await ws.send_json(
                    _res(req_id, ok=False, code=exc.code, message=exc.message)
                )
                continue
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "BotLearn WS method failed: method=%s err=%s", method, exc
                )
                await ws.send_json(
                    _res(req_id, ok=False, code="internal_error", message="internal error")
                )
                continue

            await ws.send_json(_res(req_id, ok=True, result=result))

            # Surface a coarse lifecycle event for run creation so the
            # frontend can show "started" without polling immediately. Live
            # output deltas are retrieved via cloud_run.get (no daemon stream
            # bridge in this PR).
            if method == "cloud_run.create":
                await ws.send_json(
                    {
                        "type": "event",
                        "event": "run.started",
                        "run_id": result.get("run_id"),
                    }
                )
    except Exception as exc:  # noqa: BLE001 — WebSocketDisconnect & friends
        logger.info(
            "BotLearn WS closed: installation=%s err=%s", installation_id, exc
        )
