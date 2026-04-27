"""Subscription product and billing routes under /api/subscriptions.

Uses Supabase JWT auth via ``require_active_agent`` and delegates to
the existing hub service layer.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import RequestContext, require_active_agent
from hub.database import get_db
from hub.enums import BillingInterval, SubscriptionStatus
from hub.models import AgentSubscription
from hub.services import subscriptions as sub_svc
from hub.subscription_schemas import (
    SubscriptionCreateRequest,
    SubscriptionProductCreateRequest,
)

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/subscriptions", tags=["app-subscriptions"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _product_response(p) -> dict:
    return {
        "product_id": p.product_id,
        "owner_agent_id": p.owner_agent_id,
        "name": p.name,
        "description": p.description,
        "asset_code": p.asset_code,
        "amount_minor": str(p.amount_minor),
        "billing_interval": p.billing_interval.value if hasattr(p.billing_interval, "value") else str(p.billing_interval),
        "status": p.status.value if hasattr(p.status, "value") else str(p.status),
        "created_at": p.created_at,
        "updated_at": p.updated_at,
        "archived_at": p.archived_at,
    }


def _subscription_response(s) -> dict:
    return {
        "subscription_id": s.subscription_id,
        "product_id": s.product_id,
        "subscriber_agent_id": s.subscriber_agent_id,
        "provider_agent_id": s.provider_agent_id,
        "asset_code": s.asset_code,
        "amount_minor": str(s.amount_minor),
        "billing_interval": s.billing_interval.value if hasattr(s.billing_interval, "value") else str(s.billing_interval),
        "status": s.status.value if hasattr(s.status, "value") else str(s.status),
        "current_period_start": s.current_period_start,
        "current_period_end": s.current_period_end,
        "next_charge_at": s.next_charge_at,
        "cancel_at_period_end": s.cancel_at_period_end,
        "cancelled_at": s.cancelled_at,
        "last_charged_at": s.last_charged_at,
        "last_charge_tx_id": s.last_charge_tx_id,
        "consecutive_failed_attempts": s.consecutive_failed_attempts,
        "created_at": s.created_at,
        "updated_at": s.updated_at,
    }


# ---------------------------------------------------------------------------
# Products — public
# ---------------------------------------------------------------------------


@router.get("/products")
async def list_products(
    db: AsyncSession = Depends(get_db),
):
    products = await sub_svc.list_subscription_products(db)
    return {"products": [_product_response(p) for p in products]}


@router.get("/products/me")
async def list_my_products(
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    products = await sub_svc.list_subscription_products(
        db, owner_agent_id=ctx.active_agent_id, include_archived=True,
    )
    return {"products": [_product_response(p) for p in products]}


@router.get("/products/{product_id}")
async def get_product(
    product_id: str,
    db: AsyncSession = Depends(get_db),
):
    product = await sub_svc.get_subscription_product(db, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Subscription product not found")
    active_subscriber_count = await sub_svc.count_active_subscribers(db, product_id)
    return {
        "product": {
            **_product_response(product),
            "active_subscriber_count": active_subscriber_count,
        },
    }


# ---------------------------------------------------------------------------
# Products — authed
# ---------------------------------------------------------------------------


@router.post("/products", status_code=201)
async def create_product(
    body: SubscriptionProductCreateRequest,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        amount = int(body.amount_minor)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid amount_minor")

    try:
        interval = BillingInterval(body.billing_interval)
    except ValueError:
        raise HTTPException(status_code=400, detail="billing_interval must be 'week', 'month', or 'once'")

    try:
        product = await sub_svc.create_subscription_product(
            db,
            ctx.active_agent_id,
            name=body.name,
            description=body.description,
            amount_minor=amount,
            billing_interval=interval,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    await db.commit()
    await db.refresh(product)
    return _product_response(product)


@router.post("/products/{product_id}/archive")
async def archive_product(
    product_id: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        product = await sub_svc.archive_subscription_product(
            db, product_id, ctx.active_agent_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    await db.commit()
    await db.refresh(product)
    return _product_response(product)


# ---------------------------------------------------------------------------
# Subscribe / cancel
# ---------------------------------------------------------------------------


@router.post("/products/{product_id}/subscribe", status_code=201)
async def subscribe(
    product_id: str,
    body: SubscriptionCreateRequest | None = None,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        subscription = await sub_svc.create_subscription(
            db,
            product_id=product_id,
            subscriber_agent_id=ctx.active_agent_id,
            idempotency_key=body.idempotency_key if body else None,
            room_id=body.room_id if body else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    await db.commit()
    # Refresh to load server-generated defaults (updated_at, created_at)
    await db.refresh(subscription)
    return _subscription_response(subscription)


@router.get("/products/{product_id}/subscribers")
async def list_subscribers(
    product_id: str,
    status: str | None = Query(
        default=None,
        description="Comma-separated subscription statuses to filter by (e.g. 'active,past_due')",
    ),
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    # Verify ownership
    product = await sub_svc.get_subscription_product(db, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Subscription product not found")
    if product.owner_agent_id != ctx.active_agent_id:
        raise HTTPException(status_code=403, detail="Not authorized to view subscribers")

    statuses: list[SubscriptionStatus] | None = None
    if status:
        statuses = []
        for raw in status.split(","):
            token = raw.strip()
            if not token:
                continue
            try:
                statuses.append(SubscriptionStatus(token))
            except ValueError:
                raise HTTPException(
                    status_code=400, detail=f"Invalid subscription status: {token}"
                )

    subscribers = await sub_svc.list_product_subscribers(
        db, product_id, statuses=statuses
    )
    return {"subscribers": [_subscription_response(s) for s in subscribers]}


# ---------------------------------------------------------------------------
# My subscriptions
# ---------------------------------------------------------------------------


@router.get("/me")
async def list_my_subscriptions(
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    subscriptions = await sub_svc.list_my_subscriptions(db, ctx.active_agent_id)
    return {"subscriptions": [_subscription_response(s) for s in subscriptions]}


@router.post("/{subscription_id}/cancel")
async def cancel_subscription(
    subscription_id: str,
    ctx: RequestContext = Depends(require_active_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        subscription = await sub_svc.cancel_subscription(
            db, subscription_id, ctx.active_agent_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    await db.commit()
    await db.refresh(subscription)
    return _subscription_response(subscription)
