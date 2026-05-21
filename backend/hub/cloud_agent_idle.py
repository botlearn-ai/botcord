"""Background loop for idle Cloud Agent sandbox pause."""

from __future__ import annotations

import asyncio
import logging

from hub import config as hub_config
from hub.database import async_session
from hub.services.cloud_agent import CloudAgentService

logger = logging.getLogger(__name__)


async def cloud_agent_idle_pause_loop() -> None:
    """Pause ready Cloud Agent sandboxes after the configured idle window."""
    service = CloudAgentService()
    while True:
        try:
            count = await _pause_idle_cloud_daemons(service)
            if count:
                logger.info("Idle-paused %d cloud daemon sandbox(es)", count)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("cloud_agent_idle_pause_loop error")
        await asyncio.sleep(hub_config.CLOUD_AGENT_IDLE_SWEEP_INTERVAL_SECONDS)


async def _pause_idle_cloud_daemons(service: CloudAgentService | None = None) -> int:
    if not hub_config.CLOUD_AGENT_FEATURE_ENABLED:
        return 0
    if hub_config.CLOUD_AGENT_IDLE_PAUSE_SECONDS <= 0:
        return 0

    svc = service or CloudAgentService()
    async with async_session() as session:
        return await svc.pause_idle_cloud_daemons(
            session,
            idle_seconds=hub_config.CLOUD_AGENT_IDLE_PAUSE_SECONDS,
        )
