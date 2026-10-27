"""Explicit maintenance-only capture check/repair; never changes migration ledger.

Use --check before deployment. --apply needs a quiet writer window and a DB
owner/DDL role; it atomically reinstalls capture/RLS and queues reconciliation.
It does not create missing tables or run unrelated migrations.
"""
import argparse
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import create_engine
from hub.services.conversation_capture import _validate_postgres_capture, capture_statements
from scripts.run_sql_migrations import _database_schema, _sync_dsn


def check_or_repair(connection, *, apply=False):
    schema = connection.exec_driver_sql("SELECT current_schema()").scalar()
    if not schema:
        raise RuntimeError("Target schema does not exist; apply the schema migrations first")
    user_schema = connection.get_execution_options().get("schema_translate_map", {}).get("public", "public")
    suffix = "_" + hashlib.md5(schema.encode()).hexdigest()[:8]
    if apply:
        quote = connection.dialect.identifier_preparer.quote_identifier
        # Strongest locks up front, not an outbox lock upgrade after triggers.
        # Writers can still conflict: arrange a quiet maintenance window.
        tables = sorted({(schema, t) for t in (
            "rooms", "room_members", "message_records", "agents",
            "conversation_dirty_rooms", "conversation_accounts",
            "conversation_entries", "conversation_changes",
        )} | {(user_schema, "users")})
        targets = ", ".join(f"{quote(s)}.{quote(t)}" for s, t in tables)
        connection.exec_driver_sql(f"LOCK TABLE {targets} IN ACCESS EXCLUSIVE MODE")
        for statement in capture_statements("postgresql", user_table=f'{quote(user_schema)}."users"', suffix=suffix):
            connection.exec_driver_sql(statement)
        connection.exec_driver_sql("""
            INSERT INTO conversation_dirty_rooms (room_id, generation)
            SELECT room_id, 1 FROM (SELECT room_id FROM rooms WHERE space_id IS NULL
                UNION SELECT room_id FROM conversation_entries) AS pending
            ON CONFLICT (room_id) DO UPDATE SET generation = conversation_dirty_rooms.generation + 1
        """)
    _validate_postgres_capture(connection, schema, user_schema, suffix)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    schema = _database_schema()
    engine = create_engine(_sync_dsn())
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("SET LOCAL lock_timeout = '5s'")
            connection.exec_driver_sql("SET LOCAL statement_timeout = '60s'")
            if schema:
                quote = connection.dialect.identifier_preparer.quote_identifier
                connection.exec_driver_sql(f"SET LOCAL search_path TO {quote(schema)}, public")
                if connection.exec_driver_sql("SELECT current_schema()").scalar() != schema:
                    raise RuntimeError("Configured DATABASE_SCHEMA does not exist; refusing to fall back to public")
            check_or_repair(connection, apply=args.apply)
        print("Conversation capture repaired and verified" if args.apply else "Conversation capture verified")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
