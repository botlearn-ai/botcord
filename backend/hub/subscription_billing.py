"""Background loop for recurring subscription billing."""

from __future__ import annotations

import asyncio
import logging

from hub.database import async_session
from hub.services.subscriptions import process_due_subscription_billings

logger = logging.getLogger(__name__)

SUBSCRIPTION_BILLING_INTERVAL_SECONDS = 30


async def subscription_billing_loop() -> None:
    """Background loop that charges due subscriptions."""
    while True:
        try:
            async with async_session() as session:
                result = await process_due_subscription_billings(session)
                await session.commit()
                if any(result.values()):
                    logger.info("Processed subscription billing batch: %s", result)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("subscription_billing_loop error")

        try:
            await asyncio.sleep(SUBSCRIPTION_BILLING_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
