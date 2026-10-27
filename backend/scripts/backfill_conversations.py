"""Resumable projection backfill after migration 017.

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


async def main(rebuild=False):
    total = 0
    async with async_session() as db:
        db.sync_session.info["conversation_projecting"] = True
        if rebuild:
            await db.execute(text("""INSERT INTO conversation_dirty_rooms (room_id, generation)
                SELECT room_id, 1 FROM (SELECT room_id FROM rooms WHERE space_id IS NULL
                    UNION SELECT room_id FROM conversation_entries) AS pending WHERE TRUE
                ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1"""))
            await db.commit()
        while True:
            count = await project_pending(db)
            await db.commit()
            total += count
            print(f"Projected {total} queued rooms", flush=True)
            if count == 0:
                break


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("--rebuild", action="store_true")
    asyncio.run(main(args.parse_args().rebuild))
