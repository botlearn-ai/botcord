"""
[INPUT]: Agent row + MessageRecord / Topic / AgentSchedule(Run) / Block history + model reference table
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
import json
import math
import statistics
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import ContactPolicy, MessagePolicy, MessageState, RoomInvitePolicy, TopicStatus
from hub.models import (
    Agent,
    AgentSchedule,
    AgentScheduleRun,
    Block,
    MessageRecord,
    Topic,
)

# Production traffic is sparse; a 30-day window left most agents without samples.
WINDOW_DAYS = 90
# Inbound messages newer than this are still inside the reply window and are
# not judged yet; the same grace applies to delivery state.
REPLY_WINDOW = datetime.timedelta(minutes=30)
DELIVERY_GRACE = datetime.timedelta(minutes=10)
MAX_MESSAGE_SAMPLE = 200
MIN_INBOUND_SAMPLE = 5
MIN_REPLY_SAMPLE = 3
MIN_DELIVERY_SAMPLE = 5
MIN_RUN_SAMPLE = 3
MIN_OUTBOUND_SAMPLE = 5
MIN_AUTONOMY_SAMPLE = 10

AXES = ("efficacy", "latency", "reliability", "cost", "autonomy", "assurance")

# Bayesian prior weight: an observed rate needs this many samples before it
# outweighs the L0 prior as much as the prior itself.
PRIOR_WEIGHT = 5


@dataclass(frozen=True)
class ModelRef:
    name: str
    # Artificial Analysis Intelligence Index (v4.x); None when not indexed.
    index: float
    input_price: float  # USD per 1M tokens, list price
    output_price: float

    @property
    def blended_price(self) -> float:
        """3:1 input:output blend, the Artificial Analysis convention."""
        return (3 * self.input_price + self.output_price) / 4


# Sources (2026-09): Artificial Analysis model pages / launch articles for the
# index and list prices; digitalapplied.com price index where AA lists none.
# Haiku 4.5 is not in the current index — its score is an estimate.
_OPUS = ModelRef("claude-opus-5.5", 58, 4.0, 20.0)
_FABLE = ModelRef("claude-fable-5.1", 53, 10.0, 50.0)
_SONNET = ModelRef("claude-sonnet-5", 53, 3.0, 15.0)
_HAIKU = ModelRef("claude-haiku-4.5", 38, 1.0, 5.0)
_GPT_SOL = ModelRef("gpt-5.6-sol", 59, 5.0, 30.0)
_GPT_TERRA = ModelRef("gpt-5.6-terra", 55, 2.5, 15.0)
_GPT_LUNA = ModelRef("gpt-5.6-luna", 51, 1.0, 6.0)
_GPT_55 = ModelRef("gpt-5.5", 53, 5.0, 30.0)
_DEEPSEEK_PRO = ModelRef("deepseek-v4-pro", 53, 1.32, 3.96)
_DEEPSEEK_FLASH = ModelRef("deepseek-v4-flash", 39.5, 0.44, 1.32)
_GEMINI_FLASH = ModelRef("gemini-3.5-flash", 50, 1.5, 9.0)
_KIMI = ModelRef("kimi-k3", 43.6, 3.0, 15.0)
_GLM = ModelRef("glm-5.3", 45, 1.4, 4.4)
_GLM_FLASH = ModelRef("glm-5.3-flash", 41.8, 0.15, 0.5)
_GROK = ModelRef("grok-4.7", 46.5, 2.0, 6.0)

# Ordered rules: every substring in the tuple must appear; the first match wins,
# so narrower variants come before their family.
_MODEL_RULES: list[tuple[tuple[str, ...], ModelRef]] = [
    (("haiku",), _HAIKU),
    (("luna",), _GPT_LUNA),
    (("terra",), _GPT_TERRA),
    (("gpt", "mini"), _GPT_LUNA),
    (("gpt", "nano"), _GPT_LUNA),
    (("gpt-5.6",), _GPT_SOL),
    (("gpt-5",), _GPT_55),
    (("fable",), _FABLE),
    (("opus",), _OPUS),
    (("best",), _OPUS),
    (("sonnet",), _SONNET),
    (("deepseek", "flash"), _DEEPSEEK_FLASH),
    (("deepseek",), _DEEPSEEK_PRO),
    (("gemini", "flash"), _GEMINI_FLASH),
    (("kimi",), _KIMI),
    (("glm", "flash"), _GLM_FLASH),
    (("glm",), _GLM),
    (("grok",), _GROK),
]
# Model a runtime uses when the agent did not pin one (assumed CLI defaults).
_RUNTIME_DEFAULT_MODELS = {"claude-code": _SONNET, "codex": _GPT_SOL}

# Index 30 → 0, 60 → 100: spans today's usable agent models.
_INDEX_FLOOR, _INDEX_CEIL = 30.0, 60.0
# Blended price ≤ $0.3/M → 100, ≥ $30/M → 0 (log scale; prices span 100×).
_PRICE_BEST, _PRICE_WORST = 0.3, 30.0

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

# Hub system notices (e.g. TTL_EXPIRED receipts for the agent's own sends) use
# this sender id; they are not conversation and must not count as inbound.
_HUB_SENDER = "hub"
# Owner-chat human turns are stored with sender_id == receiver_id == agent_id
# (the human lives in source_user_id), so sender_id alone misattributes them.
_OWNER_CHAT_HUMAN_SOURCE = "dashboard_user_chat"


def _inbound(agent_id: str):
    """Messages someone else sent to the agent (humans in owner chat included)."""
    return and_(
        MessageRecord.receiver_id == agent_id,
        MessageRecord.sender_id != _HUB_SENDER,
        or_(
            MessageRecord.sender_id != agent_id,
            MessageRecord.source_type == _OWNER_CHAT_HUMAN_SOURCE,
        ),
    )


def _outbound(agent_id: str):
    """Messages the agent itself authored."""
    return and_(
        MessageRecord.sender_id == agent_id,
        MessageRecord.source_type != _OWNER_CHAT_HUMAN_SOURCE,
    )


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _ev(
    score: float | None,
    value: Any = None,
    sample: int | None = None,
    confidence: float | None = None,
) -> dict:
    """One evidence cell: an axis scored by one layer.

    ``confidence`` is set only for smoothed cells: the share of the score that
    comes from observation rather than the L0 prior.
    """
    return {
        "score": None if score is None else max(0, min(100, round(score))),
        "value": value,
        "sample": sample,
        "confidence": None if confidence is None else round(confidence, 2),
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


def resolve_model(runtime: str | None, runtime_model: str | None) -> ModelRef | None:
    model = (runtime_model or "").strip().lower()
    if model and model != "default":
        for required, ref in _MODEL_RULES:
            if all(k in model for k in required):
                return ref
        return None
    return _RUNTIME_DEFAULT_MODELS.get(runtime or "")


def model_capability_score(ref: ModelRef) -> float:
    return (ref.index - _INDEX_FLOOR) / (_INDEX_CEIL - _INDEX_FLOOR) * 100


def model_cost_score(ref: ModelRef) -> float:
    return _log_decay(ref.blended_price, _PRICE_BEST, _PRICE_WORST)


def _smoothed(successes: int, trials: int, prior: float | None) -> tuple[float, float]:
    """Bayesian average toward the L0 prior (0–100); returns (score, confidence)."""
    p = 0.5 if prior is None else prior / 100
    score = (successes + PRIOR_WEIGHT * p) / (trials + PRIOR_WEIGHT) * 100
    return score, trials / (trials + PRIOR_WEIGHT)


def effective_skill_count(skills_json: list | None) -> int | None:
    if skills_json is None:
        return None
    names = {s.get("name") for s in skills_json if isinstance(s, dict) and s.get("name")}
    return len(names - BUNDLED_SKILLS)


# ---------------------------------------------------------------------------
# L0 — declared / configured
# ---------------------------------------------------------------------------


async def _l0(db: AsyncSession, agent: Agent, now: datetime.datetime) -> dict[str, dict]:
    ref = resolve_model(agent.runtime, agent.runtime_model)
    skills = effective_skill_count(agent.skills_json)
    model_label = ref.name if ref else agent.runtime_model or agent.runtime

    if ref is None:
        efficacy_score = None
    elif skills is None:
        efficacy_score = model_capability_score(ref)
    else:
        efficacy_score = 0.8 * model_capability_score(ref) + 0.2 * _saturate(skills, 5)
    efficacy = _ev(
        efficacy_score,
        {"model": model_label, "index": ref.index if ref else None, "skills": skills},
    )

    latency = _ev(_HOSTING_LATENCY.get(agent.hosting_kind or ""), agent.hosting_kind)

    filled = [bool((agent.bio or "").strip()), bool(agent.avatar_url), bool(agent.runtime)]
    age_days = (now - _aware(agent.created_at)).days if agent.created_at else 0
    reliability = _ev(
        _mean([sum(filled) / len(filled) * 100, min(age_days, WINDOW_DAYS) / WINDOW_DAYS * 100]),
        {"profile": sum(filled), "profile_total": len(filled), "age_days": age_days},
    )

    cost = _ev(
        model_cost_score(ref) if ref else None,
        {"model": model_label, "blended_price": round(ref.blended_price, 2) if ref else None},
    )

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


async def _topic_outcomes(db: AsyncSession, agent_id: str, start: datetime.datetime) -> tuple[int, int]:
    """(completed, terminal) topics the agent took part in."""
    rows = (
        await db.execute(
            select(Topic.status, func.count(distinct(Topic.topic_id)))
            .join(MessageRecord, MessageRecord.topic_id == Topic.topic_id)
            .where(
                _outbound(agent_id),
                Topic.updated_at >= start,
                Topic.status.in_(_TERMINAL_TOPIC_STATES),
            )
            .group_by(Topic.status)
        )
    ).all()
    total = sum(c for _, c in rows)
    completed = sum(c for status, c in rows if status == TopicStatus.completed)
    return completed, total


@dataclass
class _Turn:
    """An inbound message that expects a reply, and the agent's first reply to it."""

    room_id: str | None
    at: datetime.datetime
    reply_at: datetime.datetime | None = None
    reply_type: str | None = None


async def _turns(db: AsyncSession, agent_id: str, now: datetime.datetime) -> list[_Turn]:
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    # Only DMs, owner chat and @mentions expect a reply; plain group fan-out does not.
    rows = (
        await db.execute(
            select(MessageRecord.room_id, MessageRecord.created_at)
            .where(
                _inbound(agent_id),
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
    turns = [_Turn(r.room_id, _aware(r.created_at)) for r in rows]
    if not turns:
        return turns

    earliest = min(t.at for t in turns)
    rooms = [r for r in {t.room_id for t in turns} if r is not None]
    outbound = await _outbound_by_room(db, agent_id, earliest, rooms)
    for turn in turns:
        series = outbound.get(turn.room_id, [])
        i = bisect.bisect_right(series, (turn.at, "\uffff"))
        if i < len(series) and series[i][0] - turn.at <= REPLY_WINDOW:
            turn.reply_at, turn.reply_type = series[i]
    return turns


def _latency(turns: list[_Turn]) -> dict:
    if len(turns) < MIN_INBOUND_SAMPLE:
        return _ev(None, sample=len(turns))
    delays = [(t.reply_at - t.at).total_seconds() for t in turns if t.reply_at is not None]
    rate = len(delays) / len(turns)
    median = statistics.median(delays) if len(delays) >= MIN_REPLY_SAMPLE else None
    speed = _log_decay(median, 30, 30 * 60) if median is not None else None
    return _ev(
        _mean([rate * 100, speed]),
        {"reply_rate": round(rate, 3), "median_seconds": None if median is None else round(median)},
        len(turns),
    )


def _efficacy(turns: list[_Turn], topics: tuple[int, int], prior: float | None) -> dict:
    """Share of answered turns that did not end in a runtime error, plus topic
    outcomes, smoothed toward the L0 prior. Unanswered turns belong to latency."""
    answered = [t for t in turns if t.reply_type is not None]
    ok_turns = sum(1 for t in answered if t.reply_type != "error")
    topics_ok, topics_total = topics
    successes = ok_turns + topics_ok
    trials = len(answered) + topics_total
    if trials == 0 and prior is None:
        return _ev(None, sample=0)
    score, confidence = _smoothed(successes, trials, prior)
    return _ev(
        score,
        {
            "turns": len(answered),
            "turn_errors": len(answered) - ok_turns,
            "topics": topics_total,
            "topics_completed": topics_ok,
            "observed_rate": round(successes / trials, 3) if trials else None,
        },
        trials,
        confidence,
    )


async def _outbound_by_room(
    db: AsyncSession, agent_id: str, since: datetime.datetime, rooms: list[str]
) -> dict[str | None, list[tuple[datetime.datetime, str]]]:
    """Agent-authored messages per room as sorted (created_at, envelope type)."""
    # Room fan-out writes one row per receiver; collapse to one per msg_id.
    rows = (
        await db.execute(
            select(
                MessageRecord.room_id,
                func.min(MessageRecord.created_at),
                func.min(MessageRecord.envelope_json),
            )
            .where(
                _outbound(agent_id),
                MessageRecord.created_at >= since,
                or_(MessageRecord.room_id.in_(rooms), MessageRecord.room_id.is_(None)),
            )
            .group_by(MessageRecord.msg_id, MessageRecord.room_id)
        )
    ).all()
    out: dict[str | None, list[tuple[datetime.datetime, str]]] = {}
    for room, ts, envelope in rows:
        out.setdefault(room, []).append((_aware(ts), _envelope_type(envelope)))
    for series in out.values():
        series.sort()
    return out


def _envelope_type(envelope_json: str | None) -> str:
    try:
        return json.loads(envelope_json or "{}").get("type") or "message"
    except (ValueError, AttributeError):
        return "message"


async def _delivery_rate(db: AsyncSession, agent_id: str, now: datetime.datetime) -> float | None:
    rows = (
        await db.execute(
            select(MessageRecord.state, func.count())
            .where(
                _inbound(agent_id),
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
                _outbound(agent_id),
                MessageRecord.created_at >= start,
            )
        )
    ).scalar_one()


async def _reliability(db: AsyncSession, agent_id: str, now: datetime.datetime) -> dict:
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    delivery = await _delivery_rate(db, agent_id, now)
    schedules = await _schedule_success_rate(db, agent_id, start)
    days = await _active_days(db, agent_id, start)
    # Active days are shown for context but not scored: an idle agent is not an
    # unreliable one.
    return _ev(
        _mean(
            [
                None if delivery is None else delivery * 100,
                None if schedules is None else schedules * 100,
            ]
        ),
        {
            "delivery_rate": None if delivery is None else round(delivery, 3),
            "schedule_success_rate": None if schedules is None else round(schedules, 3),
            "active_days": days,
        },
    )


async def _autonomy(db: AsyncSession, agent_id: str, now: datetime.datetime) -> dict:
    """Share of outbound messages not prompted by an inbound message in the prior window."""
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    out_rows = (
        await db.execute(
            select(MessageRecord.room_id, func.min(MessageRecord.created_at).label("ts"))
            .where(_outbound(agent_id), MessageRecord.created_at >= start)
            .group_by(MessageRecord.msg_id, MessageRecord.room_id)
            .order_by(func.min(MessageRecord.created_at).desc())
            .limit(MAX_MESSAGE_SAMPLE)
        )
    ).all()
    outbound = [(r.room_id, _aware(r.ts)) for r in out_rows]
    if len(outbound) < MIN_AUTONOMY_SAMPLE:
        return _ev(None, sample=len(outbound))

    since = min(ts for _, ts in outbound) - REPLY_WINDOW
    rooms = [r for r in {room for room, _ in outbound} if r is not None]
    in_rows = (
        await db.execute(
            select(MessageRecord.room_id, MessageRecord.created_at).where(
                _inbound(agent_id),
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
    # 50%+ self-initiated traffic already means the agent runs on its own.
    return _ev(share / 0.5 * 100, round(share, 3), len(outbound))


async def _assurance(db: AsyncSession, agent_id: str, start: datetime.datetime) -> dict:
    sent = (
        await db.execute(
            select(func.count(distinct(MessageRecord.msg_id))).where(
                _outbound(agent_id),
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
                _outbound(agent_id),
                MessageRecord.created_at >= start,
                MessageRecord.recalled_at.isnot(None),
                MessageRecord.recalled_by_id != agent_id,
            )
        )
    ).scalar_one()
    incidents = blocks + recalled
    return _ev(100 - 20 * incidents, {"blocks": blocks, "recalled": recalled}, sent)


async def _l1(db: AsyncSession, agent: Agent, l0: dict[str, dict], now: datetime.datetime) -> dict[str, dict]:
    start = now - datetime.timedelta(days=WINDOW_DAYS)
    aid = agent.agent_id
    turns = await _turns(db, aid, now)
    topics = await _topic_outcomes(db, aid, start)
    # No per-run usage is reported by daemons yet, so observed cost is the model
    # list price itself — the same fact as L0, labelled as such.
    cost = {**l0["cost"], "value": {**(l0["cost"]["value"] or {}), "basis": "model_price"}}
    return {
        "efficacy": _efficacy(turns, topics, l0["efficacy"]["score"]),
        "latency": _latency(turns),
        "reliability": await _reliability(db, aid, now),
        "cost": cost,
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
    l0 = await _l0(db, agent, now)
    layers = {"l0": l0, "l1": await _l1(db, agent, l0, now)}
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
