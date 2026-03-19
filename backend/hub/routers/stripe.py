"""Stripe integration routes — checkout session, webhook, status query."""

import logging

import stripe
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_agent
from hub import config as hub_config
from hub.database import get_db
from hub.services.stripe_topup import FulfillmentError
from hub.services import stripe_topup as stripe_svc
from hub.wallet_schemas import (
    StripeCheckoutRequest,
    StripeCheckoutResponse,
    StripeSessionStatusResponse,
    StripePackageResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["stripe"])


# ---------------------------------------------------------------------------
# GET /wallet/topups/stripe/packages
# ---------------------------------------------------------------------------


@router.get(
    "/wallet/topups/stripe/packages",
    response_model=StripePackageResponse,
)
async def list_stripe_packages():
    """Return available topup packages. Public endpoint (no auth required)."""
    from hub.wallet_schemas import StripePackageItem

    packages = [
        StripePackageItem(
            package_code=pkg["package_code"],
            coin_amount_minor=str(pkg["coin_amount_minor"]),
            fiat_amount=str(pkg.get("fiat_amount", "")),
            currency=hub_config.STRIPE_TOPUP_CURRENCY,
        )
        for pkg in hub_config.STRIPE_TOPUP_PACKAGES
    ]
    return StripePackageResponse(packages=packages)


# ---------------------------------------------------------------------------
# POST /wallet/topups/stripe/checkout-session
# ---------------------------------------------------------------------------


@router.post(
    "/wallet/topups/stripe/checkout-session",
    response_model=StripeCheckoutResponse,
    status_code=201,
)
async def create_stripe_checkout_session(
    req: StripeCheckoutRequest,
    current_agent: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Create a Stripe Checkout Session for a coin topup package."""
    try:
        result = await stripe_svc.create_checkout_session(
            db,
            agent_id=current_agent,
            package_code=req.package_code,
            idempotency_key=req.idempotency_key,
            quantity=req.quantity,
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return StripeCheckoutResponse(**result)


# ---------------------------------------------------------------------------
# GET /wallet/topups/stripe/session-status
# ---------------------------------------------------------------------------


@router.get(
    "/wallet/topups/stripe/session-status",
    response_model=StripeSessionStatusResponse,
)
async def get_stripe_session_status(
    session_id: str = Query(..., min_length=1),
    current_agent: str = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Query the status of a Stripe checkout session."""
    try:
        result = await stripe_svc.get_checkout_status(
            db, session_id, agent_id=current_agent
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError:
        raise HTTPException(status_code=403, detail="Not authorized to view this topup")

    return StripeSessionStatusResponse(**result)


# ---------------------------------------------------------------------------
# POST /stripe/webhook
# ---------------------------------------------------------------------------


@router.post("/stripe/webhook", status_code=200)
async def stripe_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Receive Stripe webhook events. Verifies signature, processes payment events."""
    if not hub_config.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=500, detail="Webhook secret not configured")

    # Read raw body for signature verification
    body = await request.body()
    sig_header = request.headers.get("stripe-signature")
    if not sig_header:
        raise HTTPException(status_code=400, detail="Missing Stripe-Signature header")

    try:
        event = stripe.Webhook.construct_event(
            body, sig_header, hub_config.STRIPE_WEBHOOK_SECRET
        )
    except stripe.SignatureVerificationError:
        logger.warning("Stripe webhook signature verification failed")
        raise HTTPException(status_code=400, detail="Invalid signature")
    except ValueError:
        logger.warning("Stripe webhook payload invalid")
        raise HTTPException(status_code=400, detail="Invalid payload")

    # Only process whitelisted events
    if event.type == "checkout.session.completed":
        session_obj = event.data.object
        session_id = session_obj.get("id") if isinstance(session_obj, dict) else session_obj.id
        logger.info("Received checkout.session.completed for %s", session_id)

        try:
            await stripe_svc.fulfill_stripe_checkout(db, session_id)
            await db.commit()
        except FulfillmentError as e:
            if e.retryable:
                logger.warning(
                    "Transient fulfillment failure for %s: %s (Stripe will retry)",
                    session_id, e,
                )
                raise HTTPException(status_code=500, detail=str(e))
            else:
                logger.warning(
                    "Terminal fulfillment failure for %s: %s", session_id, e
                )
    else:
        logger.debug("Ignoring Stripe event type: %s", event.type)

    return {"status": "ok"}
