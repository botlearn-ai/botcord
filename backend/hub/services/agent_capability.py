"""
[INPUT]: Agent row + MessageRecord history
[OUTPUT]: compute_agent_capability — layered capability scores (L0 declared, L1 observed)
[POS]: Scoring core for the dashboard capability radar; pure metadata, never reads message content
[PROTOCOL]: update header on changes
"""

from __future__ import annotations

import bisect
import datetime
import math
import statistics
from typing import Any

from sqlalchemy import distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import MessageState
from hub.models import Agent, MessageRecord

WINDOW_DAYS = 30
# Inbound messages newer than this are still inside the reply window and are
# not judged yet; the same grace applies to delivery state.
REPLY_WINDOW = datetime.timedelta(minutes=30)
DELIVERY_GRACE = datetime.timedelta(minutes=10)
MAX_INBOUND_SAMPLE = 200
MIN_INBOUND_SAMPLE = 5
MIN_REPLY_SAMPLE = 3
MIN_DELIVERY_SAMPLE = 5

# Ordered: the first matching keyword wins, so lite variants ("gpt-5-mini")
# must be listed before their full-size family ("gpt-5").
_MODEL_TIERS: list[tuple[tuple[str, ...], int]] = [
    (("haiku", "mini", "flash", "nano", "lite"), 60),
    (("opus", "fable", "best"), 95),
    (("gpt-5",), 90),
    (("sonnet", "gpt-4", "o3", "pro", "deepseek", "qwen", "kimi", "glm"), 80),
]
_UNKNOWN_MODEL_SCORE = 60
# Runtime default model when the agent did not pin one.
_RUNTIME_DEFAULT_SCORES = {"claude-code": 85, "codex": 90}

_DELIVERED_STATES = {MessageState.delivered, MessageState.acked, MessageState.done}


def _dim(key: str, score: float | None, value: Any = None, sample: int | None = None) -> dict:
    return {
        "key": key,
        "score": None if score is None else max(0, min(100, round(score))),
        "value": value,
        "sample": sample,
    }


def _layer(key: str, dims: list[dict]) -> dict:
    scored = [d["score"] for d in dims if d["score"] is not None]
    return {
        "key": key,
        "score": round(sum(scored) / len(scored)) if scored else None,
        "dimensions": dims,
    }


def score_model(runtime: str | None, runtime_model: str | None) -> dict:
    model = (runtime_model or "").strip().lower()
    if model and model != "default":
        for keywords, score in _MODEL_TIERS:
            if any(k in model for k in keywords):
                return _dim("model", score, runtime_model)
        return _dim("model", _UNKNOWN_MODEL_SCORE, runtime_model)
    if not runtime:
        return _dim("model", None)
    return _dim("model", _RUNTIME_DEFAULT_SCORES.get(runtime, _UNKNOWN_MODEL_SCORE), runtime)


def score_skills(skills_json: list | None) -> dict:
    if skills_json is None:
        return _dim("skills", None)
    names = {s.get("name") for s in skills_json if isinstance(s, dict) and s.get("name")}
    n = len(names)
    # Saturating curve: 6 skills ≈ 63, 12 ≈ 86.
    return _dim("skills", 100 * (1 - math.exp(-n / 6)), n)


def score_profile(agent: Agent) -> dict:
    filled = {
        "bio": bool((agent.bio or "").strip()),
        "avatar": bool(agent.avatar_url),
        "runtime": bool(agent.runtime),
    }
    weights = {"bio": 40, "avatar": 30, "runtime": 30}
    return _dim("profile", sum(weights[k] for k, ok in filled.items() if ok), filled)


def score_latency(median_seconds: float) -> float:
    """≤30s → 100, ≥30min → 0, log-linear in between."""
    if median_seconds <= 30:
        return 100.0
    return 100 * (1 - math.log(median_seconds / 30) / math.log(60))


async def _responsiveness_dims(
    db: AsyncSession, agent_id: str, now: datetime.datetime
) -> list[dict]:
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    rows = (
        await db.execute(
            select(MessageRecord.room_id, MessageRecord.created_at)
            .where(
                MessageRecord.receiver_id == agent_id,
                MessageRecord.sender_id != agent_id,
                MessageRecord.created_at >= start,
                MessageRecord.created_at <= now - REPLY_WINDOW,
                or_(
                    MessageRecord.room_id.is_(None),
                    MessageRecord.mentioned.is_(True),
                    MessageRecord.room_id.startswith("rm_dm_"),
                    MessageRecord.room_id.startswith("rm_oc_"),
                ),
            )
            .order_by(MessageRecord.created_at.desc())
            .limit(MAX_INBOUND_SAMPLE)
        )
    ).all()
    # Only DMs, owner chat and @mentions expect a reply; plain group fan-out does not.
    inbound = [(r.room_id, _aware(r.created_at)) for r in rows]
    if len(inbound) < MIN_INBOUND_SAMPLE:
        return [
            _dim("response_rate", None, sample=len(inbound)),
            _dim("latency", None, sample=0),
        ]

    earliest = min(ts for _, ts in inbound)
    rooms = {room for room, _ in inbound}
    out_rows = (
        await db.execute(
            select(MessageRecord.room_id, func.min(MessageRecord.created_at))
            .where(
                MessageRecord.sender_id == agent_id,
                MessageRecord.created_at >= earliest,
                or_(
                    MessageRecord.room_id.in_([r for r in rooms if r is not None]),
                    MessageRecord.room_id.is_(None),
                ),
            )
            .group_by(MessageRecord.msg_id, MessageRecord.room_id)
        )
    ).all()
    outbound: dict[str | None, list[datetime.datetime]] = {}
    for room, ts in out_rows:
        outbound.setdefault(room, []).append(_aware(ts))
    for series in outbound.values():
        series.sort()

    delays: list[float] = []
    for room, ts in inbound:
        series = outbound.get(room, [])
        i = bisect.bisect_right(series, ts)
        if i < len(series) and series[i] - ts <= REPLY_WINDOW:
            delays.append((series[i] - ts).total_seconds())

    rate = len(delays) / len(inbound)
    latency = (
        _dim("latency", score_latency(statistics.median(delays)), round(statistics.median(delays)), len(delays))
        if len(delays) >= MIN_REPLY_SAMPLE
        else _dim("latency", None, sample=len(delays))
    )
    return [_dim("response_rate", rate * 100, round(rate, 3), len(inbound)), latency]


async def _delivery_dim(db: AsyncSession, agent_id: str, now: datetime.datetime) -> dict:
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    rows = (
        await db.execute(
            select(MessageRecord.state, func.count())
            .where(
                MessageRecord.receiver_id == agent_id,
                MessageRecord.created_at >= start,
                MessageRecord.created_at <= now - DELIVERY_GRACE,
            )
            .group_by(MessageRecord.state)
        )
    ).all()
    total = sum(c for _, c in rows)
    if total < MIN_DELIVERY_SAMPLE:
        return _dim("delivery", None, sample=total)
    ok = sum(c for state, c in rows if state in _DELIVERED_STATES)
    return _dim("delivery", ok / total * 100, round(ok / total, 3), total)


async def _activity_dim(db: AsyncSession, agent_id: str, now: datetime.datetime) -> dict:
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    active_days = (
        await db.execute(
            select(func.count(distinct(func.date(MessageRecord.created_at)))).where(
                MessageRecord.sender_id == agent_id,
                MessageRecord.created_at >= start,
            )
        )
    ).scalar_one()
    return _dim("activity", active_days / WINDOW_DAYS * 100, active_days, WINDOW_DAYS)


def _aware(ts: datetime.datetime) -> datetime.datetime:
    # SQLite returns naive datetimes; Postgres returns aware ones.
    return ts if ts.tzinfo else ts.replace(tzinfo=datetime.timezone.utc)


async def compute_agent_capability(
    db: AsyncSession, agent: Agent, now: datetime.datetime | None = None
) -> dict:
    now = now or datetime.datetime.now(datetime.timezone.utc)
    l0 = _layer(
        "l0",
        [
            score_model(agent.runtime, agent.runtime_model),
            score_skills(agent.skills_json),
            score_profile(agent),
        ],
    )
    l1 = _layer(
        "l1",
        [
            *await _responsiveness_dims(db, agent.agent_id, now),
            await _delivery_dim(db, agent.agent_id, now),
            await _activity_dim(db, agent.agent_id, now),
        ],
    )
    return {
        "agent_id": agent.agent_id,
        "window_days": WINDOW_DAYS,
        "computed_at": now.isoformat(),
        "layers": [l0, l1],
    }
