"""Background cleanup loop for expired files."""

from __future__ import annotations

import asyncio
import datetime
import logging

from sqlalchemy import select

from hub import config as hub_config
from hub.database import async_session
from hub.models import FileRecord
from hub.storage import delete_file

logger = logging.getLogger(__name__)


async def file_cleanup_loop() -> None:
    """Background loop that deletes expired file records and their disk files."""
    while True:
        try:
            count = await _cleanup_expired_files()
            if count:
                logger.info("Cleaned up %d expired file(s)", count)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("file_cleanup_loop error")
        await asyncio.sleep(hub_config.FILE_CLEANUP_INTERVAL_SECONDS)


async def _cleanup_expired_files() -> int:
    """Delete expired file records and their disk files. Returns count of deleted files."""
    now = datetime.datetime.now(datetime.timezone.utc)
    deleted = 0
    async with async_session() as session:
        result = await session.execute(
            select(FileRecord).where(FileRecord.expires_at <= now).limit(100)
        )
        records = list(result.scalars().all())
        for record in records:
            try:
                await delete_file(record)
            except FileNotFoundError:
                pass
            except OSError as exc:
                logger.warning("Failed to delete file for %s: %s", record.file_id, exc)
            await session.delete(record)
            deleted += 1
        if records:
            await session.commit()
    return deleted
