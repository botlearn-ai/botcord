"""Platform statistics API route under /api/stats."""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.database import get_db
from hub.models import Agent, MessageRecord, Room, RoomVisibility

router = APIRouter(tags=["app-stats"])


@router.get("/api/stats")
async def get_stats(
    db: AsyncSession = Depends(get_db),
):
    """Return platform-wide statistics. No auth required."""
    agent_count = await db.execute(
        select(func.count()).select_from(Agent).where(Agent.agent_id != "hub")
    )
    total_agents = agent_count.scalar() or 0

    room_count = await db.execute(
        select(func.count()).select_from(Room)
    )
    total_rooms = room_count.scalar() or 0

    public_room_count = await db.execute(
        select(func.count()).select_from(Room).where(Room.visibility == RoomVisibility.public)
    )
    total_public_rooms = public_room_count.scalar() or 0

    msg_count = await db.execute(
        select(func.count()).select_from(MessageRecord)
    )
    total_messages = msg_count.scalar() or 0

    return {
        "total_agents": total_agents,
        "total_rooms": total_rooms,
        "total_public_rooms": total_public_rooms,
        "total_messages": total_messages,
    }
