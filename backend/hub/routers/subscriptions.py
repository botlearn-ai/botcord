"""Subscription product and billing API router."""

from fastapi import APIRouter, Depends, Header, Query
from hub.i18n import I18nHTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub import config as hub_config
from hub.auth import get_current_claimed_agent, get_dashboard_claimed_agent
from hub.database import get_db
from hub.models import SubscriptionRoomCreatorPolicy
from hub.services import subscriptions as subscription_svc
from hub.subscription_schemas import (
    SubscriptionBillingResponse,
    SubscriptionCreateRequest,
    SubscriptionListResponse,
    SubscriptionProductCreateRequest,
    SubscriptionProductListResponse,
    SubscriptionProductResponse,
    SubscriptionResponse,
)

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])
internal_router = APIRouter(prefix="/internal/subscriptions", tags=["subscriptions-internal"])


def _require_internal(authorization: str | None = None):
    if not hub_config.ALLOW_PRIVATE_ENDPOINTS:
        raise I18nHTTPException(status_code=403, message_key="internal_endpoints_disabled")

    expected = hub_config.INTERNAL_API_SECRET
    if expected:
        if not authorization or not authorization.startswith("Bearer "):
            raise I18nHTTPException(status_code=401, message_key="missing_internal_api_secret")
        provided = authorization.removeprefix("Bearer ").strip()
        if provided != expected:
            raise I18nHTTPException(status_code=401, message_key="invalid_internal_api_secret")


def _product_response(product) -> SubscriptionProductResponse:
    return SubscriptionProductResponse(
        product_id=product.product_id,
        owner_agent_id=product.owner_agent_id,
        name=product.name,
        description=product.description,
        asset_code=product.asset_code,
        amount_minor=str(product.amount_minor),
        billing_interval=product.billing_interval.value,
        status=product.status.value,
        created_at=product.created_at,
        updated_at=product.updated_at,
        archived_at=product.archived_at,
    )


def _subscription_response(subscription) -> SubscriptionResponse:
    return SubscriptionResponse(
        subscription_id=subscription.subscription_id,
        product_id=subscription.product_id,
        subscriber_agent_id=subscription.subscriber_agent_id,
        provider_agent_id=subscription.provider_agent_id,
        asset_code=subscription.asset_code,
        amount_minor=str(subscription.amount_minor),
        billing_interval=subscription.billing_interval.value,
        status=subscription.status.value,
        current_period_start=subscription.current_period_start,
        current_period_end=subscription.current_period_end,
        next_charge_at=subscription.next_charge_at,
        cancel_at_period_end=subscription.cancel_at_period_end,
        cancelled_at=subscription.cancelled_at,
        last_charged_at=subscription.last_charged_at,
        last_charge_tx_id=subscription.last_charge_tx_id,
        consecutive_failed_attempts=subscription.consecutive_failed_attempts,
        created_at=subscription.created_at,
        updated_at=subscription.updated_at,
    )


@router.post("/products", response_model=SubscriptionProductResponse, status_code=201)
async def create_product(
    req: SubscriptionProductCreateRequest,
    current_agent: str = Depends(get_current_claimed_agent),
    db: AsyncSession = Depends(get_db),
):
    # TODO: temporarily skip whitelist verification — allow anyone to create subscription products

    try:
        amount = int(req.amount_minor)
    except ValueError:
        raise I18nHTTPException(status_code=400, message_key="amount_minor_must_be_numeric")

    try:
        billing_interval = subscription_svc.BillingInterval(req.billing_interval)
    except ValueError:
        raise I18nHTTPException(status_code=400, message_key="billing_interval_invalid")

    try:
        product = await subscription_svc.create_subscription_product(
            db,
            current_agent,
            name=req.name,
            description=req.description,
            amount_minor=amount,
            billing_interval=billing_interval,
        )
        await db.commit()
        await db.refresh(product)
    except ValueError as err:
        raise I18nHTTPException(status_code=400, message_key="wallet_service_error", detail=str(err))

    return _product_response(product)


@router.get("/products", response_model=SubscriptionProductListResponse)
async def list_products(db: AsyncSession = Depends(get_db)):
    products = await subscription_svc.list_subscription_products(db)
    return SubscriptionProductListResponse(
        products=[_product_response(product) for product in products]
    )


@router.get("/products/me", response_model=SubscriptionProductListResponse)
async def list_my_products(
    current_agent: str = Depends(get_current_claimed_agent),
    db: AsyncSession = Depends(get_db),
):
    products = await subscription_svc.list_subscription_products(
        db, owner_agent_id=current_agent, include_archived=True
    )
    return SubscriptionProductListResponse(
        products=[_product_response(product) for product in products]
    )


@router.post("/products/{product_id}/archive", response_model=SubscriptionProductResponse)
async def archive_product(
    product_id: str,
    current_agent: str = Depends(get_current_claimed_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        product = await subscription_svc.archive_subscription_product(
            db, product_id, current_agent
        )
        await db.commit()
        await db.refresh(product)
    except ValueError as err:
        raise I18nHTTPException(status_code=400, message_key="wallet_service_error", detail=str(err))
    return _product_response(product)


@router.post("/products/{product_id}/subscribe", response_model=SubscriptionResponse, status_code=201)
async def subscribe(
    product_id: str,
    req: SubscriptionCreateRequest,
    current_agent: str = Depends(get_dashboard_claimed_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        subscription = await subscription_svc.create_subscription(
            db,
            product_id=product_id,
            subscriber_agent_id=current_agent,
            idempotency_key=req.idempotency_key,
        )
        await db.commit()
        await db.refresh(subscription)
    except ValueError as err:
        raise I18nHTTPException(status_code=400, message_key="wallet_service_error", detail=str(err))
    return _subscription_response(subscription)


@router.get("/me", response_model=SubscriptionListResponse)
async def list_my_subscriptions(
    current_agent: str = Depends(get_current_claimed_agent),
    db: AsyncSession = Depends(get_db),
):
    subscriptions = await subscription_svc.list_my_subscriptions(db, current_agent)
    return SubscriptionListResponse(
        subscriptions=[_subscription_response(subscription) for subscription in subscriptions]
    )


@router.get("/products/{product_id}/subscribers", response_model=SubscriptionListResponse)
async def list_subscribers(
    product_id: str,
    current_agent: str = Depends(get_current_claimed_agent),
    db: AsyncSession = Depends(get_db),
):
    product = await subscription_svc.get_subscription_product(db, product_id)
    if product is None:
        raise I18nHTTPException(status_code=404, message_key="subscription_product_not_found")
    if product.owner_agent_id != current_agent:
        raise I18nHTTPException(status_code=403, message_key="not_authorized")

    subscriptions = await subscription_svc.list_product_subscribers(db, product_id)
    return SubscriptionListResponse(
        subscriptions=[_subscription_response(subscription) for subscription in subscriptions]
    )


@router.post("/{subscription_id}/cancel", response_model=SubscriptionResponse)
async def cancel_subscription(
    subscription_id: str,
    current_agent: str = Depends(get_current_claimed_agent),
    db: AsyncSession = Depends(get_db),
):
    try:
        subscription = await subscription_svc.cancel_subscription(
            db, subscription_id, current_agent
        )
        await db.commit()
        await db.refresh(subscription)
    except ValueError as err:
        raise I18nHTTPException(status_code=400, message_key="wallet_service_error", detail=str(err))
    return _subscription_response(subscription)


@internal_router.post("/run-billing", response_model=SubscriptionBillingResponse)
async def run_billing(
    limit: int = Query(default=100, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
):
    _require_internal(authorization)
    try:
        result = await subscription_svc.process_due_subscription_billings(db, limit=limit)
        await db.commit()
    except ValueError as err:
        raise I18nHTTPException(status_code=400, message_key="wallet_service_error", detail=str(err))

    return SubscriptionBillingResponse(**result)
