"""Display-name helpers for system-created direct-message rooms.

DM room IDs stay deterministic and machine-readable. The room title is
user-facing, so it should use the participants' names rather than their IDs.
"""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import Agent, User


_DM_ROOM_NAME_LIMIT = 128
_DM_ROOM_NAME_SEPARATOR = " & "
_DM_ROOM_NAME_SUFFIX = " 的私聊"


def _truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    if limit <= 1:
        return value[:limit]
    return f"{value[:limit - 1]}…"


def format_dm_room_name(participant_names: Sequence[str]) -> str:
    """Return the persisted title for a two-person DM within ``Room.name``."""
    if len(participant_names) != 2:
        raise ValueError("A DM room must have exactly two participant names")

    first, second = (name.strip() or "Unknown" for name in participant_names)
    title = f"{first}{_DM_ROOM_NAME_SEPARATOR}{second}{_DM_ROOM_NAME_SUFFIX}"
    if len(title) <= _DM_ROOM_NAME_LIMIT:
        return title

    available = _DM_ROOM_NAME_LIMIT - len(_DM_ROOM_NAME_SEPARATOR) - len(_DM_ROOM_NAME_SUFFIX)
    first_limit = (available + 1) // 2
    second_limit = available - first_limit
    return (
        f"{_truncate(first, first_limit)}{_DM_ROOM_NAME_SEPARATOR}"
        f"{_truncate(second, second_limit)}{_DM_ROOM_NAME_SUFFIX}"
    )


async def build_dm_room_name(
    db: AsyncSession,
    participant_ids: Sequence[str],
) -> str:
    """Resolve a friendly persisted title for an agent/human DM pair.

    Missing legacy identities deliberately fall back to their IDs so room
    creation remains resilient even if a profile was deleted concurrently.
    """
    if len(participant_ids) != 2:
        raise ValueError("A DM room must have exactly two participants")

    agent_ids = [participant_id for participant_id in participant_ids if participant_id.startswith("ag_")]
    human_ids = [participant_id for participant_id in participant_ids if participant_id.startswith("hu_")]
    display_names: dict[str, str] = {}

    if agent_ids:
        result = await db.execute(
            select(Agent.agent_id, Agent.display_name).where(Agent.agent_id.in_(agent_ids))
        )
        display_names.update({agent_id: display_name for agent_id, display_name in result.all()})

    if human_ids:
        result = await db.execute(
            select(User.human_id, User.display_name).where(User.human_id.in_(human_ids))
        )
        display_names.update({human_id: display_name for human_id, display_name in result.all() if human_id})

    return format_dm_room_name([
        display_names.get(participant_id, participant_id)
        for participant_id in participant_ids
    ])
