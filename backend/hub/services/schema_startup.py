"""Create/validate the schema, retrying only rolled-back transient transactions."""
import asyncio
import logging

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

logger = logging.getLogger(__name__)


async def prepare_schema(engine, metadata, schema=None):
    for attempt in range(3):
        engine.sync_engine._conversation_capture_installed = False
        try:
            async with engine.begin() as conn:
                if conn.dialect.name == "postgresql":
                    await conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                if schema:
                    quoted = conn.dialect.identifier_preparer.quote_identifier(schema)
                    await conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {quoted}"))
                await conn.run_sync(metadata.create_all)
            return
        except DBAPIError as exc:
            engine.sync_engine._conversation_capture_installed = False
            state = getattr(exc.orig, "sqlstate", None) or getattr(exc.orig, "pgcode", None)
            if state not in {"40P01", "40001", "55P03"} or attempt == 2:
                raise
            # engine.begin has rolled back before sleeping or opening a new
            # transaction. Never retry a single statement in an aborted one.
            logger.warning("Schema startup transaction rolled back (%s); retry %s/2", state, attempt + 1)
            await asyncio.sleep(0.2 * (2 ** attempt))
        except BaseException:
            engine.sync_engine._conversation_capture_installed = False
            raise
