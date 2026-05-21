"""Cloud Agent usage ledger + quota gate (PR 7).

The :class:`UsageService` is the only place that mutates
``usage_balances``, ``usage_reservations``, and ``usage_events``. It
exposes three primitives — :meth:`preflight`, :meth:`reserve`,
:meth:`settle` / :meth:`release` — used by :class:`CloudAgentService`
on each run.

Invariants this service preserves:

- ``usage_balances.reserved_credits`` ≡ ``sum(active.reserved_credits)``
- ``usage_balances.used_credits`` ≡ ``sum(usage_events.credits_charged)``
- ``usage_balances.used_sandbox_seconds`` ≡
  ``sum(usage_events.sandbox_seconds)``
- ``preflight`` blocks any operation that would push
  ``used + reserved + estimated`` past ``included`` (no oversell).
"""

from __future__ import annotations

import datetime
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.config import (
    CLOUD_AGENT_FREE_CREDITS_PER_PERIOD,
    CLOUD_AGENT_FREE_SANDBOX_SECONDS_PER_PERIOD,
    CLOUD_AGENT_RUN_CREDIT_RESERVATION_FLOOR,
    CREDIT_MILLIS_PER_INPUT_CACHE_HIT_KILOTOKEN,
    CREDIT_MILLIS_PER_INPUT_CACHE_MISS_KILOTOKEN,
    CREDIT_MILLIS_PER_OUTPUT_KILOTOKEN,
    CREDIT_MILLIS_PER_SANDBOX_SECOND,
)
from hub.models import UsageBalance, UsageEvent, UsageReservation

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


class UsageError(Exception):
    """Raised when a usage operation must be rejected.

    Service-level errors are typed so :class:`CloudAgentService` can map
    them to the right ``CloudAgentError`` (and the API to the right HTTP
    status) without sniffing strings.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class TokenUsage:
    """Token counts reported by the runtime."""

    input_cache_hit_tokens: int = 0
    input_cache_miss_tokens: int = 0
    output_tokens: int = 0


@dataclass
class SettlementResult:
    """Outcome of :meth:`UsageService.settle`."""

    usage_event_id: int
    credits_charged: int
    sandbox_seconds: int
    idempotency_key: str
    deduplicated: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _utc_month_window(now: datetime.datetime) -> tuple[datetime.datetime, datetime.datetime]:
    """Return ``[first-of-month, first-of-next-month)`` in UTC for ``now``."""
    start = datetime.datetime(now.year, now.month, 1, tzinfo=datetime.timezone.utc)
    year = start.year + (1 if start.month == 12 else 0)
    month = 1 if start.month == 12 else start.month + 1
    end = datetime.datetime(year, month, 1, tzinfo=datetime.timezone.utc)
    return start, end


def _credits_for_tokens(usage: TokenUsage) -> int:
    """Translate token counts → integer Cloud Credits.

    Coefficients are stored as ``credit_millis`` (1/1000 credit). Doing
    the math in integer millis avoids float drift; the final result is
    rounded up so we never under-charge.
    """
    millis = 0
    millis += (
        max(usage.input_cache_hit_tokens, 0)
        * CREDIT_MILLIS_PER_INPUT_CACHE_HIT_KILOTOKEN
        // 1000
    )
    millis += (
        max(usage.input_cache_miss_tokens, 0)
        * CREDIT_MILLIS_PER_INPUT_CACHE_MISS_KILOTOKEN
        // 1000
    )
    millis += (
        max(usage.output_tokens, 0) * CREDIT_MILLIS_PER_OUTPUT_KILOTOKEN // 1000
    )
    # Round up to the next credit so a fractional spend always charges.
    return (millis + 999) // 1000


def _credits_for_sandbox_seconds(sandbox_seconds: int) -> int:
    millis = max(sandbox_seconds, 0) * CREDIT_MILLIS_PER_SANDBOX_SECOND
    return (millis + 999) // 1000


def credits_for_settlement(
    *,
    tokens: TokenUsage,
    sandbox_seconds: int,
) -> int:
    """Public helper — total credits for a single settlement."""
    return _credits_for_tokens(tokens) + _credits_for_sandbox_seconds(sandbox_seconds)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class UsageService:
    """Usage ledger orchestrator. Holds no per-instance state."""

    def __init__(
        self,
        *,
        free_credits_per_period: int | None = None,
        free_sandbox_seconds_per_period: int | None = None,
        reservation_floor: int | None = None,
    ) -> None:
        self._free_credits = (
            CLOUD_AGENT_FREE_CREDITS_PER_PERIOD
            if free_credits_per_period is None
            else free_credits_per_period
        )
        self._free_sandbox_seconds = (
            CLOUD_AGENT_FREE_SANDBOX_SECONDS_PER_PERIOD
            if free_sandbox_seconds_per_period is None
            else free_sandbox_seconds_per_period
        )
        self._reservation_floor = (
            CLOUD_AGENT_RUN_CREDIT_RESERVATION_FLOOR
            if reservation_floor is None
            else reservation_floor
        )

    # ------------------------------------------------------------------
    # Balance lookup
    # ------------------------------------------------------------------

    async def get_or_create_balance(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        now: datetime.datetime | None = None,
        lock: bool = False,
    ) -> UsageBalance:
        """Return the active balance row for ``user_id``, creating on first use."""
        now = now or _now()
        period_start, period_end = _utc_month_window(now)
        stmt = select(UsageBalance).where(
            UsageBalance.user_id == user_id,
            UsageBalance.period_start == period_start,
        )
        if lock and db.bind is not None and db.bind.dialect.name == "postgresql":
            stmt = stmt.with_for_update()
        row = await db.scalar(stmt)
        if row is not None:
            return row

        row = UsageBalance(
            user_id=user_id,
            period_start=period_start,
            period_end=period_end,
            included_credits=self._free_credits,
            included_sandbox_seconds=self._free_sandbox_seconds,
        )
        db.add(row)
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            # Concurrent creator won — re-read.
            reread = select(UsageBalance).where(
                UsageBalance.user_id == user_id,
                UsageBalance.period_start == period_start,
            )
            if lock and db.bind is not None and db.bind.dialect.name == "postgresql":
                reread = reread.with_for_update()
            row = await db.scalar(reread)
            if row is None:
                # Shouldn't happen, but a clear error is better than NPE.
                raise UsageError(
                    "balance_init_failed",
                    f"could not initialise balance for {user_id!r}",
                )
        return row

    # ------------------------------------------------------------------
    # Estimation
    # ------------------------------------------------------------------

    def estimate_run_credits(
        self,
        *,
        max_wall_time_seconds: int,
        max_tool_calls: int,
    ) -> int:
        """Estimate credits to reserve for a single run.

        Two terms:
        - Sandbox cap at ``credits_per_sandbox_second * max_wall_time_seconds``.
        - A small per-tool-call buffer so a tool-heavy short run still
          reserves something for the model tokens it'll burn.

        Floor applied to keep trivially-small runs from slipping past
        the quota gate at zero cost.
        """
        sandbox_term = _credits_for_sandbox_seconds(max_wall_time_seconds)
        # ~0.5 credit per tool call (5 credit_millis * 100).
        tool_term = (max(max_tool_calls, 0) * 500 + 999) // 1000
        est = sandbox_term + tool_term
        return max(est, self._reservation_floor)

    def estimate_run_sandbox_seconds(self, *, max_wall_time_seconds: int) -> int:
        """Reserve the full wall-time bound as sandbox seconds."""
        return max(max_wall_time_seconds, 0)

    # ------------------------------------------------------------------
    # Preflight / reserve / settle / release
    # ------------------------------------------------------------------

    async def preflight(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        estimated_credits: int,
        estimated_sandbox_seconds: int,
    ) -> UsageBalance:
        """Raise :class:`UsageError` if the user can't fit ``estimated_*``."""
        balance = await self.get_or_create_balance(db, user_id=user_id, lock=True)
        self._assert_fits(
            balance,
            estimated_credits=estimated_credits,
            estimated_sandbox_seconds=estimated_sandbox_seconds,
        )
        return balance

    def _assert_fits(
        self,
        balance: UsageBalance,
        *,
        estimated_credits: int,
        estimated_sandbox_seconds: int,
    ) -> None:
        available_credits = (
            balance.included_credits - balance.used_credits - balance.reserved_credits
        )
        available_seconds = (
            balance.included_sandbox_seconds
            - balance.used_sandbox_seconds
            - balance.reserved_sandbox_seconds
        )
        if estimated_credits > available_credits:
            raise UsageError(
                "quota_credits_exceeded",
                f"not enough Cloud Credits: need {estimated_credits}, "
                f"available {available_credits}",
            )
        if estimated_sandbox_seconds > available_seconds:
            raise UsageError(
                "quota_sandbox_seconds_exceeded",
                f"not enough sandbox seconds: need {estimated_sandbox_seconds}, "
                f"available {available_seconds}",
            )

    async def reserve(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: str,
        run_id: str,
        credits: int,
        sandbox_seconds: int,
        metadata: dict[str, Any] | None = None,
    ) -> UsageReservation:
        """Insert (or return) a reservation, bumping the balance aggregate.

        Idempotent on ``run_id``: a second call with the same ``run_id``
        returns the existing reservation without re-bumping the
        aggregate.
        """
        existing = await db.scalar(
            select(UsageReservation).where(UsageReservation.run_id == run_id)
        )
        if existing is not None:
            return existing

        balance = await self.get_or_create_balance(db, user_id=user_id, lock=True)
        self._assert_fits(
            balance,
            estimated_credits=max(credits, 0),
            estimated_sandbox_seconds=max(sandbox_seconds, 0),
        )
        reservation = UsageReservation(
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            reserved_credits=max(credits, 0),
            reserved_sandbox_seconds=max(sandbox_seconds, 0),
            state="active",
            metadata_json=metadata or {},
        )
        db.add(reservation)
        balance.reserved_credits = (balance.reserved_credits or 0) + max(credits, 0)
        balance.reserved_sandbox_seconds = (
            balance.reserved_sandbox_seconds or 0
        ) + max(sandbox_seconds, 0)
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            existing = await db.scalar(
                select(UsageReservation).where(UsageReservation.run_id == run_id)
            )
            if existing is not None:
                return existing
            raise
        return reservation

    async def settle(
        self,
        db: AsyncSession,
        *,
        run_id: str,
        provider: str,
        model: str,
        tokens: TokenUsage | None = None,
        sandbox_seconds: int = 0,
        idempotency_key: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SettlementResult:
        """Settle a run's reservation, writing a ``usage_events`` row.

        Idempotent on ``idempotency_key`` (default ``f"{run_id}:settle"``):
        a second call returns the existing event.
        """
        key = idempotency_key or f"{run_id}:settle"
        existing_event = await db.scalar(
            select(UsageEvent).where(UsageEvent.idempotency_key == key)
        )
        if existing_event is not None:
            return SettlementResult(
                usage_event_id=existing_event.id,
                credits_charged=existing_event.credits_charged,
                sandbox_seconds=existing_event.sandbox_seconds,
                idempotency_key=key,
                deduplicated=True,
            )

        reservation_stmt = select(UsageReservation).where(UsageReservation.run_id == run_id)
        if db.bind is not None and db.bind.dialect.name == "postgresql":
            reservation_stmt = reservation_stmt.with_for_update()
        reservation = await db.scalar(reservation_stmt)
        if reservation is None:
            raise UsageError(
                "reservation_not_found",
                f"no reservation found for run {run_id!r}",
            )
        if reservation.state != "active":
            raise UsageError(
                "reservation_not_active",
                f"reservation for run {run_id!r} is in state "
                f"{reservation.state!r}",
            )

        tokens = tokens or TokenUsage()
        credits_charged = credits_for_settlement(
            tokens=tokens, sandbox_seconds=sandbox_seconds
        )

        balance = await self.get_or_create_balance(
            db, user_id=reservation.user_id, lock=True
        )

        # Move reservation -> used; the reservation amount and the
        # actual cost can diverge, so adjust the balance by the difference.
        balance.reserved_credits = max(
            (balance.reserved_credits or 0) - reservation.reserved_credits, 0
        )
        balance.reserved_sandbox_seconds = max(
            (balance.reserved_sandbox_seconds or 0)
            - reservation.reserved_sandbox_seconds,
            0,
        )
        balance.used_credits = (balance.used_credits or 0) + credits_charged
        balance.used_sandbox_seconds = (
            balance.used_sandbox_seconds or 0
        ) + max(sandbox_seconds, 0)

        event = UsageEvent(
            user_id=reservation.user_id,
            agent_id=reservation.agent_id,
            run_id=run_id,
            provider=provider,
            model=model,
            input_cache_hit_tokens=max(tokens.input_cache_hit_tokens, 0),
            input_cache_miss_tokens=max(tokens.input_cache_miss_tokens, 0),
            output_tokens=max(tokens.output_tokens, 0),
            sandbox_seconds=max(sandbox_seconds, 0),
            credits_charged=credits_charged,
            idempotency_key=key,
            metadata_json=metadata or {},
        )
        db.add(event)
        reservation.state = "settled"
        reservation.settled_at = _now()

        try:
            await db.flush()
        except IntegrityError:
            # Race with a concurrent settle of the same idempotency_key.
            await db.rollback()
            existing_event = await db.scalar(
                select(UsageEvent).where(UsageEvent.idempotency_key == key)
            )
            if existing_event is None:
                raise UsageError(
                    "settlement_race",
                    f"settlement race for run {run_id!r}",
                )
            return SettlementResult(
                usage_event_id=existing_event.id,
                credits_charged=existing_event.credits_charged,
                sandbox_seconds=existing_event.sandbox_seconds,
                idempotency_key=key,
                deduplicated=True,
            )

        return SettlementResult(
            usage_event_id=event.id,
            credits_charged=credits_charged,
            sandbox_seconds=sandbox_seconds,
            idempotency_key=key,
            deduplicated=False,
        )

    async def release(
        self,
        db: AsyncSession,
        *,
        run_id: str,
    ) -> UsageReservation | None:
        """Refund an active reservation. Idempotent: noop on settled/released."""
        stmt = select(UsageReservation).where(UsageReservation.run_id == run_id)
        if db.bind is not None and db.bind.dialect.name == "postgresql":
            stmt = stmt.with_for_update()
        reservation = await db.scalar(stmt)
        if reservation is None:
            return None
        if reservation.state != "active":
            return reservation

        balance = await self.get_or_create_balance(
            db, user_id=reservation.user_id, lock=True
        )
        balance.reserved_credits = max(
            (balance.reserved_credits or 0) - reservation.reserved_credits, 0
        )
        balance.reserved_sandbox_seconds = max(
            (balance.reserved_sandbox_seconds or 0)
            - reservation.reserved_sandbox_seconds,
            0,
        )
        reservation.state = "released"
        reservation.released_at = _now()
        await db.flush()
        return reservation

    async def release_for_agent(
        self,
        db: AsyncSession,
        *,
        agent_id: str,
    ) -> int:
        """Release every active reservation belonging to ``agent_id``.

        Used by :meth:`CloudAgentService.delete_cloud_agent` to avoid
        leaving orphan reservations on a deleted Cloud Agent. Returns the
        number of reservations released.
        """
        active = (
            await db.execute(
                select(UsageReservation).where(
                    UsageReservation.agent_id == agent_id,
                    UsageReservation.state == "active",
                )
            )
        ).scalars().all()
        for reservation in active:
            await self.release(db, run_id=reservation.run_id)
        return len(active)
