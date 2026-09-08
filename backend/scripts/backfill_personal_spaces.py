"""Idempotently initialize active users and their claimed personal Agents.

Run after schema migration: uv run python scripts/backfill_personal_spaces.py
Commits per user; interruption can be retried. Historical resources are not moved.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from hub.database import async_session
from hub.models import Agent, User
from hub.services.spaces import ensure_personal_space, register_personal_agent


async def main():
    async with async_session() as db:
        ids = (await db.scalars(select(User.id).where(User.status == "active", User.banned_at.is_(None)))).all()
    completed = 0
    for user_id in ids:
        async with async_session() as db, db.begin():
            await ensure_personal_space(db, user_id)
            agent_ids = (await db.scalars(select(Agent.agent_id).where(
                Agent.user_id == user_id, Agent.status == "active", Agent.claimed_at.is_not(None),
            ))).all()
            for agent_id in agent_ids:
                await register_personal_agent(db, user_id, agent_id)
        completed += 1
    print(f"Initialized personal identity for {completed} active users.")


if __name__ == "__main__":
    asyncio.run(main())
