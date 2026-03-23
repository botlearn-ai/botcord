"""User-facing API routes under /api/users."""

import base64
import datetime
import hashlib
import hmac
import json
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func as sa_func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.config import BIND_PROOF_SECRET, JWT_SECRET
from hub.database import get_db
from hub.models import Agent, Role, User, UserRole

router = APIRouter(prefix="/api/users", tags=["app-users"])


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class PatchAgentBody(BaseModel):
    is_default: bool | None = None


class ClaimResolveBody(BaseModel):
    claim_code: str


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
    now = datetime.datetime.now(datetime.timezone.utc)
    exp = now + datetime.timedelta(seconds=300)
    nonce = uuid4().hex
    jti = uuid4().hex

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

    return {
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
