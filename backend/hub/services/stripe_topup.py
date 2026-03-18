"""Stripe Checkout topup service — creates sessions, fulfills payments."""

import json
import logging
from uuid import uuid4

import stripe
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from hub import config as hub_config
from hub.enums import TopupStatus
from hub.models import TopupRequest
from hub.services import wallet as wallet_svc

logger = logging.getLogger(__name__)


class FulfillmentError(Exception):
    """Raised when fulfillment fails."""

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


def _get_package(package_code: str) -> dict | None:
    for pkg in hub_config.STRIPE_TOPUP_PACKAGES:
        if pkg.get("package_code") == package_code:
            return pkg
    return None


async def create_checkout_session(
    session: AsyncSession,
    agent_id: str,
    package_code: str,
    idempotency_key: str,
) -> dict:
    """Create a Stripe Checkout Session and a local pending topup.

    Returns dict with topup_id, tx_id, checkout_session_id, checkout_url,
    expires_at, status.

    Idempotency:
    - If a *pending* topup with the same idempotency_key already has a
      checkout_url, return it immediately (fast path, no Stripe call).
    - If the previous topup was *failed* (e.g. Stripe session creation
      blew up), we ignore it and create a fresh topup+session so the
      user can retry.
    """
    if not hub_config.STRIPE_SECRET_KEY:
        raise ValueError("Stripe is not configured")

    pkg = _get_package(package_code)
    if pkg is None:
        raise ValueError(f"Unknown package_code: {package_code}")

    stripe_price_id = pkg["stripe_price_id"]
    coin_amount_minor = int(pkg["coin_amount_minor"])

    # --- Idempotency: look for an existing topup with the same key ----------
    existing = await session.execute(
        select(TopupRequest).where(
            TopupRequest.agent_id == agent_id,
            TopupRequest.channel == "stripe",
            TopupRequest.metadata_json.isnot(None),
        )
    )
    for topup in existing.scalars().all():
        try:
            meta = json.loads(topup.metadata_json) if topup.metadata_json else {}
        except (json.JSONDecodeError, TypeError):
            meta = {}
        if meta.get("idempotency_key") != idempotency_key:
            continue

        # Previous attempt failed → allow a fresh retry with new topup.
        if topup.status == TopupStatus.failed:
            continue

        # Pending topup exists. Only return if checkout_url has been
        # written back (i.e. the Stripe call succeeded previously).
        checkout_url = meta.get("checkout_url")
        if topup.status == TopupStatus.pending and topup.external_ref and checkout_url:
            return {
                "topup_id": topup.topup_id,
                "tx_id": topup.tx_id,
                "checkout_session_id": topup.external_ref,
                "checkout_url": checkout_url,
                "expires_at": meta.get("expires_at"),
                "status": topup.status.value,
            }

        # Already completed (e.g. webhook raced ahead) — return as-is.
        if topup.status == TopupStatus.completed:
            return {
                "topup_id": topup.topup_id,
                "tx_id": topup.tx_id,
                "checkout_session_id": topup.external_ref or "",
                "checkout_url": meta.get("checkout_url", ""),
                "expires_at": meta.get("expires_at"),
                "status": topup.status.value,
            }

        # Pending but no checkout_url yet: the previous request crashed
        # between creating the topup and writing back the Stripe session.
        # Fall through and create a new Stripe session for this topup.
        break

    # --- 1. Create local pending topup (uses wallet-level idempotency) ------
    # Generate a unique idempotency_key per attempt so that a retry after a
    # failed topup does not collide with the old tx at the wallet layer.
    wallet_idem_key = f"{idempotency_key}:{uuid4().hex[:8]}"
    metadata = {
        "package_code": package_code,
        "stripe_price_id": stripe_price_id,
        "idempotency_key": idempotency_key,
    }
    topup, tx = await wallet_svc.create_topup_request(
        session,
        agent_id,
        coin_amount_minor,
        channel="stripe",
        metadata=metadata,
        idempotency_key=wallet_idem_key,
    )

    # --- 2. Create Stripe Checkout Session ----------------------------------
    stripe.api_key = hub_config.STRIPE_SECRET_KEY

    success_url = (
        f"{hub_config.FRONTEND_BASE_URL}/chats"
        f"?wallet_topup=success&session_id={{CHECKOUT_SESSION_ID}}"
    )
    cancel_url = f"{hub_config.FRONTEND_BASE_URL}/chats?wallet_topup=cancelled"

    try:
        checkout_session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{"price": stripe_price_id, "quantity": 1}],
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={
                "topup_id": topup.topup_id,
                "agent_id": agent_id,
                "package_code": package_code,
                "coin_amount_minor": str(coin_amount_minor),
            },
            payment_intent_data={
                "metadata": {
                    "topup_id": topup.topup_id,
                    "agent_id": agent_id,
                    "package_code": package_code,
                    "coin_amount_minor": str(coin_amount_minor),
                },
            },
            idempotency_key=topup.topup_id,  # Stripe-side idempotency per topup
        )
    except stripe.StripeError as e:
        logger.error("Stripe session creation failed: %s", e)
        await wallet_svc.fail_topup_request(session, topup.topup_id)
        # Commit the failed status so it persists (caller's except will not commit)
        await session.commit()
        raise ValueError(f"Stripe error: {e.user_message or str(e)}")

    # --- 3. Bind session ID back to topup -----------------------------------
    topup.external_ref = checkout_session.id
    metadata["checkout_url"] = checkout_session.url
    metadata["expires_at"] = checkout_session.expires_at
    topup.metadata_json = json.dumps(metadata)
    await session.flush()

    return {
        "topup_id": topup.topup_id,
        "tx_id": topup.tx_id,
        "checkout_session_id": checkout_session.id,
        "checkout_url": checkout_session.url,
        "expires_at": checkout_session.expires_at,
        "status": topup.status.value,
    }


async def fulfill_stripe_checkout(
    session: AsyncSession, checkout_session_id: str
) -> TopupRequest:
    """Fulfill a Stripe Checkout — idempotently complete the topup.

    Called from both webhook and session-status endpoint.

    Raises:
        FulfillmentError: with retryable=True for transient failures
            (Stripe API errors, topup not found yet due to race),
            retryable=False for terminal states (already completed,
            amount mismatch, invalid session).
        ValueError: for caller-facing validation errors (session-status path).
    """
    if not hub_config.STRIPE_SECRET_KEY:
        raise FulfillmentError("Stripe is not configured", retryable=False)

    stripe.api_key = hub_config.STRIPE_SECRET_KEY

    # 1. Retrieve session from Stripe
    try:
        cs = stripe.checkout.Session.retrieve(checkout_session_id)
    except stripe.StripeError as e:
        raise FulfillmentError(
            f"Failed to retrieve Stripe session: {e}", retryable=True
        )

    # 2. Validate
    if cs.mode != "payment":
        raise FulfillmentError(
            f"Unexpected session mode: {cs.mode}", retryable=False
        )

    if cs.payment_status != "paid":
        raise FulfillmentError(
            f"Payment not completed: {cs.payment_status}", retryable=False
        )

    topup_id = (cs.metadata or {}).get("topup_id")
    if not topup_id:
        raise FulfillmentError(
            "Missing topup_id in Stripe session metadata", retryable=False
        )

    # 3. Find local topup
    result = await session.execute(
        select(TopupRequest).where(TopupRequest.topup_id == topup_id)
    )
    topup = result.scalar_one_or_none()
    if topup is None:
        # Race condition: webhook arrived before DB commit of the topup.
        # Stripe should retry.
        raise FulfillmentError(
            f"Topup {topup_id} not found", retryable=True
        )

    # Bind external_ref if not yet set (crash recovery)
    if not topup.external_ref:
        topup.external_ref = checkout_session_id
        await session.flush()
    elif topup.external_ref != checkout_session_id:
        raise FulfillmentError(
            "Session ID mismatch with topup external_ref", retryable=False
        )

    # 4. Idempotent: already completed
    if topup.status == TopupStatus.completed:
        return topup

    if topup.status != TopupStatus.pending:
        raise FulfillmentError(
            f"Topup is in unexpected state: {topup.status.value}", retryable=False
        )

    # 5. Validate amount consistency
    expected_coin = (cs.metadata or {}).get("coin_amount_minor")
    if expected_coin and int(expected_coin) != topup.amount_minor:
        raise FulfillmentError(
            "Coin amount mismatch between Stripe metadata and local topup",
            retryable=False,
        )

    # 6. Complete topup
    topup, _tx = await wallet_svc.complete_topup_request(session, topup.topup_id)
    logger.info(
        "Fulfilled Stripe checkout %s → topup %s completed",
        checkout_session_id,
        topup.topup_id,
    )
    return topup


async def get_checkout_status(
    session: AsyncSession, checkout_session_id: str, *, agent_id: str
) -> dict:
    """Query the status of a Stripe checkout session and attempt fulfillment.

    Raises PermissionError if the topup does not belong to agent_id.
    """
    # Find topup by external_ref
    result = await session.execute(
        select(TopupRequest).where(TopupRequest.external_ref == checkout_session_id)
    )
    topup = result.scalar_one_or_none()

    # If not found by external_ref, try via Stripe metadata
    if topup is None and hub_config.STRIPE_SECRET_KEY:
        stripe.api_key = hub_config.STRIPE_SECRET_KEY
        try:
            cs = stripe.checkout.Session.retrieve(checkout_session_id)
            topup_id = (cs.metadata or {}).get("topup_id")
            if topup_id:
                r2 = await session.execute(
                    select(TopupRequest).where(TopupRequest.topup_id == topup_id)
                )
                topup = r2.scalar_one_or_none()
        except stripe.StripeError:
            pass

    if topup is None:
        raise ValueError("Checkout session not found")

    # Ownership check
    if topup.agent_id != agent_id:
        raise PermissionError("Not authorized to view this topup")

    # Attempt fulfillment as compensation
    payment_status = "unknown"
    if topup.status == TopupStatus.pending:
        try:
            topup = await fulfill_stripe_checkout(session, checkout_session_id)
            payment_status = "paid"
        except (FulfillmentError, ValueError):
            # Not ready yet or error — return current state
            pass

    if topup.status == TopupStatus.completed:
        payment_status = "paid"

    return {
        "topup_id": topup.topup_id,
        "tx_id": topup.tx_id,
        "checkout_session_id": checkout_session_id,
        "topup_status": topup.status.value,
        "payment_status": payment_status,
        "wallet_credited": topup.status == TopupStatus.completed,
        "amount_minor": str(topup.amount_minor),
        "asset_code": topup.asset_code,
    }
