"""Leaderboard API endpoints — no authentication required.

Public rankings for subscription rooms: subscriber count and revenue.
"""
from __future__ import annotations

from fastapi import APIRouter, Query, Depends
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from hub.database import get_db
from hub.enums import (
    SubscriptionProductStatus,
    SubscriptionStatus,
    TxStatus,
)
from hub.models import (
    Agent,
    AgentSubscription,
    Room,
    RoomVisibility,
    SubscriptionProduct,
    WalletTransaction,
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class LeaderboardRoomEntry(BaseModel):
    room_id: str
    room_name: str
    room_description: str
    owner_id: str
    owner_display_name: str | None = None
    product_id: str
    product_name: str
    amount_minor: str
    billing_interval: str
    subscriber_count: int


class SubscriberCountLeaderboardResponse(BaseModel):
    entries: list[LeaderboardRoomEntry]
    total: int


class RevenueLeaderboardEntry(BaseModel):
    room_id: str
    room_name: str
    room_description: str
    owner_id: str
    owner_display_name: str | None = None
    product_id: str
    product_name: str
    current_amount_minor: str
    billing_interval: str
    total_revenue_minor: str
    subscriber_count: int


class RevenueLeaderboardResponse(BaseModel):
    entries: list[RevenueLeaderboardEntry]
    total: int


router = APIRouter(prefix="/public/leaderboard", tags=["leaderboard"])


# ---------------------------------------------------------------------------
# 1. GET /public/leaderboard/subscribers — subscriber count ranking
# ---------------------------------------------------------------------------


@router.get("/subscribers", response_model=SubscriberCountLeaderboardResponse)
async def subscriber_count_leaderboard(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """Rank subscription-gated rooms by active subscriber count."""

    # Count active subscribers per product
    sub_count = (
        select(
            AgentSubscription.product_id,
            func.count(AgentSubscription.id).label("subscriber_count"),
        )
        .where(AgentSubscription.status == SubscriptionStatus.active)
        .group_by(AgentSubscription.product_id)
        .subquery()
    )

    # Join: Room → SubscriptionProduct → subscriber count → Agent (owner)
    stmt = (
        select(
            Room,
            SubscriptionProduct,
            func.coalesce(sub_count.c.subscriber_count, 0).label("subscriber_count"),
            Agent.display_name.label("owner_display_name"),
        )
        .join(
            SubscriptionProduct,
            Room.required_subscription_product_id == SubscriptionProduct.product_id,
        )
        .outerjoin(sub_count, SubscriptionProduct.product_id == sub_count.c.product_id)
        .join(Agent, Room.owner_id == Agent.agent_id)
        .where(
            Room.visibility == RoomVisibility.public,
            Room.required_subscription_product_id.is_not(None),
            SubscriptionProduct.status == SubscriptionProductStatus.active,
        )
        .order_by(
            func.coalesce(sub_count.c.subscriber_count, 0).desc(),
            Room.room_id,
        )
    )

    # Total count (strip ordering for efficiency)
    count_stmt = select(func.count()).select_from(stmt.order_by(None).subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    # Paginate
    result = await db.execute(stmt.limit(limit).offset(offset))
    rows = result.all()

    entries = [
        LeaderboardRoomEntry(
            room_id=room.room_id,
            room_name=room.name,
            room_description=room.description,
            owner_id=room.owner_id,
            owner_display_name=owner_name,
            product_id=product.product_id,
            product_name=product.name,
            amount_minor=str(product.amount_minor),
            billing_interval=(
                product.billing_interval.value
                if hasattr(product.billing_interval, "value")
                else str(product.billing_interval)
            ),
            subscriber_count=count,
        )
        for room, product, count, owner_name in rows
    ]

    return SubscriberCountLeaderboardResponse(entries=entries, total=total)


# ---------------------------------------------------------------------------
# 2. GET /public/leaderboard/revenue — revenue ranking
# ---------------------------------------------------------------------------


@router.get("/revenue", response_model=RevenueLeaderboardResponse)
async def revenue_leaderboard(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """Rank subscription-gated rooms by total historical revenue.

    Revenue is calculated from actual successful charge transactions
    (WalletTransaction with reference_type='subscription_charge' and
    status='completed'), so price changes over time are properly reflected.
    """

    # Sum completed subscription charge revenue per product.
    # Path: WalletTransaction → AgentSubscription (via reference_id) → product_id
    revenue_sub = (
        select(
            AgentSubscription.product_id,
            func.coalesce(func.sum(WalletTransaction.amount_minor), 0).label(
                "total_revenue"
            ),
        )
        .join(
            AgentSubscription,
            WalletTransaction.reference_id == AgentSubscription.subscription_id,
        )
        .where(
            WalletTransaction.reference_type == "subscription_charge",
            WalletTransaction.status == TxStatus.completed,
        )
        .group_by(AgentSubscription.product_id)
        .subquery()
    )

    # Active subscriber count per product (reuse from above)
    sub_count = (
        select(
            AgentSubscription.product_id,
            func.count(AgentSubscription.id).label("subscriber_count"),
        )
        .where(AgentSubscription.status == SubscriptionStatus.active)
        .group_by(AgentSubscription.product_id)
        .subquery()
    )

    stmt = (
        select(
            Room,
            SubscriptionProduct,
            func.coalesce(revenue_sub.c.total_revenue, 0).label("total_revenue"),
            func.coalesce(sub_count.c.subscriber_count, 0).label("subscriber_count"),
            Agent.display_name.label("owner_display_name"),
        )
        .join(
            SubscriptionProduct,
            Room.required_subscription_product_id == SubscriptionProduct.product_id,
        )
        .outerjoin(
            revenue_sub, SubscriptionProduct.product_id == revenue_sub.c.product_id
        )
        .outerjoin(sub_count, SubscriptionProduct.product_id == sub_count.c.product_id)
        .join(Agent, Room.owner_id == Agent.agent_id)
        .where(
            Room.visibility == RoomVisibility.public,
            Room.required_subscription_product_id.is_not(None),
            SubscriptionProduct.status == SubscriptionProductStatus.active,
        )
        .order_by(
            func.coalesce(revenue_sub.c.total_revenue, 0).desc(),
            Room.room_id,
        )
    )

    # Total count (strip ordering for efficiency)
    count_stmt = select(func.count()).select_from(stmt.order_by(None).subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    # Paginate
    result = await db.execute(stmt.limit(limit).offset(offset))
    rows = result.all()

    entries = [
        RevenueLeaderboardEntry(
            room_id=room.room_id,
            room_name=room.name,
            room_description=room.description,
            owner_id=room.owner_id,
            owner_display_name=owner_name,
            product_id=product.product_id,
            product_name=product.name,
            current_amount_minor=str(product.amount_minor),
            billing_interval=(
                product.billing_interval.value
                if hasattr(product.billing_interval, "value")
                else str(product.billing_interval)
            ),
            total_revenue_minor=str(revenue),
            subscriber_count=count,
        )
        for room, product, revenue, count, owner_name in rows
    ]

    return RevenueLeaderboardResponse(entries=entries, total=total)
