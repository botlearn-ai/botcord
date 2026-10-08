"""Project legacy relation tables into the access graph (idempotent).

Run once after applying migrations/008_access_graph.sql, then again any time to
verify (a second run reports no changes):

    uv run python scripts/sync_access_graph.py [--dry-run]

Prints what changed plus a per-kind count of live edges next to the legacy
row counts they came from, so the projection can be checked table by table.
The Hub keeps the projection fresh in the background afterwards
(ACCESS_GRAPH_SYNC_INTERVAL_SECONDS).
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402

from hub.database import async_session  # noqa: E402
from hub.models import AccessEdge, AccessPrincipal  # noqa: E402
from hub.services.access_graph_sync import sync_access_graph  # noqa: E402

LEGACY_COUNTS = {
    "agents (active, owned)": "select count(*) from agents where status = 'active' and user_id is not null",
    "organization user memberships": "select count(*) from space_user_memberships m join organizations o on o.space_id = m.space_id",
    "organization agent memberships": "select count(*) from space_agent_memberships m join organizations o on o.space_id = m.space_id",
    "agent_access_grants": "select count(*) from agent_access_grants",
    "agent_management_grants": "select count(*) from agent_management_grants",
    "contacts": "select count(*) from contacts",
    "contact_requests (pending)": "select count(*) from contact_requests where state = 'pending'",
    "blocks": "select count(*) from blocks",
    "room_members": "select count(*) from room_members",
}


async def main(dry_run: bool) -> None:
    from sqlalchemy import text

    async with async_session() as db:
        stats = await sync_access_graph(db)
        print(stats)
        print("\nlegacy rows:")
        for label, sql in LEGACY_COUNTS.items():
            print(f"  {label}: {(await db.execute(text(sql))).scalar_one()}")
        print("\nedges by kind/status:")
        rows = await db.execute(
            select(AccessEdge.kind, AccessEdge.status, func.count()).group_by(AccessEdge.kind, AccessEdge.status)
            .order_by(AccessEdge.kind, AccessEdge.status)
        )
        for kind, status, n in rows.all():
            print(f"  {kind} {status}: {n}")
        print(f"\nprincipals: {(await db.execute(select(func.count()).select_from(AccessPrincipal))).scalar_one()}")
        if dry_run:
            await db.rollback()
            print("dry run: nothing written")
        else:
            await db.commit()
            print("done")


if __name__ == "__main__":
    asyncio.run(main("--dry-run" in sys.argv))
