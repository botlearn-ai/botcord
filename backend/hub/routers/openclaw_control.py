"""OpenClaw host control-plane HTTP + WebSocket endpoints.

Implements the ``/openclaw/*`` surface used by the BotCord plugin running
inside an OpenClaw VM/container:

- ``POST /openclaw/install-claim`` — first-install flow. Plugin submits
  host + agent pubkeys with Ed25519 proof-of-possession against the
  bind-ticket nonce; Hub atomically creates the host instance, agent row
  + active key, and returns host JWT pair + agent JWT.
- ``POST /openclaw/auth/refresh`` — host refresh-token rotation (mirror of
  ``/daemon/auth/refresh``).
- ``POST /openclaw/host/provision-claim`` — used by an already-online host
  in response to a server-pushed ``provision_agent`` frame, to atomically
  create a new agent + active key and obtain its JWT.
- ``WS  /openclaw/control`` — long-lived control channel. Same Bearer JWT
  + Hub Ed25519 signed-frame contract as the daemon control WS.

The signing key is shared with the daemon control plane (single Hub
identity) — see :data:`hub.routers.daemon_control.HUB_CONTROL_PUBLIC_KEY_B64`.
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
from typing import Any

import jwt as pyjwt
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.config import (
    HUB_PUBLIC_BASE_URL,
    JWT_ALGORITHM,
    JWT_SECRET,
    OPENCLAW_ACCESS_TOKEN_EXPIRE_SECONDS,
    OPENCLAW_REFRESH_TOKEN_TTL_SECONDS,
)
from hub.crypto import verify_challenge_sig
from hub.database import async_session, get_db
from hub.id_generators import (
    generate_agent_id,
    generate_key_id,
    generate_openclaw_host_id_from_pubkey,
)
from hub.models import Agent, OpenclawHostInstance, ShortCode, SigningKey
from hub.enums import KeyState
from hub.routers.daemon_control import _build_signed_frame
from hub.validators import parse_pubkey
from hub.auth import create_agent_token

logger = logging.getLogger(__name__)

router = APIRouter(tags=["openclaw-control"])


# ---------------------------------------------------------------------------
# Time + token helpers
# ---------------------------------------------------------------------------


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generate_refresh_token() -> str:
    return "ort_" + secrets.token_urlsafe(48)


def _create_host_access_token(host_instance_id: str, owner_user_id: str) -> tuple[str, int]:
    expires_at = _now() + datetime.timedelta(seconds=OPENCLAW_ACCESS_TOKEN_EXPIRE_SECONDS)
    payload = {
        "sub": host_instance_id,
        "user_id": str(owner_user_id),
        "openclaw_host_id": host_instance_id,
        "kind": "openclaw-host-access",
        "exp": expires_at,
        "iss": "botcord-openclaw",
    }
    token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token, OPENCLAW_ACCESS_TOKEN_EXPIRE_SECONDS


def _verify_host_access_token(token: str) -> dict[str, Any]:
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("kind") != "openclaw-host-access":
        raise HTTPException(status_code=401, detail="Invalid token kind")
    if payload.get("iss") != "botcord-openclaw":
        raise HTTPException(status_code=401, detail="Invalid token issuer")
    if not payload.get("openclaw_host_id"):
        raise HTTPException(status_code=401, detail="Missing openclaw_host_id claim")
    return payload


def _issue_host_token_bundle(
    instance: OpenclawHostInstance,
) -> tuple[dict[str, Any], str]:
    """Mint (access, refresh) for the host. Caller persists ``refresh_token_hash``."""
    access_token, expires_in = _create_host_access_token(instance.id, str(instance.owner_user_id))
    refresh_token = _generate_refresh_token()
    access_expires_at = _now() + datetime.timedelta(seconds=expires_in)
    refresh_expires_at = _now() + datetime.timedelta(seconds=OPENCLAW_REFRESH_TOKEN_TTL_SECONDS)
    bundle = {
        "host_instance_id": instance.id,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "access_expires_at": int(access_expires_at.timestamp()),
        "refresh_expires_at": int(refresh_expires_at.timestamp()),
    }
    return bundle, refresh_token


# ---------------------------------------------------------------------------
# In-memory host WS registry
# ---------------------------------------------------------------------------


@dataclass
class _HostConn:
    ws: WebSocket
    owner_user_id: str
    host_instance_id: str
    pending_acks: dict[str, asyncio.Future]


class _HostRegistry:
    def __init__(self) -> None:
        self._by_instance: dict[str, _HostConn] = {}
        self._lock = asyncio.Lock()

    async def register(self, conn: _HostConn) -> _HostConn | None:
        async with self._lock:
            previous = self._by_instance.get(conn.host_instance_id)
            self._by_instance[conn.host_instance_id] = conn
            return previous

    async def unregister(self, conn: _HostConn) -> None:
        async with self._lock:
            current = self._by_instance.get(conn.host_instance_id)
            if current is conn:
                self._by_instance.pop(conn.host_instance_id, None)

    def get(self, host_instance_id: str) -> _HostConn | None:
        return self._by_instance.get(host_instance_id)

    def is_online(self, host_instance_id: str) -> bool:
        return host_instance_id in self._by_instance


_REGISTRY = _HostRegistry()


def is_openclaw_host_online(host_instance_id: str) -> bool:
    return _REGISTRY.is_online(host_instance_id)


_DEFAULT_DISPATCH_TIMEOUT_MS = 30000


async def send_host_control_frame(
    host_instance_id: str,
    type_: str,
    params: dict[str, Any] | None = None,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    """Dispatch a signed control frame to a host and await its ack.

    Mirrors :func:`hub.routers.daemon_control.send_control_frame` semantics.
    Raises ``HTTPException(409 host_offline | 502 host_send_failed | 504
    host_ack_timeout)``; resolution comes back as the ack dict.
    """
    conn = _REGISTRY.get(host_instance_id)
    if conn is None:
        raise HTTPException(status_code=409, detail="host_offline")

    frame = _build_signed_frame(type_, params or {})
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    conn.pending_acks[frame["id"]] = fut

    timeout = timeout_ms or _DEFAULT_DISPATCH_TIMEOUT_MS
    try:
        await conn.ws.send_text(json.dumps(frame))
    except Exception as exc:  # noqa: BLE001
        conn.pending_acks.pop(frame["id"], None)
        raise HTTPException(status_code=502, detail=f"host_send_failed: {exc}")

    try:
        ack = await asyncio.wait_for(fut, timeout=timeout / 1000)
    except asyncio.TimeoutError:
        conn.pending_acks.pop(frame["id"], None)
        raise HTTPException(status_code=504, detail="host_ack_timeout")
    except RuntimeError as exc:
        conn.pending_acks.pop(frame["id"], None)
        raise HTTPException(
            status_code=502,
            detail={"code": "host_disconnected", "host_message": str(exc)},
        )
    return ack


# ---------------------------------------------------------------------------
# install-claim — first-install flow
# ---------------------------------------------------------------------------


def _generic_invalid_bind_code() -> HTTPException:
    return HTTPException(status_code=400, detail="INVALID_BIND_CODE")


class _ProofModel(BaseModel):
    nonce: str
    sig: str


class _PubkeyAndProof(BaseModel):
    pubkey: str
    proof: _ProofModel


class InstallClaimBody(BaseModel):
    bind_code: str
    host: _PubkeyAndProof
    agent: _PubkeyAndProof


@router.post("/openclaw/install-claim", status_code=201)
async def openclaw_install_claim(
    body: InstallClaimBody,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Redeem an ``openclaw_install`` bind code with two Ed25519 PoPs.

    Atomic: consume bind code (stamping ``claimed_agent_id``) → burn JTI →
    create ``OpenclawHostInstance`` + ``Agent`` + active ``SigningKey`` →
    issue host JWT pair + agent JWT.
    """
    # Late-import the shared bind-ticket helpers from the BFF module to
    # avoid duplicating crypto/replay logic. The reverse import direction
    # would be circular at module load.
    from app.routers.users import (
        _consume_bind_code_with_claim,
        _consume_bind_ticket_jti,
        _ensure_agent_owner_role,
        _peek_bind_code,
        _revert_short_code_claim,
        _utc_now,
        _verify_bind_ticket,
    )
    from hub.models import User

    if not body.bind_code.startswith("bd_"):
        raise _generic_invalid_bind_code()

    bind_ticket = await _peek_bind_code(body.bind_code)
    if bind_ticket is None:
        raise _generic_invalid_bind_code()

    payload = _verify_bind_ticket(bind_ticket)
    if payload is None or payload.get("purpose") != "openclaw_install":
        raise _generic_invalid_bind_code()

    uid_str = payload.get("uid")
    if not uid_str:
        raise _generic_invalid_bind_code()
    try:
        owner_user_id = _uuid.UUID(uid_str)
    except ValueError:
        raise _generic_invalid_bind_code()

    ticket_nonce = payload.get("nonce")
    if not isinstance(ticket_nonce, str) or not ticket_nonce:
        raise _generic_invalid_bind_code()

    if body.host.proof.nonce != ticket_nonce or body.agent.proof.nonce != ticket_nonce:
        raise HTTPException(status_code=401, detail="INVALID_PROOF")

    # Validate pubkeys + verify both signatures.
    try:
        host_pubkey_b64 = parse_pubkey(body.host.pubkey.strip())
        agent_pubkey_b64 = parse_pubkey(body.agent.pubkey.strip())
    except HTTPException:
        raise HTTPException(status_code=400, detail="INVALID_PUBKEY")

    if not verify_challenge_sig(host_pubkey_b64, ticket_nonce, body.host.proof.sig):
        raise HTTPException(status_code=401, detail="INVALID_PROOF")
    if not verify_challenge_sig(agent_pubkey_b64, ticket_nonce, body.agent.proof.sig):
        raise HTTPException(status_code=401, detail="INVALID_PROOF")

    if host_pubkey_b64 == agent_pubkey_b64:
        # The two PoPs must come from distinct keypairs — otherwise the
        # agent identity would equal the host identity, which is not a
        # supported topology.
        raise HTTPException(status_code=400, detail="INVALID_PUBKEY")

    agent_id = generate_agent_id(agent_pubkey_b64)
    host_id = generate_openclaw_host_id_from_pubkey(host_pubkey_b64)

    # Pubkey collisions: refuse if either is already registered.
    dup_key_q = await db.execute(
        select(SigningKey).where(
            SigningKey.pubkey == f"ed25519:{agent_pubkey_b64}",
            SigningKey.state.in_((KeyState.active, KeyState.pending)),
        )
    )
    if dup_key_q.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")
    dup_agent_q = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    if dup_agent_q.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")
    dup_host_q = await db.execute(
        select(OpenclawHostInstance).where(
            (OpenclawHostInstance.host_pubkey == host_pubkey_b64)
            | (OpenclawHostInstance.id == host_id)
        )
    )
    if dup_host_q.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")

    # Owner quota check.
    user_q = await db.execute(select(User).where(User.id == owner_user_id))
    user = user_q.scalar_one_or_none()
    if user is None:
        raise _generic_invalid_bind_code()
    from sqlalchemy import func as sa_func

    count_q = await db.execute(
        select(sa_func.count())
        .select_from(Agent)
        .where(Agent.user_id == owner_user_id, Agent.status == "active")
    )
    current_count = count_q.scalar_one()
    if current_count >= user.max_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Agent quota exceeded (max {user.max_agents})",
        )
    is_first = current_count == 0

    # Atomic consume bind code + stamp claimed_agent_id.
    if not await _consume_bind_code_with_claim(body.bind_code, agent_id):
        raise _generic_invalid_bind_code()
    if not await _consume_bind_ticket_jti(payload["jti"]):
        raise _generic_invalid_bind_code()

    # Insert host instance + agent + active key in one transaction.
    intended_name = (
        payload.get("intended_name")
        if isinstance(payload.get("intended_name"), str)
        else None
    )
    intended_bio = (
        payload.get("intended_bio")
        if isinstance(payload.get("intended_bio"), str)
        else None
    )
    display_name = intended_name or agent_id

    now = _utc_now()
    agent_token, expires_at_ts = create_agent_token(agent_id)
    token_expires_at = datetime.datetime.fromtimestamp(
        expires_at_ts, tz=datetime.timezone.utc
    )

    instance = OpenclawHostInstance(
        id=host_id,
        owner_user_id=owner_user_id,
        host_pubkey=host_pubkey_b64,
        label=intended_name or None,
        last_seen_at=now,
    )
    bundle, refresh_token = _issue_host_token_bundle(instance)
    instance.refresh_token_hash = _hash_refresh_token(refresh_token)
    instance.refresh_token_expires_at = datetime.datetime.fromtimestamp(
        bundle["refresh_expires_at"], tz=datetime.timezone.utc
    )

    key_id = generate_key_id()
    agent = Agent(
        agent_id=agent_id,
        display_name=display_name,
        bio=intended_bio,
        user_id=owner_user_id,
        agent_token=agent_token,
        token_expires_at=token_expires_at,
        is_default=is_first,
        claimed_at=now,
        hosting_kind="plugin",
        openclaw_host_id=host_id,
    )
    signing_key = SigningKey(
        agent_id=agent_id,
        key_id=key_id,
        pubkey=f"ed25519:{agent_pubkey_b64}",
        state=KeyState.active,
    )
    try:
        async with db.begin_nested():
            db.add(instance)
            db.add(agent)
            db.add(signing_key)
    except IntegrityError:
        await db.rollback()
        # The bind code was already stamped + the JTI burned. The agent
        # row never landed; revert the short_code so polling readers don't
        # see a phantom "claimed" state. The JTI stays burned (replay
        # safety > the user redoing this exact flow).
        await _revert_short_code_claim(body.bind_code, "bind")
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")

    try:
        await _ensure_agent_owner_role(db, owner_user_id)
        await db.commit()
    except Exception:
        await db.rollback()
        await _revert_short_code_claim(body.bind_code, "bind")
        raise
    await db.refresh(agent)

    control_ws_url = (
        HUB_PUBLIC_BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
        + "/openclaw/control"
    )

    return {
        "agent": {
            "id": agent.agent_id,
            "key_id": key_id,
            "token": agent_token,
            "token_expires_at": expires_at_ts,
            "display_name": agent.display_name,
            "bio": agent.bio,
        },
        "host": {
            **bundle,
            "control_ws_url": control_ws_url,
        },
        "hub_url": HUB_PUBLIC_BASE_URL,
    }


# ---------------------------------------------------------------------------
# /openclaw/auth/refresh
# ---------------------------------------------------------------------------


class _RefreshRequest(BaseModel):
    refresh_token: str = Field(..., min_length=8, max_length=256)


@router.post("/openclaw/auth/refresh")
async def openclaw_refresh_token(
    body: _RefreshRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    refresh_hash = _hash_refresh_token(body.refresh_token)
    result = await db.execute(
        select(OpenclawHostInstance).where(
            OpenclawHostInstance.refresh_token_hash == refresh_hash
        )
    )
    instance = result.scalar_one_or_none()
    if instance is None:
        raise HTTPException(status_code=401, detail="invalid_refresh_token")
    if instance.revoked_at is not None:
        raise HTTPException(status_code=401, detail="host_revoked")
    expires_at = instance.refresh_token_expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    if expires_at is not None and expires_at < _now():
        raise HTTPException(status_code=401, detail="invalid_refresh_token")

    bundle, new_refresh = _issue_host_token_bundle(instance)
    instance.refresh_token_hash = _hash_refresh_token(new_refresh)
    instance.refresh_token_expires_at = datetime.datetime.fromtimestamp(
        bundle["refresh_expires_at"], tz=datetime.timezone.utc
    )
    instance.last_seen_at = _now()
    await db.commit()
    return bundle


# ---------------------------------------------------------------------------
# /openclaw/host/provision-claim
# ---------------------------------------------------------------------------


class ProvisionClaimBody(BaseModel):
    provision_id: str
    nonce: str
    agent: _PubkeyAndProof


def _require_host_bearer(request: Request) -> dict[str, Any]:
    auth_header = request.headers.get("authorization") or request.headers.get(
        "Authorization"
    )
    if not auth_header or not auth_header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing_bearer")
    token = auth_header[len("Bearer ") :]
    return _verify_host_access_token(token)


@router.post("/openclaw/host/provision-claim", status_code=201)
async def openclaw_provision_claim(
    body: ProvisionClaimBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Plugin-side claim of a ``provision_agent`` frame: create the agent.

    Atomic: consume provision short-code → create ``Agent`` + active key →
    return the agent JWT. Caller must also ack the original WS frame so
    the BFF future resolves; this endpoint does *not* notify the BFF.
    """
    from app.routers.users import (
        _consume_short_code_with_claim,
        _ensure_agent_owner_role,
        _revert_short_code_claim,
        _utc_now,
    )
    from hub.models import User

    claims = _require_host_bearer(request)
    host_instance_id = claims["openclaw_host_id"]
    host_owner_user_id = claims["user_id"]

    # 1. Verify the host instance is still alive + un-revoked.
    inst_q = await db.execute(
        select(OpenclawHostInstance).where(
            OpenclawHostInstance.id == host_instance_id
        )
    )
    instance = inst_q.scalar_one_or_none()
    if instance is None or instance.revoked_at is not None:
        raise HTTPException(status_code=401, detail="host_revoked_or_unknown")
    if str(instance.owner_user_id) != str(host_owner_user_id):
        raise HTTPException(status_code=401, detail="host_owner_mismatch")

    # 2. Look up the provision short code.
    sc_q = await db.execute(
        select(ShortCode).where(
            ShortCode.code == body.provision_id,
            ShortCode.kind == "openclaw_provision",
        )
    )
    short_code = sc_q.scalar_one_or_none()
    if short_code is None:
        raise HTTPException(status_code=400, detail="INVALID_PROVISION")
    expires_at = short_code.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    if (
        short_code.consumed_at is not None
        or (expires_at is not None and expires_at < _now())
        or short_code.use_count >= short_code.max_uses
    ):
        raise HTTPException(status_code=400, detail="INVALID_PROVISION")

    try:
        sc_payload = json.loads(short_code.payload_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="INVALID_PROVISION")

    if sc_payload.get("nonce") != body.nonce:
        raise HTTPException(status_code=401, detail="INVALID_PROOF")
    if sc_payload.get("openclaw_host_id") != host_instance_id:
        raise HTTPException(status_code=403, detail="host_mismatch")
    if str(sc_payload.get("owner_user_id")) != str(host_owner_user_id):
        raise HTTPException(status_code=403, detail="owner_mismatch")

    # 3. Verify the agent PoP signs the provision nonce.
    if body.agent.proof.nonce != body.nonce:
        raise HTTPException(status_code=401, detail="INVALID_PROOF")
    try:
        agent_pubkey_b64 = parse_pubkey(body.agent.pubkey.strip())
    except HTTPException:
        raise HTTPException(status_code=400, detail="INVALID_PUBKEY")
    if not verify_challenge_sig(agent_pubkey_b64, body.nonce, body.agent.proof.sig):
        raise HTTPException(status_code=401, detail="INVALID_PROOF")

    agent_id = generate_agent_id(agent_pubkey_b64)

    # 4. Pubkey + agent_id collisions, owner quota.
    dup_key_q = await db.execute(
        select(SigningKey).where(
            SigningKey.pubkey == f"ed25519:{agent_pubkey_b64}",
            SigningKey.state.in_((KeyState.active, KeyState.pending)),
        )
    )
    if dup_key_q.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")
    dup_agent_q = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    if dup_agent_q.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")

    owner_user_id = _uuid.UUID(str(host_owner_user_id))
    user_q = await db.execute(select(User).where(User.id == owner_user_id))
    user = user_q.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=400, detail="owner_not_found")
    from sqlalchemy import func as sa_func

    count_q = await db.execute(
        select(sa_func.count())
        .select_from(Agent)
        .where(Agent.user_id == owner_user_id, Agent.status == "active")
    )
    current_count = count_q.scalar_one()
    if current_count >= user.max_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Agent quota exceeded (max {user.max_agents})",
        )
    is_first = current_count == 0

    # 5. Atomic consume of the short code.
    if not await _consume_short_code_with_claim(
        body.provision_id, "openclaw_provision", agent_id
    ):
        raise HTTPException(status_code=400, detail="INVALID_PROVISION")

    # 6. Insert agent + active key.
    intended_name = (
        sc_payload.get("intended_name")
        if isinstance(sc_payload.get("intended_name"), str)
        else None
    )
    intended_bio = (
        sc_payload.get("intended_bio")
        if isinstance(sc_payload.get("intended_bio"), str)
        else None
    )
    display_name = intended_name or agent_id

    now = _utc_now()
    agent_token, expires_at_ts = create_agent_token(agent_id)
    token_expires_at = datetime.datetime.fromtimestamp(
        expires_at_ts, tz=datetime.timezone.utc
    )
    key_id = generate_key_id()
    agent = Agent(
        agent_id=agent_id,
        display_name=display_name,
        bio=intended_bio,
        user_id=owner_user_id,
        agent_token=agent_token,
        token_expires_at=token_expires_at,
        is_default=is_first,
        claimed_at=now,
        hosting_kind="plugin",
        openclaw_host_id=host_instance_id,
    )
    signing_key = SigningKey(
        agent_id=agent_id,
        key_id=key_id,
        pubkey=f"ed25519:{agent_pubkey_b64}",
        state=KeyState.active,
    )
    try:
        async with db.begin_nested():
            db.add(agent)
            db.add(signing_key)
    except IntegrityError:
        await db.rollback()
        await _revert_short_code_claim(
            body.provision_id, "openclaw_provision", reopen=True
        )
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")

    try:
        await _ensure_agent_owner_role(db, owner_user_id)
        await db.commit()
    except Exception:
        await db.rollback()
        await _revert_short_code_claim(
            body.provision_id, "openclaw_provision", reopen=True
        )
        raise
    await db.refresh(agent)

    return {
        "agent_id": agent.agent_id,
        "key_id": key_id,
        "token": agent_token,
        "token_expires_at": expires_at_ts,
        "display_name": agent.display_name,
        "bio": agent.bio,
    }


# ---------------------------------------------------------------------------
# WS /openclaw/control
# ---------------------------------------------------------------------------


_HOST_INITIATED_TYPES = {"heartbeat", "pong"}


@router.websocket("/openclaw/control")
async def openclaw_control_ws(ws: WebSocket) -> None:
    """Long-lived host control channel.

    Auth: ``Authorization: Bearer <openclaw host access JWT>``. Each frame
    pushed by Hub is signed with the same Ed25519 key used for daemons.
    """
    auth_header = ws.headers.get("authorization") or ws.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        await ws.close(code=4401, reason="missing bearer")
        return
    token = auth_header[len("Bearer ") :]
    try:
        claims = _verify_host_access_token(token)
    except HTTPException as exc:
        await ws.close(code=4401, reason=exc.detail or "auth")
        return

    host_instance_id = claims["openclaw_host_id"]
    owner_user_id = claims.get("user_id") or ""

    async with async_session() as db:
        result = await db.execute(
            select(OpenclawHostInstance).where(
                OpenclawHostInstance.id == host_instance_id
            )
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

    conn = _HostConn(
        ws=ws,
        owner_user_id=owner_user_id,
        host_instance_id=host_instance_id,
        pending_acks={},
    )
    previous = await _REGISTRY.register(conn)
    if previous is not None:
        try:
            await previous.ws.close(code=4001, reason="displaced by new connection")
        except Exception:
            pass

    hello = _build_signed_frame(
        "hello",
        {"server_time": int(_now().timestamp() * 1000)},
    )
    try:
        await ws.send_text(json.dumps(hello))
    except Exception as exc:  # noqa: BLE001
        logger.warning("openclaw hello send failed: %s", exc)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("openclaw WS: non-JSON frame, dropping")
                continue
            if not isinstance(msg, dict):
                continue

            # Ack of a Hub-issued dispatch.
            if "ok" in msg and isinstance(msg.get("id"), str) and "type" not in msg:
                fut = conn.pending_acks.pop(msg["id"], None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
                continue

            # Host-initiated event (heartbeat, pong).
            await _handle_host_event(conn, msg)

    except WebSocketDisconnect:
        logger.info("openclaw WS disconnect: instance=%s", host_instance_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("openclaw WS error: instance=%s err=%s", host_instance_id, exc)
    finally:
        await _REGISTRY.unregister(conn)
        for fut in conn.pending_acks.values():
            if not fut.done():
                fut.set_exception(RuntimeError("host disconnected"))


async def _handle_host_event(conn: _HostConn, msg: dict[str, Any]) -> None:
    msg_id = msg.get("id")
    msg_type = msg.get("type")
    if not isinstance(msg_id, str) or not isinstance(msg_type, str):
        return

    if msg_type not in _HOST_INITIATED_TYPES:
        ack = {
            "id": msg_id,
            "ok": False,
            "error": {"code": "unknown_type", "message": f"unknown host event type: {msg_type}"},
        }
        try:
            await conn.ws.send_text(json.dumps(ack))
        except Exception:
            pass
        return

    try:
        async with async_session() as db:
            result = await db.execute(
                select(OpenclawHostInstance).where(
                    OpenclawHostInstance.id == conn.host_instance_id
                )
            )
            instance = result.scalar_one_or_none()
            if instance is not None:
                instance.last_seen_at = _now()
                await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug("openclaw event persist failed: %s", exc)

    ack = {"id": msg_id, "ok": True}
    try:
        await conn.ws.send_text(json.dumps(ack))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _registry_for_tests() -> _HostRegistry:
    return _REGISTRY
