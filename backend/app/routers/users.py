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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import case, func as sa_func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.auth import create_agent_token, verify_agent_token
from hub.config import BIND_PROOF_SECRET, JWT_SECRET
from hub.crypto import verify_challenge_sig
from hub.database import async_session as _default_session_factory, get_db
from hub.models import Agent, Role, ShortCode, User, UserRole

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


# ---------------------------------------------------------------------------
# Helper: agent metadata dict
# ---------------------------------------------------------------------------


def _agent_meta(agent: Agent) -> dict:
    return {
        "agent_id": agent.agent_id,
        "display_name": agent.display_name,
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


async def _consume_bind_code(code: str) -> str | None:
    """Burn a bind short code and return its mapped bind ticket."""
    async with _short_code_session_factory() as code_session:
        now = _utc_now()
        result = await code_session.execute(
            update(ShortCode)
            .where(
                ShortCode.code == code,
                ShortCode.kind == "bind",
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
            .returning(ShortCode.payload_json)
        )
        payload_json = result.scalar_one_or_none()
        if payload_json is None:
            await code_session.rollback()
            return None
        await code_session.commit()
        try:
            payload = json.loads(payload_json)
        except json.JSONDecodeError:
            return None
        bind_ticket = payload.get("bind_ticket")
        return bind_ticket if isinstance(bind_ticket, str) else None


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
        select(sa_func.count()).select_from(Agent).where(Agent.user_id == user_id)
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
                .where(Agent.agent_id == agent_id, Agent.user_id.is_(None))
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
            .where(Agent.agent_id == agent_id, Agent.user_id.is_(None))
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

    # Ensure user has the "agent_owner" role
    role_result = await db.execute(select(Role).where(Role.name == "agent_owner"))
    agent_owner_role = role_result.scalar_one_or_none()

    if agent_owner_role is not None:
        existing_ur = await db.execute(
            select(UserRole).where(
                UserRole.user_id == user_id,
                UserRole.role_id == agent_owner_role.id,
            )
        )
        if existing_ur.scalar_one_or_none() is None:
            db.add(UserRole(user_id=user_id, role_id=agent_owner_role.id))

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
        select(Agent).where(Agent.user_id == user.id).order_by(Agent.created_at)
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
                "is_default": a.is_default,
                "claimed_at": a.claimed_at.isoformat() if a.claimed_at else None,
            }
            for a in agents
        ],
    }


@router.get("/me/agents")
async def get_my_agents(
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Return list of agents belonging to the authenticated user."""
    agent_result = await db.execute(
        select(Agent).where(Agent.user_id == ctx.user_id).order_by(Agent.created_at)
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
        select(Agent).where(Agent.agent_id == agent_id, Agent.user_id == ctx.user_id)
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    return {
        "agent_id": agent.agent_id,
        "agent_token": agent.agent_token,
    }


# ---------------------------------------------------------------------------
# DELETE /api/users/me/agents/{agent_id}
# ---------------------------------------------------------------------------


@router.delete("/me/agents/{agent_id}")
async def delete_agent(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Unbind an agent from the current user."""
    result = await db.execute(
        select(Agent).where(Agent.agent_id == agent_id, Agent.user_id == ctx.user_id)
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    was_default = agent.is_default

    # Unbind agent
    agent.user_id = None
    agent.claimed_at = None
    agent.is_default = False
    agent.agent_token = None
    agent.token_expires_at = None

    # If the deleted agent was default, promote the next agent by earliest created_at
    if was_default:
        next_result = await db.execute(
            select(Agent)
            .where(Agent.user_id == ctx.user_id, Agent.agent_id != agent_id)
            .order_by(Agent.created_at)
            .limit(1)
        )
        next_agent = next_result.scalar_one_or_none()
        if next_agent is not None:
            next_agent.is_default = True

    await db.commit()
    return {"ok": True}


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
    """Update agent attributes (currently only is_default)."""
    result = await db.execute(
        select(Agent).where(Agent.agent_id == agent_id, Agent.user_id == ctx.user_id)
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    if body.is_default is True:
        # Unset default on all other agents for this user
        await db.execute(
            update(Agent)
            .where(Agent.user_id == ctx.user_id, Agent.agent_id != agent_id)
            .values(is_default=False)
        )
        agent.is_default = True

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

    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    payload_b64 = base64.urlsafe_b64encode(payload_json.encode()).decode()

    secret = BIND_PROOF_SECRET or JWT_SECRET
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).decode()

    ticket = f"{payload_b64}.{sig_b64}"

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
        select(Agent).where(Agent.claim_code == claim_code)
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
        select(sa_func.count()).select_from(Agent).where(Agent.user_id == ctx.user_id)
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

    # Ensure user has the "agent_owner" role
    role_result = await db.execute(
        select(Role).where(Role.name == "agent_owner")
    )
    agent_owner_role = role_result.scalar_one_or_none()

    if agent_owner_role is not None:
        existing_ur = await db.execute(
            select(UserRole).where(
                UserRole.user_id == ctx.user_id,
                UserRole.role_id == agent_owner_role.id,
            )
        )
        if existing_ur.scalar_one_or_none() is None:
            db.add(UserRole(user_id=ctx.user_id, role_id=agent_owner_role.id))

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

    # --- resolve bind credential to real bind_ticket ---
    bind_ticket = body.bind_ticket
    if body.bind_code:
        bind_ticket = await _consume_bind_code(body.bind_code)
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

    # Consume jti (one-time use, DB-backed)
    if not await _consume_bind_ticket_jti(ticket_payload["jti"]):
        raise HTTPException(
            status_code=401, detail="Bind ticket already used"
        )

    # --- verify agent_token directly via hub JWT verification ---
    if not _verify_agent_control(body.agent_id, body.agent_token):
        raise HTTPException(
            status_code=401, detail="Agent token verification failed"
        )

    # Bind agent to user (shared logic)
    agent = await _bind_agent_to_user(
        db, user_id, body.agent_id, body.display_name, body.agent_token
    )
    return _agent_meta(agent)
