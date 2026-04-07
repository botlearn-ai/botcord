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
    """Delete expired file storage objects, keeping DB records so downloads return 'file_expired'."""
    now = datetime.datetime.now(datetime.timezone.utc)
    cleaned = 0
    async with async_session() as session:
        result = await session.execute(
            select(FileRecord).where(
                FileRecord.expires_at <= now,
                FileRecord.storage_backend != "expired",
            ).limit(100)
        )
        records = list(result.scalars().all())
        for record in records:
            try:
                await delete_file(record)
            except FileNotFoundError:
                pass
            except Exception as exc:
                logger.warning("Failed to delete file for %s: %s", record.file_id, exc)
                continue
            record.storage_backend = "expired"
            record.disk_path = None
            record.storage_object_key = None
            cleaned += 1
        if records:
            await session.commit()
    return cleaned
