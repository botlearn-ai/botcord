"""Fixed 017 -> 018 maintenance gate, also runnable with the previous Hub image.

The deploy coordinator provides only the required runtime environment on stdin.
State contains capture DDL and aggregate checks, never credentials or messages.
No Hub server is started by this command.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path("/app") if Path("/app/hub").is_dir() else Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

MIGRATION = "018_incremental_conversation_projection.sql"
BASELINE = "017_conversation_directory.sql"
RUNTIME_KEYS = {"DATABASE_URL", "DATABASE_SCHEMA", "JWT_SECRET", "BOTCORD_HUB_CONTROL_PRIVATE_KEY"}


class GateError(RuntimeError):
    """A static, safe-to-log operator diagnostic."""


def connect():
    import psycopg2
    from psycopg2 import sql

    dsn = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://", 1)
    conn = psycopg2.connect(dsn, connect_timeout=15, application_name="botcord-conversation-release")
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '60s'")
        cur.execute("SET lock_timeout = '5s'")
        schema = os.environ.get("DATABASE_SCHEMA") or "public"
        if os.environ.get("DATABASE_SCHEMA"):
            cur.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(schema)))
        cur.execute("SELECT current_schema()")
        if cur.fetchone()[0] != schema:
            raise GateError("Configured schema is missing; refusing fallback")
    return conn, schema


def epoch_digest(cur):
    cur.execute("SELECT user_id, epoch FROM conversation_accounts ORDER BY user_id")
    return hashlib.sha256(json.dumps(cur.fetchall(), default=str).encode()).hexdigest()


def preflight(conn, schema):
    with conn.cursor() as cur:
        cur.execute("SELECT version FROM _botcord_schema_migrations")
        versions = {r[0] for r in cur.fetchall()}
        if BASELINE not in versions and "016_space_knowledge_base.sql" not in versions:
            raise GateError("This fixed release requires migration 016 or 017 already installed")
        if any(v > MIGRATION for v in versions):
            raise GateError("Database is newer than this release")
        cur.execute("SELECT count(*) FROM rooms WHERE space_id IS NULL AND left(room_id,7) <> 'rm_sdm_'")
        rooms = cur.fetchone()[0]
    # The ledger alone is insufficient after a rollback of capture definitions.
    needs_migration = MIGRATION not in versions
    if not needs_migration:
        try:
            validate_capture(schema)
        except RuntimeError:
            needs_migration = True
    return {"schema": schema, "personal_rooms": rooms, "needs_migration": needs_migration,
            "needs_017": BASELINE not in versions}


def validate_capture(schema):
    from sqlalchemy import create_engine
    from hub.services.conversation_capture import _validate_postgres_capture
    engine = create_engine(os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://", 1))
    try:
        with engine.begin() as connection:
            if os.environ.get("DATABASE_SCHEMA"):
                quote = connection.dialect.identifier_preparer.quote_identifier
                connection.exec_driver_sql(f"SET LOCAL search_path TO {quote(schema)}, public")
            suffix = "_" + hashlib.md5(schema.encode()).hexdigest()[:8]
            _validate_postgres_capture(connection, schema, "public", suffix)
    finally:
        engine.dispose()


def snapshot(conn, schema, path):
    suffix = "_" + hashlib.md5(schema.encode()).hexdigest()[:8]
    names = [f"conversation_{table}_{op}{suffix}" for table in
             ("rooms", "room_members", "message_records", "agents", "users")
             for op in ("insert", "update", "delete")]
    with conn.cursor() as cur:
        cur.execute("""SELECT pg_get_functiondef(p.oid) FROM pg_proc p
            JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname=%s AND p.proname=ANY(%s) ORDER BY p.proname""", (schema, names))
        functions = [r[0] for r in cur.fetchall()]
        cur.execute("""SELECT n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid)
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
            WHERE pn.nspname=%s AND t.tgname=ANY(%s) ORDER BY t.tgname""", (schema, names))
        triggers = cur.fetchall()
        if len(functions) != 15 or len(triggers) != 15:
            raise GateError("Expected all 15 existing capture functions and triggers")
        cur.execute("SELECT EXISTS(SELECT 1 FROM _botcord_schema_migrations WHERE version=%s)", (MIGRATION,))
        state = {"schema": schema, "functions": functions, "triggers": triggers,
                 "had_migration": cur.fetchone()[0], "epochs": epoch_digest(cur)}
        cur.execute("SELECT EXISTS(SELECT 1 FROM _botcord_schema_migrations WHERE version=%s)", (BASELINE,))
        state["had_baseline"] = cur.fetchone()[0]
    # O_EXCL ensures a retry never overwrites the original recovery snapshot.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(state, out)


def apply_migration(conn, path):
    if path.name not in {BASELINE, MIGRATION}:
        raise GateError("Only migrations 017 and 018 are allowed in this gate")
    sql = path.read_text()
    if not sql.rstrip().endswith("COMMIT;"):
        raise GateError("Migration must own its transaction")
    # Ledger and schema commit together; this runs only the fixed migration.
    sql = sql.rstrip()[:-len("COMMIT;")] + (
        f"INSERT INTO _botcord_schema_migrations(version) VALUES ('{path.name}') "
        "ON CONFLICT DO NOTHING;\nCOMMIT;"
    )
    with conn.cursor() as cur:
        cur.execute(sql)


def restore(conn, schema, path):
    from psycopg2 import sql
    state = json.loads(path.read_text())
    if state["schema"] != schema:
        raise GateError("Recovery schema does not match runtime")
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            tables = sorted({(r[0], r[1]) for r in state["triggers"]})
            cur.execute(sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(
                sql.SQL(", ").join(sql.Identifier(*t) for t in tables)))
            for definition in state["functions"]:
                cur.execute(definition)
            for ns, table, name, definition in state["triggers"]:
                cur.execute(sql.SQL("DROP TRIGGER IF EXISTS {} ON {}.{}").format(
                    sql.Identifier(name), sql.Identifier(ns), sql.Identifier(table)))
                cur.execute(definition)
            if not state["had_migration"]:
                cur.execute("DELETE FROM _botcord_schema_migrations WHERE version=%s", (MIGRATION,))
            if not state["had_baseline"]:
                cur.execute("DELETE FROM _botcord_schema_migrations WHERE version=%s", (BASELINE,))
            cur.execute("""INSERT INTO conversation_dirty_rooms(room_id,generation)
                SELECT room_id,1 FROM (SELECT room_id FROM rooms WHERE space_id IS NULL
                    UNION SELECT room_id FROM conversation_entries) p
                ON CONFLICT(room_id) DO UPDATE SET generation=conversation_dirty_rooms.generation+1""")
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.autocommit = True


async def backfill():
    # Compatible with both the pre-018 image and the new image.
    from hub.database import async_session, engine
    from hub.services.conversation_projection import project_pending
    from sqlalchemy import text
    total = 0
    try:
        async with async_session() as db:
            db.sync_session.info["conversation_projecting"] = True
            while True:
                await db.execute(text("SET LOCAL statement_timeout = '60s'"))
                await db.execute(text("SET LOCAL lock_timeout = '5s'"))
                count = await project_pending(db, limit=1)
                await db.commit()
                total += count
                if total % 20 == 0 or not count:
                    print(f"Projected {total} queued rooms", file=sys.stderr, flush=True)
                if not count:
                    break
                await asyncio.sleep(0.1)
    finally:
        await engine.dispose()


def verify(conn, state_path):
    state = json.loads(state_path.read_text())
    with conn.cursor() as cur:
        for table in ("conversation_dirty_rooms", "conversation_dirty_messages", "conversation_dirty_readers"):
            cur.execute(f"SELECT count(*) FROM {table}")
            if cur.fetchone()[0]:
                raise GateError(f"{table} is not drained")
        cur.execute("""SELECT count(*) FROM rooms r LEFT JOIN conversation_room_summaries s USING(room_id)
            WHERE r.space_id IS NULL AND left(r.room_id,7) <> 'rm_sdm_' AND s.room_id IS NULL""")
        if cur.fetchone()[0]:
            raise GateError("Personal room summaries are missing")
        if epoch_digest(cur) != state["epochs"]:
            raise GateError("Existing conversation cursor epochs changed")
        cur.execute("SELECT count(*) FROM conversation_messages")
        return {"logical_messages": cur.fetchone()[0], "queues_empty": True, "epochs_preserved": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("preflight", "validate", "snapshot", "apply", "restore", "backfill-old"))
    parser.add_argument("--state", default="/release-state/capture.json")
    args = parser.parse_args()
    runtime = json.load(sys.stdin)
    if not runtime.get("DATABASE_URL") or not runtime.get("BOTCORD_HUB_CONTROL_PRIVATE_KEY"):
        raise GateError("Runtime database and signing configuration are required")
    os.environ.update({k: v for k, v in runtime.items() if k in RUNTIME_KEYS and v})
    if args.mode == "backfill-old":
        asyncio.run(backfill())
        return
    conn, schema = connect()
    path = Path(args.state)
    try:
        if args.mode == "preflight":
            result = preflight(conn, schema)
        elif args.mode == "validate":
            validate_capture(schema)
            result = {"runtime_capture_verified": True}
        elif args.mode == "snapshot":
            snapshot(conn, schema, path)
            result = {"capture_snapshot_saved": True}
        elif args.mode == "restore":
            restore(conn, schema, path)
            result = {"capture_restored": True}
        else:
            with conn.cursor() as cur:
                cur.execute("SELECT EXISTS(SELECT 1 FROM _botcord_schema_migrations WHERE version=%s)", (BASELINE,))
                needs_baseline = not cur.fetchone()[0]
            if needs_baseline:
                apply_migration(conn, ROOT / "migrations" / BASELINE)
            apply_migration(conn, ROOT / "migrations" / MIGRATION)
            validate_capture(schema)
            asyncio.run(backfill())
            result = verify(conn, path)
        print(json.dumps(result), flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Connection/SQL exceptions can contain DSNs or private source values.
        detail = f": {exc}" if isinstance(exc, GateError) else ""
        print(f"Conversation release gate failed: {type(exc).__name__}{detail}", file=sys.stderr)
        sys.exit(1)
