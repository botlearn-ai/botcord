"""
[INPUT]: 依赖 agent_presence / agent_status_settings / agent_presence_connections 三张表与 Supabase Realtime broadcast 能力，承载 Agent 在线、忙碌、工作中等综合状态的统一写入路径。
[OUTPUT]: 对外提供 mark_connected / mark_heartbeat / mark_disconnected / set_manual_status / set_processing / get_snapshots 等 Presence Service API。
[POS]: hub 状态系统中枢，负责把连接信号、用户主动设置、活动信号合成为 effective_status 并广播。
[PROTOCOL]: 变更时更新此头部，然后检查 README.md。
"""

from __future__ import annotations

import dataclasses
import datetime
import logging
from typing import Iterable

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import CompileError
from sqlalchemy.ext.asyncio import AsyncSession

from hub import config as hub_config
from hub.models import AgentPresence, AgentPresenceConnection, AgentStatusSettings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EFFECTIVE_STATUSES = ("offline", "online", "busy", "away", "working")
MANUAL_STATUSES = ("available", "busy", "away", "invisible")


# ---------------------------------------------------------------------------
# DTO
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class AgentPresenceSnapshot:
    """Read model returned to API/realtime layers."""

    agent_id: str
    effective_status: str
    connected: bool
    connection_count: int
    version: int
    last_seen_at: datetime.datetime | None
    activity: dict
    attributes: dict
    manual_status: str
    status_message: str | None
    manual_expires_at: datetime.datetime | None
    updated_at: datetime.datetime | None

    def to_dict(self) -> dict:
        def _iso(value: datetime.datetime | None) -> str | None:
            return value.isoformat() if value else None

        return {
            "agent_id": self.agent_id,
            "version": self.version,
            "effective_status": self.effective_status,
            "connected": self.connected,
            "manual_status": self.manual_status,
            "status_message": self.status_message,
            "manual_expires_at": _iso(self.manual_expires_at),
            "activity": dict(self.activity),
            "attributes": dict(self.attributes),
            "last_seen_at": _iso(self.last_seen_at),
            "updated_at": _iso(self.updated_at),
        }

    def for_observer(self, *, is_owner: bool) -> dict:
        """Return public projection. Non-owners never see ``invisible`` —
        the agent appears as ``offline`` instead.
        """
        if not is_owner and self.manual_status == "invisible":
            d = self.to_dict()
            d["effective_status"] = "offline"
            d["connected"] = False
            d["manual_status"] = "available"
            d["status_message"] = None
            return d
        return self.to_dict()


# ---------------------------------------------------------------------------
# Pure resolver (unit-testable in isolation)
# ---------------------------------------------------------------------------


def resolve_effective_status(
    *,
    manual_status: str,
    connected: bool,
    activity: dict,
) -> str:
    """Compose effective_status from manual_status + connection + activity.

    Priority:
      invisible           -> offline
      not connected       -> offline
      activity.processing -> working
      manual busy         -> busy
      manual away / idle  -> away
      otherwise           -> online
    """
    if manual_status == "invisible":
        return "offline"
    if not connected:
        return "offline"
    if bool(activity.get("processing")):
        return "working"
    if manual_status == "busy":
        return "busy"
    if manual_status == "away" or bool(activity.get("idle")):
        return "away"
    return "online"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _now(now: datetime.datetime | None = None) -> datetime.datetime:
    return now or datetime.datetime.now(datetime.timezone.utc)


def _online_cutoff(now: datetime.datetime) -> datetime.datetime:
    return now - datetime.timedelta(
        seconds=hub_config.PRESENCE_ONLINE_TIMEOUT_SECONDS
    )


async def _ensure_row(
    db: AsyncSession,
    model,
    agent_id: str,
    insert_values: dict,
):
    """Race-safe upsert-then-lock pattern.

    On Postgres: ``INSERT ... ON CONFLICT DO NOTHING`` then ``SELECT ... FOR
    UPDATE``. Concurrent first-create attempts converge: only one INSERT
    wins; both observers see the row under a row lock for the subsequent
    update.

    On other dialects (SQLite tests): fall back to get-or-add. The test
    suite is single-connection so the race window doesn't apply.
    """
    bind = db.get_bind()
    is_postgres = getattr(bind, "dialect", None) is not None and bind.dialect.name == "postgresql"

    if is_postgres:
        # Under READ COMMITTED, a concurrent in-flight INSERT for the same
        # PK causes ON CONFLICT DO NOTHING to skip silently AND the follow-up
        # SELECT FOR UPDATE will not see the uncommitted row, so a tight
        # first-create race can yield no row. One retry covers it: the
        # racing transaction will have committed by then.
        stmt = (
            pg_insert(model)
            .values(**insert_values)
            .on_conflict_do_nothing(index_elements=[model.agent_id])
        )
        for attempt in range(2):
            await db.execute(stmt)
            row = (
                await db.execute(
                    select(model).where(model.agent_id == agent_id).with_for_update()
                )
            ).scalar_one_or_none()
            if row is not None:
                return row
        raise RuntimeError(
            f"presence: could not ensure {model.__tablename__} row for {agent_id}"
        )

    row = await db.get(model, agent_id)
    if row is None:
        row = model(**insert_values)
        db.add(row)
        await db.flush()
    return row


async def _ensure_settings(
    db: AsyncSession, agent_id: str
) -> AgentStatusSettings:
    return await _ensure_row(
        db,
        AgentStatusSettings,
        agent_id,
        {"agent_id": agent_id, "manual_status": "available"},
    )


async def _ensure_presence(
    db: AsyncSession, agent_id: str
) -> AgentPresence:
    return await _ensure_row(
        db, AgentPresence, agent_id, {"agent_id": agent_id}
    )


async def _count_connections(
    db: AsyncSession, agent_id: str, *, now: datetime.datetime
) -> int:
    cutoff = _online_cutoff(now)
    rows = await db.execute(
        select(AgentPresenceConnection.connection_id).where(
            AgentPresenceConnection.agent_id == agent_id,
            AgentPresenceConnection.last_seen_at >= cutoff,
        )
    )
    return len(rows.scalars().all())


def _expire_manual_if_needed(
    settings: AgentStatusSettings, now: datetime.datetime
) -> None:
    """In-place: if manual_expires_at has passed, reset to ``available``."""
    if (
        settings.manual_expires_at is not None
        and settings.manual_expires_at <= now
    ):
        settings.manual_status = "available"
        settings.status_message = None
        settings.manual_expires_at = None


def _expire_processing_if_needed(
    activity: dict, now: datetime.datetime
) -> dict:
    """Return a copy of ``activity`` with ``processing`` cleared if expired."""
    a = dict(activity)
    expires_at = a.get("processing_expires_at")
    if expires_at and a.get("processing"):
        try:
            ts = datetime.datetime.fromisoformat(str(expires_at))
        except (TypeError, ValueError):
            ts = None
        if ts and ts <= now:
            a["processing"] = False
            a.pop("processing_expires_at", None)
    return a


async def _recompute_and_persist(
    db: AsyncSession,
    agent_id: str,
    *,
    now: datetime.datetime,
    activity_override: dict | None = None,
    attributes_override: dict | None = None,
) -> tuple[AgentPresenceSnapshot, bool]:
    """Recompute effective_status, persist, and return (snapshot, changed).

    ``changed`` is True when version was bumped (effective_status, connected,
    or one of activity/attributes changed). Callers can use this to skip
    realtime broadcasts on no-op updates.
    """
    settings = await _ensure_settings(db, agent_id)
    presence = await _ensure_presence(db, agent_id)

    _expire_manual_if_needed(settings, now)

    activity = activity_override if activity_override is not None else dict(presence.activity_json or {})
    activity = _expire_processing_if_needed(activity, now)
    attributes = (
        attributes_override
        if attributes_override is not None
        else dict(presence.attributes_json or {})
    )

    connection_count = await _count_connections(db, agent_id, now=now)
    connected = connection_count > 0

    new_status = resolve_effective_status(
        manual_status=settings.manual_status,
        connected=connected,
        activity=activity,
    )

    changed = (
        presence.effective_status != new_status
        or presence.connected != connected
        or presence.connection_count != connection_count
        or dict(presence.activity_json or {}) != activity
        or dict(presence.attributes_json or {}) != attributes
    )

    presence.effective_status = new_status
    presence.connected = connected
    presence.connection_count = connection_count
    presence.activity_json = activity
    presence.attributes_json = attributes
    presence.updated_at = now
    if changed:
        presence.version = (presence.version or 0) + 1
        if connected:
            presence.last_seen_at = now

    await db.flush()
    snapshot = _to_snapshot(presence, settings)
    return snapshot, changed


def _to_snapshot(
    presence: AgentPresence, settings: AgentStatusSettings
) -> AgentPresenceSnapshot:
    return AgentPresenceSnapshot(
        agent_id=presence.agent_id,
        effective_status=presence.effective_status,
        connected=presence.connected,
        connection_count=presence.connection_count,
        version=presence.version or 0,
        last_seen_at=presence.last_seen_at,
        activity=dict(presence.activity_json or {}),
        attributes=dict(presence.attributes_json or {}),
        manual_status=settings.manual_status,
        status_message=settings.status_message,
        manual_expires_at=settings.manual_expires_at,
        updated_at=presence.updated_at,
    )


async def _upsert_connection(
    db: AsyncSession,
    *,
    connection_id: str,
    agent_id: str,
    node_id: str,
    now: datetime.datetime,
) -> None:
    """Insert or refresh ``last_seen_at`` for this connection lease.

    Uses Postgres-style ON CONFLICT in production. For the SQLite test
    backend we fall back to a manual upsert path.
    """
    try:
        stmt = (
            pg_insert(AgentPresenceConnection)
            .values(
                connection_id=connection_id,
                agent_id=agent_id,
                node_id=node_id,
                last_seen_at=now,
                created_at=now,
            )
            .on_conflict_do_update(
                index_elements=[AgentPresenceConnection.connection_id],
                set_={"last_seen_at": now, "node_id": node_id},
            )
        )
        await db.execute(stmt)
        return
    except (CompileError, NotImplementedError):
        pass

    existing = await db.get(AgentPresenceConnection, connection_id)
    if existing is None:
        db.add(
            AgentPresenceConnection(
                connection_id=connection_id,
                agent_id=agent_id,
                node_id=node_id,
                last_seen_at=now,
                created_at=now,
            )
        )
    else:
        existing.last_seen_at = now
        existing.node_id = node_id
    await db.flush()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def mark_connected(
    db: AsyncSession,
    agent_id: str,
    connection_id: str,
    *,
    node_id: str | None = None,
    now: datetime.datetime | None = None,
) -> tuple[AgentPresenceSnapshot, bool]:
    """Register a new agent WS connection and recompute presence."""
    moment = _now(now)
    await _upsert_connection(
        db,
        connection_id=connection_id,
        agent_id=agent_id,
        node_id=(node_id or hub_config.PRESENCE_NODE_ID),
        now=moment,
    )
    return await _recompute_and_persist(db, agent_id, now=moment)


async def mark_heartbeat(
    db: AsyncSession,
    agent_id: str,
    connection_id: str,
    *,
    node_id: str | None = None,
    now: datetime.datetime | None = None,
) -> tuple[AgentPresenceSnapshot, bool]:
    """Refresh ``last_seen_at`` for a known connection."""
    moment = _now(now)
    await _upsert_connection(
        db,
        connection_id=connection_id,
        agent_id=agent_id,
        node_id=(node_id or hub_config.PRESENCE_NODE_ID),
        now=moment,
    )
    return await _recompute_and_persist(db, agent_id, now=moment)


async def mark_disconnected(
    db: AsyncSession,
    agent_id: str,
    connection_id: str,
    *,
    now: datetime.datetime | None = None,
) -> tuple[AgentPresenceSnapshot, bool]:
    """Drop a single connection lease and recompute presence."""
    moment = _now(now)
    await db.execute(
        delete(AgentPresenceConnection).where(
            AgentPresenceConnection.connection_id == connection_id
        )
    )
    return await _recompute_and_persist(db, agent_id, now=moment)


async def set_manual_status(
    db: AsyncSession,
    agent_id: str,
    manual_status: str,
    *,
    status_message: str | None = None,
    manual_expires_at: datetime.datetime | None = None,
    updated_by_type: str | None = None,
    updated_by_id: str | None = None,
    now: datetime.datetime | None = None,
) -> tuple[AgentPresenceSnapshot, bool]:
    if manual_status not in MANUAL_STATUSES:
        raise ValueError(f"invalid manual_status: {manual_status!r}")
    moment = _now(now)
    settings = await _ensure_settings(db, agent_id)
    settings.manual_status = manual_status
    settings.status_message = status_message
    settings.manual_expires_at = manual_expires_at
    settings.updated_by_type = updated_by_type
    settings.updated_by_id = updated_by_id
    settings.updated_at = moment
    await db.flush()
    return await _recompute_and_persist(db, agent_id, now=moment)


async def set_processing(
    db: AsyncSession,
    agent_id: str,
    processing: bool,
    *,
    current_task: str | None = None,
    expires_at: datetime.datetime | None = None,
    now: datetime.datetime | None = None,
) -> tuple[AgentPresenceSnapshot, bool]:
    moment = _now(now)
    presence = await _ensure_presence(db, agent_id)
    activity = dict(presence.activity_json or {})
    attributes = dict(presence.attributes_json or {})

    activity["processing"] = bool(processing)
    if processing:
        if expires_at is None:
            expires_at = moment + datetime.timedelta(
                seconds=hub_config.PRESENCE_PROCESSING_FAILSAFE_TIMEOUT_SECONDS
            )
        activity["processing_expires_at"] = expires_at.isoformat()
        if current_task is not None:
            attributes["current_task"] = current_task
    else:
        activity.pop("processing_expires_at", None)
        attributes.pop("current_task", None)

    return await _recompute_and_persist(
        db,
        agent_id,
        now=moment,
        activity_override=activity,
        attributes_override=attributes,
    )


async def set_typing(
    db: AsyncSession,
    agent_id: str,
    typing: bool,
    *,
    expires_at: datetime.datetime | None = None,
    now: datetime.datetime | None = None,
) -> tuple[AgentPresenceSnapshot, bool]:
    moment = _now(now)
    presence = await _ensure_presence(db, agent_id)
    activity = dict(presence.activity_json or {})
    activity["typing"] = bool(typing)
    if typing:
        if expires_at is None:
            expires_at = moment + datetime.timedelta(
                seconds=hub_config.PRESENCE_TYPING_TIMEOUT_SECONDS
            )
        activity["typing_expires_at"] = expires_at.isoformat()
    else:
        activity.pop("typing_expires_at", None)
    return await _recompute_and_persist(
        db, agent_id, now=moment, activity_override=activity
    )


_DEFAULT_SETTINGS_TUPLE = ("available", None, None)


async def get_snapshots(
    db: AsyncSession,
    agent_ids: Iterable[str],
) -> list[AgentPresenceSnapshot]:
    ids = [a for a in dict.fromkeys(agent_ids) if a]
    if not ids:
        return []
    presence_rows = (
        await db.execute(select(AgentPresence).where(AgentPresence.agent_id.in_(ids)))
    ).scalars().all()
    settings_rows = (
        await db.execute(
            select(
                AgentStatusSettings.agent_id,
                AgentStatusSettings.manual_status,
                AgentStatusSettings.status_message,
                AgentStatusSettings.manual_expires_at,
            ).where(AgentStatusSettings.agent_id.in_(ids))
        )
    ).all()
    settings_by_id = {row[0]: (row[1], row[2], row[3]) for row in settings_rows}
    out: list[AgentPresenceSnapshot] = []
    for presence in presence_rows:
        manual_status, status_message, manual_expires_at = settings_by_id.get(
            presence.agent_id, _DEFAULT_SETTINGS_TUPLE
        )
        out.append(
            AgentPresenceSnapshot(
                agent_id=presence.agent_id,
                effective_status=presence.effective_status,
                connected=presence.connected,
                connection_count=presence.connection_count,
                version=presence.version or 0,
                last_seen_at=presence.last_seen_at,
                activity=dict(presence.activity_json or {}),
                attributes=dict(presence.attributes_json or {}),
                manual_status=manual_status,
                status_message=status_message,
                manual_expires_at=manual_expires_at,
                updated_at=presence.updated_at,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------


def emit_processing_signal_async(
    agent_id: str,
    processing: bool,
    *,
    current_task: str | None = None,
) -> None:
    """Fire-and-forget helper for callers that don't have a DB session handy.

    Schedules a background task that opens its own session, calls
    ``set_processing``, and broadcasts on change. Failures are logged but
    never raised — presence updates must never break the message path.
    """
    import asyncio

    from hub.database import async_session

    async def _run():
        try:
            async with async_session() as db:
                snapshot, changed = await set_processing(
                    db, agent_id, processing, current_task=current_task
                )
                await db.commit()
            if changed:
                from hub.routers.hub import broadcast_status_changed

                asyncio.create_task(broadcast_status_changed(snapshot))
        except Exception as exc:
            logger.warning(
                "emit_processing_signal_async failed agent=%s err=%s",
                agent_id, exc,
            )

    try:
        asyncio.create_task(_run())
    except RuntimeError:
        # No running event loop — running outside async context.
        pass


async def cleanup_stale(
    db: AsyncSession,
    *,
    now: datetime.datetime | None = None,
) -> list[AgentPresenceSnapshot]:
    """Drop expired connection leases + recompute affected agents.

    Returns snapshots whose effective_status changed (callers should
    broadcast each one).
    """
    moment = _now(now)
    cutoff = _online_cutoff(moment)

    stale_rows = (
        await db.execute(
            select(AgentPresenceConnection.agent_id)
            .where(AgentPresenceConnection.last_seen_at < cutoff)
        )
    ).scalars().all()

    affected_agent_ids: set[str] = set(stale_rows)
    if stale_rows:
        await db.execute(
            delete(AgentPresenceConnection).where(
                AgentPresenceConnection.last_seen_at < cutoff
            )
        )

    # Catch presence rows that still claim ``connected=True`` but no live
    # connection lease exists (covers Hub restarts that left orphan rows).
    orphan_rows = (
        await db.execute(
            select(AgentPresence.agent_id).where(
                AgentPresence.connected == True,  # noqa: E712
                ~select(AgentPresenceConnection.connection_id)
                .where(
                    AgentPresenceConnection.agent_id == AgentPresence.agent_id,
                    AgentPresenceConnection.last_seen_at >= cutoff,
                )
                .exists(),
            )
        )
    ).scalars().all()
    affected_agent_ids.update(orphan_rows)

    changed: list[AgentPresenceSnapshot] = []
    for agent_id in affected_agent_ids:
        snapshot, was_changed = await _recompute_and_persist(
            db, agent_id, now=moment
        )
        if was_changed:
            changed.append(snapshot)
    return changed
