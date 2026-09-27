"""
[INPUT]: Agent row + MessageRecord / Topic / AgentSchedule(Run) / UsageEvent / Block history
[OUTPUT]: compute_agent_capability — six general axes (CLEAR + autonomy), each scored per evidence layer
[POS]: Scoring core for the dashboard capability radar; pure metadata, never reads message content
[PROTOCOL]: update header on changes

Axes are domain-agnostic (Efficacy, Latency, Reliability, Cost, Autonomy,
Assurance). Layers are evidence strength, not dimensions: L0 = declared /
configured, L1 = observed by the Hub. L2 (counterparty ratings) and L3
(certification) will add further layers on the same axes.
"""

from __future__ import annotations

import bisect
import datetime
import math
import statistics
from typing import Any

from sqlalchemy import distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import ContactPolicy, MessagePolicy, MessageState, RoomInvitePolicy, TopicStatus
from hub.models import (
    Agent,
    AgentSchedule,
    AgentScheduleRun,
    Block,
    MessageRecord,
    Topic,
    UsageEvent,
)

WINDOW_DAYS = 30
# Inbound messages newer than this are still inside the reply window and are
# not judged yet; the same grace applies to delivery state.
REPLY_WINDOW = datetime.timedelta(minutes=30)
DELIVERY_GRACE = datetime.timedelta(minutes=10)
MAX_MESSAGE_SAMPLE = 200
MIN_INBOUND_SAMPLE = 5
MIN_REPLY_SAMPLE = 3
MIN_DELIVERY_SAMPLE = 5
MIN_TOPIC_SAMPLE = 3
MIN_RUN_SAMPLE = 3
MIN_OUTBOUND_SAMPLE = 5

AXES = ("efficacy", "latency", "reliability", "cost", "autonomy", "assurance")

# Ordered: the first matching keyword wins, so lite variants ("gpt-5-mini")
# must be listed before their full-size family ("gpt-5").
# Each tier: (keywords, capability score, cost-efficiency score).
_MODEL_TIERS: list[tuple[tuple[str, ...], int, int]] = [
    (("haiku", "mini", "flash", "nano", "lite"), 60, 90),
    (("opus", "fable", "best"), 95, 40),
    (("gpt-5",), 90, 55),
    (("sonnet", "gpt-4", "o3", "pro", "deepseek", "qwen", "kimi", "glm"), 80, 65),
]
_UNKNOWN_MODEL = (60, 60)
# Runtime default model when the agent did not pin one.
_RUNTIME_DEFAULTS = {"claude-code": (85, 55), "codex": (90, 55)}

# Skills every agent of a runtime gets for free; they carry no signal.
BUNDLED_SKILLS = frozenset(
    {
        "botcord",
        "botcord-user-guide",
        "botcord_memory",
        "skill-creator",
        "skill-installer",
        "plugin-creator",
        "openai-docs",
        "imagegen",
    }
)

_HOSTING_LATENCY = {"cloud": 90, "daemon": 70, "openclaw": 70, "cli": 40}

_DELIVERED_STATES = {MessageState.delivered, MessageState.acked, MessageState.done}
_TERMINAL_TOPIC_STATES = {TopicStatus.completed, TopicStatus.failed, TopicStatus.expired}
_SCHEDULE_RUN_OUTCOMES = {"dispatched", "failed", "offline"}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _ev(score: float | None, value: Any = None, sample: int | None = None) -> dict:
    """One evidence cell: an axis scored by one layer."""
    return {
        "score": None if score is None else max(0, min(100, round(score))),
        "value": value,
        "sample": sample,
    }


def _mean(scores: list[float | None]) -> float | None:
    present = [s for s in scores if s is not None]
    return sum(present) / len(present) if present else None


def _saturate(n: float, scale: float) -> float:
    """0 → 0, grows toward 100; n == scale ≈ 63."""
    return 100 * (1 - math.exp(-n / scale))


def _log_decay(x: float, best: float, worst: float) -> float:
    """≤best → 100, ≥worst → 0, log-linear in between."""
    if x <= best:
        return 100.0
    return 100 * (1 - math.log(x / best) / math.log(worst / best))


def _aware(ts: datetime.datetime) -> datetime.datetime:
    # SQLite returns naive datetimes; Postgres returns aware ones.
    return ts if ts.tzinfo else ts.replace(tzinfo=datetime.timezone.utc)


def model_tier(runtime: str | None, runtime_model: str | None) -> tuple[int, int] | None:
    """(capability, cost-efficiency) for the configured model, or None if unknown."""
    model = (runtime_model or "").strip().lower()
    if model and model != "default":
        for keywords, capability, cost in _MODEL_TIERS:
            if any(k in model for k in keywords):
                return capability, cost
        return _UNKNOWN_MODEL
    if not runtime:
        return None
    return _RUNTIME_DEFAULTS.get(runtime, _UNKNOWN_MODEL)


def effective_skill_count(skills_json: list | None) -> int | None:
    if skills_json is None:
        return None
    names = {s.get("name") for s in skills_json if isinstance(s, dict) and s.get("name")}
    return len(names - BUNDLED_SKILLS)


# ---------------------------------------------------------------------------
# L0 — declared / configured
# ---------------------------------------------------------------------------


async def _l0(db: AsyncSession, agent: Agent, now: datetime.datetime) -> dict[str, dict]:
    tier = model_tier(agent.runtime, agent.runtime_model)
    skills = effective_skill_count(agent.skills_json)
    model_label = agent.runtime_model or agent.runtime

    efficacy = _ev(
        _mean(
            [
                tier[0] if tier else None,
                _saturate(skills, 5) if skills is not None else None,
            ]
        ),
        {"model": model_label, "skills": skills},
    )

    latency = _ev(_HOSTING_LATENCY.get(agent.hosting_kind or ""), agent.hosting_kind)

    filled = [bool((agent.bio or "").strip()), bool(agent.avatar_url), bool(agent.runtime)]
    age_days = (now - _aware(agent.created_at)).days if agent.created_at else 0
    reliability = _ev(
        _mean([sum(filled) / len(filled) * 100, min(age_days, WINDOW_DAYS) / WINDOW_DAYS * 100]),
        {"profile": sum(filled), "profile_total": len(filled), "age_days": age_days},
    )

    cost = _ev(tier[1] if tier else None, model_label)

    schedules = (
        await db.execute(
            select(func.count()).where(
                AgentSchedule.agent_id == agent.agent_id,
                AgentSchedule.enabled.is_(True),
            )
        )
    ).scalar_one()
    autonomy = _ev(20 + 0.8 * _saturate(schedules, 2), schedules)

    guarded = [
        agent.message_policy == MessagePolicy.contacts_only,
        agent.contact_policy != ContactPolicy.open,
        agent.room_invite_policy != RoomInvitePolicy.open,
    ]
    assurance = _ev(sum(guarded) / len(guarded) * 100, {"guarded": sum(guarded), "total": len(guarded)})

    return {
        "efficacy": efficacy,
        "latency": latency,
        "reliability": reliability,
        "cost": cost,
        "autonomy": autonomy,
        "assurance": assurance,
    }


# ---------------------------------------------------------------------------
# L1 — observed by the Hub
# ---------------------------------------------------------------------------


async def _topic_outcomes(db: AsyncSession, agent_id: str, start: datetime.datetime) -> dict:
    rows = (
        await db.execute(
            select(Topic.status, func.count(distinct(Topic.topic_id)))
            .join(MessageRecord, MessageRecord.topic_id == Topic.topic_id)
            .where(
                MessageRecord.sender_id == agent_id,
                Topic.updated_at >= start,
                Topic.status.in_(_TERMINAL_TOPIC_STATES),
            )
            .group_by(Topic.status)
        )
    ).all()
    total = sum(c for _, c in rows)
    if total < MIN_TOPIC_SAMPLE:
        return _ev(None, sample=total)
    completed = sum(c for status, c in rows if status == TopicStatus.completed)
    return _ev(completed / total * 100, round(completed / total, 3), total)


async def _responsiveness(db: AsyncSession, agent_id: str, now: datetime.datetime) -> dict:
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    # Only DMs, owner chat and @mentions expect a reply; plain group fan-out does not.
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
            .limit(MAX_MESSAGE_SAMPLE)
        )
    ).all()
    inbound = [(r.room_id, _aware(r.created_at)) for r in rows]
    if len(inbound) < MIN_INBOUND_SAMPLE:
        return _ev(None, sample=len(inbound))

    earliest = min(ts for _, ts in inbound)
    rooms = [r for r in {room for room, _ in inbound} if r is not None]
    outbound = await _outbound_by_room(db, agent_id, earliest, rooms)

    delays: list[float] = []
    for room, ts in inbound:
        series = outbound.get(room, [])
        i = bisect.bisect_right(series, ts)
        if i < len(series) and series[i] - ts <= REPLY_WINDOW:
            delays.append((series[i] - ts).total_seconds())

    rate = len(delays) / len(inbound)
    median = statistics.median(delays) if len(delays) >= MIN_REPLY_SAMPLE else None
    speed = _log_decay(median, 30, 30 * 60) if median is not None else None
    return _ev(
        _mean([rate * 100, speed]),
        {"reply_rate": round(rate, 3), "median_seconds": None if median is None else round(median)},
        len(inbound),
    )


async def _outbound_by_room(
    db: AsyncSession, agent_id: str, since: datetime.datetime, rooms: list[str]
) -> dict[str | None, list[datetime.datetime]]:
    # Room fan-out writes one row per receiver; collapse to one per msg_id.
    rows = (
        await db.execute(
            select(MessageRecord.room_id, func.min(MessageRecord.created_at))
            .where(
                MessageRecord.sender_id == agent_id,
                MessageRecord.created_at >= since,
                or_(MessageRecord.room_id.in_(rooms), MessageRecord.room_id.is_(None)),
            )
            .group_by(MessageRecord.msg_id, MessageRecord.room_id)
        )
    ).all()
    out: dict[str | None, list[datetime.datetime]] = {}
    for room, ts in rows:
        out.setdefault(room, []).append(_aware(ts))
    for series in out.values():
        series.sort()
    return out


async def _delivery_rate(db: AsyncSession, agent_id: str, now: datetime.datetime) -> float | None:
    rows = (
        await db.execute(
            select(MessageRecord.state, func.count())
            .where(
                MessageRecord.receiver_id == agent_id,
                MessageRecord.created_at >= now - datetime.timedelta(days=WINDOW_DAYS),
                MessageRecord.created_at <= now - DELIVERY_GRACE,
            )
            .group_by(MessageRecord.state)
        )
    ).all()
    total = sum(c for _, c in rows)
    if total < MIN_DELIVERY_SAMPLE:
        return None
    return sum(c for state, c in rows if state in _DELIVERED_STATES) / total


async def _schedule_success_rate(db: AsyncSession, agent_id: str, start: datetime.datetime) -> float | None:
    rows = (
        await db.execute(
            select(AgentScheduleRun.status, func.count())
            .where(
                AgentScheduleRun.agent_id == agent_id,
                AgentScheduleRun.scheduled_for >= start,
                AgentScheduleRun.status.in_(_SCHEDULE_RUN_OUTCOMES),
            )
            .group_by(AgentScheduleRun.status)
        )
    ).all()
    total = sum(c for _, c in rows)
    if total < MIN_RUN_SAMPLE:
        return None
    return sum(c for status, c in rows if status == "dispatched") / total


async def _active_days(db: AsyncSession, agent_id: str, start: datetime.datetime) -> int:
    return (
        await db.execute(
            select(func.count(distinct(func.date(MessageRecord.created_at)))).where(
                MessageRecord.sender_id == agent_id,
                MessageRecord.created_at >= start,
            )
        )
    ).scalar_one()


async def _reliability(db: AsyncSession, agent_id: str, now: datetime.datetime) -> dict:
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    delivery = await _delivery_rate(db, agent_id, now)
    schedules = await _schedule_success_rate(db, agent_id, start)
    days = await _active_days(db, agent_id, start)
    return _ev(
        _mean(
            [
                None if delivery is None else delivery * 100,
                None if schedules is None else schedules * 100,
                days / WINDOW_DAYS * 100,
            ]
        ),
        {
            "delivery_rate": None if delivery is None else round(delivery, 3),
            "schedule_success_rate": None if schedules is None else round(schedules, 3),
            "active_days": days,
        },
    )


async def _cost(db: AsyncSession, agent_id: str, start: datetime.datetime) -> dict:
    rows = (
        await db.execute(
            select(
                func.sum(
                    UsageEvent.input_cache_miss_tokens
                    + UsageEvent.output_tokens
                    + UsageEvent.input_cache_hit_tokens / 10
                )
            )
            .where(UsageEvent.agent_id == agent_id, UsageEvent.created_at >= start)
            .group_by(UsageEvent.run_id)
        )
    ).all()
    if len(rows) < MIN_RUN_SAMPLE:
        return _ev(None, sample=len(rows))
    median_tokens = statistics.median(float(r[0] or 0) for r in rows)
    # Effective tokens per run: ≤20k is cheap, ≥1M is expensive.
    return _ev(_log_decay(max(median_tokens, 1), 20_000, 1_000_000), round(median_tokens), len(rows))


async def _autonomy(db: AsyncSession, agent_id: str, now: datetime.datetime) -> dict:
    """Share of outbound messages not prompted by an inbound message in the prior window."""
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    out_rows = (
        await db.execute(
            select(MessageRecord.room_id, func.min(MessageRecord.created_at).label("ts"))
            .where(MessageRecord.sender_id == agent_id, MessageRecord.created_at >= start)
            .group_by(MessageRecord.msg_id, MessageRecord.room_id)
            .order_by(func.min(MessageRecord.created_at).desc())
            .limit(MAX_MESSAGE_SAMPLE)
        )
    ).all()
    outbound = [(r.room_id, _aware(r.ts)) for r in out_rows]
    if len(outbound) < MIN_OUTBOUND_SAMPLE:
        return _ev(None, sample=len(outbound))

    since = min(ts for _, ts in outbound) - REPLY_WINDOW
    rooms = [r for r in {room for room, _ in outbound} if r is not None]
    in_rows = (
        await db.execute(
            select(MessageRecord.room_id, MessageRecord.created_at).where(
                MessageRecord.receiver_id == agent_id,
                MessageRecord.sender_id != agent_id,
                MessageRecord.created_at >= since,
                or_(MessageRecord.room_id.in_(rooms), MessageRecord.room_id.is_(None)),
            )
        )
    ).all()
    inbound: dict[str | None, list[datetime.datetime]] = {}
    for room, ts in in_rows:
        inbound.setdefault(room, []).append(_aware(ts))
    for series in inbound.values():
        series.sort()

    proactive = 0
    for room, ts in outbound:
        series = inbound.get(room, [])
        i = bisect.bisect_left(series, ts)
        if i == 0 or ts - series[i - 1] > REPLY_WINDOW:
            proactive += 1
    share = proactive / len(outbound)
    # 30%+ self-initiated traffic already means the agent runs on its own.
    return _ev(share / 0.3 * 100, round(share, 3), len(outbound))


async def _assurance(db: AsyncSession, agent_id: str, start: datetime.datetime) -> dict:
    sent = (
        await db.execute(
            select(func.count(distinct(MessageRecord.msg_id))).where(
                MessageRecord.sender_id == agent_id,
                MessageRecord.created_at >= start,
            )
        )
    ).scalar_one()
    if sent < MIN_OUTBOUND_SAMPLE:
        return _ev(None, sample=sent)
    blocks = (
        await db.execute(
            select(func.count()).where(Block.blocked_agent_id == agent_id, Block.created_at >= start)
        )
    ).scalar_one()
    # Messages removed by someone other than the agent itself (owner / room admin).
    recalled = (
        await db.execute(
            select(func.count(distinct(MessageRecord.msg_id))).where(
                MessageRecord.sender_id == agent_id,
                MessageRecord.created_at >= start,
                MessageRecord.recalled_at.isnot(None),
                MessageRecord.recalled_by_id != agent_id,
            )
        )
    ).scalar_one()
    incidents = blocks + recalled
    return _ev(100 - 20 * incidents, {"blocks": blocks, "recalled": recalled}, sent)


async def _l1(db: AsyncSession, agent: Agent, now: datetime.datetime) -> dict[str, dict]:
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    aid = agent.agent_id
    return {
        "efficacy": await _topic_outcomes(db, aid, start),
        "latency": await _responsiveness(db, aid, now),
        "reliability": await _reliability(db, aid, now),
        "cost": await _cost(db, aid, start),
        "autonomy": await _autonomy(db, aid, now),
        "assurance": await _assurance(db, aid, start),
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def compute_agent_capability(
    db: AsyncSession, agent: Agent, now: datetime.datetime | None = None
) -> dict:
    now = now or datetime.datetime.now(datetime.timezone.utc)
    layers = {"l0": await _l0(db, agent, now), "l1": await _l1(db, agent, now)}
    layer_scores = {}
    for key, cells in layers.items():
        score = _mean([cells[axis]["score"] for axis in AXES])
        layer_scores[key] = None if score is None else round(score)
    return {
        "agent_id": agent.agent_id,
        "window_days": WINDOW_DAYS,
        "computed_at": now.isoformat(),
        "layers": ["l0", "l1"],
        "layer_scores": layer_scores,
        "axes": [
            {"key": axis, "layers": {key: cells[axis] for key, cells in layers.items()}}
            for axis in AXES
        ],
    }
