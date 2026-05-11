"""Dashboard-facing agent schedule management."""

from __future__ import annotations

import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_user
from hub.database import get_db
from hub.models import Agent, AgentSchedule, AgentScheduleRun
from hub.services.agent_schedules import (
    compute_next_fire_at,
    create_schedule,
    dispatch_schedule_run,
    now_utc,
    serialize_run,
    serialize_schedule,
    validate_payload_json,
    validate_schedule_json,
)

router = APIRouter(prefix="/api/agents", tags=["agent-schedules"])


class ScheduleBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    enabled: bool = True
    schedule: dict[str, Any]
    payload: dict[str, Any] | None = None


class SchedulePatchBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    enabled: bool | None = None
    schedule: dict[str, Any] | None = None
    payload: dict[str, Any] | None = None


async def _load_owned_agent(db: AsyncSession, ctx: RequestContext, agent_id: str) -> Agent:
    agent = await db.scalar(select(Agent).where(Agent.agent_id == agent_id))
    if agent is None or str(agent.user_id) != str(ctx.user_id) or agent.status != "active":
        raise HTTPException(status_code=404, detail="agent_not_found")
    return agent


async def _load_owned_schedule(
    db: AsyncSession,
    ctx: RequestContext,
    agent_id: str,
    schedule_id: str,
) -> AgentSchedule:
    await _load_owned_agent(db, ctx, agent_id)
    row = await db.scalar(
        select(AgentSchedule).where(
            AgentSchedule.id == schedule_id,
            AgentSchedule.agent_id == agent_id,
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="schedule_not_found")
    return row


@router.get("/{agent_id}/schedules")
async def list_schedules(
    agent_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await _load_owned_agent(db, ctx, agent_id)
    rows = (
        await db.execute(
            select(AgentSchedule)
            .where(AgentSchedule.agent_id == agent_id)
            .order_by(AgentSchedule.created_at, AgentSchedule.id)
        )
    ).scalars().all()
    return {"schedules": [serialize_schedule(row) for row in rows]}


@router.post("/{agent_id}/schedules", status_code=201)
async def create_agent_schedule(
    agent_id: str,
    body: ScheduleBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    agent = await _load_owned_agent(db, ctx, agent_id)
    row = await create_schedule(
        db,
        agent=agent,
        name=body.name,
        schedule_json=body.schedule,
        payload_json=body.payload,
        enabled=body.enabled,
        created_by="owner",
    )
    try:
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        await db.rollback()
        if "agent_schedules" in str(exc):
            raise HTTPException(status_code=409, detail="schedule_name_exists")
        raise
    await db.refresh(row)
    return serialize_schedule(row)


@router.patch("/{agent_id}/schedules/{schedule_id}")
async def patch_agent_schedule(
    agent_id: str,
    schedule_id: str,
    body: SchedulePatchBody,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    row = await _load_owned_schedule(db, ctx, agent_id, schedule_id)
    schedule_changed = False
    if body.name is not None:
        row.name = body.name.strip()
    if body.schedule is not None:
        row.schedule_json = validate_schedule_json(body.schedule)
        schedule_changed = True
    if body.payload is not None:
        row.payload_json = validate_payload_json(body.payload)
    if body.enabled is not None:
        row.enabled = body.enabled
        schedule_changed = True
    if schedule_changed:
        row.next_fire_at = compute_next_fire_at(row.schedule_json) if row.enabled else None
        row.locked_until = None
        row.locked_by = None
    try:
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        await db.rollback()
        if "agent_schedules" in str(exc):
            raise HTTPException(status_code=409, detail="schedule_name_exists")
        raise
    await db.refresh(row)
    return serialize_schedule(row)


@router.delete("/{agent_id}/schedules/{schedule_id}", status_code=204)
async def delete_agent_schedule(
    agent_id: str,
    schedule_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    row = await _load_owned_schedule(db, ctx, agent_id, schedule_id)
    await db.delete(row)
    await db.commit()


@router.post("/{agent_id}/schedules/{schedule_id}/run")
async def run_agent_schedule(
    agent_id: str,
    schedule_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    row = await _load_owned_schedule(db, ctx, agent_id, schedule_id)
    run = await dispatch_schedule_run(
        db,
        schedule=row,
        scheduled_for=now_utc(),
        manual=True,
    )
    row.last_fire_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    await db.refresh(run)
    return serialize_run(run)


@router.get("/{agent_id}/schedules/{schedule_id}/runs")
async def list_schedule_runs(
    agent_id: str,
    schedule_id: str,
    ctx: RequestContext = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await _load_owned_schedule(db, ctx, agent_id, schedule_id)
    rows = (
        await db.execute(
            select(AgentScheduleRun)
            .where(
                AgentScheduleRun.schedule_id == schedule_id,
                AgentScheduleRun.agent_id == agent_id,
            )
            .order_by(AgentScheduleRun.created_at.desc())
            .limit(20)
        )
    ).scalars().all()
    return {"runs": [serialize_run(row) for row in rows]}
