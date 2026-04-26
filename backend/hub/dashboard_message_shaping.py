"""Shared helpers for shaping MessageRecord rows into dashboard DTOs.

Derives sender_kind / display_sender_name / is_mine for human-aware display.
"""

from __future__ import annotations

import logging
import uuid as _uuid
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import Agent, MessageRecord, User


_logger = logging.getLogger(__name__)

HUMAN_ROOM_SOURCE_TYPE = "dashboard_human_room"


def sender_kind_for(source_type: str | None) -> str:
    return "human" if source_type == HUMAN_ROOM_SOURCE_TYPE else "agent"


async def load_user_display_names(
    db: AsyncSession, user_ids: Iterable[str]
) -> dict[str, str]:
    """Map internal User.id (stored in MessageRecord.source_user_id) -> display_name.

    source_user_id is the internal user_id (UUID string), not supabase_user_id.
    We try User.id first, then fall back to supabase_user_id for legacy rows.
    """
    ids = {uid for uid in user_ids if uid}
    if not ids:
        return {}
    out: dict[str, str] = {}
    uuid_ids: list[_uuid.UUID] = []
    for s in ids:
        try:
            uuid_ids.append(_uuid.UUID(str(s)))
        except (ValueError, TypeError):
            continue
    if uuid_ids:
        try:
            result = await db.execute(
                select(User.id, User.display_name).where(User.id.in_(uuid_ids))
            )
            for uid, name in result.all():
                out[str(uid)] = name
        except Exception:
            _logger.warning("load_user_display_names: User.id lookup failed", exc_info=True)
        missing = {str(u) for u in uuid_ids} - set(out.keys())
        if missing:
            try:
                missing_uuids = [_uuid.UUID(m) for m in missing]
                result = await db.execute(
                    select(User.supabase_user_id, User.display_name).where(
                        User.supabase_user_id.in_(missing_uuids)
                    )
                )
                for uid, name in result.all():
                    out[str(uid)] = name
            except Exception:
                _logger.warning(
                    "load_user_display_names: supabase_user_id fallback failed",
                    exc_info=True,
                )
    return out


async def load_agent_display_names(
    db: AsyncSession, agent_ids: Iterable[str]
) -> dict[str, str]:
    ids = {aid for aid in agent_ids if aid}
    if not ids:
        return {}
    result = await db.execute(
        select(Agent.agent_id, Agent.display_name).where(Agent.agent_id.in_(ids))
    )
    return dict(result.all())


def derive_sender_fields(
    rec: MessageRecord,
    *,
    agent_name_map: dict[str, str],
    user_name_map: dict[str, str],
    viewer_agent_id: str | None,
    viewer_user_id: str | None,
) -> dict:
    """Return the five PRD §5.3 display fields for a single MessageRecord.

    Keys: sender_kind, display_sender_name, source_user_id, source_user_name, is_mine.
    """
    source_type = rec.source_type or "agent"
    kind = sender_kind_for(source_type)
    source_user_id = rec.source_user_id
    source_user_name: str | None = None
    is_mine = False

    if kind == "human":
        source_user_name = user_name_map.get(source_user_id) if source_user_id else None
        display_sender_name = source_user_name or "User"
        if viewer_user_id and source_user_id and str(viewer_user_id) == str(source_user_id):
            is_mine = True
    else:
        display_sender_name = agent_name_map.get(rec.sender_id) or rec.sender_id
        if viewer_agent_id and rec.sender_id == viewer_agent_id:
            is_mine = True

    return {
        "sender_kind": kind,
        "display_sender_name": display_sender_name,
        "source_user_id": source_user_id,
        "source_user_name": source_user_name,
        "is_mine": is_mine,
    }
