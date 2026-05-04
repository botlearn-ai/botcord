"""Daemon control-plane HTTP + WebSocket endpoints.

Implements the `/daemon/*` surface:

- Auth: device-code flow + paste-token fallback + refresh
- Instance management: list / revoke / dispatch
- Control WS: signed Hub→daemon frames + daemon→Hub events

Conventions (match existing Hub routers):

- All handlers are ``async def``.
- DB sessions come from ``hub.database.get_db``.
- Supabase user JWT auth reuses ``app.auth.require_user``.
"""

from __future__ import annotations

import asyncio
import base64
import datetime
import hashlib
import json
import logging
import secrets
import uuid as _uuid
from dataclasses import dataclass
from urllib.parse import quote
from typing import Any

import jcs
import jwt as pyjwt
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from nacl.signing import SigningKey
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.config import (
    DAEMON_ACCESS_TOKEN_EXPIRE_SECONDS,
    DAEMON_DEVICE_CODE_INTERVAL_SECONDS,
    DAEMON_DEVICE_CODE_TTL_SECONDS,
    DAEMON_INSTALL_TICKET_TTL_SECONDS,
    DAEMON_DISPATCH_DEFAULT_TIMEOUT_MS,
    DAEMON_DISPATCH_MAX_TIMEOUT_MS,
    DAEMON_HUB_CONTROL_PRIVATE_KEY_B64,
    FRONTEND_BASE_URL,
    HUB_PUBLIC_BASE_URL,
    JWT_ALGORITHM,
    JWT_SECRET,
)
from hub.database import async_session, get_db
from hub.id_generators import (
    generate_daemon_device_code,
    generate_daemon_install_ticket_id,
    generate_daemon_install_token,
    generate_daemon_instance_id,
    generate_daemon_user_code,
)
from hub.models import (
    Agent,
    DaemonAgentCleanup,
    DaemonDeviceCode,
    DaemonInstallTicket,
    DaemonInstance,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["daemon-control"])


# ---------------------------------------------------------------------------
# Hub control-plane signing key (Ed25519)
# ---------------------------------------------------------------------------


def _load_hub_signing_key() -> SigningKey:
    seed = base64.b64decode(DAEMON_HUB_CONTROL_PRIVATE_KEY_B64)
    if len(seed) != 32:
        raise RuntimeError(
            "BOTCORD_HUB_CONTROL_PRIVATE_KEY must be a base64-encoded "
            "32-byte Ed25519 seed"
        )
    return SigningKey(seed)


_HUB_SIGNING_KEY: SigningKey = _load_hub_signing_key()
HUB_CONTROL_PUBLIC_KEY_B64: str = base64.b64encode(
    bytes(_HUB_SIGNING_KEY.verify_key)
).decode()


def _sign_frame(frame: dict[str, Any]) -> str:
    """Return base64 Ed25519 signature over the canonical JSON of the frame."""
    canonical = jcs.canonicalize(
        {
            "id": frame["id"],
            "type": frame["type"],
            "params": frame.get("params") or {},
            "ts": frame["ts"],
        }
    )
    sig_bytes = _HUB_SIGNING_KEY.sign(canonical).signature
    return base64.b64encode(sig_bytes).decode()


def _build_signed_frame(type_: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    frame: dict[str, Any] = {
        "id": str(_uuid.uuid4()),
        "type": type_,
        "params": params or {},
        "ts": int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000),
    }
    frame["sig"] = _sign_frame(frame)
    return frame


# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _aware(dt: datetime.datetime | None) -> datetime.datetime | None:
    """SQLite drops tzinfo on round-trip — coerce to UTC for comparisons."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def _hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _hash_install_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generate_refresh_token() -> str:
    return "drt_" + secrets.token_urlsafe(48)


def _create_daemon_access_token(daemon_instance_id: str, user_id: str) -> tuple[str, int]:
    expires_at = _now() + datetime.timedelta(
        seconds=DAEMON_ACCESS_TOKEN_EXPIRE_SECONDS
    )
    payload = {
        "sub": daemon_instance_id,
        "user_id": str(user_id),
        "daemon_instance_id": daemon_instance_id,
        "kind": "daemon-access",
        "exp": expires_at,
        "iss": "botcord-daemon",
    }
    token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token, DAEMON_ACCESS_TOKEN_EXPIRE_SECONDS


def _verify_daemon_access_token(token: str) -> dict[str, Any]:
    """Return JWT claims; raise ``HTTPException(401)`` on any failure."""
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("kind") != "daemon-access":
        raise HTTPException(status_code=401, detail="Invalid token kind")
    if payload.get("iss") != "botcord-daemon":
        raise HTTPException(status_code=401, detail="Invalid token issuer")
    if not payload.get("daemon_instance_id"):
        raise HTTPException(status_code=401, detail="Missing daemon_instance_id claim")
    return payload


def _build_token_bundle(
    user_id: str,
    daemon_instance_id: str,
) -> tuple[dict[str, Any], str]:
    """Issue (access, refresh) for the given instance.

    Returns the JSON bundle that ``/device-token``-style endpoints emit and
    the raw refresh token (caller stores its hash).
    """
    access_token, expires_in = _create_daemon_access_token(daemon_instance_id, user_id)
    refresh_token = _generate_refresh_token()
    bundle = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": expires_in,
        "user_id": str(user_id),
        "daemon_instance_id": daemon_instance_id,
        "hub_url": HUB_PUBLIC_BASE_URL,
    }
    return bundle, refresh_token


# ---------------------------------------------------------------------------
# In-memory daemon WS registry (one connection per instance)
# ---------------------------------------------------------------------------


@dataclass
class _DaemonConn:
    ws: WebSocket
    user_id: str
    daemon_instance_id: str
    pending_acks: dict[str, asyncio.Future]


class _DaemonRegistry:
    """Process-local registry of currently-connected daemon control WSes.

    A second connection for the same ``daemon_instance_id`` displaces the
    first (close code 4001) — the daemon is expected to maintain a single
    socket. For multi-process deployments this map needs to move to Redis;
    documented as a follow-up.
    """

    def __init__(self) -> None:
        self._by_instance: dict[str, _DaemonConn] = {}
        self._lock = asyncio.Lock()

    async def register(self, conn: _DaemonConn) -> _DaemonConn | None:
        """Register, returning the previous connection if any (for displacement)."""
        async with self._lock:
            previous = self._by_instance.get(conn.daemon_instance_id)
            self._by_instance[conn.daemon_instance_id] = conn
            return previous

    async def unregister(self, conn: _DaemonConn) -> None:
        async with self._lock:
            current = self._by_instance.get(conn.daemon_instance_id)
            if current is conn:
                self._by_instance.pop(conn.daemon_instance_id, None)

    def get(self, daemon_instance_id: str) -> _DaemonConn | None:
        return self._by_instance.get(daemon_instance_id)

    def is_online(self, daemon_instance_id: str) -> bool:
        return daemon_instance_id in self._by_instance


_REGISTRY = _DaemonRegistry()
_BACKGROUND_CLEANUPS: set[asyncio.Task] = set()


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------


class _InstallTicketRequest(BaseModel):
    label: str | None = Field(default=None, max_length=64)


class _InstallTicketResponse(BaseModel):
    install_token: str
    expires_in: int
    expires_at: datetime.datetime


@router.post("/daemon/auth/install-ticket", response_model=_InstallTicketResponse)
async def issue_install_ticket(
    body: _InstallTicketRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> _InstallTicketResponse:
    install_token = generate_daemon_install_token()
    expires_at = _now() + datetime.timedelta(seconds=DAEMON_INSTALL_TICKET_TTL_SECONDS)
    label = (
        body.label.strip()
        if isinstance(body.label, str) and body.label.strip()
        else None
    )
    row = DaemonInstallTicket(
        id=generate_daemon_install_ticket_id(),
        user_id=ctx.user_id,
        token_hash=_hash_install_token(install_token),
        label=label,
        expires_at=expires_at,
    )
    db.add(row)
    await db.commit()
    return _InstallTicketResponse(
        install_token=install_token,
        expires_in=DAEMON_INSTALL_TICKET_TTL_SECONDS,
        expires_at=expires_at,
    )


class _InstallTokenRequest(BaseModel):
    install_token: str = Field(..., min_length=8, max_length=128)
    label: str | None = Field(default=None, max_length=64)


@router.post("/daemon/auth/install-token")
async def redeem_install_token(
    body: _InstallTokenRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    token_hash = _hash_install_token(body.install_token)
    result = await db.execute(
        select(DaemonInstallTicket).where(DaemonInstallTicket.token_hash == token_hash)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=401, detail="invalid_install_token")
    if _aware(row.expires_at) <= _now():
        raise HTTPException(status_code=410, detail="install_token_expired")
    if row.consumed_at is not None:
        raise HTTPException(status_code=400, detail="install_token_consumed")

    label = (
        body.label.strip()
        if isinstance(body.label, str) and body.label.strip()
        else row.label
    )
    daemon_instance_id, refresh_token = await _provision_daemon_instance(
        db, row.user_id, label
    )
    bundle, _ = _build_token_bundle(str(row.user_id), daemon_instance_id)
    bundle["refresh_token"] = refresh_token

    row.consumed_at = _now()
    row.daemon_instance_id = daemon_instance_id
    await db.commit()
    return bundle


class _DeviceCodeResponse(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int


@router.post("/daemon/auth/device-code", response_model=_DeviceCodeResponse)
async def issue_device_code(db: AsyncSession = Depends(get_db)) -> _DeviceCodeResponse:
    device_code = generate_daemon_device_code()
    # Retry on user-code collision (extremely unlikely with 32^8 alphabet).
    for _ in range(5):
        user_code = generate_daemon_user_code()
        existing = await db.execute(
            select(DaemonDeviceCode).where(
                DaemonDeviceCode.user_code == user_code,
                DaemonDeviceCode.status == "pending",
            )
        )
        if existing.scalar_one_or_none() is None:
            break
    expires_at = _now() + datetime.timedelta(seconds=DAEMON_DEVICE_CODE_TTL_SECONDS)
    row = DaemonDeviceCode(
        device_code=device_code,
        user_code=user_code,
        expires_at=expires_at,
        status="pending",
    )
    db.add(row)
    await db.commit()

    verification_uri = f"{FRONTEND_BASE_URL.rstrip('/')}/activate"
    verification_uri_complete = f"{verification_uri}?code={quote(user_code, safe='')}"
    return _DeviceCodeResponse(
        device_code=device_code,
        user_code=user_code,
        verification_uri=verification_uri,
        verification_uri_complete=verification_uri_complete,
        expires_in=DAEMON_DEVICE_CODE_TTL_SECONDS,
        interval=DAEMON_DEVICE_CODE_INTERVAL_SECONDS,
    )


class _DeviceTokenRequest(BaseModel):
    device_code: str = Field(..., min_length=8, max_length=64)


@router.post("/daemon/auth/device-token")
async def poll_device_token(
    body: _DeviceTokenRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    result = await db.execute(
        select(DaemonDeviceCode).where(DaemonDeviceCode.device_code == body.device_code)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=400, detail="invalid_device_code")
    if _aware(row.expires_at) <= _now():
        raise HTTPException(status_code=410, detail="device_code_expired")
    if row.status == "denied":
        raise HTTPException(status_code=403, detail="device_code_denied")
    if row.status == "consumed":
        raise HTTPException(status_code=400, detail="device_code_already_consumed")
    if row.status == "pending":
        return {"status": "pending"}
    if row.status == "approved" and row.issued_token_json:
        bundle = json.loads(row.issued_token_json)
        row.status = "consumed"
        row.consumed_at = _now()
        row.issued_token_json = None
        await db.commit()
        return bundle
    # Unknown state.
    raise HTTPException(status_code=500, detail="device_code_invalid_state")


class _DeviceApproveRequest(BaseModel):
    user_code: str = Field(..., min_length=4, max_length=16)
    label: str | None = Field(default=None, max_length=64)


@router.post("/daemon/auth/device-approve")
async def approve_device_code(
    body: _DeviceApproveRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    normalized = body.user_code.strip().upper()
    result = await db.execute(
        select(DaemonDeviceCode).where(DaemonDeviceCode.user_code == normalized)
    )
    row = result.scalar_one_or_none()
    if row is None or row.status != "pending":
        raise HTTPException(status_code=400, detail="invalid_user_code")
    if _aware(row.expires_at) <= _now():
        raise HTTPException(status_code=410, detail="device_code_expired")

    daemon_instance_id, refresh_token = await _provision_daemon_instance(
        db, ctx.user_id, body.label
    )
    bundle, _ = _build_token_bundle(str(ctx.user_id), daemon_instance_id)
    # Replace refresh in the issued bundle with the one we already saved.
    bundle["refresh_token"] = refresh_token

    row.user_id = ctx.user_id
    row.daemon_instance_id = daemon_instance_id
    row.label = body.label
    row.approved_at = _now()
    row.status = "approved"
    row.issued_token_json = json.dumps(bundle)
    await db.commit()

    return {
        "ok": True,
        "daemon_instance_id": daemon_instance_id,
        "user_id": str(ctx.user_id),
    }


async def _provision_daemon_instance(
    db: AsyncSession,
    user_id: _uuid.UUID,
    label: str | None,
) -> tuple[str, str]:
    """Create a fresh ``daemon_instances`` row and return (id, raw refresh token)."""
    daemon_instance_id = generate_daemon_instance_id()
    refresh_token = _generate_refresh_token()
    instance = DaemonInstance(
        id=daemon_instance_id,
        user_id=user_id,
        label=label,
        refresh_token_hash=_hash_refresh_token(refresh_token),
    )
    db.add(instance)
    await db.flush()
    return daemon_instance_id, refresh_token


class _RefreshRequest(BaseModel):
    refresh_token: str = Field(..., min_length=8, max_length=256)


@router.post("/daemon/auth/refresh")
async def refresh_daemon_token(
    body: _RefreshRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    refresh_hash = _hash_refresh_token(body.refresh_token)
    result = await db.execute(
        select(DaemonInstance).where(DaemonInstance.refresh_token_hash == refresh_hash)
    )
    instance = result.scalar_one_or_none()
    if instance is None:
        raise HTTPException(status_code=401, detail="invalid_refresh_token")
    if instance.revoked_at is not None:
        raise HTTPException(status_code=401, detail="daemon_revoked")

    bundle, new_refresh = _build_token_bundle(str(instance.user_id), instance.id)
    instance.refresh_token_hash = _hash_refresh_token(new_refresh)
    instance.last_seen_at = _now()
    bundle["refresh_token"] = new_refresh
    await db.commit()
    return bundle


# ---------------------------------------------------------------------------
# Instance management
# ---------------------------------------------------------------------------


class _InstanceView(BaseModel):
    id: str
    label: str | None = None
    created_at: datetime.datetime
    last_seen_at: datetime.datetime | None = None
    revoked_at: datetime.datetime | None = None
    removal_requested_at: datetime.datetime | None = None
    cleanup_completed_at: datetime.datetime | None = None
    status: str
    online: bool
    runtimes: list[dict[str, Any]] | None = None
    runtimes_probed_at: datetime.datetime | None = None


def _instance_status(instance: DaemonInstance) -> str:
    if instance.revoked_at is not None:
        return "revoked"
    if instance.removal_requested_at is not None:
        return "removal_pending"
    return "active"


def _instance_to_view(instance: DaemonInstance) -> _InstanceView:
    return _InstanceView(
        id=instance.id,
        label=instance.label,
        created_at=instance.created_at,
        last_seen_at=instance.last_seen_at,
        revoked_at=instance.revoked_at,
        removal_requested_at=instance.removal_requested_at,
        cleanup_completed_at=instance.cleanup_completed_at,
        status=_instance_status(instance),
        online=_REGISTRY.is_online(instance.id),
        runtimes=instance.runtimes_json if instance.runtimes_json else None,
        runtimes_probed_at=instance.runtimes_probed_at,
    )


class _InstancesResponse(BaseModel):
    instances: list[_InstanceView]


@router.get("/daemon/instances", response_model=_InstancesResponse)
async def list_instances(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> _InstancesResponse:
    result = await db.execute(
        select(DaemonInstance)
        .where(DaemonInstance.user_id == ctx.user_id)
        .order_by(DaemonInstance.created_at.desc())
    )
    rows = result.scalars().all()
    return _InstancesResponse(instances=[_instance_to_view(row) for row in rows])


async def _load_owned_instance(
    db: AsyncSession,
    user_id: _uuid.UUID,
    daemon_instance_id: str,
) -> DaemonInstance:
    result = await db.execute(
        select(DaemonInstance).where(DaemonInstance.id == daemon_instance_id)
    )
    instance = result.scalar_one_or_none()
    if instance is None or str(instance.user_id) != str(user_id):
        raise HTTPException(status_code=404, detail="daemon_instance_not_found")
    return instance


class _RenameInstanceRequest(BaseModel):
    label: str | None = Field(default=None, max_length=64)


@router.patch("/daemon/instances/{daemon_instance_id}", response_model=_InstanceView)
async def rename_instance(
    daemon_instance_id: str,
    body: _RenameInstanceRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> _InstanceView:
    instance = await _load_owned_instance(db, ctx.user_id, daemon_instance_id)
    new_label = body.label.strip() if isinstance(body.label, str) else None
    instance.label = new_label or None
    await db.commit()
    await db.refresh(instance)
    return _instance_to_view(instance)


def _mark_instance_revoked(instance: DaemonInstance) -> None:
    """Mutate ``instance`` to a terminal revoked state. Caller commits."""
    if instance.revoked_at is None:
        instance.revoked_at = _now()
    # Burn the refresh hash so /refresh can never re-issue.
    instance.refresh_token_hash = "revoked:" + secrets.token_hex(8)


async def _push_daemon_revoke(daemon_instance_id: str, reason: str) -> bool:
    """Send the daemon-level ``revoke`` frame and close the socket. Returns
    True when a live websocket existed, False otherwise."""
    conn = _REGISTRY.get(daemon_instance_id)
    if conn is None:
        return False
    try:
        frame = _build_signed_frame("revoke", {"reason": reason})
        await conn.ws.send_text(json.dumps(frame))
    except Exception as exc:  # noqa: BLE001
        logger.warning("revoke push failed: %s", exc)
    try:
        await conn.ws.close(code=4403, reason="daemon revoked")
    except Exception:
        pass
    await _REGISTRY.unregister(conn)
    return True


@router.post("/daemon/instances/{daemon_instance_id}/revoke")
async def revoke_instance(
    daemon_instance_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    instance = await _load_owned_instance(db, ctx.user_id, daemon_instance_id)
    if instance.revoked_at is None:
        _mark_instance_revoked(instance)
        await db.commit()

    was_online = await _push_daemon_revoke(daemon_instance_id, "revoked_by_user")
    return {"ok": True, "was_online": was_online}


# ---------------------------------------------------------------------------
# Device removal — detach hosted bots, drain local cleanup, then revoke.
# ---------------------------------------------------------------------------


class _RemoveInstanceRequest(BaseModel):
    forget_if_offline: bool = False
    reason: str | None = Field(default=None, max_length=200)


class _RemovedAgentView(BaseModel):
    agent_id: str
    display_name: str | None = None


class _RemoveInstanceResponse(BaseModel):
    ok: bool
    daemon_instance_id: str
    status: str
    was_online: bool
    detached_agents: list[_RemovedAgentView]
    cleanup_jobs_queued: int


async def _detach_hosted_agents(
    db: AsyncSession,
    *,
    daemon_instance_id: str,
    user_id: _uuid.UUID,
) -> tuple[list[Agent], int]:
    """Detach all active user-owned agents from ``daemon_instance_id`` and
    insert one pending ``DaemonAgentCleanup`` per agent (skipping any agent
    that already has a pending cleanup row for this daemon)."""
    result = await db.execute(
        select(Agent).where(
            Agent.user_id == user_id,
            Agent.daemon_instance_id == daemon_instance_id,
            Agent.status == "active",
        )
    )
    agents = list(result.scalars().all())
    if not agents:
        return [], 0

    existing = await db.execute(
        select(DaemonAgentCleanup.agent_id).where(
            DaemonAgentCleanup.daemon_instance_id == daemon_instance_id,
            DaemonAgentCleanup.status == "pending",
            DaemonAgentCleanup.agent_id.in_([a.agent_id for a in agents]),
        )
    )
    pending_agent_ids = {row for row in existing.scalars().all()}

    await db.execute(
        update(Agent)
        .where(Agent.agent_id.in_([a.agent_id for a in agents]))
        .values(daemon_instance_id=None)
    )
    queued = 0
    for agent in agents:
        # Keep ORM state coherent with the bulk UPDATE so callers reading
        # ``agent.daemon_instance_id`` see ``None`` without an extra refresh.
        agent.daemon_instance_id = None
        if agent.agent_id not in pending_agent_ids:
            db.add(
                DaemonAgentCleanup(
                    daemon_instance_id=daemon_instance_id,
                    agent_id=agent.agent_id,
                    delete_credentials=True,
                    delete_state=True,
                    delete_workspace=False,
                )
            )
            queued += 1
    return agents, queued


@router.post(
    "/daemon/instances/{daemon_instance_id}/remove",
    response_model=_RemoveInstanceResponse,
)
async def remove_instance(
    daemon_instance_id: str,
    body: _RemoveInstanceRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> _RemoveInstanceResponse:
    """Remove a device: detach hosted bots, queue local cleanup, optionally
    revoke immediately when offline-forget is requested."""
    instance = await _load_owned_instance(db, ctx.user_id, daemon_instance_id)
    if instance.revoked_at is not None:
        # Already terminal — surface idempotent success.
        return _RemoveInstanceResponse(
            ok=True,
            daemon_instance_id=instance.id,
            status="revoked",
            was_online=False,
            detached_agents=[],
            cleanup_jobs_queued=0,
        )

    online = _REGISTRY.is_online(daemon_instance_id)
    detached, queued = await _detach_hosted_agents(
        db, daemon_instance_id=daemon_instance_id, user_id=ctx.user_id
    )

    if instance.removal_requested_at is None:
        instance.removal_requested_at = _now()
    if body.reason:
        instance.removal_reason = body.reason

    forget = bool(body.forget_if_offline) and not online

    if forget:
        # Cancel any pending cleanup rows — they cannot ever drain.
        pending_rows = (
            await db.execute(
                select(DaemonAgentCleanup).where(
                    DaemonAgentCleanup.daemon_instance_id == daemon_instance_id,
                    DaemonAgentCleanup.status == "pending",
                )
            )
        ).scalars().all()
        now = _now()
        for row in pending_rows:
            row.status = "cancelled"
            row.completed_at = now
            row.last_error = "device forgotten before local cleanup"
        instance.cleanup_completed_at = now
        _mark_instance_revoked(instance)

    await db.commit()
    await db.refresh(instance)

    if forget:
        await _push_daemon_revoke(daemon_instance_id, "removed_by_user")
    elif online:
        # Drain pending cleanup jobs immediately. If the drain finishes them
        # all, the worker will finalize revoke at the tail.
        schedule_pending_daemon_cleanups(daemon_instance_id)

    return _RemoveInstanceResponse(
        ok=True,
        daemon_instance_id=instance.id,
        status=_instance_status(instance),
        was_online=online,
        detached_agents=[
            _RemovedAgentView(agent_id=a.agent_id, display_name=a.display_name)
            for a in detached
        ],
        cleanup_jobs_queued=queued,
    )


_ALLOWED_DISPATCH_TYPES = {
    "provision_agent",
    "revoke_agent",
    "reload_config",
    "list_agents",
    "list_agent_files",
    "set_route",
    "ping",
    "list_runtimes",
    # PR3: BFF fans this out from PATCH /api/agents/{id}/policy and the
    # per-room override endpoints (the latter ship in PR2). Daemon handler
    # invalidates `policyResolver` cache for the (agent, room?) pair.
    "policy_updated",
}


class _DispatchRequest(BaseModel):
    type: str
    params: dict[str, Any] | None = None
    timeout_ms: int | None = Field(default=None, ge=100, le=DAEMON_DISPATCH_MAX_TIMEOUT_MS)


async def send_control_frame(
    daemon_instance_id: str,
    type_: str,
    params: dict[str, Any] | None = None,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    """Dispatch a signed control frame to ``daemon_instance_id`` and await ack.

    Raises the same ``HTTPException`` codes as ``/dispatch`` so BFF callers
    can surface a consistent contract (409 ``daemon_offline``, 502 send
    failure, 504 ack timeout). The caller is responsible for validating
    user ownership and instance state.
    """
    conn = _REGISTRY.get(daemon_instance_id)
    if conn is None:
        raise HTTPException(status_code=409, detail="daemon_offline")

    frame = _build_signed_frame(type_, params or {})
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    conn.pending_acks[frame["id"]] = fut

    timeout = timeout_ms or DAEMON_DISPATCH_DEFAULT_TIMEOUT_MS
    try:
        await conn.ws.send_text(json.dumps(frame))
    except Exception as exc:  # noqa: BLE001
        conn.pending_acks.pop(frame["id"], None)
        raise HTTPException(status_code=502, detail=f"daemon_send_failed: {exc}")

    try:
        ack = await asyncio.wait_for(fut, timeout=timeout / 1000)
    except asyncio.TimeoutError:
        conn.pending_acks.pop(frame["id"], None)
        raise HTTPException(status_code=504, detail="daemon_ack_timeout")
    except RuntimeError as exc:
        conn.pending_acks.pop(frame["id"], None)
        raise HTTPException(
            status_code=502,
            detail={"code": "daemon_disconnected", "daemon_message": str(exc)},
        )
    return ack


def is_daemon_online(daemon_instance_id: str) -> bool:
    """Expose registry online state to BFF callers."""
    return _REGISTRY.is_online(daemon_instance_id)


def _cleanup_error_message(ack: dict[str, Any]) -> str:
    err = ack.get("error")
    if isinstance(err, dict):
        message = err.get("message") or err.get("code")
        if isinstance(message, str) and message:
            return message[:1000]
    return "daemon cleanup failed"


async def _cleanup_still_applies(
    db: AsyncSession,
    cleanup: DaemonAgentCleanup,
) -> bool:
    """A pending cleanup is still applicable as long as the agent is no
    longer bound to *this specific daemon*. Covers both:

    - **Unbind**: agent fully released (``user_id is None``,
      ``daemon_instance_id is None``).
    - **Device removal**: agent retains cloud ownership but was detached
      from this daemon (``user_id`` set, ``daemon_instance_id`` is None or
      points elsewhere).

    Only when the agent re-bound to *this same daemon* before we drained do
    we cancel the cleanup (sending ``revoke_agent`` would wipe live creds).
    """
    agent = await db.scalar(select(Agent).where(Agent.agent_id == cleanup.agent_id))
    if agent is None:
        return True
    return agent.daemon_instance_id != cleanup.daemon_instance_id


async def _finalize_removal_if_drained(daemon_instance_id: str) -> bool:
    """If the daemon is in pending-removal and no pending cleanup jobs remain,
    stamp ``cleanup_completed_at`` + ``revoked_at``, burn the refresh hash,
    and push a ``revoke`` frame. Returns True when finalization happened."""
    async with async_session() as db:
        instance = await db.get(DaemonInstance, daemon_instance_id)
        if instance is None:
            return False
        if instance.removal_requested_at is None or instance.revoked_at is not None:
            return False
        count = await db.scalar(
            select(func.count(DaemonAgentCleanup.id)).where(
                DaemonAgentCleanup.daemon_instance_id == daemon_instance_id,
                DaemonAgentCleanup.status == "pending",
            )
        )
        if count and count > 0:
            return False
        instance.cleanup_completed_at = _now()
        _mark_instance_revoked(instance)
        await db.commit()

    await _push_daemon_revoke(daemon_instance_id, "cleanup_completed")
    return True


async def process_pending_daemon_cleanups(daemon_instance_id: str) -> None:
    """Best-effort drain of pending local cleanup jobs for one daemon."""
    async with async_session() as db:
        rows = (
            await db.execute(
                select(DaemonAgentCleanup)
                .where(
                    DaemonAgentCleanup.daemon_instance_id == daemon_instance_id,
                    DaemonAgentCleanup.status == "pending",
                )
                .order_by(DaemonAgentCleanup.created_at, DaemonAgentCleanup.id)
                .limit(50)
            )
        ).scalars().all()

    for row in rows:
        async with async_session() as db:
            current = await db.get(DaemonAgentCleanup, row.id)
            if current is None or current.status != "pending":
                continue
            if not await _cleanup_still_applies(db, current):
                current.status = "cancelled"
                current.completed_at = _now()
                current.last_error = "agent rebound before cleanup"
                await db.commit()
                continue

        try:
            ack = await send_control_frame(
                daemon_instance_id,
                "revoke_agent",
                {
                    "agentId": row.agent_id,
                    "deleteCredentials": row.delete_credentials,
                    "deleteState": row.delete_state,
                    "deleteWorkspace": row.delete_workspace,
                },
                timeout_ms=10000,
            )
        except HTTPException as exc:
            if exc.status_code == 409:
                return
            async with async_session() as db:
                current = await db.get(DaemonAgentCleanup, row.id)
                if current is not None and current.status == "pending":
                    current.attempts += 1
                    current.last_error = str(exc.detail)[:1000]
                    await db.commit()
            continue

        async with async_session() as db:
            current = await db.get(DaemonAgentCleanup, row.id)
            if current is None or current.status != "pending":
                continue
            current.attempts += 1
            if isinstance(ack, dict) and ack.get("ok"):
                current.status = "succeeded"
                current.completed_at = _now()
                current.last_error = None
            else:
                current.last_error = _cleanup_error_message(ack if isinstance(ack, dict) else {})
            await db.commit()

    # Finalize the device removal if the queue is now drained and the daemon
    # was scheduled for removal. Safe no-op for plain agent unbinds.
    await _finalize_removal_if_drained(daemon_instance_id)


def schedule_pending_daemon_cleanups(daemon_instance_id: str) -> None:
    if not is_daemon_online(daemon_instance_id):
        return
    task = asyncio.create_task(process_pending_daemon_cleanups(daemon_instance_id))
    _BACKGROUND_CLEANUPS.add(task)
    task.add_done_callback(_BACKGROUND_CLEANUPS.discard)


@router.post("/daemon/instances/{daemon_instance_id}/dispatch")
async def dispatch_to_instance(
    daemon_instance_id: str,
    body: _DispatchRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if body.type not in _ALLOWED_DISPATCH_TYPES:
        raise HTTPException(status_code=400, detail="unsupported_type")

    instance = await _load_owned_instance(db, ctx.user_id, daemon_instance_id)
    if instance.revoked_at is not None:
        raise HTTPException(status_code=409, detail="daemon_revoked")

    ack = await send_control_frame(
        daemon_instance_id, body.type, body.params or {}, body.timeout_ms
    )
    return {"ok": True, "ack": ack}


class _RefreshRuntimesResponse(BaseModel):
    runtimes: list[dict[str, Any]]
    runtimes_probed_at: datetime.datetime


_REFRESH_RUNTIMES_TIMEOUT_MS = 10000


@router.post(
    "/daemon/instances/{daemon_instance_id}/refresh-runtimes",
    response_model=_RefreshRuntimesResponse,
)
async def refresh_instance_runtimes(
    daemon_instance_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> _RefreshRuntimesResponse:
    """Ask a connected daemon to (re-)probe its runtimes and persist the result.

    Returns 409 ``daemon_offline`` when the daemon WS is not currently
    registered (§8.4 离线降级) and 502 ``upstream_error`` when the daemon
    responds with an error ack. On success the snapshot is stored on the
    ``daemon_instances`` row and echoed back to the caller.
    """
    instance = await _load_owned_instance(db, ctx.user_id, daemon_instance_id)
    if instance.revoked_at is not None:
        raise HTTPException(status_code=409, detail="daemon_revoked")

    conn = _REGISTRY.get(daemon_instance_id)
    if conn is None:
        raise HTTPException(status_code=409, detail="daemon_offline")

    frame = _build_signed_frame("list_runtimes", {})
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    conn.pending_acks[frame["id"]] = fut

    try:
        await conn.ws.send_text(json.dumps(frame))
    except Exception as exc:  # noqa: BLE001
        conn.pending_acks.pop(frame["id"], None)
        raise HTTPException(status_code=502, detail=f"daemon_send_failed: {exc}")

    try:
        ack = await asyncio.wait_for(
            fut, timeout=_REFRESH_RUNTIMES_TIMEOUT_MS / 1000
        )
    except asyncio.TimeoutError:
        conn.pending_acks.pop(frame["id"], None)
        raise HTTPException(status_code=504, detail="daemon_ack_timeout")
    except RuntimeError as exc:
        # The control-WS finally block sets this exception on every pending
        # ack when the daemon disconnects. Surface it as 502 rather than
        # letting it escape to a generic 500.
        conn.pending_acks.pop(frame["id"], None)
        raise HTTPException(
            status_code=502,
            detail={"code": "daemon_disconnected", "daemon_message": str(exc)},
        )

    if not isinstance(ack, dict) or not ack.get("ok"):
        err = ack.get("error") if isinstance(ack, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else None
        message = (err or {}).get("message") if isinstance(err, dict) else None
        raise HTTPException(
            status_code=502,
            detail={
                "code": "upstream_error",
                "daemon_code": code,
                "daemon_message": message,
            },
        )

    result = ack.get("result") if isinstance(ack.get("result"), dict) else None
    persisted = None
    if result is not None:
        persisted = await _persist_runtime_snapshot(db, instance, result)
    if persisted is None:
        raise HTTPException(
            status_code=502,
            detail={"code": "upstream_error", "daemon_message": "malformed runtime snapshot"},
        )
    await db.commit()

    runtimes, probed_dt = persisted
    return _RefreshRuntimesResponse(
        runtimes=runtimes,
        runtimes_probed_at=probed_dt,
    )


# ---------------------------------------------------------------------------
# Control WebSocket
# ---------------------------------------------------------------------------


@router.websocket("/daemon/ws")
async def daemon_control_ws(ws: WebSocket) -> None:
    """Long-lived control-plane channel.

    Auth: ``Authorization: Bearer <daemon access JWT>``. The header is read
    from the upgrade request — same convention as standard FastAPI WS auth.
    """
    auth_header = ws.headers.get("authorization") or ws.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        await ws.close(code=4401, reason="missing bearer")
        return
    token = auth_header[len("Bearer ") :]

    try:
        claims = _verify_daemon_access_token(token)
    except HTTPException as exc:
        await ws.close(code=4401, reason=exc.detail or "auth")
        return

    daemon_instance_id = claims["daemon_instance_id"]
    user_id = claims.get("user_id") or ""

    # Verify the instance still exists and is not revoked.
    async with async_session() as db:
        result = await db.execute(
            select(DaemonInstance).where(DaemonInstance.id == daemon_instance_id)
        )
        instance = result.scalar_one_or_none()
        if instance is None:
            await ws.close(code=4401, reason="instance not found")
            return
        if instance.revoked_at is not None:
            await ws.close(code=4403, reason="instance revoked")
            return
        instance.last_seen_at = _now()
        await db.commit()

    await ws.accept()

    conn = _DaemonConn(
        ws=ws,
        user_id=user_id,
        daemon_instance_id=daemon_instance_id,
        pending_acks={},
    )
    previous = await _REGISTRY.register(conn)
    if previous is not None:
        try:
            await previous.ws.close(code=4001, reason="displaced by new connection")
        except Exception:
            pass

    # Send the hello frame straight away. The `agents` snapshot lets the
    # daemon reconcile each provisioned agent's on-disk `identity.md` against
    # the dashboard-edited truth — offline edits land here on next reconnect.
    agents_snapshot = await _load_agent_identity_snapshot(daemon_instance_id)
    hello = _build_signed_frame(
        "hello",
        {
            "server_time": int(_now().timestamp() * 1000),
            "agents": agents_snapshot,
        },
    )
    try:
        await ws.send_text(json.dumps(hello))
    except Exception as exc:  # noqa: BLE001
        logger.warning("daemon hello send failed: %s", exc)

    schedule_pending_daemon_cleanups(daemon_instance_id)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("daemon WS: non-JSON frame, dropping")
                continue
            if not isinstance(msg, dict):
                continue

            # Ack of a Hub-issued dispatch (matches a pending future).
            if "ok" in msg and isinstance(msg.get("id"), str) and "type" not in msg:
                fut = conn.pending_acks.pop(msg["id"], None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
                continue

            # Daemon-initiated event frame.
            await _handle_daemon_event(conn, msg)

    except WebSocketDisconnect:
        logger.info("daemon WS disconnect: instance=%s", daemon_instance_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("daemon WS error: instance=%s err=%s", daemon_instance_id, exc)
    finally:
        await _REGISTRY.unregister(conn)
        # Cancel any pending dispatch awaiting an ack.
        for fut in conn.pending_acks.values():
            if not fut.done():
                fut.set_exception(RuntimeError("daemon disconnected"))


_DAEMON_INITIATED_TYPES = {
    "agent_provisioned",
    "agent_revoked",
    "pong",
    "runtime_snapshot",
}


def _parse_runtime_snapshot_params(
    params: Any,
) -> tuple[list[dict[str, Any]], datetime.datetime] | None:
    """Validate a ``runtime_snapshot`` / ``list_runtimes`` ack payload.

    Returns ``(runtimes, probed_at_utc)`` on success, ``None`` on malformed
    input (caller should respond with ``bad_params``).
    """
    if not isinstance(params, dict):
        return None
    runtimes = params.get("runtimes")
    probed_at = params.get("probedAt")
    if not isinstance(runtimes, list):
        return None
    # Cap array length to keep a buggy/hostile daemon from bloating the
    # `runtimes_json` column and the dashboard payload. The real list has
    # a handful of adapter ids (~3 today); 64 is roomy without being a DoS
    # vector.
    if len(runtimes) > 64:
        return None
    # Each entry must be a dict — beyond that we trust the daemon's schema.
    # The one schema-aware check we run is on the optional nested
    # ``endpoints[]`` (RFC §3.8.2): a misconfigured daemon could otherwise
    # ship thousands of OpenClaw gateway entries inside the jsonb column.
    # Cap at 32 (matches RUNTIME_ENDPOINTS_CAP on the daemon side); silently
    # truncate rather than reject so a transient overflow doesn't drop the
    # whole snapshot.
    for entry in runtimes:
        if not isinstance(entry, dict):
            return None
        endpoints = entry.get("endpoints")
        if isinstance(endpoints, list) and len(endpoints) > 32:
            entry["endpoints"] = endpoints[:32]
    if not isinstance(probed_at, (int, float)) or isinstance(probed_at, bool):
        return None
    if probed_at <= 0:
        return None
    try:
        probed_dt = datetime.datetime.fromtimestamp(
            probed_at / 1000, tz=datetime.timezone.utc
        )
    except (OverflowError, OSError, ValueError):
        return None
    # Skew tolerance: daemon clock must be within +5min of hub clock.
    upper_bound = _now() + datetime.timedelta(minutes=5)
    if probed_dt > upper_bound:
        return None
    return runtimes, probed_dt


async def _persist_runtime_snapshot(
    db: AsyncSession,
    instance: DaemonInstance,
    params: dict[str, Any],
) -> tuple[list[dict[str, Any]], datetime.datetime] | None:
    """Persist a validated snapshot onto ``instance`` within the given session.

    Returns the parsed ``(runtimes, probed_at)`` pair for caller use (e.g. the
    HTTP refresh endpoint echoing the result). Returns ``None`` if params are
    malformed; the caller is responsible for surfacing the error.
    """
    parsed = _parse_runtime_snapshot_params(params)
    if parsed is None:
        return None
    runtimes, probed_dt = parsed
    instance.runtimes_json = runtimes
    instance.runtimes_probed_at = probed_dt
    return runtimes, probed_dt


async def _load_agent_identity_snapshot(
    daemon_instance_id: str,
) -> list[dict[str, Any]]:
    """Return the identity snapshot for every active agent bound to this daemon.

    Embedded in the `hello` frame so the daemon can rewrite each agent's
    on-disk `identity.md` whenever the dashboard mutated it while the daemon
    was offline. Failures are logged and yield an empty list — losing the
    snapshot is preferable to refusing the connection.
    """
    try:
        async with async_session() as db:
            result = await db.execute(
                select(Agent).where(
                    Agent.daemon_instance_id == daemon_instance_id,
                    Agent.status == "active",
                )
            )
            rows = result.scalars().all()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "hello agents snapshot load failed: instance=%s err=%s",
            daemon_instance_id,
            exc,
        )
        return []
    # Only fields the daemon's `applyAgentIdentity` actually consumes ship
    # on the wire — runtime is already cached locally in the credentials
    # file and re-sending it here would just bloat the hello payload.
    return [
        {
            "agentId": row.agent_id,
            "displayName": row.display_name,
            "bio": row.bio,
        }
        for row in rows
    ]


async def _handle_daemon_event(conn: _DaemonConn, msg: dict[str, Any]) -> None:
    msg_id = msg.get("id")
    msg_type = msg.get("type")
    if not isinstance(msg_id, str) or not isinstance(msg_type, str):
        return

    if msg_type not in _DAEMON_INITIATED_TYPES:
        ack = {
            "id": msg_id,
            "ok": False,
            "error": {"code": "unknown_type", "message": f"unknown daemon event type: {msg_type}"},
        }
        try:
            await conn.ws.send_text(json.dumps(ack))
        except Exception:
            pass
        return

    # For runtime_snapshot we need to validate params *before* the DB touch so
    # we can bail with bad_params without writing anything.
    params = msg.get("params")
    if msg_type == "runtime_snapshot":
        parsed = _parse_runtime_snapshot_params(params)
        if parsed is None:
            err = {
                "id": msg_id,
                "ok": False,
                "error": {
                    "code": "bad_params",
                    "message": "runtime_snapshot requires {runtimes:list, probedAt:int}",
                },
            }
            try:
                await conn.ws.send_text(json.dumps(err))
            except Exception:
                pass
            return

    # Bump last_seen_at (and persist runtime snapshot if applicable) in one tx.
    try:
        async with async_session() as db:
            result = await db.execute(
                select(DaemonInstance).where(DaemonInstance.id == conn.daemon_instance_id)
            )
            instance = result.scalar_one_or_none()
            if instance is not None:
                instance.last_seen_at = _now()
                if msg_type == "runtime_snapshot":
                    # params already validated above; ignore return value.
                    await _persist_runtime_snapshot(db, instance, params)  # type: ignore[arg-type]
                await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug("daemon event persist failed: %s", exc)

    ack = {"id": msg_id, "ok": True}
    try:
        await conn.ws.send_text(json.dumps(ack))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _registry_for_tests() -> _DaemonRegistry:
    """Exposed for unit tests so they can inject fake connections."""
    return _REGISTRY
