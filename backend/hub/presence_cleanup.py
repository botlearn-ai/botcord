"""Background loop that drops stale presence connection leases.

See docs/agent-presence-status-v1-supabase.md (#cleanup-job).
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text

from hub import config as hub_config
from hub.database import async_session

logger = logging.getLogger(__name__)

# Random Postgres advisory-lock key for the presence cleanup job. The bigint
# is arbitrary but stable; multiple Hub processes will only let one win.
_ADVISORY_LOCK_KEY = 0x7072_6573_656E_6365  # "presence" in hex (8 bytes)


async def _try_run_cleanup() -> int:
    """Acquire the advisory lock, run cleanup, and broadcast snapshots.

    The advisory lock is held in a dedicated session so a transaction
    rollback in the cleanup path cannot leave it stuck.
    """
    from hub.routers.hub import broadcast_status_changed
    from hub.services import presence as presence_service

    # Detect dialect once — we need a session to read it.
    async with async_session() as probe:
        dialect = getattr(probe.get_bind(), "dialect", None)
        is_postgres = dialect is not None and dialect.name == "postgresql"

    lock_session = None
    if is_postgres:
        lock_session = async_session()
        await lock_session.__aenter__()
        got = (
            await lock_session.execute(
                text("SELECT pg_try_advisory_lock(:key)"),
                {"key": _ADVISORY_LOCK_KEY},
            )
        ).scalar_one()
        if not got:
            await lock_session.__aexit__(None, None, None)
            return 0

    try:
        async with async_session() as db:
            try:
                changed = await presence_service.cleanup_stale(db)
                await db.commit()
            except Exception:
                await db.rollback()
                raise
    finally:
        if lock_session is not None:
            try:
                await lock_session.execute(
                    text("SELECT pg_advisory_unlock(:key)"),
                    {"key": _ADVISORY_LOCK_KEY},
                )
                await lock_session.commit()
            except Exception as exc:
                logger.warning("presence advisory unlock failed: %s", exc)
            finally:
                await lock_session.__aexit__(None, None, None)

    for snapshot in changed:
        try:
            asyncio.create_task(broadcast_status_changed(snapshot))
        except RuntimeError:
            break
    return len(changed)


async def presence_cleanup_loop() -> None:
    """Background loop: drop stale connections + recompute presence."""
    while True:
        try:
            count = await _try_run_cleanup()
            if count:
                logger.info("presence cleanup: %d agent(s) updated", count)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("presence_cleanup_loop error")
        await asyncio.sleep(hub_config.PRESENCE_CLEANUP_INTERVAL_SECONDS)
