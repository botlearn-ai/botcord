"""Agent capability rating API under /api/dashboard/agents/{agent_id}/capability."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user_with_optional_agent
from hub.database import get_db
from hub.models import Agent
from hub.services.agent_capability import compute_agent_capability

router = APIRouter(prefix="/api/dashboard", tags=["app-agent-capability"])


@router.get("/agents/{agent_id}/capability")
async def get_agent_capability(
    agent_id: str,
    ctx: RequestContext = Depends(require_user_with_optional_agent),
    db: AsyncSession = Depends(get_db),
):
    """Layered capability scores (L0 declared, L1 observed) for an owned agent."""
    agent = (
        await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    ).scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.user_id != ctx.user_id:
        raise HTTPException(status_code=403, detail="Agent not owned by user")
    return await compute_agent_capability(db, agent)
