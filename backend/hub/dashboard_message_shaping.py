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
USER_CHAT_SOURCE_TYPE = "dashboard_user_chat"
HUMAN_SOURCE_TYPES = frozenset({HUMAN_ROOM_SOURCE_TYPE, USER_CHAT_SOURCE_TYPE})


def sender_kind_for(source_type: str | None) -> str:
    return "human" if source_type in HUMAN_SOURCE_TYPES else "agent"


async def load_user_profiles(
    db: AsyncSession, user_ids: Iterable[str]
) -> dict[str, tuple[str, str | None]]:
    """Map internal User.id (stored in MessageRecord.source_user_id) -> display_name/avatar.

    source_user_id is the internal user_id (UUID string), not supabase_user_id.
    We try User.id first, then fall back to supabase_user_id for legacy rows.
    """
    ids = {uid for uid in user_ids if uid}
    if not ids:
        return {}
    out: dict[str, tuple[str, str | None]] = {}
    uuid_ids: list[_uuid.UUID] = []
    human_ids: list[str] = []
    for s in ids:
        try:
            uuid_ids.append(_uuid.UUID(str(s)))
        except (ValueError, TypeError):
            if str(s).startswith("hu_"):
                human_ids.append(str(s))
            continue
    if uuid_ids:
        try:
            result = await db.execute(
                select(User.id, User.display_name, User.avatar_url).where(
                    User.id.in_(uuid_ids)
                )
            )
            for uid, name, avatar_url in result.all():
                out[str(uid)] = (name, avatar_url)
        except Exception:
            _logger.warning("load_user_display_names: User.id lookup failed", exc_info=True)
        missing = {str(u) for u in uuid_ids} - set(out.keys())
        if missing:
            try:
                missing_uuids = [_uuid.UUID(m) for m in missing]
                result = await db.execute(
                    select(User.supabase_user_id, User.display_name, User.avatar_url).where(
                        User.supabase_user_id.in_(missing_uuids)
                    )
                )
                for uid, name, avatar_url in result.all():
                    out[str(uid)] = (name, avatar_url)
            except Exception:
                _logger.warning(
                    "load_user_display_names: supabase_user_id fallback failed",
                    exc_info=True,
                )
    if human_ids:
        try:
            result = await db.execute(
                select(User.human_id, User.display_name, User.avatar_url).where(
                    User.human_id.in_(human_ids)
                )
            )
            for human_id, name, avatar_url in result.all():
                out[str(human_id)] = (name, avatar_url)
        except Exception:
            _logger.warning("load_user_display_names: human_id lookup failed", exc_info=True)
    return out


async def load_user_display_names(
    db: AsyncSession, user_ids: Iterable[str]
) -> dict[str, str]:
    profiles = await load_user_profiles(db, user_ids)
    return {uid: profile[0] for uid, profile in profiles.items()}


async def load_agent_profiles(
    db: AsyncSession, agent_ids: Iterable[str]
) -> dict[str, tuple[str, str | None]]:
    ids = {aid for aid in agent_ids if aid}
    if not ids:
        return {}
    result = await db.execute(
        select(Agent.agent_id, Agent.display_name, Agent.avatar_url).where(
            Agent.agent_id.in_(ids)
        )
    )
    return {aid: (name, avatar_url) for aid, name, avatar_url in result.all()}


async def load_agent_display_names(
    db: AsyncSession, agent_ids: Iterable[str]
) -> dict[str, str]:
    profiles = await load_agent_profiles(db, agent_ids)
    return {aid: profile[0] for aid, profile in profiles.items()}


def derive_sender_fields(
    rec: MessageRecord,
    *,
    agent_name_map: dict[str, str],
    agent_avatar_map: dict[str, str | None] | None = None,
    user_name_map: dict[str, str],
    user_avatar_map: dict[str, str | None] | None = None,
    viewer_agent_id: str | None,
    viewer_user_id: str | None,
) -> dict:
    """Return the five PRD §5.3 display fields for a single MessageRecord.

    Keys: sender_kind, display_sender_name, source_user_id, source_user_name, is_mine.
    """
    source_type = rec.source_type or "agent"
    kind = sender_kind_for(source_type)
    if kind != "human" and (rec.sender_id or "").startswith("hu_"):
        kind = "human"
    source_user_id = rec.source_user_id
    source_user_name: str | None = None
    sender_avatar_url: str | None = None
    is_mine = False

    if kind == "human":
        source_user_name = (
            user_name_map.get(source_user_id) if source_user_id else None
        ) or user_name_map.get(rec.sender_id)
        display_sender_name = source_user_name or "User"
        sender_avatar_url = (
            user_avatar_map.get(source_user_id) if user_avatar_map and source_user_id else None
        ) or (user_avatar_map.get(rec.sender_id) if user_avatar_map else None)
        if viewer_user_id and source_user_id and str(viewer_user_id) == str(source_user_id):
            is_mine = True
    else:
        display_sender_name = agent_name_map.get(rec.sender_id) or rec.sender_id
        sender_avatar_url = agent_avatar_map.get(rec.sender_id) if agent_avatar_map else None
        if viewer_agent_id and rec.sender_id == viewer_agent_id:
            is_mine = True

    return {
        "sender_kind": kind,
        "display_sender_name": display_sender_name,
        "sender_avatar_url": sender_avatar_url,
        "source_user_id": source_user_id,
        "source_user_name": source_user_name,
        "is_mine": is_mine,
    }
