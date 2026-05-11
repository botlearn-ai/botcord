"""Agent schedule validation, dispatch, and background processing."""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import socket
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from hub.database import async_session
from hub.id_generators import generate_agent_schedule_id, generate_agent_schedule_run_id
from hub.models import Agent, AgentSchedule, AgentScheduleRun

logger = logging.getLogger(__name__)

MIN_EVERY_MS = 5 * 60 * 1000
MAX_EVERY_MS = 30 * 24 * 60 * 60 * 1000
DEFAULT_PROACTIVE_MESSAGE = "【BotCord 自主任务】执行本轮工作目标。"
_BACKGROUND_RUNS: set[asyncio.Task] = set()
WEEKDAYS = set(range(7))


def now_utc() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def aware(dt: datetime.datetime | None) -> datetime.datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def validate_schedule_json(value: dict[str, Any]) -> dict[str, Any]:
    kind = value.get("kind")
    if kind == "every":
        every_ms = value.get("every_ms", value.get("everyMs"))
        if not isinstance(every_ms, int):
            raise HTTPException(status_code=400, detail="every_ms_required")
        if every_ms < MIN_EVERY_MS:
            raise HTTPException(status_code=400, detail="schedule_interval_too_short")
        if every_ms > MAX_EVERY_MS:
            raise HTTPException(status_code=400, detail="schedule_interval_too_long")
        return {"kind": "every", "every_ms": every_ms}

    if kind == "calendar":
        frequency = value.get("frequency")
        if frequency not in {"daily", "weekly"}:
            raise HTTPException(status_code=400, detail="calendar_frequency_invalid")
        time_value = value.get("time")
        if not isinstance(time_value, str):
            raise HTTPException(status_code=400, detail="calendar_time_required")
        try:
            hour_raw, minute_raw = time_value.split(":", 1)
            hour = int(hour_raw)
            minute = int(minute_raw)
        except ValueError:
            raise HTTPException(status_code=400, detail="calendar_time_invalid") from None
        if not 0 <= hour <= 23 or not 0 <= minute <= 59:
            raise HTTPException(status_code=400, detail="calendar_time_invalid")
        timezone = value.get("timezone", "UTC")
        if not isinstance(timezone, str) or not timezone:
            raise HTTPException(status_code=400, detail="calendar_timezone_invalid")
        try:
            ZoneInfo(timezone)
        except ZoneInfoNotFoundError:
            raise HTTPException(status_code=400, detail="calendar_timezone_invalid") from None

        schedule: dict[str, Any] = {
            "kind": "calendar",
            "frequency": frequency,
            "time": f"{hour:02d}:{minute:02d}",
            "timezone": timezone,
        }
        if frequency == "weekly":
            weekdays = value.get("weekdays")
            if not isinstance(weekdays, list) or not weekdays:
                raise HTTPException(status_code=400, detail="calendar_weekdays_required")
            if any(not isinstance(day, int) or isinstance(day, bool) or day not in WEEKDAYS for day in weekdays):
                raise HTTPException(status_code=400, detail="calendar_weekdays_invalid")
            clean_weekdays = sorted(set(weekdays))
            if len(clean_weekdays) != len(weekdays):
                raise HTTPException(status_code=400, detail="calendar_weekdays_invalid")
            schedule["weekdays"] = clean_weekdays
        return schedule

    raise HTTPException(status_code=400, detail="unsupported_schedule_kind")


def validate_payload_json(value: dict[str, Any] | None) -> dict[str, Any]:
    payload = value or {}
    kind = payload.get("kind", "agent_turn")
    if kind != "agent_turn":
        raise HTTPException(status_code=400, detail="unsupported_payload_kind")
    message = payload.get("message", DEFAULT_PROACTIVE_MESSAGE)
    if not isinstance(message, str) or not message.strip():
        raise HTTPException(status_code=400, detail="message_required")
    message = message.strip()
    if len(message) > 2000:
        raise HTTPException(status_code=400, detail="message_too_long")
    return {"kind": "agent_turn", "message": message}


def compute_next_fire_at(
    schedule_json: dict[str, Any],
    base: datetime.datetime | None = None,
) -> datetime.datetime:
    schedule = validate_schedule_json(schedule_json)
    base_utc = aware(base or now_utc())
    assert base_utc is not None
    if schedule["kind"] == "every":
        return base_utc + datetime.timedelta(milliseconds=schedule["every_ms"])

    tz = ZoneInfo(schedule["timezone"])
    local_base = base_utc.astimezone(tz)
    hour, minute = (int(part) for part in schedule["time"].split(":", 1))
    allowed_weekdays = set(schedule.get("weekdays", WEEKDAYS))
    for offset in range(8):
        day = local_base.date() + datetime.timedelta(days=offset)
        if day.weekday() not in allowed_weekdays:
            continue
        candidate = datetime.datetime(
            day.year,
            day.month,
            day.day,
            hour,
            minute,
            tzinfo=tz,
        )
        if candidate > local_base:
            return candidate.astimezone(datetime.timezone.utc)
    raise HTTPException(status_code=400, detail="calendar_next_fire_unavailable")


def serialize_schedule(row: AgentSchedule) -> dict[str, Any]:
    return {
        "id": row.id,
        "agent_id": row.agent_id,
        "name": row.name,
        "enabled": row.enabled,
        "schedule": row.schedule_json,
        "payload": row.payload_json,
        "created_by": row.created_by,
        "next_fire_at": aware(row.next_fire_at).isoformat() if row.next_fire_at else None,
        "last_fire_at": aware(row.last_fire_at).isoformat() if row.last_fire_at else None,
        "created_at": aware(row.created_at).isoformat() if row.created_at else None,
        "updated_at": aware(row.updated_at).isoformat() if row.updated_at else None,
    }


def serialize_run(row: AgentScheduleRun) -> dict[str, Any]:
    return {
        "id": row.id,
        "schedule_id": row.schedule_id,
        "agent_id": row.agent_id,
        "scheduled_for": aware(row.scheduled_for).isoformat(),
        "started_at": aware(row.started_at).isoformat() if row.started_at else None,
        "completed_at": aware(row.completed_at).isoformat() if row.completed_at else None,
        "status": row.status,
        "error": row.error,
        "dedupe_key": row.dedupe_key,
        "created_at": aware(row.created_at).isoformat() if row.created_at else None,
    }


def _ack_error_message(ack: Any) -> str:
    if not isinstance(ack, dict):
        return "malformed_ack"
    err = ack.get("error")
    if isinstance(err, dict):
        code = err.get("code")
        message = err.get("message")
        if isinstance(code, str) and isinstance(message, str):
            return f"{code}: {message}"[:1000]
        if isinstance(code, str):
            return code[:1000]
        if isinstance(message, str):
            return message[:1000]
    return "ack_not_ok"


async def create_schedule(
    db: AsyncSession,
    *,
    agent: Agent,
    name: str,
    schedule_json: dict[str, Any],
    payload_json: dict[str, Any] | None,
    enabled: bool = True,
    created_by: str = "owner",
) -> AgentSchedule:
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="name_required")
    if len(clean_name) > 80:
        raise HTTPException(status_code=400, detail="name_too_long")
    schedule = validate_schedule_json(schedule_json)
    payload = validate_payload_json(payload_json)
    row = AgentSchedule(
        id=generate_agent_schedule_id(),
        agent_id=agent.agent_id,
        user_id=agent.user_id,
        name=clean_name,
        enabled=enabled,
        schedule_json=schedule,
        payload_json=payload,
        created_by=created_by,
        next_fire_at=compute_next_fire_at(schedule) if enabled else None,
    )
    db.add(row)
    await db.flush()
    return row


async def dispatch_schedule_run(
    db: AsyncSession,
    *,
    schedule: AgentSchedule,
    scheduled_for: datetime.datetime,
    manual: bool = False,
) -> AgentScheduleRun:
    agent = await db.scalar(select(Agent).where(Agent.agent_id == schedule.agent_id))
    if agent is None or agent.status != "active":
        raise HTTPException(status_code=404, detail="agent_not_found")

    run = AgentScheduleRun(
        id=generate_agent_schedule_run_id(),
        schedule_id=schedule.id,
        agent_id=schedule.agent_id,
        scheduled_for=scheduled_for,
        started_at=now_utc(),
        status="queued",
        dedupe_key=f"{schedule.id}:{int(scheduled_for.timestamp())}:{'manual' if manual else 'auto'}",
    )
    db.add(run)
    await db.flush()

    params = {
        "agent_id": schedule.agent_id,
        "reason": "manual" if manual else "scheduled",
        "trigger": "botcord.proactive",
        "message": schedule.payload_json.get("message", DEFAULT_PROACTIVE_MESSAGE),
        "schedule_id": schedule.id,
        "run_id": run.id,
        "dedupe_key": run.dedupe_key,
    }

    try:
        if agent.hosting_kind == "daemon" and agent.daemon_instance_id:
            from hub.routers.daemon_control import send_control_frame

            ack = await send_control_frame(agent.daemon_instance_id, "wake_agent", params, timeout_ms=30000)
        elif agent.hosting_kind == "plugin" and agent.openclaw_host_id:
            from hub.routers.openclaw_control import send_host_control_frame

            ack = await send_host_control_frame(agent.openclaw_host_id, "wake_agent", params, timeout_ms=30000)
        else:
            run.status = "failed"
            run.error = "agent_not_hosted"
            run.completed_at = now_utc()
            await db.flush()
            return run

        if not isinstance(ack, dict) or ack.get("ok") is not True:
            run.status = "failed"
            run.error = _ack_error_message(ack)
            run.completed_at = now_utc()
            await db.flush()
            return run
    except HTTPException as exc:
        detail = exc.detail
        code = detail if isinstance(detail, str) else str(detail)
        run.status = "offline" if exc.status_code == 409 and code in {"daemon_offline", "host_offline"} else "failed"
        run.error = code[:1000]
        run.completed_at = now_utc()
        await db.flush()
        return run
    except Exception as exc:  # noqa: BLE001
        run.status = "failed"
        run.error = str(exc)[:1000]
        run.completed_at = now_utc()
        await db.flush()
        return run

    run.status = "dispatched"
    run.error = None
    run.completed_at = now_utc()
    await db.flush()
    return run


async def process_due_schedules_once(worker_id: str | None = None, limit: int = 25) -> int:
    worker = worker_id or f"{socket.gethostname()}:{os.getpid()}"
    now = now_utc()
    lease_until = now + datetime.timedelta(seconds=60)
    processed = 0

    async with async_session() as db:
        rows = (
            await db.execute(
                select(AgentSchedule)
                .where(
                    AgentSchedule.enabled.is_(True),
                    AgentSchedule.next_fire_at.is_not(None),
                    AgentSchedule.next_fire_at <= now,
                    or_(AgentSchedule.locked_until.is_(None), AgentSchedule.locked_until < now),
                )
                .order_by(AgentSchedule.next_fire_at, AgentSchedule.id)
                .limit(limit)
            )
        ).scalars().all()

        for candidate in rows:
            result = await db.execute(
                update(AgentSchedule)
                .where(
                    AgentSchedule.id == candidate.id,
                    AgentSchedule.enabled.is_(True),
                    AgentSchedule.next_fire_at == candidate.next_fire_at,
                    or_(AgentSchedule.locked_until.is_(None), AgentSchedule.locked_until < now),
                )
                .values(locked_until=lease_until, locked_by=worker)
            )
            if result.rowcount != 1:
                continue
            await db.commit()

            schedule = await db.get(AgentSchedule, candidate.id)
            if schedule is None or schedule.next_fire_at is None:
                continue
            scheduled_for = aware(schedule.next_fire_at) or now
            await dispatch_schedule_run(db, schedule=schedule, scheduled_for=scheduled_for)
            schedule.last_fire_at = now_utc()
            schedule.next_fire_at = compute_next_fire_at(schedule.schedule_json, base=now_utc())
            schedule.locked_until = None
            schedule.locked_by = None
            await db.commit()
            processed += 1

    return processed


async def agent_schedule_loop(interval_seconds: int = 10) -> None:
    while True:
        try:
            await process_due_schedules_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("agent schedule loop failed")
        await asyncio.sleep(interval_seconds)


def start_background_schedule_run(coro: Any) -> None:
    task = asyncio.create_task(coro)
    _BACKGROUND_RUNS.add(task)
    task.add_done_callback(_BACKGROUND_RUNS.discard)
