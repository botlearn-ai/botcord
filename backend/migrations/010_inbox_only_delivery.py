"""
Migration 010: Inbox-only delivery cleanup

Part of the webhook-to-inbox refactoring. This is a DATA migration (no schema
changes). It cleans up message_records rows that were queued for webhook push
delivery so they can be consumed via the new inbox-pull model instead.

Changes:
  1. Clear next_retry_at for all queued messages (they will be picked up by
     inbox polling, not by the retired webhook retry loop).
  2. Clear last_error for messages whose error was 'ENDPOINT_UNREACHABLE' or
     'NO_ENDPOINT' — these error codes are artefacts of webhook delivery and
     are no longer meaningful.

Safe to run multiple times (idempotent).

Usage:
    python migrations/010_inbox_only_delivery.py            # apply
    python migrations/010_inbox_only_delivery.py --dry-run  # preview only
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import os

# Ensure the backend package root is importable when run as a standalone script.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from hub.config import DATABASE_SCHEMA, DATABASE_URL


def _build_engine():
    connect_args: dict = {}
    execution_options: dict = {}
    if DATABASE_SCHEMA:
        connect_args["server_settings"] = {"search_path": f"{DATABASE_SCHEMA},public"}
        execution_options["schema_translate_map"] = {None: DATABASE_SCHEMA}
    return create_async_engine(
        DATABASE_URL, echo=False,
        connect_args=connect_args,
        execution_options=execution_options,
    )


OBSOLETE_ERRORS = ("ENDPOINT_UNREACHABLE", "NO_ENDPOINT")


async def migrate(*, dry_run: bool = False) -> None:
    engine = _build_engine()
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with session_factory() as session:
        # ── Step 1: Clear next_retry_at on queued messages ────────────
        print("[1/2] Clearing next_retry_at for queued messages …")

        count_result = await session.execute(
            text(
                "SELECT COUNT(*) FROM message_records "
                "WHERE state = 'queued' AND next_retry_at IS NOT NULL"
            )
        )
        retry_count = count_result.scalar_one()
        print(f"      Found {retry_count} queued message(s) with a pending retry timestamp.")

        if retry_count > 0 and not dry_run:
            result = await session.execute(
                text(
                    "UPDATE message_records "
                    "SET next_retry_at = NULL "
                    "WHERE state = 'queued' AND next_retry_at IS NOT NULL"
                )
            )
            print(f"      Updated {result.rowcount} row(s).")
        elif dry_run and retry_count > 0:
            print("      (dry-run) Would update these rows.")

        # ── Step 2: Clear obsolete last_error values ──────────────────
        print("[2/2] Clearing obsolete last_error values …")

        count_result = await session.execute(
            text(
                "SELECT COUNT(*) FROM message_records "
                "WHERE last_error IN (:err1, :err2)"
            ),
            {"err1": OBSOLETE_ERRORS[0], "err2": OBSOLETE_ERRORS[1]},
        )
        error_count = count_result.scalar_one()
        print(f"      Found {error_count} message(s) with obsolete webhook errors "
              f"({', '.join(OBSOLETE_ERRORS)}).")

        if error_count > 0 and not dry_run:
            result = await session.execute(
                text(
                    "UPDATE message_records "
                    "SET last_error = NULL "
                    "WHERE last_error IN (:err1, :err2)"
                ),
                {"err1": OBSOLETE_ERRORS[0], "err2": OBSOLETE_ERRORS[1]},
            )
            print(f"      Updated {result.rowcount} row(s).")
        elif dry_run and error_count > 0:
            print("      (dry-run) Would update these rows.")

        # ── Commit or skip ────────────────────────────────────────────
        if dry_run:
            print("\n[dry-run] No changes committed. Re-run without --dry-run to apply.")
            await session.rollback()
        else:
            await session.commit()
            print("\nMigration 010 applied successfully.")

    await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migration 010: clean up webhook delivery artefacts for inbox-only mode"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without committing",
    )
    args = parser.parse_args()

    asyncio.run(migrate(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
