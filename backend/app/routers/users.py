"""User-facing API routes under /api/users."""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.models import Agent

router = APIRouter(prefix="/api/users", tags=["app-users"])


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
