"""Subscription product and recurring billing business logic."""

from __future__ import annotations

import calendar
import datetime
import logging

from sqlalchemy import func as sa_func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from hub.enums import (
    BillingInterval,
    SubscriptionChargeAttemptStatus,
    SubscriptionProductStatus,
    SubscriptionStatus,
)
from hub.id_generators import (
    generate_subscription_charge_attempt_id,
    generate_subscription_id,
    generate_subscription_product_id,
)
from hub.models import (
    AgentSubscription,
    Room,
    RoomMember,
    RoomRole,
    SubscriptionChargeAttempt,
    SubscriptionProduct,
)
from hub.services.wallet import create_transfer

logger = logging.getLogger(__name__)

MAX_FAILED_BILLING_ATTEMPTS = 3
RETRY_DELAY = datetime.timedelta(hours=24)
_NEVER = datetime.datetime(9999, 12, 31, tzinfo=datetime.timezone.utc)


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _ensure_tz(dt: datetime.datetime) -> datetime.datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc)


def _advance_period(anchor: datetime.datetime, interval: BillingInterval) -> datetime.datetime:
    anchor = _ensure_tz(anchor)
    if interval == BillingInterval.once:
        return _NEVER
    if interval == BillingInterval.week:
        return anchor + datetime.timedelta(days=7)

    year = anchor.year + (1 if anchor.month == 12 else 0)
    month = 1 if anchor.month == 12 else anchor.month + 1
    day = min(anchor.day, calendar.monthrange(year, month)[1])
    return anchor.replace(year=year, month=month, day=day)


def _billing_cycle_key(subscription: AgentSubscription) -> str:
    return _ensure_tz(subscription.current_period_end).isoformat()


def _product_query(owner_agent_id: str | None = None, include_archived: bool = False):
    stmt = select(SubscriptionProduct)
    if owner_agent_id is not None:
        stmt = stmt.where(SubscriptionProduct.owner_agent_id == owner_agent_id)
    if not include_archived:
        stmt = stmt.where(SubscriptionProduct.status == SubscriptionProductStatus.active)
    return stmt.order_by(SubscriptionProduct.created_at.desc())


def _subscription_query(agent_id: str | None = None, product_id: str | None = None):
    stmt = select(AgentSubscription)
    if agent_id is not None:
        stmt = stmt.where(AgentSubscription.subscriber_agent_id == agent_id)
    if product_id is not None:
        stmt = stmt.where(AgentSubscription.product_id == product_id)
    return stmt.order_by(AgentSubscription.created_at.desc())


async def create_subscription_product(
    session: AsyncSession,
    owner_agent_id: str,
    *,
    name: str,
    description: str = "",
    amount_minor: int,
    billing_interval: BillingInterval,
    asset_code: str = "COIN",
) -> SubscriptionProduct:
    if amount_minor <= 0:
        raise ValueError("Amount must be positive")
    if billing_interval not in {BillingInterval.week, BillingInterval.month, BillingInterval.once}:
        raise ValueError("billing_interval must be week, month, or once")

    product = SubscriptionProduct(
        product_id=generate_subscription_product_id(),
        owner_agent_id=owner_agent_id,
        name=name,
        description=description or "",
        asset_code=asset_code,
        amount_minor=amount_minor,
        billing_interval=billing_interval,
        status=SubscriptionProductStatus.active,
    )
    session.add(product)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise ValueError("Subscription product already exists")
    return product


async def list_subscription_products(
    session: AsyncSession,
    *,
    owner_agent_id: str | None = None,
    include_archived: bool = False,
) -> list[SubscriptionProduct]:
    result = await session.execute(_product_query(owner_agent_id, include_archived))
    return list(result.scalars().all())


async def archive_subscription_product(
    session: AsyncSession,
    product_id: str,
    current_agent: str,
) -> SubscriptionProduct:
    result = await session.execute(
        select(SubscriptionProduct).where(SubscriptionProduct.product_id == product_id)
    )
    product = result.scalar_one_or_none()
    if product is None:
        raise ValueError("Subscription product not found")
    if product.owner_agent_id != current_agent:
        raise ValueError("Not authorized to archive this product")
    if product.status == SubscriptionProductStatus.archived:
        return product

    product.status = SubscriptionProductStatus.archived
    product.archived_at = _utcnow()
    await session.flush()
    return product


async def get_subscription_product(
    session: AsyncSession, product_id: str
) -> SubscriptionProduct | None:
    result = await session.execute(
        select(SubscriptionProduct).where(SubscriptionProduct.product_id == product_id)
    )
    return result.scalar_one_or_none()


async def get_subscription(
    session: AsyncSession, subscription_id: str
) -> AgentSubscription | None:
    result = await session.execute(
        select(AgentSubscription).where(AgentSubscription.subscription_id == subscription_id)
    )
    return result.scalar_one_or_none()


async def list_my_subscriptions(
    session: AsyncSession, agent_id: str
) -> list[AgentSubscription]:
    result = await session.execute(_subscription_query(agent_id))
    return list(result.scalars().all())


async def list_product_subscribers(
    session: AsyncSession, product_id: str
) -> list[AgentSubscription]:
    result = await session.execute(_subscription_query(product_id=product_id))
    return list(result.scalars().all())


async def count_active_subscribers(
    session: AsyncSession, product_id: str
) -> int:
    stmt = (
        select(sa_func.count())
        .select_from(AgentSubscription)
        .where(
            AgentSubscription.product_id == product_id,
            AgentSubscription.status == SubscriptionStatus.active,
        )
    )
    result = await session.execute(stmt)
    return result.scalar_one()


async def create_subscription(
    session: AsyncSession,
    *,
    product_id: str,
    subscriber_agent_id: str,
    idempotency_key: str | None = None,
) -> AgentSubscription:
    result = await session.execute(
        select(SubscriptionProduct).where(SubscriptionProduct.product_id == product_id)
    )
    product = result.scalar_one_or_none()
    if product is None:
        raise ValueError("Subscription product not found")
    if product.status != SubscriptionProductStatus.active:
        raise ValueError("Subscription product is archived")
    if product.owner_agent_id == subscriber_agent_id:
        raise ValueError("Cannot subscribe to your own product")

    existing = await session.execute(
        select(AgentSubscription).where(
            AgentSubscription.product_id == product_id,
            AgentSubscription.subscriber_agent_id == subscriber_agent_id,
        )
    )
    current = existing.scalar_one_or_none()
    if current is not None:
        if current.status == SubscriptionStatus.cancelled:
            # Reactivate cancelled subscription: charge and reset billing period
            return await _reactivate_subscription(
                session, current, product, idempotency_key,
            )
        return current

    now = _utcnow()
    current_period_end = _advance_period(now, product.billing_interval)
    subscription_id = generate_subscription_id()

    metadata = {
        "kind": "subscription_charge",
        "product_id": product.product_id,
        "subscription_id": subscription_id,
        "billing_cycle_key": now.isoformat(),
    }
    tx = await create_transfer(
        session,
        from_agent_id=subscriber_agent_id,
        to_agent_id=product.owner_agent_id,
        amount_minor=product.amount_minor,
        idempotency_key=idempotency_key or f"subscription:first:{subscription_id}",
        reference_type="subscription_charge",
        reference_id=subscription_id,
        metadata=metadata,
        asset_code=product.asset_code,
    )

    subscription = AgentSubscription(
        subscription_id=subscription_id,
        product_id=product.product_id,
        subscriber_agent_id=subscriber_agent_id,
        provider_agent_id=product.owner_agent_id,
        asset_code=product.asset_code,
        amount_minor=product.amount_minor,
        billing_interval=product.billing_interval,
        status=SubscriptionStatus.active,
        current_period_start=now,
        current_period_end=current_period_end,
        next_charge_at=current_period_end,
        cancel_at_period_end=False,
        last_charged_at=now,
        last_charge_tx_id=tx.tx_id,
        consecutive_failed_attempts=0,
    )
    session.add(subscription)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        existing = await session.execute(
            select(AgentSubscription).where(
                AgentSubscription.product_id == product_id,
                AgentSubscription.subscriber_agent_id == subscriber_agent_id,
            )
        )
        current = existing.scalar_one_or_none()
        if current is not None:
            return current
        raise ValueError("Subscription already exists")

    await _auto_join_subscription_rooms(session, subscription)
    return subscription


async def _reactivate_subscription(
    session: AsyncSession,
    subscription: AgentSubscription,
    product: SubscriptionProduct,
    idempotency_key: str | None,
) -> AgentSubscription:
    """Reactivate a cancelled subscription by charging and resetting the billing period."""
    now = _utcnow()
    current_period_end = _advance_period(now, product.billing_interval)

    metadata = {
        "kind": "subscription_charge",
        "product_id": product.product_id,
        "subscription_id": subscription.subscription_id,
        "billing_cycle_key": now.isoformat(),
    }
    tx = await create_transfer(
        session,
        from_agent_id=subscription.subscriber_agent_id,
        to_agent_id=product.owner_agent_id,
        amount_minor=product.amount_minor,
        idempotency_key=idempotency_key or f"subscription:reactivate:{subscription.subscription_id}:{now.isoformat()}",
        reference_type="subscription_charge",
        reference_id=subscription.subscription_id,
        metadata=metadata,
        asset_code=product.asset_code,
    )

    subscription.status = SubscriptionStatus.active
    subscription.current_period_start = now
    subscription.current_period_end = current_period_end
    subscription.next_charge_at = current_period_end
    subscription.cancel_at_period_end = False
    subscription.cancelled_at = None
    subscription.last_charged_at = now
    subscription.last_charge_tx_id = tx.tx_id
    subscription.consecutive_failed_attempts = 0
    await session.flush()

    await _auto_join_subscription_rooms(session, subscription)
    return subscription


async def _auto_join_subscription_rooms(
    session: AsyncSession,
    subscription: AgentSubscription,
) -> None:
    result = await session.execute(
        select(Room).where(
            Room.required_subscription_product_id == subscription.product_id
        )
    )
    rooms = list(result.scalars().all())

    for room in rooms:
        existing_result = await session.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.room_id,
                RoomMember.agent_id == subscription.subscriber_agent_id,
            )
        )
        if existing_result.scalar_one_or_none() is not None:
            continue

        member_count_result = await session.execute(
            select(sa_func.count(RoomMember.id)).where(RoomMember.room_id == room.room_id)
        )
        current_count = member_count_result.scalar() or 0
        if room.max_members is not None and current_count >= room.max_members:
            raise ValueError(
                f"Subscription room {room.room_id} is full; cannot complete subscription"
            )

        try:
            async with session.begin_nested():
                session.add(
                    RoomMember(
                        room_id=room.room_id,
                        agent_id=subscription.subscriber_agent_id,
                        role=RoomRole.member,
                    )
                )
                await session.flush()
        except IntegrityError:
            raise ValueError(
                f"Failed to auto-join subscription room {room.room_id}"
            )


async def _revoke_subscription_room_access(
    session: AsyncSession,
    subscription: AgentSubscription,
) -> None:
    result = await session.execute(
        select(RoomMember)
        .join(Room, Room.room_id == RoomMember.room_id)
        .where(
            Room.required_subscription_product_id == subscription.product_id,
            RoomMember.agent_id == subscription.subscriber_agent_id,
        )
    )
    for membership in result.scalars().all():
        await session.delete(membership)
    await session.flush()


async def cancel_subscription(
    session: AsyncSession,
    subscription_id: str,
    current_agent: str,
) -> AgentSubscription:
    result = await session.execute(
        select(AgentSubscription).where(AgentSubscription.subscription_id == subscription_id)
    )
    subscription = result.scalar_one_or_none()
    if subscription is None:
        raise ValueError("Subscription not found")
    if current_agent not in {subscription.subscriber_agent_id, subscription.provider_agent_id}:
        raise ValueError("Not authorized to cancel this subscription")
    if subscription.status == SubscriptionStatus.cancelled:
        return subscription

    now = _utcnow()
    subscription.status = SubscriptionStatus.cancelled
    subscription.cancelled_at = now
    subscription.cancel_at_period_end = False
    await _revoke_subscription_room_access(session, subscription)
    await session.flush()
    return subscription


async def _ensure_charge_attempt(
    session: AsyncSession,
    subscription: AgentSubscription,
    billing_cycle_key: str,
    now: datetime.datetime,
) -> SubscriptionChargeAttempt:
    result = await session.execute(
        select(SubscriptionChargeAttempt).where(
            SubscriptionChargeAttempt.subscription_id == subscription.subscription_id,
            SubscriptionChargeAttempt.billing_cycle_key == billing_cycle_key,
        )
    )
    attempt = result.scalar_one_or_none()
    if attempt is None:
        attempt = SubscriptionChargeAttempt(
            attempt_id=generate_subscription_charge_attempt_id(),
            subscription_id=subscription.subscription_id,
            billing_cycle_key=billing_cycle_key,
            status=SubscriptionChargeAttemptStatus.pending,
            scheduled_at=subscription.next_charge_at,
            attempted_at=now,
            attempt_count=1,
        )
        session.add(attempt)
        await session.flush()
        return attempt

    attempt.attempt_count += 1
    attempt.status = SubscriptionChargeAttemptStatus.pending
    attempt.scheduled_at = subscription.next_charge_at
    attempt.attempted_at = now
    attempt.failure_reason = None
    attempt.tx_id = None
    await session.flush()
    return attempt


async def _charge_subscription(
    session: AsyncSession,
    subscription: AgentSubscription,
    now: datetime.datetime,
) -> str:
    if subscription.status == SubscriptionStatus.cancelled:
        return "skipped"

    due_at = _ensure_tz(subscription.next_charge_at)
    if due_at > now:
        return "skipped"

    billing_cycle_key = _billing_cycle_key(subscription)
    attempt_result = await session.execute(
        select(SubscriptionChargeAttempt).where(
            SubscriptionChargeAttempt.subscription_id == subscription.subscription_id,
            SubscriptionChargeAttempt.billing_cycle_key == billing_cycle_key,
        )
    )
    existing_attempt = attempt_result.scalar_one_or_none()
    if existing_attempt is not None and existing_attempt.status == SubscriptionChargeAttemptStatus.succeeded:
        return "skipped"
    if existing_attempt is not None and existing_attempt.status == SubscriptionChargeAttemptStatus.pending:
        return "skipped"

    attempt = await _ensure_charge_attempt(session, subscription, billing_cycle_key, now)

    metadata = {
        "kind": "subscription_charge",
        "product_id": subscription.product_id,
        "subscription_id": subscription.subscription_id,
        "billing_cycle_key": billing_cycle_key,
    }

    try:
        tx = await create_transfer(
            session,
            from_agent_id=subscription.subscriber_agent_id,
            to_agent_id=subscription.provider_agent_id,
            amount_minor=subscription.amount_minor,
            idempotency_key=f"subscription:charge:{subscription.subscription_id}:{billing_cycle_key}",
            reference_type="subscription_charge",
            reference_id=subscription.subscription_id,
            metadata=metadata,
            asset_code=subscription.asset_code,
        )
    except ValueError as err:
        attempt.status = SubscriptionChargeAttemptStatus.failed
        attempt.failure_reason = str(err)
        subscription.consecutive_failed_attempts += 1
        subscription.status = SubscriptionStatus.past_due
        subscription.next_charge_at = now + RETRY_DELAY
        if subscription.consecutive_failed_attempts >= MAX_FAILED_BILLING_ATTEMPTS:
            subscription.status = SubscriptionStatus.cancelled
            subscription.cancelled_at = now
            await _revoke_subscription_room_access(session, subscription)
        await session.flush()
        return "failed"

    attempt.status = SubscriptionChargeAttemptStatus.succeeded
    attempt.tx_id = tx.tx_id
    attempt.failure_reason = None
    subscription.current_period_start = _ensure_tz(subscription.current_period_end)
    subscription.current_period_end = _advance_period(
        subscription.current_period_end, subscription.billing_interval
    )
    subscription.next_charge_at = subscription.current_period_end
    subscription.status = SubscriptionStatus.active
    subscription.last_charged_at = now
    subscription.last_charge_tx_id = tx.tx_id
    subscription.consecutive_failed_attempts = 0
    await session.flush()
    return "charged"


async def process_due_subscription_billings(
    session: AsyncSession,
    *,
    limit: int = 100,
) -> dict[str, int]:
    now = _utcnow()
    stmt = (
        select(AgentSubscription.subscription_id)
        .where(
            AgentSubscription.status.in_(
                [SubscriptionStatus.active, SubscriptionStatus.past_due]
            ),
            AgentSubscription.next_charge_at <= now,
        )
        .order_by(AgentSubscription.next_charge_at.asc(), AgentSubscription.id.asc())
        .limit(limit)
    )
    result = await session.execute(stmt)
    subscription_ids = [row[0] for row in result.all()]

    processed_count = 0
    charged_count = 0
    failed_count = 0
    skipped_count = 0

    for subscription_id in subscription_ids:
        try:
            async with session.begin_nested():
                sub_result = await session.execute(
                    select(AgentSubscription).where(
                        AgentSubscription.subscription_id == subscription_id
                    )
                )
                subscription = sub_result.scalar_one_or_none()
                if subscription is None:
                    skipped_count += 1
                    continue

                outcome = await _charge_subscription(session, subscription, now)
                processed_count += 1
                if outcome == "charged":
                    charged_count += 1
                elif outcome == "failed":
                    failed_count += 1
                else:
                    skipped_count += 1
        except Exception as exc:
            import sentry_sdk
            sentry_sdk.capture_exception(exc)
            logger.exception(
                "Failed to process subscription billing for %s", subscription_id
            )
            failed_count += 1

    return {
        "processed_count": processed_count,
        "charged_count": charged_count,
        "failed_count": failed_count,
        "skipped_count": skipped_count,
    }
