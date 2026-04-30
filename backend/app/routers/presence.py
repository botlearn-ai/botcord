"""
[INPUT]: 依赖 hub.services.presence 与 dashboard 鉴权，承载前端拉取 agent 状态 snapshot 与设置 manual status 的入口。
[OUTPUT]: 对外提供 GET/POST /api/presence/agents、PATCH /api/agents/{agent_id}/status。
[POS]: BFF 层 presence 路由，负责权限过滤、observer 视图与 invisible 隐藏。
[PROTOCOL]: 变更时更新此头部，然后检查 README.md。
"""

from __future__ import annotations

import datetime
import logging
from typing import Iterable

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.models import Agent, Contact, RoomMember, User
from hub.services import presence as presence_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/presence", tags=["app-presence"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class SnapshotRequest(BaseModel):
    agent_ids: list[str] = Field(default_factory=list, max_length=200)


class SnapshotResponse(BaseModel):
    agents: list[dict]


class ManualStatusUpdate(BaseModel):
    manual_status: str = Field(..., pattern=r"^(available|busy|away|invisible)$")
    status_message: str | None = Field(default=None, max_length=140)
    manual_expires_at: datetime.datetime | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _resolve_human_id(db: AsyncSession, user_id) -> str | None:
    row = await db.execute(select(User.human_id).where(User.id == user_id))
    return row.scalar_one_or_none()


async def _filter_visible(
    db: AsyncSession,
    requester_human_id: str | None,
    requester_owned_agent_ids: set[str],
    agent_ids: Iterable[str],
) -> dict[str, bool]:
    """Return {agent_id: is_owner} for agents the requester is allowed to see.

    Visibility rules:
      - owner: always allowed (is_owner=True)
      - contact: ``Contact.owner_id == requester_human_id`` and
        ``contact_agent_id in agent_ids``
      - room comember: ``RoomMember`` join via shared room
      - else: hidden (entry omitted)
    """
    ids = list({a for a in agent_ids if a})
    if not ids:
        return {}

    visible: dict[str, bool] = {}

    # Owner check
    own_rows = (
        await db.execute(
            select(Agent.agent_id).where(
                Agent.agent_id.in_(ids),
                Agent.agent_id.in_(requester_owned_agent_ids)
                if requester_owned_agent_ids
                else Agent.agent_id.is_(None),
            )
        )
    ).scalars().all()
    for aid in own_rows:
        visible[aid] = True

    if requester_human_id is None:
        return visible

    remaining = [a for a in ids if a not in visible]
    if not remaining:
        return visible

    # Contact check (requester_human_id has contact_agent_id == aid)
    contact_rows = (
        await db.execute(
            select(Contact.contact_agent_id).where(
                Contact.owner_id == requester_human_id,
                Contact.contact_agent_id.in_(remaining),
            )
        )
    ).scalars().all()
    for aid in contact_rows:
        visible.setdefault(aid, False)

    remaining = [a for a in ids if a not in visible]
    if not remaining:
        return visible

    # Room comember check: requester membership is polymorphic — they may be in
    # rooms as their human id (hu_*) OR via any of their owned agents (ag_*).
    requester_membership_ids: list[str] = []
    if requester_human_id is not None:
        requester_membership_ids.append(requester_human_id)
    requester_membership_ids.extend(requester_owned_agent_ids)
    requester_rooms: list[str] = []
    if requester_membership_ids:
        requester_rooms = (
            await db.execute(
                select(RoomMember.room_id).where(
                    RoomMember.agent_id.in_(requester_membership_ids)
                )
            )
        ).scalars().all()
    if requester_rooms:
        comember_rows = (
            await db.execute(
                select(RoomMember.agent_id).where(
                    RoomMember.agent_id.in_(remaining),
                    RoomMember.room_id.in_(list(requester_rooms)),
                )
            )
        ).scalars().all()
        for aid in comember_rows:
            visible.setdefault(aid, False)

    return visible


async def _requester_owned_agent_ids(
    db: AsyncSession, user_id
) -> set[str]:
    rows = (
        await db.execute(select(Agent.agent_id).where(Agent.user_id == user_id))
    ).scalars().all()
    return set(rows)


async def _build_response(
    db: AsyncSession, ctx: RequestContext, agent_ids: list[str]
) -> SnapshotResponse:
    requester_human_id = await _resolve_human_id(db, ctx.user_id)
    owned_ids = await _requester_owned_agent_ids(db, ctx.user_id)
    visible = await _filter_visible(
        db, requester_human_id, owned_ids, agent_ids
    )
    if not visible:
        return SnapshotResponse(agents=[])

    snapshots = await presence_service.get_snapshots(db, list(visible.keys()))
    seen = {s.agent_id for s in snapshots}
    # For agents with no presence row yet, return a synthetic offline snapshot
    # so the frontend always has an entry per requested id.
    extras = []
    for aid, is_owner in visible.items():
        if aid in seen:
            continue
        extras.append(
            {
                "agent_id": aid,
                "version": 0,
                "effective_status": "offline",
                "connected": False,
                "manual_status": "available",
                "status_message": None,
                "manual_expires_at": None,
                "activity": {},
                "attributes": {},
                "last_seen_at": None,
                "updated_at": "",
            }
        )

    payloads = [s.for_observer(is_owner=visible[s.agent_id]) for s in snapshots]
    return SnapshotResponse(agents=payloads + extras)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/agents", response_model=SnapshotResponse)
async def get_agent_snapshots(
    ids: str = Query(default="", description="Comma-separated agent ids"),
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> SnapshotResponse:
    agent_ids = [a.strip() for a in ids.split(",") if a.strip()][:200]
    if not agent_ids:
        return SnapshotResponse(agents=[])
    return await _build_response(db, ctx, agent_ids)


@router.post("/agents/snapshot", response_model=SnapshotResponse)
async def post_agent_snapshots(
    body: SnapshotRequest,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> SnapshotResponse:
    if not body.agent_ids:
        return SnapshotResponse(agents=[])
    return await _build_response(db, ctx, body.agent_ids)


# Mounted on a separate prefix in main.py so that the URL is
# /api/agents/{agent_id}/status — matching the design doc.
status_router = APIRouter(prefix="/api/agents", tags=["app-presence"])


@status_router.patch("/{agent_id}/status")
async def update_manual_status(
    agent_id: str,
    body: ManualStatusUpdate,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    agent_row = (
        await db.execute(select(Agent).where(Agent.agent_id == agent_id))
    ).scalar_one_or_none()
    if agent_row is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if str(agent_row.user_id) != str(ctx.user_id):
        raise HTTPException(status_code=403, detail="Not the owner of this agent")

    snapshot, changed = await presence_service.set_manual_status(
        db,
        agent_id,
        body.manual_status,
        status_message=body.status_message,
        manual_expires_at=body.manual_expires_at,
        updated_by_type="user",
        updated_by_id=str(ctx.user_id),
    )
    await db.commit()

    if changed:
        # Lazy import to avoid circular dependency
        import asyncio

        from hub.routers.hub import broadcast_status_changed

        try:
            asyncio.create_task(broadcast_status_changed(snapshot))
        except RuntimeError:
            # Event loop is shutting down — drop the broadcast.
            pass

    return snapshot.for_observer(is_owner=True)
