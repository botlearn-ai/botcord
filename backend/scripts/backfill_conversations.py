"""Resumable projection backfill after migrations 017/018.

Run: uv run python scripts/backfill_conversations.py [--rebuild]
--rebuild queues all personal rooms; unchanged summaries keep their versions.
"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlalchemy import text
from hub.database import async_session
from hub.services.conversation_projection import project_pending


async def main(rebuild=False, batch_size=1, pause=0.1):
    total = 0
    async with async_session() as db:
        db.sync_session.info["conversation_projecting"] = True
        if rebuild:
            await db.execute(text("""INSERT INTO conversation_dirty_rooms (room_id, generation, reasons)
                SELECT room_id, 1, 8 FROM (SELECT room_id FROM rooms WHERE space_id IS NULL
                    UNION SELECT room_id FROM conversation_entries) AS pending WHERE TRUE
                ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1,
                    reasons = conversation_dirty_rooms.reasons | 8"""))
            await db.commit()
        while True:
            if db.get_bind().dialect.name == "postgresql":
                await db.execute(text("SET LOCAL statement_timeout = '60s'"))
                await db.execute(text("SET LOCAL lock_timeout = '5s'"))
            count = await project_pending(db, limit=batch_size)
            await db.commit()
            total += count
            print(f"Projected {total} queued rooms", flush=True)
            if count == 0:
                break
            await asyncio.sleep(pause)


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("--rebuild", action="store_true")
    args.add_argument("--batch-size", type=int, default=1, choices=range(1, 21))
    args.add_argument("--pause", type=float, default=0.1)
    parsed = args.parse_args()
    if parsed.pause < 0:
        args.error("--pause must be non-negative")
    asyncio.run(main(parsed.rebuild, parsed.batch_size, parsed.pause))
