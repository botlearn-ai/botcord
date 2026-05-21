"""Cloud daemon control-plane WebSocket.

Mirrors ``/daemon/ws`` but with independent auth (``cloud-daemon-access``
JWT) and an isolated registry. One cloud daemon (E2B sandbox) may host
multiple Cloud Agents. See ``docs/cloud-agent-technical-design.md`` §4.

Conventions match :mod:`hub.routers.daemon_control`:

- All handlers are ``async def``.
- The Hub signing key, frame builder, ack semantics, and runtime-snapshot
  validator are imported from the local daemon module so cloud and local
  daemons speak the same frame schema (only auth and lookup differ).
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
from dataclasses import dataclass, field
from typing import Any

import jwt as pyjwt
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from hub.config import (
    DAEMON_ACCESS_TOKEN_EXPIRE_SECONDS,
    JWT_ALGORITHM,
    JWT_SECRET,
)
from hub.database import async_session
from hub.models import CloudDaemonInstance, DaemonInstance
from hub.routers.daemon_control import (
    _build_signed_frame,
    _load_agent_identity_snapshot,
    _now,
    _parse_runtime_snapshot_params,
    _persist_runtime_snapshot,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["cloud-daemon-control"])


CLOUD_DAEMON_TOKEN_KIND = "cloud-daemon-access"
CLOUD_DAEMON_TOKEN_ISSUER = "botcord-cloud-daemon"


# ---------------------------------------------------------------------------
# Token helpers — independent from the local daemon token kind so Hub can
# revoke cloud daemons without touching user-installed daemons.
# ---------------------------------------------------------------------------


def _create_cloud_daemon_access_token(
    cloud_daemon_instance_id: str,
    daemon_instance_id: str,
    user_id: str,
) -> tuple[str, int]:
    """Issue a short-lived JWT for a cloud daemon's WS upgrade.

    Same lifetime as the local daemon access token. The cloud-daemon
    provider rotates the token on each ``resume`` so leaked tokens decay
    quickly.
    """
    expires_at = _now() + datetime.timedelta(
        seconds=DAEMON_ACCESS_TOKEN_EXPIRE_SECONDS
    )
    payload = {
        "kind": CLOUD_DAEMON_TOKEN_KIND,
        "sub": cloud_daemon_instance_id,
        "user_id": str(user_id),
        "cloud_daemon_instance_id": cloud_daemon_instance_id,
        "daemon_instance_id": daemon_instance_id,
        "exp": expires_at,
        "iss": CLOUD_DAEMON_TOKEN_ISSUER,
    }
    token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token, DAEMON_ACCESS_TOKEN_EXPIRE_SECONDS


class _TokenError(Exception):
    """Internal — converted to a WS close on the upgrade path."""

    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def _verify_cloud_daemon_access_token(token: str) -> dict[str, Any]:
    """Decode and validate a cloud-daemon-access JWT. Raises :class:`_TokenError`."""
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except pyjwt.ExpiredSignatureError:
        raise _TokenError(4401, "token expired")
    except pyjwt.InvalidTokenError:
        raise _TokenError(4401, "invalid token")
    if payload.get("kind") != CLOUD_DAEMON_TOKEN_KIND:
        raise _TokenError(4401, "invalid token kind")
    if payload.get("iss") != CLOUD_DAEMON_TOKEN_ISSUER:
        raise _TokenError(4401, "invalid token issuer")
    if not payload.get("cloud_daemon_instance_id"):
        raise _TokenError(4401, "missing cloud_daemon_instance_id claim")
    if not payload.get("daemon_instance_id"):
        raise _TokenError(4401, "missing daemon_instance_id claim")
    if not payload.get("user_id"):
        raise _TokenError(4401, "missing user_id claim")
    return payload


# ---------------------------------------------------------------------------
# In-memory cloud daemon registry. Indexed by both ``cloud_daemon_instance_id``
# (the canonical key) and ``daemon_instance_id`` so existing agent-routing
# code that looks up the daemon by its underlying daemon row can find the
# cloud connection without a join. See §4.4.
# ---------------------------------------------------------------------------


@dataclass
class _CloudDaemonConn:
    ws: Any  # ``WebSocket`` at runtime; widened so tests can inject _FakeWS.
    user_id: str
    cloud_daemon_instance_id: str
    daemon_instance_id: str
    pending_acks: dict[str, asyncio.Future] = field(default_factory=dict)


class _CloudDaemonRegistry:
    """Process-local cloud daemon WS registry.

    Independent from the local-daemon registry: lookups on either side
    must never see the other. A second connection for the same cloud
    daemon displaces the first (close code 4001).
    """

    def __init__(self) -> None:
        self._by_cloud: dict[str, _CloudDaemonConn] = {}
        self._by_daemon: dict[str, _CloudDaemonConn] = {}
        self._lock = asyncio.Lock()

    async def register(self, conn: _CloudDaemonConn) -> _CloudDaemonConn | None:
        async with self._lock:
            previous = self._by_cloud.get(conn.cloud_daemon_instance_id)
            self._by_cloud[conn.cloud_daemon_instance_id] = conn
            self._by_daemon[conn.daemon_instance_id] = conn
            return previous

    async def unregister(self, conn: _CloudDaemonConn) -> None:
        async with self._lock:
            current_cloud = self._by_cloud.get(conn.cloud_daemon_instance_id)
            if current_cloud is conn:
                self._by_cloud.pop(conn.cloud_daemon_instance_id, None)
            current_daemon = self._by_daemon.get(conn.daemon_instance_id)
            if current_daemon is conn:
                self._by_daemon.pop(conn.daemon_instance_id, None)

    def get_by_cloud(self, cloud_daemon_instance_id: str) -> _CloudDaemonConn | None:
        return self._by_cloud.get(cloud_daemon_instance_id)

    def get_by_daemon(self, daemon_instance_id: str) -> _CloudDaemonConn | None:
        return self._by_daemon.get(daemon_instance_id)

    def is_online(self, cloud_daemon_instance_id: str) -> bool:
        return cloud_daemon_instance_id in self._by_cloud


_REGISTRY = _CloudDaemonRegistry()


def is_cloud_daemon_online(cloud_daemon_instance_id: str) -> bool:
    """Public probe for higher-level services (e.g. provider resume)."""
    return _REGISTRY.is_online(cloud_daemon_instance_id)


def is_cloud_daemon_online_by_daemon_id(daemon_instance_id: str) -> bool:
    """Same as :func:`is_cloud_daemon_online` but keyed by ``daemon_instance_id``.

    The dashboard's ``/daemon/instances`` list iterates ``DaemonInstance`` rows
    and needs an online flag without a separate ``CloudDaemonInstance`` lookup —
    the cloud registry already indexes by both keys so this is O(1).
    """
    return _REGISTRY.get_by_daemon(daemon_instance_id) is not None


def _registry_for_tests() -> _CloudDaemonRegistry:
    """Test-only accessor for injecting fake connections."""
    return _REGISTRY


# ---------------------------------------------------------------------------
# Hub -> daemon dispatch
# ---------------------------------------------------------------------------


CLOUD_DAEMON_DISPATCH_DEFAULT_TIMEOUT_MS = 30000


class CloudDaemonDispatchError(Exception):
    """Raised when the Hub cannot deliver a control frame to a cloud daemon.

    Service-layer code wraps this into ``CloudAgentError`` so the API
    surface stays free of WS-level codes.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def send_cloud_control_frame(
    cloud_daemon_instance_id: str,
    type_: str,
    params: dict[str, Any] | None = None,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    """Dispatch a signed frame and await the daemon's ack.

    Returns the parsed ack dict (which may carry ``ok=False`` on a
    handled daemon-side error). Raises :class:`CloudDaemonDispatchError`
    if the daemon is offline, the send fails, or the ack times out.
    """
    conn = _REGISTRY.get_by_cloud(cloud_daemon_instance_id)
    if conn is None:
        raise CloudDaemonDispatchError(
            "cloud_daemon_offline",
            f"cloud daemon {cloud_daemon_instance_id!r} is not connected",
        )

    frame = _build_signed_frame(type_, params or {})
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    conn.pending_acks[frame["id"]] = fut

    timeout = timeout_ms or CLOUD_DAEMON_DISPATCH_DEFAULT_TIMEOUT_MS
    try:
        await conn.ws.send_text(json.dumps(frame))
    except Exception as exc:  # noqa: BLE001
        conn.pending_acks.pop(frame["id"], None)
        raise CloudDaemonDispatchError(
            "cloud_daemon_send_failed", f"daemon send failed: {exc}"
        ) from exc

    try:
        ack = await asyncio.wait_for(fut, timeout=timeout / 1000)
    except asyncio.TimeoutError as exc:
        conn.pending_acks.pop(frame["id"], None)
        raise CloudDaemonDispatchError(
            "cloud_daemon_ack_timeout",
            f"ack timeout after {timeout}ms for frame {frame['id']!r}",
        ) from exc
    except RuntimeError as exc:
        conn.pending_acks.pop(frame["id"], None)
        raise CloudDaemonDispatchError(
            "cloud_daemon_disconnected", str(exc)
        ) from exc
    return ack


# ---------------------------------------------------------------------------
# Control WebSocket
# ---------------------------------------------------------------------------


_DAEMON_INITIATED_TYPES = {
    "agent_provisioned",
    "agent_revoked",
    "pong",
    "runtime_snapshot",
}


@router.websocket("/cloud/daemon/ws")
async def cloud_daemon_control_ws(ws: WebSocket) -> None:
    """Long-lived control-plane channel for Hub-managed cloud daemons.

    Auth: ``Authorization: Bearer <cloud-daemon-access JWT>``. Same
    Bearer convention as ``/daemon/ws`` so the daemon binary can reuse
    its existing upgrade code.
    """
    auth_header = ws.headers.get("authorization") or ws.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        await ws.close(code=4401, reason="missing bearer")
        return
    token = auth_header[len("Bearer ") :]

    try:
        claims = _verify_cloud_daemon_access_token(token)
    except _TokenError as exc:
        await ws.close(code=exc.code, reason=exc.reason)
        return

    cloud_daemon_instance_id = claims["cloud_daemon_instance_id"]
    daemon_instance_id = claims["daemon_instance_id"]
    user_id = claims.get("user_id") or ""

    # Verify both rows still exist, are cloud-owned, and not torn down.
    async with async_session() as db:
        cloud_row = await db.scalar(
            select(CloudDaemonInstance).where(
                CloudDaemonInstance.id == cloud_daemon_instance_id
            )
        )
        if cloud_row is None:
            await ws.close(code=4401, reason="cloud daemon not found")
            return
        if cloud_row.daemon_instance_id != daemon_instance_id:
            # Token's cloud/daemon pair must match the persisted binding.
            await ws.close(code=4401, reason="cloud daemon mismatch")
            return
        if str(cloud_row.user_id) != str(user_id):
            await ws.close(code=4401, reason="cloud daemon user mismatch")
            return
        if cloud_row.status in {"deleting", "deleted"}:
            await ws.close(code=4403, reason="cloud daemon revoked")
            return

        daemon_row = await db.scalar(
            select(DaemonInstance).where(DaemonInstance.id == daemon_instance_id)
        )
        if daemon_row is None:
            await ws.close(code=4401, reason="daemon not found")
            return
        if daemon_row.kind != "cloud":
            await ws.close(code=4401, reason="not a cloud daemon")
            return
        if str(daemon_row.user_id) != str(user_id):
            await ws.close(code=4401, reason="daemon user mismatch")
            return
        if daemon_row.revoked_at is not None:
            await ws.close(code=4403, reason="daemon revoked")
            return

        # Stamp last_seen on both rows in the same transaction.
        now = _now()
        daemon_row.last_seen_at = now
        cloud_row.last_seen_at = now
        await db.commit()

    await ws.accept()

    conn = _CloudDaemonConn(
        ws=ws,
        user_id=user_id,
        cloud_daemon_instance_id=cloud_daemon_instance_id,
        daemon_instance_id=daemon_instance_id,
    )
    previous = await _REGISTRY.register(conn)
    if previous is not None:
        try:
            await previous.ws.close(code=4001, reason="displaced by new connection")
        except Exception:
            pass

    agents_snapshot = await _load_agent_identity_snapshot(daemon_instance_id)
    hello = _build_signed_frame(
        "hello",
        {
            "server_time": int(_now().timestamp() * 1000),
            "agents": agents_snapshot,
            "cloud_daemon_instance_id": cloud_daemon_instance_id,
        },
    )
    try:
        await ws.send_text(json.dumps(hello))
    except Exception as exc:  # noqa: BLE001
        logger.warning("cloud daemon hello send failed: %s", exc)

    # Drain any agents that were created while the daemon was offline.
    # The drain runs as a background task so the WS receive loop below
    # starts pumping immediately — provision_agent dispatches will land
    # in this same conn once they go out.
    schedule_provision_drain(cloud_daemon_instance_id)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("cloud daemon WS: non-JSON frame, dropping")
                continue
            if not isinstance(msg, dict):
                continue

            # Ack of a Hub-issued dispatch (matches a pending future).
            if "ok" in msg and isinstance(msg.get("id"), str) and "type" not in msg:
                fut = conn.pending_acks.pop(msg["id"], None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
                continue

            await _handle_cloud_daemon_event(conn, msg)

    except WebSocketDisconnect:
        logger.info(
            "cloud daemon WS disconnect: cloud=%s daemon=%s",
            cloud_daemon_instance_id,
            daemon_instance_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "cloud daemon WS error: cloud=%s err=%s",
            cloud_daemon_instance_id,
            exc,
        )
    finally:
        await _REGISTRY.unregister(conn)
        for fut in conn.pending_acks.values():
            if not fut.done():
                fut.set_exception(RuntimeError("cloud daemon disconnected"))


# Background tasks for provisioning drain — must be kept alive until done
# so they aren't GC'd mid-execution. Mirrors the local daemon's
# ``_BACKGROUND_CLEANUPS`` pattern.
_BACKGROUND_PROVISION_DRAINS: set[asyncio.Task] = set()


def schedule_provision_drain(cloud_daemon_instance_id: str) -> None:
    """Fire-and-forget: ask :class:`CloudAgentService` to provision pending agents.

    The import is deferred to side-step the
    ``cloud_daemon_control -> cloud_agent -> cloud_daemon_control`` cycle.
    Test hooks override this symbol to assert it was called without
    actually touching the service.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover — only hit outside an async ctx
        return

    async def _run() -> None:
        try:
            # Late import: avoids the import cycle and keeps the WS
            # handler usable in tests that monkeypatch the service.
            from hub.services.cloud_agent import CloudAgentService

            service = CloudAgentService()
            async with async_session() as db:
                await service.provision_pending_for_cloud_daemon(
                    db, cloud_daemon_instance_id=cloud_daemon_instance_id
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "provision drain failed: cloud=%s err=%s",
                cloud_daemon_instance_id,
                exc,
            )

    task = loop.create_task(_run())
    _BACKGROUND_PROVISION_DRAINS.add(task)
    task.add_done_callback(_BACKGROUND_PROVISION_DRAINS.discard)


async def _handle_cloud_daemon_event(
    conn: _CloudDaemonConn, msg: dict[str, Any]
) -> None:
    """Handle a daemon-initiated event frame on the cloud control plane."""
    msg_id = msg.get("id")
    msg_type = msg.get("type")
    if not isinstance(msg_id, str) or not isinstance(msg_type, str):
        return

    if msg_type not in _DAEMON_INITIATED_TYPES:
        ack = {
            "id": msg_id,
            "ok": False,
            "error": {
                "code": "unknown_type",
                "message": f"unknown daemon event type: {msg_type}",
            },
        }
        try:
            await conn.ws.send_text(json.dumps(ack))
        except Exception:
            pass
        return

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

    # Bump last_seen on both rows; persist snapshot when applicable.
    try:
        async with async_session() as db:
            daemon_row = await db.scalar(
                select(DaemonInstance).where(
                    DaemonInstance.id == conn.daemon_instance_id
                )
            )
            cloud_row = await db.scalar(
                select(CloudDaemonInstance).where(
                    CloudDaemonInstance.id == conn.cloud_daemon_instance_id
                )
            )
            now = _now()
            if daemon_row is not None:
                daemon_row.last_seen_at = now
                if msg_type == "runtime_snapshot":
                    await _persist_runtime_snapshot(db, daemon_row, params)  # type: ignore[arg-type]
            if cloud_row is not None:
                cloud_row.last_seen_at = now
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug("cloud daemon event persist failed: %s", exc)

    ack = {"id": msg_id, "ok": True}
    try:
        await conn.ws.send_text(json.dumps(ack))
    except Exception:
        pass
