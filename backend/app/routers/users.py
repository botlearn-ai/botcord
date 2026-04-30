"""
[INPUT]: 依赖用户鉴权上下文、Hub token 校验、数据库会话与 Agent 模型完成 dashboard 身份流转
[OUTPUT]: 对外提供 /api/users 用户资料、Agent 认领、短码绑定与默认身份切换接口
[POS]: app BFF 用户入口，把浏览器态与 Agent 身份绑定协议收敛成单一边界
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

import asyncio
import base64
import datetime
import hashlib
import hmac
import json
import logging
import os
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, case, func as sa_func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub import config as hub_config
from hub.auth import create_agent_token, verify_agent_token
from hub.config import BIND_PROOF_SECRET, HUB_PUBLIC_BASE_URL, JWT_SECRET
from hub.routers.hub import is_agent_ws_online
from hub.routers.daemon_control import is_daemon_online, send_control_frame
from hub.crypto import verify_challenge_sig
from hub.database import async_session as _default_session_factory, get_db
from hub.models import (
    Agent,
    AgentSubscription,
    DaemonInstance,
    OpenclawHostInstance,
    Role,
    ShortCode,
    SigningKey,
    SubscriptionChargeAttempt,
    SubscriptionProduct,
    TopupRequest,
    User,
    UserRole,
    WalletAccount,
    WalletTransaction,
    WithdrawalRequest,
)
from hub.id_generators import generate_agent_id, generate_key_id
from hub.enums import (
    KeyState,
    SubscriptionChargeAttemptStatus,
    SubscriptionProductStatus,
    SubscriptionStatus,
    TopupStatus,
    TxStatus,
    WithdrawalStatus,
)
from hub.schemas import ResetCredentialResponse
from hub.services import wallet as wallet_svc
from hub.services.wallet import get_or_create_wallet
from hub.validators import parse_pubkey

from nacl.signing import SigningKey as NaClSigningKey

# Bind-code onboarding: short TTL + per-user active cap.
BIND_TICKET_TTL_MINUTES = 30
MAX_ACTIVE_BIND_CODES_PER_USER = 5

_logger = logging.getLogger(__name__)

# Session factory for jti consumption. Uses a separate connection so the
# insert commits independently of the caller's transaction.  Tests can
# override this to point at the in-memory SQLite engine.
_jti_session_factory = _default_session_factory
_short_code_session_factory = _default_session_factory

router = APIRouter(prefix="/api/users", tags=["app-users"])


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class PatchAgentBody(BaseModel):
    is_default: bool | None = None
    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    bio: str | None = Field(default=None, max_length=4000)


class ClaimResolveBody(BaseModel):
    claim_code: str


class ClaimAgentBody(BaseModel):
    agent_id: str
    display_name: str
    agent_token: str | None = None
    bind_proof: dict | None = None  # {key_id, nonce, sig}
    bind_ticket: str | None = None


class AgentBindBody(BaseModel):
    agent_id: str
    display_name: str
    agent_token: str
    bind_ticket: str | None = None
    bind_code: str | None = None


class ResetCredentialTicketResponse(BaseModel):
    agent_id: str
    reset_code: str
    reset_ticket: str
    expires_at: int


class ResetCredentialBody(BaseModel):
    agent_id: str
    pubkey: str
    reset_ticket: str | None = None
    reset_code: str | None = None


# ---------------------------------------------------------------------------
# Helper: agent metadata dict
# ---------------------------------------------------------------------------


def _agent_meta(agent: Agent) -> dict:
    return {
        "agent_id": agent.agent_id,
        "display_name": agent.display_name,
        "bio": agent.bio,
        "is_default": agent.is_default,
        "claimed_at": agent.claimed_at.isoformat() if agent.claimed_at else None,
    }


# ---------------------------------------------------------------------------
# Helper: bind ticket verification
# ---------------------------------------------------------------------------


def _verify_bind_ticket(ticket: str) -> dict | None:
    """Verify a bind ticket's HMAC signature and expiry.

    Returns the decoded payload dict on success, or None on failure.
    jti replay protection is enforced at the DB level via UsedBindTicket
    in _consume_bind_ticket_jti(), called by the route after this returns.
    """
    parts = ticket.split(".")
    if len(parts) != 2:
        return None

    payload_b64, sig_b64 = parts

    secret = BIND_PROOF_SECRET or JWT_SECRET
    expected_sig = hmac.new(
        secret.encode(), payload_b64.encode(), hashlib.sha256
    ).digest()

    try:
        actual_sig = base64.urlsafe_b64decode(sig_b64)
    except Exception:
        return None

    if not hmac.compare_digest(expected_sig, actual_sig):
        return None

    try:
        payload_json = base64.urlsafe_b64decode(payload_b64).decode()
        payload = json.loads(payload_json)
    except Exception:
        return None

    # Check expiry
    exp = payload.get("exp")
    if exp is None:
        return None
    now_ts = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    if now_ts > exp:
        return None

    # Require jti for later replay check
    if not payload.get("jti"):
        return None

    return payload


def _utc_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


async def _ensure_agent_owner_role(
    db: AsyncSession,
    user_id: UUID,
) -> None:
    """Ensure the claiming user owns the agent_owner role."""
    role_result = await db.execute(select(Role).where(Role.name == "agent_owner"))
    agent_owner_role = role_result.scalar_one_or_none()
    if agent_owner_role is None:
        return

    existing_ur = await db.execute(
        select(UserRole).where(
            UserRole.user_id == user_id,
            UserRole.role_id == agent_owner_role.id,
        )
    )
    if existing_ur.scalar_one_or_none() is None:
        db.add(UserRole(user_id=user_id, role_id=agent_owner_role.id))


async def _maybe_remove_agent_owner_role(db: AsyncSession, user_id: UUID) -> None:
    """Remove global agent_owner role only after the user owns no active agents."""
    remaining_result = await db.execute(
        select(sa_func.count())
        .select_from(Agent)
        .where(
            Agent.user_id == user_id,
            Agent.status == "active",
        )
    )
    if (remaining_result.scalar_one() or 0) > 0:
        return

    role_result = await db.execute(select(Role).where(Role.name == "agent_owner"))
    agent_owner_role = role_result.scalar_one_or_none()
    if agent_owner_role is None:
        return

    await db.execute(
        delete(UserRole).where(
            UserRole.user_id == user_id,
            UserRole.role_id == agent_owner_role.id,
        )
    )


async def _ensure_agent_unbind_allowed(db: AsyncSession, agent_id: str) -> None:
    wallet_result = await db.execute(
        select(WalletAccount.id)
        .where(
            WalletAccount.owner_id == agent_id,
            (WalletAccount.available_balance_minor != 0)
            | (WalletAccount.locked_balance_minor != 0),
        )
        .limit(1)
    )
    if wallet_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="wallet_not_empty")

    # An agent being decommissioned could be either the owner of an
    # agent-owned product OR the provider for a human-owned product. Block
    # decommission while either kind has active subscribers.
    active_owner_products = (
        select(SubscriptionProduct.product_id)
        .where(
            (SubscriptionProduct.owner_id == agent_id)
            | (SubscriptionProduct.provider_agent_id == agent_id),
            SubscriptionProduct.status == SubscriptionProductStatus.active,
        )
        .subquery()
    )
    subscriber_result = await db.execute(
        select(AgentSubscription.id)
        .where(
            AgentSubscription.product_id.in_(select(active_owner_products.c.product_id)),
            AgentSubscription.status == SubscriptionStatus.active,
        )
        .limit(1)
    )
    if subscriber_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="product_has_subscribers")

    pending_tx_result = await db.execute(
        select(WalletTransaction.id)
        .where(
            (
                (WalletTransaction.from_owner_id == agent_id)
                | (WalletTransaction.to_owner_id == agent_id)
                | (WalletTransaction.initiator_owner_id == agent_id)
            ),
            WalletTransaction.status.in_([TxStatus.pending, TxStatus.processing]),
        )
        .limit(1)
    )
    if pending_tx_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="pending_obligations")

    pending_topup_result = await db.execute(
        select(TopupRequest.id)
        .where(TopupRequest.owner_id == agent_id, TopupRequest.status == TopupStatus.pending)
        .limit(1)
    )
    pending_withdrawal_result = await db.execute(
        select(WithdrawalRequest.id)
        .where(
            WithdrawalRequest.owner_id == agent_id,
            WithdrawalRequest.status.in_([WithdrawalStatus.pending, WithdrawalStatus.approved]),
        )
        .limit(1)
    )
    pending_charge_result = await db.execute(
        select(SubscriptionChargeAttempt.id)
        .join(
            AgentSubscription,
            AgentSubscription.subscription_id == SubscriptionChargeAttempt.subscription_id,
        )
        .where(
            (
                (AgentSubscription.subscriber_agent_id == agent_id)
                | (AgentSubscription.provider_agent_id == agent_id)
            ),
            SubscriptionChargeAttempt.status == SubscriptionChargeAttemptStatus.pending,
        )
        .limit(1)
    )
    if (
        pending_topup_result.scalar_one_or_none() is not None
        or pending_withdrawal_result.scalar_one_or_none() is not None
        or pending_charge_result.scalar_one_or_none() is not None
    ):
        raise HTTPException(status_code=409, detail="pending_obligations")


async def _cancel_agent_subscriptions(db: AsyncSession, agent_id: str, now: datetime.datetime) -> None:
    result = await db.execute(
        select(AgentSubscription).where(
            AgentSubscription.subscriber_agent_id == agent_id,
            AgentSubscription.status == SubscriptionStatus.active,
        )
    )
    for subscription in result.scalars().all():
        subscription.status = SubscriptionStatus.cancelled
        subscription.cancelled_at = now
        subscription.cancel_at_period_end = False


async def _promote_next_default_agent(db: AsyncSession, user_id: UUID, agent_id: str) -> None:
    next_result = await db.execute(
        select(Agent)
        .where(
            Agent.user_id == user_id,
            Agent.agent_id != agent_id,
            Agent.status == "active",
        )
        .order_by(Agent.created_at)
        .limit(1)
    )
    next_agent = next_result.scalar_one_or_none()
    if next_agent is not None:
        next_agent.is_default = True


async def _unbind_agent_from_user(db: AsyncSession, agent_id: str, user_id: UUID) -> dict:
    result = await db.execute(
        select(Agent).where(
            Agent.agent_id == agent_id,
            Agent.user_id == user_id,
            Agent.status == "active",
        )
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    await _ensure_agent_unbind_allowed(db, agent_id)

    now = _utc_now()
    was_default = agent.is_default
    daemon_instance_id = agent.daemon_instance_id

    await _cancel_agent_subscriptions(db, agent_id, now)

    agent.user_id = None
    agent.claimed_at = None
    agent.is_default = False
    agent.agent_token = None
    agent.token_expires_at = None
    agent.daemon_instance_id = None
    agent.claim_code = f"clm_{uuid4().hex}"

    if was_default:
        await _promote_next_default_agent(db, user_id, agent_id)

    await _maybe_remove_agent_owner_role(db, user_id)
    await db.flush()
    return {
        "agent_id": agent_id,
        "unbound_at": now.isoformat(),
        "daemon_instance_id": daemon_instance_id,
    }


async def _maybe_grant_claim_gift(
    db: AsyncSession,
    agent: Agent,
) -> None:
    """Grant the cold-start claim gift exactly once per agent within the window."""
    if not hub_config.is_claim_gift_active():
        return

    await wallet_svc.create_grant(
        db,
        owner_id=agent.agent_id,
        amount_minor=hub_config.CLAIM_GIFT_AMOUNT_MINOR,
        asset_code=hub_config.CLAIM_GIFT_ASSET_CODE,
        idempotency_key="claim-cold-start-gift-v1",
        memo="Cold-start claim gift",
        reference_type="agent_claim_gift",
        reference_id=agent.agent_id,
        metadata={
            "campaign": "claim_cold_start_2026_q2",
            "claimed_at": agent.claimed_at.isoformat() if agent.claimed_at else None,
        },
    )


async def _peek_short_code(code: str, kind: str, payload_key: str) -> str | None:
    """Validate a short code and return a payload field WITHOUT consuming it."""
    async with _short_code_session_factory() as code_session:
        now = _utc_now()
        result = await code_session.execute(
            select(ShortCode.payload_json).where(
                ShortCode.code == code,
                ShortCode.kind == kind,
                ShortCode.consumed_at.is_(None),
                ShortCode.use_count < ShortCode.max_uses,
                ShortCode.expires_at > now,
            )
        )
        payload_json = result.scalar_one_or_none()
        if payload_json is None:
            return None
        try:
            payload = json.loads(payload_json)
        except json.JSONDecodeError:
            return None
        ticket = payload.get(payload_key)
        return ticket if isinstance(ticket, str) else None


async def _consume_short_code(code: str, kind: str) -> bool:
    """Atomically consume a short code. Returns True on success."""
    async with _short_code_session_factory() as code_session:
        now = _utc_now()
        result = await code_session.execute(
            update(ShortCode)
            .where(
                ShortCode.code == code,
                ShortCode.kind == kind,
                ShortCode.consumed_at.is_(None),
                ShortCode.use_count < ShortCode.max_uses,
                ShortCode.expires_at > now,
            )
            .values(
                use_count=ShortCode.use_count + 1,
                consumed_at=case(
                    (ShortCode.use_count + 1 >= ShortCode.max_uses, now),
                    else_=ShortCode.consumed_at,
                ),
            )
        )
        if result.rowcount == 0:
            await code_session.rollback()
            return False
        await code_session.commit()
        return True


async def _peek_bind_code(code: str) -> str | None:
    return await _peek_short_code(code, "bind", "bind_ticket")


async def _consume_bind_code(code: str) -> bool:
    return await _consume_short_code(code, "bind")


async def _revert_short_code_claim(
    code: str, kind: str, *, reopen: bool = False
) -> None:
    """Best-effort: roll back a ``claimed_agent_id`` stamp on a short_code.

    Used when the downstream insert (Agent / SigningKey / etc.) fails
    after :func:`_consume_short_code_with_claim` already stamped the
    short_code. The claim metadata is always stripped so polling never
    reports a phantom "claimed but agent missing" state.

    ``reopen`` controls what happens to the consumed bookkeeping:

    - ``False`` (default, **safe for bind tickets**): leave ``consumed_at``
      and ``use_count`` set. The row stays terminal — polling reports the
      bind code as no longer pending and the user must request a fresh one.
      This avoids a phantom-pending state when the ``jti`` was burned by
      :func:`_consume_bind_ticket_jti` (one-shot, irreversible) and the
      ticket can therefore never be redeemed again even if reopened.

    - ``True``: also reset ``consumed_at = None`` and ``use_count = 0`` so
      the code can be re-redeemed. Only safe for short_code kinds whose
      consume path is *not* JTI-gated (e.g. ``openclaw_provision``).

    Failures are swallowed: if the revert can't run (DB down, transaction
    poisoned), the row is left consumed-with-stamp, which is the
    fail-closed direction for credential issuance.
    """
    try:
        async with _short_code_session_factory() as code_session:
            select_result = await code_session.execute(
                select(ShortCode.payload_json).where(
                    ShortCode.code == code,
                    ShortCode.kind == kind,
                )
            )
            existing = select_result.scalar_one_or_none()
            if existing is None:
                return
            try:
                payload = json.loads(existing)
            except json.JSONDecodeError:
                payload = {}
            payload.pop("claimed_agent_id", None)
            payload.pop("claimed_at", None)
            new_payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
            values: dict = {"payload_json": new_payload_json}
            if reopen:
                values["consumed_at"] = None
                values["use_count"] = 0
            await code_session.execute(
                update(ShortCode)
                .where(ShortCode.code == code, ShortCode.kind == kind)
                .values(**values)
            )
            await code_session.commit()
    except Exception:  # noqa: BLE001
        pass


async def _consume_short_code_with_claim(code: str, kind: str, agent_id: str) -> bool:
    """Generalized variant of :func:`_consume_bind_code_with_claim`.

    Atomically consumes any ``ShortCode`` row by ``(code, kind)`` and
    stamps ``payload_json.claimed_agent_id`` in the same transaction so
    polling readers never observe a "consumed but no agent" intermediate
    state. Used by both the bind-ticket install path and the OpenClaw
    install / provision claim paths.
    """
    async with _short_code_session_factory() as code_session:
        now = _utc_now()
        select_result = await code_session.execute(
            select(ShortCode.payload_json).where(
                ShortCode.code == code,
                ShortCode.kind == kind,
                ShortCode.consumed_at.is_(None),
                ShortCode.use_count < ShortCode.max_uses,
                ShortCode.expires_at > now,
            )
        )
        existing_payload_json = select_result.scalar_one_or_none()
        if existing_payload_json is None:
            return False
        try:
            payload = json.loads(existing_payload_json)
        except json.JSONDecodeError:
            payload = {}
        payload["claimed_agent_id"] = agent_id
        payload["claimed_at"] = now.isoformat()
        new_payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)

        update_result = await code_session.execute(
            update(ShortCode)
            .where(
                ShortCode.code == code,
                ShortCode.kind == kind,
                ShortCode.consumed_at.is_(None),
                ShortCode.use_count < ShortCode.max_uses,
                ShortCode.expires_at > now,
            )
            .values(
                use_count=ShortCode.use_count + 1,
                consumed_at=case(
                    (ShortCode.use_count + 1 >= ShortCode.max_uses, now),
                    else_=ShortCode.consumed_at,
                ),
                payload_json=new_payload_json,
            )
        )
        if update_result.rowcount == 0:
            await code_session.rollback()
            return False
        await code_session.commit()
        return True


async def _consume_bind_code_with_claim(code: str, agent_id: str) -> bool:
    """Atomically consume a bind code AND stamp the resulting agent_id.

    install-claim derives ``agent_id`` deterministically from the public
    key before it ever touches the short_code row, so we can write
    ``payload_json.claimed_agent_id`` in the same transaction that flips
    ``consumed_at`` to non-null. Doing it as two separate writes left a
    race window where ``GET /bind-ticket/{code}`` between the consume and
    the metadata write saw a consumed row with no claimed_agent_id and
    reported it as ``revoked`` — terminal-looking — even though the
    agent was about to appear.

    Returns True on first-use, False if the code was already consumed,
    expired, or unknown (semantics identical to ``_consume_bind_code``).
    """
    return await _consume_short_code_with_claim(code, "bind", agent_id)


async def _peek_reset_code(code: str) -> str | None:
    return await _peek_short_code(code, "credential_reset", "reset_ticket")


async def _consume_reset_code(code: str) -> bool:
    return await _consume_short_code(code, "credential_reset")


def _build_signed_ticket(payload: dict) -> str:
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    payload_b64 = base64.urlsafe_b64encode(payload_json.encode()).decode()

    secret = BIND_PROOF_SECRET or JWT_SECRET
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).decode()

    return f"{payload_b64}.{sig_b64}"


async def _consume_bind_ticket_jti(jti: str) -> bool:
    """Consume a bind ticket jti via the UsedBindTicket table.

    Opens a **separate DB session** (independent connection) and commits
    immediately.  Because this is a different transaction from the caller,
    the INSERT survives even if the caller's transaction later rolls back
    (e.g. proof verification or agent-bind failure).  This is the only way
    to guarantee true one-time use: the jti is burned the moment we check
    it, regardless of what happens afterwards in the request.

    Returns True if consumed (first use), False if already used.
    Works across all workers/instances because it's DB-backed.
    """
    from hub.models import UsedBindTicket

    async with _jti_session_factory() as jti_session:
        jti_session.add(UsedBindTicket(jti=jti))
        try:
            await jti_session.commit()
            return True
        except IntegrityError:
            return False


# ---------------------------------------------------------------------------
# Helper: verify agent control via hub JWT verification (direct call)
# ---------------------------------------------------------------------------


def _verify_agent_control(agent_id: str, agent_token: str) -> bool:
    """Verify that agent_token is a valid hub JWT for the given agent_id.

    Uses hub.auth.verify_agent_token directly — no HTTP self-call.
    """
    try:
        token_agent_id = verify_agent_token(agent_token)
        return token_agent_id == agent_id
    except Exception:
        return False


def _verify_reset_ticket(ticket: str) -> dict | None:
    payload = _verify_bind_ticket(ticket)
    if payload is None:
        return None
    if payload.get("purpose") != "credential_reset":
        return None
    agent_id = payload.get("agent_id")
    return payload if isinstance(agent_id, str) and agent_id.startswith("ag_") else None


# ---------------------------------------------------------------------------
# Helper: refresh agent token with bind proof (direct internal call)
# ---------------------------------------------------------------------------


async def _refresh_agent_token_with_proof(
    db: AsyncSession,
    agent_id: str,
    bind_proof: dict,
) -> str | None:
    """Verify Ed25519 bind proof and issue a new agent token.

    Directly calls registry-layer logic instead of HTTP self-call.
    Returns the agent_token string on success, or None on failure.
    """
    from hub.models import SigningKey, KeyState, UsedNonce

    key_id = bind_proof.get("key_id")
    nonce = bind_proof.get("nonce")
    sig = bind_proof.get("sig")
    if not key_id or not nonce or not sig:
        return None

    # 1. Look up the signing key
    result = await db.execute(
        select(SigningKey).where(
            SigningKey.key_id == key_id,
            SigningKey.agent_id == agent_id,
        )
    )
    signing_key = result.scalar_one_or_none()
    if signing_key is None or signing_key.state != KeyState.active:
        return None

    # 2. Check nonce not already used (anti-replay)
    nonce_result = await db.execute(
        select(UsedNonce).where(
            UsedNonce.agent_id == agent_id,
            UsedNonce.nonce == nonce,
        )
    )
    if nonce_result.scalar_one_or_none() is not None:
        return None

    # 3. Verify Ed25519 signature over the nonce
    pubkey_b64 = signing_key.pubkey[len("ed25519:"):]
    if not verify_challenge_sig(pubkey_b64, nonce, sig):
        return None

    # 4. Record nonce as used (savepoint so concurrent requests get IntegrityError
    #    without rolling back the caller's pending changes)
    try:
        async with db.begin_nested():
            db.add(UsedNonce(agent_id=agent_id, nonce=nonce))
    except IntegrityError:
        return None  # concurrent request already consumed this nonce

    # 5. Issue new token
    token, _expires_at = create_agent_token(agent_id)
    return token


# ---------------------------------------------------------------------------
# Helper: bind agent to user (shared by claim_agent and agent_bind)
# ---------------------------------------------------------------------------


async def _bind_agent_to_user(
    db: AsyncSession,
    user_id: UUID,
    agent_id: str,
    display_name: str,
    agent_token: str,
) -> Agent:
    """Find or create an agent, verify not already claimed, check quota, and bind.

    Uses a conditional UPDATE (WHERE user_id IS NULL) to prevent race conditions.
    Returns the bound Agent. Raises HTTPException on error.
    """
    # Check user's agent quota first
    user_result = await db.execute(select(User).where(User.id == user_id))
    user = user_result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    count_result = await db.execute(
        select(sa_func.count())
        .select_from(Agent)
        .where(Agent.user_id == user_id, Agent.status == "active")
    )
    current_count = count_result.scalar_one()

    if current_count >= user.max_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Agent quota exceeded (max {user.max_agents})",
        )

    is_first = current_count == 0
    now = datetime.datetime.now(datetime.timezone.utc)

    # Find existing agent
    result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is not None and agent.status != "active":
        raise HTTPException(status_code=410, detail="agent_deleted")

    if agent is None:
        # Agent not in DB yet — try insert inside a savepoint; if a concurrent
        # request created the same agent_id, the savepoint rolls back without
        # affecting the outer transaction, and we fall through to conditional update.
        agent = Agent(
            agent_id=agent_id,
            display_name=display_name,
            user_id=user_id,
            agent_token=agent_token,
            is_default=is_first,
            claimed_at=now,
        )
        try:
            async with db.begin_nested():
                db.add(agent)
        except IntegrityError:
            # Re-read: another request created it first
            result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
            agent = result.scalar_one_or_none()
            if agent is None:
                raise HTTPException(status_code=500, detail="Agent creation race failed")
            if agent.user_id is not None:
                raise HTTPException(status_code=409, detail="Agent already claimed")
            # Fall through to conditional update below
            upd_result = await db.execute(
                update(Agent)
                .where(
                    Agent.agent_id == agent_id,
                    Agent.user_id.is_(None),
                    Agent.status == "active",
                )
                .values(
                    user_id=user_id,
                    display_name=display_name,
                    agent_token=agent_token,
                    is_default=is_first,
                    claimed_at=now,
                )
            )
            if upd_result.rowcount == 0:
                raise HTTPException(status_code=409, detail="Agent already claimed")
            await db.refresh(agent)
    else:
        if agent.user_id is not None:
            raise HTTPException(status_code=409, detail="Agent already claimed")

        # Atomic conditional update: only bind if user_id is still NULL
        upd_result = await db.execute(
            update(Agent)
            .where(
                Agent.agent_id == agent_id,
                Agent.user_id.is_(None),
                Agent.status == "active",
            )
            .values(
                user_id=user_id,
                display_name=display_name,
                agent_token=agent_token,
                is_default=is_first,
                claimed_at=now,
            )
        )
        if upd_result.rowcount == 0:
            # Concurrent claim raced and won
            raise HTTPException(status_code=409, detail="Agent already claimed")

        # Refresh to get updated state
        await db.refresh(agent)

    await _ensure_agent_owner_role(db, user_id)
    await _maybe_grant_claim_gift(db, agent)

    await db.commit()
    await db.refresh(agent)
    return agent


# ---------------------------------------------------------------------------
# Existing routes
# ---------------------------------------------------------------------------


@router.get("/me")
async def get_me(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the authenticated user profile with roles and agents."""
    from hub.models import User, UserRole, Role

    # Load user
    result = await db.execute(select(User).where(User.id == ctx.user_id))
    user = result.scalar_one()

    # Load roles
    role_result = await db.execute(
        select(Role.name)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.user_id == user.id)
    )
    roles = [row[0] for row in role_result.all()]

    # Load agents belonging to this user
    agent_result = await db.execute(
        select(Agent)
        .where(Agent.user_id == user.id, Agent.status == "active")
        .order_by(Agent.created_at)
    )
    agents = agent_result.scalars().all()

    return {
        "id": str(user.id),
        "display_name": user.display_name,
        "email": user.email,
        "avatar_url": user.avatar_url,
        "status": user.status,
        "max_agents": user.max_agents,
        "beta_access": user.beta_access,
        "beta_admin": user.beta_admin,
        "roles": roles,
        "agents": [
            {
                "agent_id": a.agent_id,
                "display_name": a.display_name,
                "bio": a.bio,
                "is_default": a.is_default,
                "claimed_at": a.claimed_at.isoformat() if a.claimed_at else None,
                "ws_online": is_agent_ws_online(a.agent_id),
                "daemon_instance_id": a.daemon_instance_id,
            }
            for a in agents
        ],
    }


@router.get("/me/agents")
async def get_my_agents(
    include_deleted: bool = Query(default=False),
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Return list of agents belonging to the authenticated user."""
    stmt = select(Agent).where(Agent.user_id == ctx.user_id)
    if not include_deleted:
        stmt = stmt.where(Agent.status == "active")
    agent_result = await db.execute(
        stmt.order_by(Agent.created_at)
    )
    agents = agent_result.scalars().all()

    return {
        "agents": [
            {
                "agent_id": a.agent_id,
                "display_name": a.display_name,
                "bio": a.bio,
                "message_policy": a.message_policy.value if a.message_policy else None,
                "is_default": a.is_default,
                "claimed_at": a.claimed_at.isoformat() if a.claimed_at else None,
                "status": a.status,
                "deleted_at": a.deleted_at.isoformat() if a.deleted_at else None,
                "ws_online": is_agent_ws_online(a.agent_id),
            }
            for a in agents
        ],
    }


# ---------------------------------------------------------------------------
# GET /api/users/me/agents/{agent_id}/identity
# ---------------------------------------------------------------------------


@router.get("/me/agents/{agent_id}/identity")
async def get_agent_identity(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Return agent_id and agent_token for the specified agent owned by the user."""
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

    return {
        "agent_id": agent.agent_id,
        "agent_token": agent.agent_token,
    }


# ---------------------------------------------------------------------------
# DELETE /api/users/me/agents/{agent_id}/binding
# ---------------------------------------------------------------------------


@router.delete("/me/agents/{agent_id}/binding")
async def unbind_agent_binding(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Unbind an active agent from the current user."""
    payload = await _unbind_agent_from_user(db, agent_id, ctx.user_id)
    await db.commit()
    _schedule_daemon_revoke(payload)
    return payload


@router.delete("/me/agents/{agent_id}")
async def delete_agent(
    agent_id: str,
    response: Response,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Deprecated alias for unbinding an agent from the current user."""
    payload = await _unbind_agent_from_user(db, agent_id, ctx.user_id)
    await db.commit()
    _schedule_daemon_revoke(payload)
    response.headers["Deprecation"] = "true"
    response.headers["Link"] = f'</api/users/me/agents/{agent_id}/binding>; rel="successor-version"'
    return {"ok": True, "deprecated": True, **payload}


# ---------------------------------------------------------------------------
# PATCH /api/users/me/agents/{agent_id}
# ---------------------------------------------------------------------------


@router.patch("/me/agents/{agent_id}")
async def patch_agent(
    agent_id: str,
    body: PatchAgentBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Update agent attributes (is_default, display_name, bio)."""
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

    if body.is_default is True:
        # Unset default on all other agents for this user
        await db.execute(
            update(Agent)
            .where(
                Agent.user_id == ctx.user_id,
                Agent.agent_id != agent_id,
                Agent.status == "active",
            )
            .values(is_default=False)
        )
        agent.is_default = True

    identity_changed = False
    if body.display_name is not None:
        name = body.display_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="display_name must not be empty")
        if agent.display_name != name:
            agent.display_name = name
            identity_changed = True

    if body.bio is not None:
        # Normalise empty string to NULL so it reads as "no bio" downstream.
        bio = body.bio.strip() or None
        if agent.bio != bio:
            agent.bio = bio
            identity_changed = True

    await db.commit()
    await db.refresh(agent)

    # Best-effort live push to the daemon — fire-and-forget so a slow or
    # half-open daemon WS can never inflate this PATCH's latency. Offline
    # daemons reconcile via the `hello.agents` snapshot on next reconnect.
    if identity_changed and agent.daemon_instance_id and is_daemon_online(agent.daemon_instance_id):
        params: dict[str, object | None] = {"agentId": agent.agent_id}
        if body.display_name is not None:
            params["displayName"] = agent.display_name
        if body.bio is not None:
            params["bio"] = agent.bio
        task = asyncio.create_task(
            _push_update_agent_frame(agent.daemon_instance_id, agent.agent_id, params)
        )
        # Keep a strong reference until completion — without this, the
        # asyncio event loop only weakly tracks tasks and GC can collect
        # the coroutine mid-flight (documented CPython behaviour).
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_TASKS.discard)

    return _agent_meta(agent)


# Strong-reference set keeping fire-and-forget background tasks alive until
# they complete. See the matching `add` / `discard` calls in `patch_agent`.
_BACKGROUND_TASKS: set[asyncio.Task] = set()


def _schedule_daemon_revoke(payload: dict) -> None:
    agent_id = payload.get("agent_id")
    daemon_instance_id = payload.get("daemon_instance_id")
    if not agent_id or not daemon_instance_id:
        return
    if not is_daemon_online(str(daemon_instance_id)):
        _logger.info(
            "revoke_agent push skipped: agent=%s daemon=%s offline",
            agent_id,
            daemon_instance_id,
        )
        return

    task = asyncio.create_task(
        _push_revoke_agent_frame(str(daemon_instance_id), str(agent_id))
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


async def _push_update_agent_frame(
    daemon_instance_id: str, agent_id: str, params: dict[str, object | None]
) -> None:
    """Best-effort `update_agent` dispatch — never raises, only logs."""
    try:
        await send_control_frame(daemon_instance_id, "update_agent", params)
    except HTTPException as exc:
        _logger.info(
            "update_agent push skipped: agent=%s status=%s detail=%s",
            agent_id,
            exc.status_code,
            exc.detail,
        )
    except Exception as exc:  # noqa: BLE001
        _logger.warning(
            "update_agent push failed: agent=%s err=%s", agent_id, exc
        )


async def _push_revoke_agent_frame(daemon_instance_id: str, agent_id: str) -> None:
    """Best-effort `revoke_agent` dispatch — never raises, only logs."""
    params: dict[str, object] = {
        "agentId": agent_id,
        "deleteCredentials": True,
        "deleteState": True,
        "deleteWorkspace": False,
    }
    try:
        await send_control_frame(daemon_instance_id, "revoke_agent", params)
    except HTTPException as exc:
        _logger.info(
            "revoke_agent push skipped: agent=%s status=%s detail=%s",
            agent_id,
            exc.status_code,
            exc.detail,
        )
    except Exception as exc:  # noqa: BLE001
        _logger.warning(
            "revoke_agent push failed: agent=%s err=%s", agent_id, exc
        )


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/bind-ticket
# ---------------------------------------------------------------------------


class BindTicketBody(BaseModel):
    intended_name: str | None = Field(default=None, max_length=128)


def _build_install_command(bind_code: str, nonce: str) -> str:
    base = HUB_PUBLIC_BASE_URL.rstrip("/")
    return (
        f"curl -fsSL {base}/openclaw/install.sh | bash -s -- "
        f"--bind-code {bind_code} --bind-nonce {nonce}"
    )


@router.post("/me/agents/bind-ticket")
async def create_bind_ticket(
    body: BindTicketBody | None = None,
    ctx: RequestContext = Depends(require_user),
):
    """Issue a one-time bind ticket for cryptographic agent binding.

    Phase 1 onboarding: short TTL, per-user active-code cap, embeds
    ``purpose=install_claim`` and a base64 32-byte nonce so the same code
    can be redeemed by ``install-claim`` with an Ed25519 proof of possession.
    """
    intended_name = (body.intended_name.strip() if body and body.intended_name else None) or None

    now = _utc_now()
    exp = now + datetime.timedelta(minutes=BIND_TICKET_TTL_MINUTES)
    # Base64 32-byte nonce so the install client can sign it as an Ed25519 challenge.
    nonce = base64.b64encode(os.urandom(32)).decode()
    jti = uuid4().hex
    bind_code = f"bd_{uuid4().hex[:12]}"

    # Cap concurrently active install codes per user.
    async with _short_code_session_factory() as code_session:
        active_count_result = await code_session.execute(
            select(sa_func.count())
            .select_from(ShortCode)
            .where(
                ShortCode.kind == "bind",
                ShortCode.owner_user_id == ctx.user_id,
                ShortCode.consumed_at.is_(None),
                ShortCode.expires_at > now,
            )
        )
        active_count = active_count_result.scalar_one()
        if active_count >= MAX_ACTIVE_BIND_CODES_PER_USER:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Too many active bind codes (max {MAX_ACTIVE_BIND_CODES_PER_USER}); "
                    "revoke or wait for one to expire"
                ),
            )

    ticket_payload = {
        "uid": str(ctx.user_id),
        "purpose": "install_claim",
        "nonce": nonce,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "jti": jti,
    }
    if intended_name:
        ticket_payload["intended_name"] = intended_name

    ticket = _build_signed_ticket(ticket_payload)

    short_code_payload: dict = {"bind_ticket": ticket}
    if intended_name:
        short_code_payload["intended_name"] = intended_name

    short_code = ShortCode(
        code=bind_code,
        kind="bind",
        owner_user_id=ctx.user_id,
        payload_json=json.dumps(short_code_payload, separators=(",", ":"), sort_keys=True),
        expires_at=exp,
    )
    async with _short_code_session_factory() as code_session:
        code_session.add(short_code)
        await code_session.commit()

    install_command = _build_install_command(bind_code, nonce)

    return {
        "bind_code": bind_code,
        "bind_ticket": ticket,
        "nonce": nonce,
        "expires_at": int(exp.timestamp()),
        "install_command": install_command,
        "intended_name": intended_name,
    }


# ---------------------------------------------------------------------------
# GET /api/users/me/agents/bind-ticket/{code}  (owner-only polling)
# ---------------------------------------------------------------------------


@router.get("/me/agents/bind-ticket/{code}")
async def get_bind_ticket_status(
    code: str,
    ctx: RequestContext = Depends(require_user),
):
    """Poll the status of a bind code issued by the current user.

    Returns ``status`` ∈ {pending, claimed, expired} plus the resulting
    ``agent_id`` once the install client has redeemed the code.
    """
    if not code.startswith("bd_"):
        raise HTTPException(status_code=404, detail="Bind code not found")

    async with _short_code_session_factory() as code_session:
        result = await code_session.execute(
            select(ShortCode).where(
                ShortCode.code == code,
                ShortCode.kind == "bind",
                ShortCode.owner_user_id == ctx.user_id,
            )
        )
        row = result.scalar_one_or_none()

    if row is None:
        raise HTTPException(status_code=404, detail="Bind code not found")

    now = _utc_now()
    expires_at = row.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        # SQLite stores naive datetimes; treat as UTC.
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    expires_at_iso = expires_at.isoformat() if expires_at else None
    expires_at_ts = int(expires_at.timestamp()) if expires_at else None

    try:
        payload = json.loads(row.payload_json) if row.payload_json else {}
    except json.JSONDecodeError:
        payload = {}

    if row.consumed_at is not None:
        claimed_agent_id = payload.get("claimed_agent_id")
        # A consumed row without a recorded claimed_agent_id was revoked
        # (or the post-claim metadata write failed). Either way it is
        # terminal — surface it as "revoked" so polling stops without
        # claiming there is an agent we can navigate to.
        status = "claimed" if claimed_agent_id else "revoked"
        return {
            "bind_code": code,
            "status": status,
            "agent_id": claimed_agent_id,
            "claimed_at": row.consumed_at.isoformat(),
            "expires_at": expires_at_iso,
            "expires_at_ts": expires_at_ts,
        }
    if expires_at is not None and expires_at <= now:
        return {
            "bind_code": code,
            "status": "expired",
            "agent_id": None,
            "expires_at": expires_at_iso,
            "expires_at_ts": expires_at_ts,
        }
    return {
        "bind_code": code,
        "status": "pending",
        "agent_id": None,
        "expires_at": expires_at_iso,
        "expires_at_ts": expires_at_ts,
    }


# ---------------------------------------------------------------------------
# DELETE /api/users/me/agents/bind-ticket/{code}  (owner revoke)
# ---------------------------------------------------------------------------


@router.delete("/me/agents/bind-ticket/{code}")
async def revoke_bind_ticket(
    code: str,
    ctx: RequestContext = Depends(require_user),
):
    """Revoke a pending bind code owned by the current user."""
    if not code.startswith("bd_"):
        raise HTTPException(status_code=404, detail="Bind code not found")

    now = _utc_now()
    async with _short_code_session_factory() as code_session:
        upd = await code_session.execute(
            update(ShortCode)
            .where(
                ShortCode.code == code,
                ShortCode.kind == "bind",
                ShortCode.owner_user_id == ctx.user_id,
                ShortCode.consumed_at.is_(None),
            )
            .values(
                consumed_at=now,
                use_count=ShortCode.max_uses,
            )
        )
        if upd.rowcount == 0:
            await code_session.rollback()
            # Either not found or already consumed/expired — surface 404 so the
            # caller treats it as terminal in either case.
            raise HTTPException(status_code=404, detail="Bind code not found or already consumed")
        await code_session.commit()
    return {"ok": True}


@router.post(
    "/me/agents/{agent_id}/credential-reset-ticket",
    response_model=ResetCredentialTicketResponse,
)
async def create_credential_reset_ticket(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Issue a one-time credential reset ticket for an owned agent."""
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

    now = _utc_now()
    exp = now + datetime.timedelta(minutes=30)
    jti = uuid4().hex
    reset_code = f"rc_{uuid4().hex[:12]}"

    payload = {
        "uid": str(ctx.user_id),
        "agent_id": agent_id,
        "purpose": "credential_reset",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "jti": jti,
    }
    ticket = _build_signed_ticket(payload)

    short_code = ShortCode(
        code=reset_code,
        kind="credential_reset",
        owner_user_id=ctx.user_id,
        payload_json=json.dumps({"reset_ticket": ticket}, separators=(",", ":"), sort_keys=True),
        expires_at=exp,
    )
    async with _short_code_session_factory() as code_session:
        code_session.add(short_code)
        await code_session.commit()

    return ResetCredentialTicketResponse(
        agent_id=agent_id,
        reset_code=reset_code,
        reset_ticket=ticket,
        expires_at=int(exp.timestamp()),
    )


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/claim/resolve
# ---------------------------------------------------------------------------


@router.post("/me/agents/claim/resolve", status_code=201)
async def claim_resolve(
    body: ClaimResolveBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Claim an agent via claim code."""
    claim_code = body.claim_code.strip()

    # Validate format
    if not claim_code.startswith("clm_"):
        raise HTTPException(status_code=400, detail="Invalid claim code format")

    # Look up the agent
    result = await db.execute(
        select(Agent).where(Agent.claim_code == claim_code, Agent.status == "active")
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Invalid claim code")

    if agent.user_id is not None:
        raise HTTPException(status_code=409, detail="Agent already claimed")

    # Check user's agent quota
    user_result = await db.execute(select(User).where(User.id == ctx.user_id))
    user = user_result.scalar_one()

    count_result = await db.execute(
        select(sa_func.count())
        .select_from(Agent)
        .where(Agent.user_id == ctx.user_id, Agent.status == "active")
    )
    current_count = count_result.scalar_one()

    if current_count >= user.max_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Agent quota exceeded (max {user.max_agents})",
        )

    # Determine if this is the first agent for the user
    is_first = current_count == 0

    # Bind the agent
    agent.user_id = ctx.user_id
    agent.claimed_at = datetime.datetime.now(datetime.timezone.utc)
    agent.is_default = is_first

    await _ensure_agent_owner_role(db, ctx.user_id)
    await _maybe_grant_claim_gift(db, agent)

    await db.commit()
    await db.refresh(agent)
    return _agent_meta(agent)


# ---------------------------------------------------------------------------
# POST /api/users/me/agents  (claim/bind an agent with token or proof)
# ---------------------------------------------------------------------------


@router.post("/me/agents", status_code=201)
async def claim_agent(
    body: ClaimAgentBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Claim/bind an agent via agent_token or bind_proof + bind_ticket."""

    # --- input validation ---
    if not body.agent_id.startswith("ag_"):
        raise HTTPException(status_code=400, detail="agent_id must start with 'ag_'")
    if not body.display_name:
        raise HTTPException(status_code=400, detail="display_name is required")
    if not body.agent_token and not body.bind_proof:
        raise HTTPException(
            status_code=400,
            detail="Either agent_token or bind_proof is required",
        )

    agent_token = body.agent_token

    if body.bind_proof:
        # --- bind_proof flow: verify ticket then refresh token ---
        if not body.bind_ticket:
            raise HTTPException(
                status_code=400,
                detail="bind_ticket is required when using bind_proof",
            )

        ticket_payload = _verify_bind_ticket(body.bind_ticket)
        if ticket_payload is None:
            raise HTTPException(
                status_code=401, detail="Invalid or expired bind ticket"
            )

        # Ensure the ticket belongs to this user
        if ticket_payload.get("uid") != str(ctx.user_id):
            raise HTTPException(
                status_code=403, detail="Bind ticket does not match user"
            )

        # Consume jti (one-time use, DB-backed)
        if not await _consume_bind_ticket_jti(ticket_payload["jti"]):
            raise HTTPException(
                status_code=401, detail="Bind ticket already used"
            )

        agent_token = await _refresh_agent_token_with_proof(
            db, body.agent_id, body.bind_proof
        )
        if agent_token is None:
            raise HTTPException(
                status_code=401,
                detail="Failed to verify bind proof with registry",
            )
    else:
        # --- agent_token flow: verify control ---
        if agent_token is None:
            raise HTTPException(status_code=400, detail="agent_token is required")
        if not _verify_agent_control(body.agent_id, agent_token):
            raise HTTPException(
                status_code=401, detail="Agent token verification failed"
            )

    # Bind agent to user (shared logic)
    agent = await _bind_agent_to_user(
        db, ctx.user_id, body.agent_id, body.display_name, agent_token
    )
    return _agent_meta(agent)


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/bind  (agent-side bind, no user auth)
# ---------------------------------------------------------------------------


@router.post("/me/agents/bind", status_code=201)
async def agent_bind(
    body: AgentBindBody,
    db: AsyncSession = Depends(get_db),
):
    """Bind an agent to a user via agent_token + bind_ticket (no user auth)."""

    # --- input validation ---
    if not body.agent_id.startswith("ag_"):
        raise HTTPException(status_code=400, detail="agent_id must start with 'ag_'")
    if not body.display_name:
        raise HTTPException(status_code=400, detail="display_name is required")

    # --- resolve bind credential to real bind_ticket (peek, don't consume yet) ---
    bind_ticket = body.bind_ticket
    has_bind_code = bool(body.bind_code)
    if has_bind_code:
        bind_ticket = await _peek_bind_code(body.bind_code)
        if bind_ticket is None:
            raise HTTPException(
                status_code=401, detail="Invalid or expired bind code"
            )
    if bind_ticket is None:
        raise HTTPException(
            status_code=400, detail="bind_ticket or bind_code is required"
        )

    # --- verify bind_ticket to extract user_id ---
    ticket_payload = _verify_bind_ticket(bind_ticket)
    if ticket_payload is None:
        raise HTTPException(
            status_code=401, detail="Invalid or expired bind ticket"
        )

    uid_str = ticket_payload.get("uid")
    if not uid_str:
        raise HTTPException(status_code=401, detail="Bind ticket missing uid")

    try:
        user_id = UUID(uid_str)
    except ValueError:
        raise HTTPException(status_code=401, detail="Bind ticket has invalid uid")

    # --- verify agent_token directly via hub JWT verification ---
    if not _verify_agent_control(body.agent_id, body.agent_token):
        raise HTTPException(
            status_code=401, detail="Agent token verification failed"
        )

    # --- All validations passed, now consume the one-time credentials ---

    # Consume bind_code (atomic UPDATE)
    if has_bind_code:
        if not await _consume_bind_code(body.bind_code):
            raise HTTPException(
                status_code=401, detail="Bind code already consumed (race condition)"
            )

    # Consume jti (one-time use, DB-backed)
    if not await _consume_bind_ticket_jti(ticket_payload["jti"]):
        raise HTTPException(
            status_code=401, detail="Bind ticket already used"
        )

    # Bind agent to user (shared logic)
    agent = await _bind_agent_to_user(
        db, user_id, body.agent_id, body.display_name, body.agent_token
    )
    return _agent_meta(agent)


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/install-claim  (no JWT)
# ---------------------------------------------------------------------------


class InstallClaimProof(BaseModel):
    nonce: str
    sig: str


class InstallClaimBody(BaseModel):
    bind_code: str
    pubkey: str
    proof: InstallClaimProof
    name: str | None = Field(default=None, max_length=128)


def _generic_invalid_bind_code() -> HTTPException:
    """Unauth claim path returns the same 400 for all bind-code-related failures.

    Differentiating "not found" from "expired" from "already used" leaks
    state to anyone holding a candidate code. Owner-visible state is
    surfaced via the authenticated polling endpoint.
    """
    return HTTPException(status_code=400, detail="INVALID_BIND_CODE")


@router.post("/me/agents/install-claim", status_code=201)
async def install_claim(
    body: InstallClaimBody,
    db: AsyncSession = Depends(get_db),
):
    """Redeem an install bind code with an Ed25519 proof of possession.

    No user JWT — the bind code is a bearer credential issued from the
    dashboard. The Ed25519 proof binds the redemption to the keypair that
    the install client locally generated, so the server can never derive
    the private key and a leaked bind code cannot be used to register a
    pubkey the attacker does not control.
    """
    # 1. Shape check
    if not body.bind_code.startswith("bd_"):
        raise _generic_invalid_bind_code()

    # 2. Peek the ticket without consuming
    bind_ticket = await _peek_bind_code(body.bind_code)
    if bind_ticket is None:
        raise _generic_invalid_bind_code()

    # 3. Verify ticket signature + expiry
    ticket_payload = _verify_bind_ticket(bind_ticket)
    if ticket_payload is None:
        raise _generic_invalid_bind_code()

    if ticket_payload.get("purpose") != "install_claim":
        raise _generic_invalid_bind_code()

    uid_str = ticket_payload.get("uid")
    if not uid_str:
        raise _generic_invalid_bind_code()
    try:
        user_id = UUID(uid_str)
    except ValueError:
        raise _generic_invalid_bind_code()

    ticket_nonce = ticket_payload.get("nonce")
    if not isinstance(ticket_nonce, str) or not ticket_nonce:
        raise _generic_invalid_bind_code()

    # 4. Proof: nonce must match the ticket's nonce
    if body.proof.nonce != ticket_nonce:
        raise HTTPException(status_code=401, detail="INVALID_PROOF")

    # 5. Validate pubkey format ("ed25519:<base64-32-bytes>")
    pubkey = body.pubkey.strip()
    try:
        pubkey_b64 = parse_pubkey(pubkey)
    except HTTPException:
        raise HTTPException(status_code=400, detail="INVALID_PUBKEY")

    # 6. Verify Ed25519 proof of possession
    if not verify_challenge_sig(pubkey_b64, ticket_nonce, body.proof.sig):
        raise HTTPException(status_code=401, detail="INVALID_PROOF")

    # 7. Derive agent_id from pubkey
    agent_id = generate_agent_id(pubkey_b64)

    # 8. Pre-check pubkey not already in use by any active/pending key
    dup_key_result = await db.execute(
        select(SigningKey).where(
            SigningKey.pubkey == pubkey,
            SigningKey.state.in_((KeyState.active, KeyState.pending)),
        )
    )
    if dup_key_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")

    # If an Agent row already exists for this deterministic agent_id, the
    # pubkey was already claimed in a prior install. Surface as conflict.
    dup_agent_result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    if dup_agent_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")

    # 9. Quota check on owning user
    user_result = await db.execute(select(User).where(User.id == user_id))
    user = user_result.scalar_one_or_none()
    if user is None:
        raise _generic_invalid_bind_code()
    count_result = await db.execute(
        select(sa_func.count()).select_from(Agent).where(Agent.user_id == user_id)
    )
    current_count = count_result.scalar_one()
    if current_count >= user.max_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Agent quota exceeded (max {user.max_agents})",
        )
    is_first = current_count == 0

    # 10. Atomically consume the short_code AND stamp it with the
    #     deterministic agent_id so polling never sees a "consumed but
    #     no agent" intermediate state. If we lose the consume race,
    #     surface as INVALID_BIND_CODE.
    if not await _consume_bind_code_with_claim(body.bind_code, agent_id):
        raise _generic_invalid_bind_code()

    # 11. Burn the JTI (separate connection, commits independently).
    if not await _consume_bind_ticket_jti(ticket_payload["jti"]):
        # Code is already burned at this point; nothing to roll back.
        raise _generic_invalid_bind_code()

    # 12. Insert Agent + active SigningKey atomically.
    intended_name = ticket_payload.get("intended_name") if isinstance(ticket_payload.get("intended_name"), str) else None
    requested_name = (body.name.strip() if body.name else None) or None
    display_name = requested_name or intended_name or agent_id

    now = _utc_now()
    agent_token, expires_at_ts = create_agent_token(agent_id)
    token_expires_at = datetime.datetime.fromtimestamp(
        expires_at_ts, tz=datetime.timezone.utc
    )

    key_id = generate_key_id()
    agent = Agent(
        agent_id=agent_id,
        display_name=display_name,
        user_id=user_id,
        agent_token=agent_token,
        token_expires_at=token_expires_at,
        is_default=is_first,
        claimed_at=now,
    )
    signing_key = SigningKey(
        agent_id=agent_id,
        key_id=key_id,
        pubkey=pubkey,
        state=KeyState.active,
    )
    try:
        async with db.begin_nested():
            db.add(agent)
            db.add(signing_key)
    except IntegrityError:
        # Another concurrent claim won. The bind code is already burned, so
        # nothing further to do here — surface as conflict.
        await db.rollback()
        raise HTTPException(status_code=409, detail="PUBKEY_ALREADY_REGISTERED")

    await _ensure_agent_owner_role(db, user_id)
    await _maybe_grant_claim_gift(db, agent)

    await db.commit()
    await db.refresh(agent)

    # claimed_agent_id was already written into short_code.payload_json
    # by _consume_bind_code_with_claim above, so dashboard polling sees
    # a fully consistent state without a "revoked" intermediate read.

    return {
        "agent_id": agent_id,
        "key_id": key_id,
        "agent_token": agent_token,
        "token_expires_at": expires_at_ts,
        "hub_url": HUB_PUBLIC_BASE_URL,
        "ws_url": HUB_PUBLIC_BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/ws",
        "display_name": display_name,
    }


@router.post(
    "/me/agents/reset-credential",
    response_model=ResetCredentialResponse,
)
async def reset_agent_credential(
    body: ResetCredentialBody,
    db: AsyncSession = Depends(get_db),
):
    """Replace an owned agent's active signing credential via a user-issued reset ticket."""
    if not body.agent_id.startswith("ag_"):
        raise HTTPException(status_code=400, detail="agent_id must start with 'ag_'")

    reset_ticket = body.reset_ticket
    has_reset_code = bool(body.reset_code)
    if has_reset_code:
        reset_ticket = await _peek_reset_code(body.reset_code)
        if reset_ticket is None:
            raise HTTPException(status_code=401, detail="Invalid or expired reset code")
    if reset_ticket is None:
        raise HTTPException(status_code=400, detail="reset_ticket or reset_code is required")

    ticket_payload = _verify_reset_ticket(reset_ticket)
    if ticket_payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired reset ticket")
    if ticket_payload["agent_id"] != body.agent_id:
        raise HTTPException(status_code=403, detail="Reset ticket does not match agent")

    uid_str = ticket_payload.get("uid")
    if not uid_str:
        raise HTTPException(status_code=401, detail="Reset ticket missing uid")

    try:
        user_id = UUID(uid_str)
    except ValueError:
        raise HTTPException(status_code=401, detail="Reset ticket has invalid uid")

    result = await db.execute(
        select(Agent).where(
            Agent.agent_id == body.agent_id,
            Agent.user_id == user_id,
            Agent.status == "active",
        )
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    pubkey = body.pubkey.strip()
    parse_pubkey(pubkey)

    existing_key_result = await db.execute(
        select(SigningKey).where(
            SigningKey.agent_id == body.agent_id,
            SigningKey.pubkey == pubkey,
        )
    )
    if existing_key_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Public key already exists for agent")

    if has_reset_code:
        if not await _consume_reset_code(body.reset_code):
            raise HTTPException(status_code=401, detail="Reset code already consumed")
    if not await _consume_bind_ticket_jti(ticket_payload["jti"]):
        raise HTTPException(status_code=401, detail="Reset ticket already used")

    key_id = generate_key_id()
    active_keys_result = await db.execute(
        select(SigningKey).where(
            SigningKey.agent_id == body.agent_id,
            SigningKey.state == KeyState.active,
        )
    )
    for signing_key in active_keys_result.scalars().all():
        signing_key.state = KeyState.revoked

    db.add(
        SigningKey(
            agent_id=body.agent_id,
            key_id=key_id,
            pubkey=pubkey,
            state=KeyState.active,
        )
    )

    agent_token, expires_at = create_agent_token(body.agent_id)
    agent.agent_token = agent_token
    agent.token_expires_at = datetime.datetime.fromtimestamp(
        expires_at, tz=datetime.timezone.utc
    )

    await db.commit()
    await db.refresh(agent)

    return ResetCredentialResponse(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
        key_id=key_id,
        agent_token=agent_token,
        expires_at=expires_at,
        hub_url=None,
    )


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/provision
# ---------------------------------------------------------------------------
#
# Create a fresh agent bound to one of the user's daemons. Hub is the
# source-of-truth for runtime: the `runtime` column is written here, and
# the daemon receives the cached copy via the `provision_agent` control
# frame's `credentials` envelope.


class ProvisionAgentBody(BaseModel):
    daemon_instance_id: str
    label: str
    runtime: str
    cwd: str | None = None
    bio: str | None = None
    # Optional OpenClaw routing selection. Only meaningful when
    # `runtime == "openclaw-acp"` — daemon writes these to credentials so the
    # synthesized managed route can resolve a `ResolvedOpenclawGateway`.
    openclaw_gateway: str | None = None
    openclaw_agent: str | None = None
    # Hermes profile to attach to. Only meaningful when `runtime ==
    # "hermes-agent"` — daemon enforces 1 BotCord agent : 1 hermes profile
    # and rejects with `hermes_profile_occupied` when already bound.
    hermes_profile: str | None = None


class ProvisionAgentResponse(BaseModel):
    agent_id: str
    display_name: str
    runtime: str
    daemon_instance_id: str
    is_default: bool


def _daemon_lists_runtime(
    instance: DaemonInstance,
    runtime: str,
    openclaw_gateway: str | None = None,
    hermes_profile: str | None = None,
) -> bool:
    """Check that the daemon's last runtime probe lists `runtime` as available.

    Empty / missing snapshots are treated permissively: the daemon may not
    have completed its first probe yet, and rejecting here would deadlock
    provisioning on a freshly-connected daemon. The daemon will still reject
    unknown runtimes in `provision.ts` at the handler boundary.

    For `runtime == "openclaw-acp"`, RFC §3.8.2 requires an additional check:
    when `openclaw_gateway` is given, the matching `endpoints[]` entry must
    be reachable. Without this, a daemon with the OpenClaw CLI installed but
    a misconfigured / unreachable gateway would still pass the gate and only
    fail at first turn.
    """
    snap = instance.runtimes_json
    if not isinstance(snap, list) or not snap:
        return True
    for entry in snap:
        if not isinstance(entry, dict):
            continue
        if entry.get("id") != runtime:
            continue
        if entry.get("available") is not True:
            return False
        if runtime == "openclaw-acp" and openclaw_gateway:
            endpoints = entry.get("endpoints")
            if not isinstance(endpoints, list):
                return False
            for ep in endpoints:
                if not isinstance(ep, dict):
                    continue
                if ep.get("name") == openclaw_gateway and ep.get("reachable") is True:
                    return True
            return False
        if runtime == "hermes-agent" and hermes_profile:
            # Mirror the openclaw gating: when a specific profile is selected,
            # require it to appear in the snapshot's `profiles[]`. Daemon will
            # still re-validate (existence + occupancy) under its per-profile
            # lock, but rejecting here gives the dashboard a fast 409 instead
            # of a 5s round-trip to the daemon.
            profiles = entry.get("profiles")
            if not isinstance(profiles, list):
                # Empty / missing snapshot — let the daemon decide.
                return True
            for p in profiles:
                if not isinstance(p, dict):
                    continue
                if p.get("name") == hermes_profile:
                    occupied = p.get("occupiedBy")
                    if isinstance(occupied, str) and occupied:
                        return False
                    return True
            return False
        return True
    return False


@router.post(
    "/me/agents/provision",
    status_code=201,
    response_model=ProvisionAgentResponse,
)
async def provision_agent(
    body: ProvisionAgentBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> ProvisionAgentResponse:
    """Create a new agent on one of the user's daemons.

    Hub generates the Ed25519 keypair, inserts the Agent row (with
    `runtime` column set), activates the signing key, issues a JWT, and
    ships the credential envelope to the daemon over its control WS. The
    daemon writes credentials to disk and hot-plugs a gateway channel.
    """
    # --- Validate daemon + ownership + online ---------------------------
    label = (body.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="label is required")
    runtime = (body.runtime or "").strip()
    if not runtime:
        raise HTTPException(status_code=400, detail="runtime is required")

    result = await db.execute(
        select(DaemonInstance).where(DaemonInstance.id == body.daemon_instance_id)
    )
    instance = result.scalar_one_or_none()
    if instance is None or str(instance.user_id) != str(ctx.user_id):
        raise HTTPException(status_code=404, detail="daemon_instance_not_found")
    if instance.revoked_at is not None:
        raise HTTPException(status_code=409, detail="daemon_revoked")
    if not is_daemon_online(body.daemon_instance_id):
        raise HTTPException(status_code=409, detail="daemon_offline")
    if not _daemon_lists_runtime(
        instance,
        runtime,
        body.openclaw_gateway,
        body.hermes_profile,
    ):
        raise HTTPException(status_code=409, detail="runtime_unavailable")

    # --- Quota check ---------------------------------------------------
    user_result = await db.execute(select(User).where(User.id == ctx.user_id))
    user = user_result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    count_result = await db.execute(
        select(sa_func.count())
        .select_from(Agent)
        .where(Agent.user_id == ctx.user_id, Agent.status == "active")
    )
    current_count = count_result.scalar_one()
    if current_count >= user.max_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Agent quota exceeded (max {user.max_agents})",
        )
    is_first = current_count == 0

    # --- Generate keypair + derive agent_id -----------------------------
    signing_key = NaClSigningKey.generate()
    pubkey_raw = bytes(signing_key.verify_key)
    private_key_raw = bytes(signing_key)
    pubkey_b64 = base64.b64encode(pubkey_raw).decode("ascii")
    private_key_b64 = base64.b64encode(private_key_raw).decode("ascii")
    agent_id = generate_agent_id(pubkey_b64)

    # Defensive: the derivation is deterministic, so collision means another
    # row already exists for this pubkey. Since we freshly generated the key,
    # a real collision is effectively 2^-128 and indicates data corruption.
    dup_result = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    if dup_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=500, detail="agent_id_collision")

    # --- Insert Agent + SigningKey in one transaction -------------------
    now = datetime.datetime.now(datetime.timezone.utc)
    key_id = generate_key_id()
    agent = Agent(
        agent_id=agent_id,
        display_name=label,
        bio=body.bio,
        user_id=ctx.user_id,
        is_default=is_first,
        claimed_at=now,
        runtime=runtime,
        daemon_instance_id=body.daemon_instance_id,
        hosting_kind="daemon",
    )
    db.add(agent)
    db.add(
        SigningKey(
            agent_id=agent_id,
            key_id=key_id,
            pubkey=f"ed25519:{pubkey_b64}",
            state=KeyState.active,
        )
    )
    # Flush so FKs satisfy subsequent writes; commit happens after the
    # daemon ack so we can roll back on dispatch failure.
    await db.flush()

    agent_token, token_expires_at = create_agent_token(agent_id)
    agent.agent_token = agent_token
    agent.token_expires_at = datetime.datetime.fromtimestamp(
        token_expires_at, tz=datetime.timezone.utc
    )
    await get_or_create_wallet(db, agent_id)
    await _ensure_agent_owner_role(db, ctx.user_id)
    await db.flush()

    # --- Dispatch provision_agent to the daemon, wait for ack -----------
    frame_params: dict = {
        "name": label,
        "runtime": runtime,
        "credentials": {
            "agentId": agent_id,
            "keyId": key_id,
            "privateKey": private_key_b64,
            "publicKey": pubkey_b64,
            "hubUrl": hub_config.HUB_PUBLIC_BASE_URL,
            "displayName": label,
            "token": agent_token,
            "tokenExpiresAt": token_expires_at * 1000,
            "runtime": runtime,
        },
    }
    if body.cwd:
        frame_params["cwd"] = body.cwd
        frame_params["credentials"]["cwd"] = body.cwd
    if body.bio:
        frame_params["bio"] = body.bio
    if body.openclaw_gateway:
        # Top-level nested form (RFC §3.9.2).
        oc: dict[str, str] = {"gateway": body.openclaw_gateway}
        if body.openclaw_agent:
            oc["agent"] = body.openclaw_agent
        frame_params["openclaw"] = oc
        # Mirror onto the flat credentials envelope so daemon's offline reload
        # path picks the same gateway without seeing the top-level field.
        frame_params["credentials"]["openclawGateway"] = body.openclaw_gateway
        if body.openclaw_agent:
            frame_params["credentials"]["openclawAgent"] = body.openclaw_agent
    if body.hermes_profile:
        # Same dual-write pattern as openclaw — top-level nested form for the
        # daemon's runtime selector, flat credentials mirror for the offline
        # reload path.
        frame_params["hermes"] = {"profile": body.hermes_profile}
        frame_params["credentials"]["hermesProfile"] = body.hermes_profile

    # Seed the daemon's policyResolver with the agent's default attention so
    # it has a real policy from message zero (no first-message refetch race).
    # `attention_keywords` is JSON-encoded TEXT in the DB.
    try:
        _seed_kw = json.loads(agent.attention_keywords or "[]")
        if not isinstance(_seed_kw, list):
            _seed_kw = []
    except (json.JSONDecodeError, TypeError):
        _seed_kw = []
    _attn = agent.default_attention
    frame_params["defaultAttention"] = _attn.value if hasattr(_attn, "value") else str(_attn)
    frame_params["attentionKeywords"] = [str(x) for x in _seed_kw if isinstance(x, str)]

    try:
        ack = await send_control_frame(
            body.daemon_instance_id, "provision_agent", frame_params
        )
    except HTTPException:
        # Roll back the uncommitted Agent / SigningKey so Hub doesn't get
        # stuck with a phantom agent row while the daemon is offline or
        # misbehaving (plan §8.4 事务性与回滚: step b fail → ack error, no state).
        await db.rollback()
        raise

    if not isinstance(ack, dict) or not ack.get("ok"):
        err = ack.get("error") if isinstance(ack, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else None
        message = (err or {}).get("message") if isinstance(err, dict) else None
        await db.rollback()
        raise HTTPException(
            status_code=502,
            detail={
                "code": "daemon_provision_failed",
                "daemon_code": code,
                "daemon_message": message,
            },
        )

    await db.commit()
    await db.refresh(agent)

    return ProvisionAgentResponse(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
        runtime=runtime,
        daemon_instance_id=body.daemon_instance_id,
        is_default=agent.is_default,
    )


# ---------------------------------------------------------------------------
# OpenClaw onboarding — BFF routes
# ---------------------------------------------------------------------------
#
# The user-authenticated entry points for the OpenClaw flow.  The
# unauthenticated counterparts (``/openclaw/install-claim``,
# ``/openclaw/host/provision-claim``, ``/openclaw/auth/refresh``,
# ``WS /openclaw/control``) live in ``hub.routers.openclaw_control``.


class OpenclawInstallBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    bio: str | None = Field(default=None, max_length=4000)


class OpenclawInstallResponse(BaseModel):
    bind_code: str
    bind_ticket: str
    nonce: str
    expires_at: int
    install_command: str


@router.post("/me/agents/openclaw/install", response_model=OpenclawInstallResponse)
async def openclaw_install(
    body: OpenclawInstallBody,
    ctx: RequestContext = Depends(require_user),
) -> OpenclawInstallResponse:
    """Issue a bind ticket for the OpenClaw one-line install command."""
    intended_name = body.name.strip()
    if not intended_name:
        raise HTTPException(status_code=400, detail="name is required")
    intended_bio = (body.bio.strip() if body.bio else None) or None

    now = _utc_now()
    exp = now + datetime.timedelta(minutes=BIND_TICKET_TTL_MINUTES)
    nonce = base64.b64encode(os.urandom(32)).decode()
    jti = uuid4().hex
    bind_code = f"bd_{uuid4().hex[:12]}"

    async with _short_code_session_factory() as code_session:
        active_count_result = await code_session.execute(
            select(sa_func.count())
            .select_from(ShortCode)
            .where(
                ShortCode.kind == "bind",
                ShortCode.owner_user_id == ctx.user_id,
                ShortCode.consumed_at.is_(None),
                ShortCode.expires_at > now,
            )
        )
        active_count = active_count_result.scalar_one()
        if active_count >= MAX_ACTIVE_BIND_CODES_PER_USER:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Too many active bind codes (max {MAX_ACTIVE_BIND_CODES_PER_USER}); "
                    "revoke or wait for one to expire"
                ),
            )

    ticket_payload = {
        "uid": str(ctx.user_id),
        "purpose": "openclaw_install",
        "nonce": nonce,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "jti": jti,
        "intended_name": intended_name,
    }
    if intended_bio:
        ticket_payload["intended_bio"] = intended_bio

    ticket = _build_signed_ticket(ticket_payload)

    short_code_payload: dict = {
        "bind_ticket": ticket,
        "intended_name": intended_name,
    }
    if intended_bio:
        short_code_payload["intended_bio"] = intended_bio

    short_code = ShortCode(
        code=bind_code,
        kind="bind",
        owner_user_id=ctx.user_id,
        payload_json=json.dumps(short_code_payload, separators=(",", ":"), sort_keys=True),
        expires_at=exp,
    )
    async with _short_code_session_factory() as code_session:
        code_session.add(short_code)
        await code_session.commit()

    base = HUB_PUBLIC_BASE_URL.rstrip("/")
    install_command = (
        f"curl -fsSL {base}/openclaw/install.sh | bash -s -- "
        f"--purpose openclaw_install --bind-code {bind_code} --bind-nonce {nonce}"
    )

    return OpenclawInstallResponse(
        bind_code=bind_code,
        bind_ticket=ticket,
        nonce=nonce,
        expires_at=int(exp.timestamp()),
        install_command=install_command,
    )


# ---- hosts CRUD -----------------------------------------------------------


class OpenclawHostView(BaseModel):
    id: str
    label: str | None = None
    online: bool
    last_seen_at: datetime.datetime | None = None
    revoked_at: datetime.datetime | None = None
    agent_count: int
    created_at: datetime.datetime


class OpenclawHostsResponse(BaseModel):
    hosts: list[OpenclawHostView]


@router.get(
    "/me/agents/openclaw/hosts",
    response_model=OpenclawHostsResponse,
)
async def list_openclaw_hosts(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> OpenclawHostsResponse:
    from hub.routers.openclaw_control import is_openclaw_host_online

    rows = (
        await db.execute(
            select(OpenclawHostInstance)
            .where(OpenclawHostInstance.owner_user_id == ctx.user_id)
            .order_by(OpenclawHostInstance.created_at.desc())
        )
    ).scalars().all()

    hosts: list[OpenclawHostView] = []
    for row in rows:
        count_result = await db.execute(
            select(sa_func.count())
            .select_from(Agent)
            .where(
                Agent.user_id == ctx.user_id,
                Agent.openclaw_host_id == row.id,
                Agent.status == "active",
            )
        )
        agent_count = count_result.scalar_one() or 0
        hosts.append(
            OpenclawHostView(
                id=row.id,
                label=row.label,
                online=row.revoked_at is None and is_openclaw_host_online(row.id),
                last_seen_at=row.last_seen_at,
                revoked_at=row.revoked_at,
                agent_count=agent_count,
                created_at=row.created_at,
            )
        )
    return OpenclawHostsResponse(hosts=hosts)


async def _load_owned_openclaw_host(
    db: AsyncSession, user_id: UUID, host_id: str
) -> OpenclawHostInstance:
    result = await db.execute(
        select(OpenclawHostInstance).where(OpenclawHostInstance.id == host_id)
    )
    instance = result.scalar_one_or_none()
    if instance is None or str(instance.owner_user_id) != str(user_id):
        raise HTTPException(status_code=404, detail="openclaw_host_not_found")
    return instance


class OpenclawHostPatchBody(BaseModel):
    label: str | None = Field(default=None, max_length=64)


@router.patch(
    "/me/agents/openclaw/hosts/{host_id}",
    response_model=OpenclawHostView,
)
async def patch_openclaw_host(
    host_id: str,
    body: OpenclawHostPatchBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> OpenclawHostView:
    from hub.routers.openclaw_control import is_openclaw_host_online

    instance = await _load_owned_openclaw_host(db, ctx.user_id, host_id)
    new_label = body.label.strip() if isinstance(body.label, str) else None
    instance.label = new_label or None
    await db.commit()
    await db.refresh(instance)

    count_result = await db.execute(
        select(sa_func.count())
        .select_from(Agent)
        .where(
            Agent.user_id == ctx.user_id,
            Agent.openclaw_host_id == instance.id,
            Agent.status == "active",
        )
    )
    return OpenclawHostView(
        id=instance.id,
        label=instance.label,
        online=instance.revoked_at is None and is_openclaw_host_online(instance.id),
        last_seen_at=instance.last_seen_at,
        revoked_at=instance.revoked_at,
        agent_count=count_result.scalar_one() or 0,
        created_at=instance.created_at,
    )


@router.delete("/me/agents/openclaw/hosts/{host_id}")
async def delete_openclaw_host(
    host_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Revoke an OpenClaw host and unbind all of its agents.

    Mirrors the existing per-agent unbind semantics (``user_id`` /
    ``claimed_at`` / ``agent_token`` are cleared) so the agent rows
    remain reusable after the user re-installs on the host.
    """
    from hub.routers.openclaw_control import _REGISTRY as _HOST_REGISTRY

    instance = await _load_owned_openclaw_host(db, ctx.user_id, host_id)

    now = _utc_now()
    if instance.revoked_at is None:
        instance.revoked_at = now
    instance.refresh_token_hash = None
    instance.refresh_token_expires_at = None

    rows = (
        await db.execute(
            select(Agent).where(
                Agent.user_id == ctx.user_id,
                Agent.openclaw_host_id == host_id,
                Agent.status == "active",
            )
        )
    ).scalars().all()
    revoked_ids = {a.agent_id for a in rows}
    any_was_default = False
    for agent in rows:
        try:
            await _ensure_agent_unbind_allowed(db, agent.agent_id)
        except HTTPException:
            await db.rollback()
            raise
        if agent.is_default:
            any_was_default = True
        await _cancel_agent_subscriptions(db, agent.agent_id, now)
        agent.user_id = None
        agent.claimed_at = None
        agent.is_default = False
        agent.agent_token = None
        agent.token_expires_at = None
        agent.openclaw_host_id = None
        agent.claim_code = f"clm_{uuid4().hex}"

    # Promote a single replacement default *after* every host agent has been
    # detached, so the helper can't pick another agent that is still in
    # ``rows`` but not yet processed.
    if any_was_default:
        next_q = await db.execute(
            select(Agent)
            .where(
                Agent.user_id == ctx.user_id,
                Agent.agent_id.notin_(revoked_ids) if revoked_ids else True,
                Agent.status == "active",
            )
            .order_by(Agent.created_at)
            .limit(1)
        )
        next_agent = next_q.scalar_one_or_none()
        if next_agent is not None:
            next_agent.is_default = True

    if rows:
        await _maybe_remove_agent_owner_role(db, ctx.user_id)

    await db.commit()

    conn = _HOST_REGISTRY.get(host_id)
    if conn is not None:
        try:
            await conn.ws.close(code=4403, reason="host revoked")
        except Exception:
            pass
        await _HOST_REGISTRY.unregister(conn)

    return {"ok": True, "revoked_agents": [a.agent_id for a in rows]}


# ---- provision (host-authorized) ------------------------------------------


class OpenclawProvisionBody(BaseModel):
    openclaw_host_id: str
    name: str = Field(..., min_length=1, max_length=128)
    bio: str | None = Field(default=None, max_length=4000)


class OpenclawProvisionResponse(BaseModel):
    agent_id: str
    display_name: str
    openclaw_host_id: str
    is_default: bool
    # Forwarded from the host's provision-claim ack so the dashboard can
    # surface a "manually attach this agent in your OpenClaw config" warning
    # when the plugin couldn't update ``~/.openclaw/openclaw.json`` itself
    # (multi-account guard, IO error, etc.). ``True`` means the new agent
    # will auto-load on the host's next plugin reload; ``False`` means the
    # user (or follow-up automation) must take an action.
    config_patched: bool = True
    config_skip_reason: str | None = None


@router.post(
    "/me/agents/openclaw/provision",
    status_code=201,
    response_model=OpenclawProvisionResponse,
)
async def openclaw_provision(
    body: OpenclawProvisionBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> OpenclawProvisionResponse:
    """Create an agent on an already-registered OpenClaw host.

    Allocates a one-time provision short-code, dispatches a signed
    ``provision_agent`` frame over the host control WS, and waits for
    the host's ack — which fires only after the host has called
    ``POST /openclaw/host/provision-claim`` to materialise the agent.
    """
    from hub.config import OPENCLAW_PROVISION_TICKET_TTL_SECONDS
    from hub.routers.openclaw_control import (
        is_openclaw_host_online,
        send_host_control_frame,
    )

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    bio = (body.bio.strip() if body.bio else None) or None

    instance = await _load_owned_openclaw_host(db, ctx.user_id, body.openclaw_host_id)
    if instance.revoked_at is not None:
        raise HTTPException(status_code=409, detail="host_revoked")
    if not is_openclaw_host_online(instance.id):
        raise HTTPException(status_code=409, detail="host_offline")

    user_result = await db.execute(select(User).where(User.id == ctx.user_id))
    user = user_result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    count_result = await db.execute(
        select(sa_func.count())
        .select_from(Agent)
        .where(Agent.user_id == ctx.user_id, Agent.status == "active")
    )
    if count_result.scalar_one() >= user.max_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Agent quota exceeded (max {user.max_agents})",
        )

    now = _utc_now()
    provision_id = f"prv_{uuid4().hex[:16]}"
    nonce = base64.b64encode(os.urandom(32)).decode()
    expires_at = now + datetime.timedelta(seconds=OPENCLAW_PROVISION_TICKET_TTL_SECONDS)

    sc_payload = {
        "owner_user_id": str(ctx.user_id),
        "openclaw_host_id": instance.id,
        "intended_name": name,
        "nonce": nonce,
    }
    if bio:
        sc_payload["intended_bio"] = bio

    short_code = ShortCode(
        code=provision_id,
        kind="openclaw_provision",
        owner_user_id=ctx.user_id,
        payload_json=json.dumps(sc_payload, separators=(",", ":"), sort_keys=True),
        expires_at=expires_at,
    )
    async with _short_code_session_factory() as code_session:
        code_session.add(short_code)
        await code_session.commit()

    frame_params: dict = {
        "provision_id": provision_id,
        "nonce": nonce,
        "owner_user_id": str(ctx.user_id),
    }

    async def _burn_provision_code() -> None:
        # Best-effort: stamp consumed_at on the unredeemed provision code so
        # a late host claim can't sneak through after we've already returned
        # an error to the dashboard. Failures here are intentionally
        # swallowed — the TTL provides a hard ceiling either way.
        try:
            async with _short_code_session_factory() as code_session:
                await code_session.execute(
                    update(ShortCode)
                    .where(
                        ShortCode.code == provision_id,
                        ShortCode.kind == "openclaw_provision",
                        ShortCode.consumed_at.is_(None),
                    )
                    .values(consumed_at=_utc_now())
                )
                await code_session.commit()
        except Exception:  # noqa: BLE001
            pass

    try:
        ack = await send_host_control_frame(
            instance.id, "provision_agent", frame_params
        )
    except HTTPException:
        await _burn_provision_code()
        raise

    if not isinstance(ack, dict) or not ack.get("ok"):
        err = ack.get("error") if isinstance(ack, dict) else None
        code = (err or {}).get("code") if isinstance(err, dict) else None
        message = (err or {}).get("message") if isinstance(err, dict) else None
        await _burn_provision_code()
        raise HTTPException(
            status_code=502,
            detail={
                "code": "openclaw_provision_failed",
                "host_code": code,
                "host_message": message,
            },
        )

    result = ack.get("result") if isinstance(ack.get("result"), dict) else None
    agent_id = (result or {}).get("agent_id")
    if not isinstance(agent_id, str):
        await _burn_provision_code()
        raise HTTPException(
            status_code=502,
            detail={
                "code": "openclaw_provision_failed",
                "host_message": "host ack missing agent_id",
            },
        )

    # Trust check: a buggy or compromised host could ack with someone
    # else's agent_id. Only return success if the row was actually
    # produced by *this* provision (correct owner + same host instance).
    # Note we deliberately don't fall through to a different "wrong agent"
    # error code — leaking that an unrelated agent_id exists is itself a
    # disclosure.
    agent_q = await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    agent = agent_q.scalar_one_or_none()
    if (
        agent is None
        or str(agent.user_id) != str(ctx.user_id)
        or agent.openclaw_host_id != instance.id
    ):
        await _burn_provision_code()
        raise HTTPException(
            status_code=502,
            detail={
                "code": "openclaw_provision_failed",
                "host_message": "agent row not found or not bound to this host",
            },
        )

    config_patched_raw = (result or {}).get("config_patched")
    config_skip_reason = (result or {}).get("config_skip_reason")
    return OpenclawProvisionResponse(
        agent_id=agent.agent_id,
        display_name=agent.display_name,
        openclaw_host_id=instance.id,
        is_default=agent.is_default,
        config_patched=bool(config_patched_raw) if config_patched_raw is not None else True,
        config_skip_reason=config_skip_reason if isinstance(config_skip_reason, str) else None,
    )
