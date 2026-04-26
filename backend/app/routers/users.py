"""
[INPUT]: 依赖用户鉴权上下文、Hub token 校验、数据库会话与 Agent 模型完成 dashboard 身份流转
[OUTPUT]: 对外提供 /api/users 用户资料、Agent 认领、短码绑定与默认身份切换接口
[POS]: app BFF 用户入口，把浏览器态与 Agent 身份绑定协议收敛成单一边界
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

import base64
import datetime
import hashlib
import hmac
import json
import logging
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, case, func as sa_func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub import config as hub_config
from hub.auth import create_agent_token, verify_agent_token
from hub.config import BIND_PROOF_SECRET, JWT_SECRET
from hub.routers.hub import is_agent_ws_online
from hub.routers.daemon_control import is_daemon_online, send_control_frame
from hub.crypto import verify_challenge_sig
from hub.database import async_session as _default_session_factory, get_db
from hub.models import (
    Agent,
    AgentSubscription,
    DaemonInstance,
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

    active_owner_products = (
        select(SubscriptionProduct.product_id)
        .where(
            SubscriptionProduct.owner_agent_id == agent_id,
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

    await _cancel_agent_subscriptions(db, agent_id, now)

    agent.user_id = None
    agent.claimed_at = None
    agent.is_default = False
    agent.agent_token = None
    agent.token_expires_at = None
    agent.claim_code = f"clm_{uuid4().hex}"

    if was_default:
        await _promote_next_default_agent(db, user_id, agent_id)

    await _maybe_remove_agent_owner_role(db, user_id)
    await db.flush()
    return {"agent_id": agent_id, "unbound_at": now.isoformat()}


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

    if body.display_name is not None:
        name = body.display_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="display_name must not be empty")
        agent.display_name = name

    if body.bio is not None:
        # Normalise empty string to NULL so it reads as "no bio" downstream.
        bio = body.bio.strip()
        agent.bio = bio or None

    await db.commit()
    await db.refresh(agent)
    return _agent_meta(agent)


# ---------------------------------------------------------------------------
# POST /api/users/me/agents/bind-ticket
# ---------------------------------------------------------------------------


@router.post("/me/agents/bind-ticket")
async def create_bind_ticket(
    ctx: RequestContext = Depends(require_user),
):
    """Issue a one-time bind ticket for cryptographic agent binding."""
    now = _utc_now()
    exp = now + datetime.timedelta(minutes=30)
    nonce = uuid4().hex
    jti = uuid4().hex
    bind_code = f"bd_{uuid4().hex[:12]}"

    payload = {
        "uid": str(ctx.user_id),
        "nonce": nonce,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "jti": jti,
    }

    ticket = _build_signed_ticket(payload)

    short_code = ShortCode(
        code=bind_code,
        kind="bind",
        owner_user_id=ctx.user_id,
        payload_json=json.dumps({"bind_ticket": ticket}, separators=(",", ":"), sort_keys=True),
        expires_at=exp,
    )
    async with _short_code_session_factory() as code_session:
        code_session.add(short_code)
        await code_session.commit()

    return {
        "bind_code": bind_code,
        "bind_ticket": ticket,
        "nonce": nonce,
        "expires_at": int(exp.timestamp()),
    }


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


class ProvisionAgentResponse(BaseModel):
    agent_id: str
    display_name: str
    runtime: str
    daemon_instance_id: str
    is_default: bool


def _daemon_lists_runtime(instance: DaemonInstance, runtime: str) -> bool:
    """Check that the daemon's last runtime probe lists `runtime` as available.

    Empty / missing snapshots are treated permissively: the daemon may not
    have completed its first probe yet, and rejecting here would deadlock
    provisioning on a freshly-connected daemon. The daemon will still reject
    unknown runtimes in `provision.ts` at the handler boundary.
    """
    snap = instance.runtimes_json
    if not isinstance(snap, list) or not snap:
        return True
    for entry in snap:
        if not isinstance(entry, dict):
            continue
        if entry.get("id") == runtime and entry.get("available") is True:
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
    if not _daemon_lists_runtime(instance, runtime):
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
