"""Exercise the exact release gate and recovery DDL in disposable PG schemas."""
import json
import os
import uuid
from pathlib import Path

import psycopg2
import pytest
from sqlalchemy import text

from scripts import conversation_release_gate as gate
from tests.test_conversation_cursor_postgres import database, URL
from hub.services.conversation_projection import project_pending

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(not URL, reason="requires disposable PostgreSQL")]


@pytest.mark.parametrize("has_baseline", [True, False])
async def test_fixed_gate_upgrades_and_restores_017_capture(database, tmp_path, has_baseline):
    engine, sessions, ctx, schema = database
    migrations = Path(__file__).parents[1] / "migrations"
    async with engine.begin() as connection:
        await connection.execute(text("DROP TABLE conversation_messages,conversation_room_summaries,conversation_dirty_messages,conversation_dirty_readers"))
        await connection.execute(text("ALTER TABLE conversation_dirty_rooms DROP COLUMN reasons"))
        await connection.execute(text("ALTER TABLE conversation_entries DROP COLUMN read_member_id"))
        raw = await connection.get_raw_connection()
        sql = (migrations / "017_conversation_directory.sql").read_text().replace('"public"."users"', f'"{schema}"."users"')
        await raw.driver_connection.execute(sql)
        await connection.execute(text("CREATE TABLE _botcord_schema_migrations(version text PRIMARY KEY)"))
        await connection.execute(text("INSERT INTO _botcord_schema_migrations VALUES ('016_space_knowledge_base.sql')"))
        if has_baseline:
            await connection.execute(text("INSERT INTO _botcord_schema_migrations VALUES ('017_conversation_directory.sql')"))
    conn = psycopg2.connect(URL.replace("postgresql+asyncpg://", "postgresql://", 1))
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(f'SET search_path TO "{schema}",public')
        assert gate.preflight(conn, schema)["needs_migration"]
        state = tmp_path / "capture.json"
        gate.snapshot(conn, schema, state)
        assert state.stat().st_mode & 0o777 == 0o600
        before = json.loads(state.read_text())
        with pytest.raises(FileExistsError):
            gate.snapshot(conn, schema, state)
        migration = tmp_path / gate.MIGRATION
        migration.write_text((migrations / gate.MIGRATION).read_text().replace('"public"."users"', f'"{schema}"."users"'))
        if not has_baseline:
            baseline = tmp_path / gate.BASELINE
            baseline.write_text((migrations / gate.BASELINE).read_text().replace('"public"."users"', f'"{schema}"."users"'))
            gate.apply_migration(conn, baseline)
        gate.apply_migration(conn, migration)
        async with sessions() as db:
            db.sync_session.info["conversation_projecting"] = True
            while await project_pending(db, limit=1):
                await db.commit()
            await db.commit()
        assert gate.verify(conn, state)["epochs_preserved"]
        with conn.cursor() as cur:
            cur.execute("INSERT INTO conversation_accounts(user_id,epoch,version,floor) VALUES (%s,'new-account',0,0)", (str(uuid.uuid4()),))
        assert gate.verify(conn, state)["epochs_preserved"]
        with conn.cursor() as cur:
            cur.execute("SELECT epoch FROM conversation_accounts WHERE user_id=%s", (str(ctx.user_id),))
            original_epoch = cur.fetchone()[0]
            cur.execute("UPDATE conversation_accounts SET epoch='unexpected-reset' WHERE user_id=%s", (str(ctx.user_id),))
        with pytest.raises(gate.GateError, match="cursor epochs changed"):
            gate.verify(conn, state)
        with conn.cursor() as cur:
            cur.execute("UPDATE conversation_accounts SET epoch=%s WHERE user_id=%s", (original_epoch, str(ctx.user_id)))
        with conn.cursor() as cur:
            cur.execute("SELECT version FROM _botcord_schema_migrations ORDER BY version")
            assert cur.fetchall()[-1][0] == gate.MIGRATION
        gate.restore(conn, schema, state)
        restored = tmp_path / "restored.json"
        gate.snapshot(conn, schema, restored)
        after = json.loads(restored.read_text())
        assert after["functions"] == before["functions"]
        assert after["triggers"] == before["triggers"]
        assert not after["had_migration"]
        assert after["had_baseline"] == has_baseline
        # Retrying after rollback installs 018 again and retains the epoch.
        gate.apply_migration(conn, migration)
        async with sessions() as db:
            db.sync_session.info["conversation_projecting"] = True
            while await project_pending(db, limit=1):
                await db.commit()
            await db.commit()
        assert gate.verify(conn, state)["epochs_preserved"]
    finally:
        conn.close()


async def test_fixed_gate_refuses_database_without_017_ledger(database):
    engine, _, _, schema = database
    async with engine.begin() as connection:
        await connection.execute(text("CREATE TABLE _botcord_schema_migrations(version text PRIMARY KEY)"))
    conn = psycopg2.connect(URL.replace("postgresql+asyncpg://", "postgresql://", 1))
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(f'SET search_path TO "{schema}",public')
        with pytest.raises(RuntimeError, match="requires migration 016 or 017"):
            gate.preflight(conn, schema)
    finally:
        conn.close()
