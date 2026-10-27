"""Real PostgreSQL locks, triggers and repeatable migration in isolated schemas.

CONVERSATION_TEST_DATABASE_URL=postgresql+asyncpg://... uv run pytest tests/test_conversation_cursor_postgres.py
"""
import asyncio
import os
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.auth import RequestContext
from app.routers.conversations import ConversationSyncRequest, sync_conversations
from hub.models import Base, ConversationAccount, ConversationDirtyRoom, Room, User
from hub.services.conversation_projection import project_pending
from tests.test_app.test_conversation_sync import add_message, add_room

URL = os.environ.get("CONVERSATION_TEST_DATABASE_URL")
pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(not URL, reason="requires disposable PostgreSQL")]


@pytest_asyncio.fixture
async def database():
    schema = "conversation_test_" + uuid.uuid4().hex
    admin = create_async_engine(URL)
    async with admin.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(URL, connect_args={"server_settings": {"search_path": schema, "statement_timeout": "30000"}},
        execution_options={"schema_translate_map": {"public": schema}})
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as db:
            user = User(id=uuid.uuid4(), supabase_user_id=uuid.uuid4(), human_id="hu_cursor", display_name="Cursor")
            db.add(user)
            await db.flush()
            await add_room(db, "rm_a", [user.human_id])
            await add_room(db, "rm_b", [user.human_id])
            await db.commit()
            ctx = RequestContext(user_id=user.id, supabase_user_id=str(user.supabase_user_id), human_id=user.human_id)
        yield engine, sessions, ctx, schema
    finally:
        await engine.dispose()
        async with admin.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()


async def sync(sessions, ctx, cursor=None):
    async with sessions() as db:
        return await sync_conversations(ConversationSyncRequest(cursor=cursor), ctx, db)


async def test_concurrent_commit_order_cannot_skip_a_delayed_transaction(database):
    engine, sessions, ctx, _ = database
    initial = await sync(sessions, ctx)
    async with sessions() as first:
        first.sync_session.info["conversation_projecting"] = True
        await add_message(first, "rm_a", "first", 10)
        await project_pending(first)  # holds the account's version lock
        started = asyncio.Event()
        async def second_writer():
            async with sessions() as second:
                await add_message(second, "rm_b", "second", 20)
                started.set()
                await second.commit()
        task = asyncio.create_task(second_writer())
        try:
            await asyncio.wait_for(started.wait(), 5)
            await asyncio.sleep(0.05)
            assert not task.done(), "later version must wait for the previous account transaction"
            during = await sync(sessions, ctx, initial["next_cursor"])
            assert during["upserts"] == []
            await first.commit()
            await asyncio.wait_for(task, 10)
        finally:
            if not task.done():
                task.cancel()
    after = await sync(sessions, ctx, initial["next_cursor"])
    assert {r["room_id"] for r in after["upserts"]} == {"rm_a", "rm_b"}
    assert (await sync(sessions, ctx, after["next_cursor"]))["upserts"] == []


async def test_rollback_and_raw_sql_recovery_preserve_outbox(database):
    engine, sessions, ctx, _ = database
    initial = await sync(sessions, ctx)
    async with engine.connect() as conn:
        tx = await conn.begin()
        await conn.execute(text("UPDATE rooms SET name='aborted' WHERE room_id='rm_a'"))
        await tx.rollback()
    assert (await sync(sessions, ctx, initial["next_cursor"]))["upserts"] == []
    # Direct SQL has no ORM hook, but the trigger persists its invalidation.
    async with engine.begin() as conn:
        await conn.execute(text("UPDATE rooms SET name='external change' WHERE room_id='rm_a'"))
    async with sessions() as db:
        assert (await db.execute(select(ConversationDirtyRoom.room_id))).scalars().all() == ["rm_a"]
        await project_pending(db)
        await db.commit()
    changed = await sync(sessions, ctx, initial["next_cursor"])
    assert changed["upserts"][0]["name"] == "external change"


async def test_migration_is_repeatable_and_backfill_preserves_cursors(database):
    engine, sessions, ctx, schema = database
    initial = await sync(sessions, ctx)
    sql = (Path(__file__).parents[1] / "migrations/017_conversation_directory.sql").read_text()
    sql = sql.replace('"public"."users"', f'"{schema}"."users"')
    async with engine.begin() as conn:
        raw = await conn.get_raw_connection()
        for _ in range(2):
            await raw.driver_connection.execute(sql)
    async with sessions() as db:
        await project_pending(db)
        await db.commit()
    after = await sync(sessions, ctx, initial["next_cursor"])
    assert after["upserts"] == [] and after["next_cursor"] == initial["next_cursor"]
    async with engine.connect() as conn:
        count = (await conn.execute(text("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'conversation_rooms_update%' AND tgrelid = 'rooms'::regclass"))).scalar()
        assert count == 1, "fresh schema + migration must not install duplicate triggers"


async def test_writer_racing_outbox_delete_is_not_lost(database):
    engine, sessions, ctx, _ = database
    initial = await sync(sessions, ctx)
    async with engine.begin() as conn:
        await conn.execute(text("UPDATE rooms SET name='first' WHERE room_id='rm_a'"))
    async with sessions() as worker:
        worker.sync_session.info["conversation_projecting"] = True
        await project_pending(worker)
        async def raw_writer():
            async with engine.begin() as conn:
                await conn.execute(text("UPDATE rooms SET name='second' WHERE room_id='rm_a'"))
        task = asyncio.create_task(raw_writer())
        try:
            await asyncio.sleep(0.05)
            assert not task.done()
            await worker.commit()
            await asyncio.wait_for(task, 10)
        finally:
            if not task.done(): task.cancel()
    async with sessions() as worker:
        assert (await worker.execute(select(ConversationDirtyRoom.room_id))).scalars().all() == ["rm_a"]
        await project_pending(worker)
        await worker.commit()
    changed = await sync(sessions, ctx, initial["next_cursor"])
    assert changed["upserts"][0]["name"] == "second"


@pytest.mark.skipif(os.environ.get("CONVERSATION_BENCHMARK") != "1", reason="explicit performance fixture")
async def test_cursor_query_benchmark(database):
    import json
    import math
    import time
    from sqlalchemy import event
    from hub.services.conversation_projection import conversation_summaries
    engine, sessions, ctx, _ = database
    async with sessions() as db:
        for i in range(98):
            await add_room(db, f"rm_bench_{i:03}", [ctx.human_id])
        await db.execute(text("""INSERT INTO message_records
            (hub_msg_id, msg_id, sender_id, receiver_id, room_id, state, envelope_json,
             ttl_sec, retry_count, mentioned, created_at)
            SELECT 'bench_' || r.room_id || '_' || n, 'm_' || r.room_id || '_' || n,
                'ag_bench', 'ag_sink', r.room_id, 'delivered',
                json_build_object('type', 'message', 'payload', json_build_object('text', 'message ' || n))::text,
                3600, 0, false, timestamp '2026-01-01' + n * interval '1 second'
            FROM rooms r CROSS JOIN generate_series(1, 1000) n"""))
        await db.commit()
    async with engine.begin() as conn:
        await conn.execute(text("ANALYZE message_records"))
        await conn.execute(text("ANALYZE conversation_entries"))
        await conn.execute(text("ANALYZE conversation_changes"))
    initial = await sync(sessions, ctx)
    assert len(initial["upserts"]) == 100
    statements = []
    def record(conn, cursor, sql, *args): statements.append(sql.lower())
    event.listen(engine.sync_engine, "before_cursor_execute", record)
    results = {}
    async def measure(name, operation, expected=None):
        for _ in range(2): await operation()
        statements.clear()
        times = []
        for _ in range(20):
            start = time.perf_counter()
            result = await operation()
            times.append((time.perf_counter() - start) * 1000)
            if expected is not None: assert len(result["upserts"]) == expected
        results[name] = {"p50_ms": round(sorted(times)[10], 2), "p95_ms": round(sorted(times)[math.ceil(len(times)*.95)-1], 2),
            "sql_per_call": len(statements)//20, "history_queries_per_call": sum("message_records" in s for s in statements)//20}
    try:
        async def baseline():
            async with sessions() as db:
                return await conversation_summaries(db, ctx)
        await measure("full_projection_baseline", baseline)
        await measure("snapshot_first_page", lambda: sync(sessions, ctx), 100)
        await measure("cursor_no_change", lambda: sync(sessions, ctx, initial["next_cursor"]), 0)
        write_started = time.perf_counter()
        async with sessions() as db:
            await add_message(db, "rm_a", "fresh", 2000)
            await db.commit()
        write_ms = round((time.perf_counter() - write_started) * 1000, 2)
        await measure("cursor_one_changed_room", lambda: sync(sessions, ctx, initial["next_cursor"]), 1)
        assert results["cursor_no_change"]["history_queries_per_call"] == 0
        assert results["cursor_one_changed_room"]["history_queries_per_call"] == 0
        async with engine.connect() as conn:
            plan = (await conn.execute(text("""EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                SELECT room_id, version FROM conversation_changes
                WHERE user_id = CAST(:user AS uuid) AND version > 100 AND version <= 101
                ORDER BY version LIMIT 101"""), {"user": str(ctx.user_id)})).scalar()
        artifact = {"database": "PostgreSQL 16 in local Docker", "rooms": 100, "historical_messages": 100000,
            "samples_per_scenario": 20, "single_room_write_with_projection_ms": write_ms, "scope": "SQLAlchemy service reads including session open/close; excludes HTTP/auth/browser; warm database cache", "results": results, "delta_explain": plan}
        output = Path(__file__).parents[2] / "docs/conversation-cursor-benchmark.json"
        output.write_text(json.dumps(artifact, indent=2) + "\n")
        print(json.dumps(results))
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)


async def test_upgrade_from_old_schema_backfills_and_resets_prior_epoch(database):
    engine, sessions, ctx, schema = database
    initial = await sync(sessions, ctx)
    sql = (Path(__file__).parents[1] / "migrations/017_conversation_directory.sql").read_text()
    sql = sql.replace('"public"."users"', f'"{schema}"."users"')
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE conversation_changes, conversation_entries, conversation_accounts, conversation_dirty_rooms"))
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(sql)
    async with sessions() as db:
        assert await project_pending(db) == 2
        await db.commit()
    result = await sync(sessions, ctx, initial["next_cursor"])
    assert result["reset"] is True
    assert {r["room_id"] for r in result["upserts"]} == {"rm_a", "rm_b"}


async def test_normal_send_does_not_drain_unrelated_backfill(database):
    engine, sessions, ctx, _ = database
    initial = await sync(sessions, ctx)
    async with engine.begin() as conn:
        await conn.execute(text("UPDATE rooms SET name='pending recovery' WHERE room_id='rm_a'"))
    async with sessions() as db:
        await add_message(db, "rm_b", "ordinary-send", 10)
        await db.commit()
        assert (await db.execute(select(ConversationDirtyRoom.room_id))).scalars().all() == ["rm_a"]
    changed = await sync(sessions, ctx, initial["next_cursor"])
    assert [r["room_id"] for r in changed["upserts"]] == ["rm_b"]
    async with sessions() as db:
        await project_pending(db)
        await db.commit()
    recovered = await sync(sessions, ctx, changed["next_cursor"])
    assert recovered["upserts"][0]["name"] == "pending recovery"


async def test_private_summaries_are_not_exposed_to_direct_database_clients(database):
    engine, _, _, schema = database
    role = "conversation_client_" + uuid.uuid4().hex
    async with engine.begin() as conn:
        await conn.execute(text(f'CREATE ROLE "{role}" NOLOGIN'))
        try:
            await conn.execute(text(f'GRANT USAGE ON SCHEMA "{schema}" TO "{role}"'))
            await conn.execute(text(f'GRANT SELECT ON conversation_entries, conversation_changes, conversation_accounts, conversation_dirty_rooms TO "{role}"'))
            assert (await conn.execute(text("SELECT count(*) FROM conversation_entries"))).scalar() == 2
            await conn.execute(text(f'SET LOCAL ROLE "{role}"'))
            for table in ("conversation_entries", "conversation_changes", "conversation_accounts", "conversation_dirty_rooms"):
                assert (await conn.execute(text(f"SELECT count(*) FROM {table}"))).scalar() == 0
            await conn.execute(text("RESET ROLE"))
        finally:
            await conn.execute(text("RESET ROLE"))
            await conn.execute(text(f'DROP OWNED BY "{role}"'))
            await conn.execute(text(f'DROP ROLE "{role}"'))


async def test_restart_does_not_lock_live_capture_tables(database):
    """A projector may hold dirty-room locks while reading source relations."""
    from sqlalchemy import event
    engine, _, _, _ = database
    statements = []
    def record(conn, cursor, sql, *args):
        statements.append(sql)
    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        async with engine.begin() as writer:
            await writer.execute(text("LOCK TABLE conversation_dirty_rooms IN ROW EXCLUSIVE MODE"))
            async with engine.begin() as startup:
                await startup.execute(text("SET LOCAL lock_timeout = '200ms'"))
                await startup.run_sync(Base.metadata.create_all)
            await writer.execute(text("SELECT count(*) FROM rooms"))
        assert not any(s.lstrip().upper().startswith(("CREATE ", "DROP ", "ALTER ")) for s in statements)
        assert engine.sync_engine._conversation_capture_installed
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)


@pytest.mark.parametrize("drift", ["rls", "trigger", "function"])
async def test_restart_fails_closed_on_capture_drift_and_migration_repairs(database, drift):
    import hashlib
    engine, _, _, schema = database
    suffix = "_" + hashlib.md5(schema.encode()).hexdigest()[:8]
    async with engine.begin() as conn:
        if drift == "rls":
            await conn.execute(text("ALTER TABLE conversation_dirty_rooms DISABLE ROW LEVEL SECURITY"))
        elif drift == "trigger":
            await conn.execute(text(f"ALTER TABLE rooms DISABLE TRIGGER conversation_rooms_update{suffix}"))
        else:
            await conn.execute(text(f"CREATE OR REPLACE FUNCTION conversation_rooms_update{suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$"))
    with pytest.raises(RuntimeError, match="repair_conversation_capture"):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    sql = (Path(__file__).parents[1] / "migrations/017_conversation_directory.sql").read_text()
    sql = sql.replace('"public"."users"', f'"{schema}"."users"')
    async with engine.begin() as conn:
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(sql)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)



@pytest.mark.parametrize("drift", ["update_columns", "stable", "immutable"])
async def test_restart_rejects_capture_semantic_drift_and_repair_restores_writes(database, drift):
    import hashlib
    from sqlalchemy.exc import DBAPIError
    from scripts.repair_conversation_capture import check_or_repair

    engine, _, _, schema = database
    name = "conversation_rooms_update_" + hashlib.md5(schema.encode()).hexdigest()[:8]
    async with engine.begin() as conn:
        if drift == "update_columns":
            await conn.exec_driver_sql(f"DROP TRIGGER {name} ON rooms")
            await conn.exec_driver_sql(
                f"CREATE TRIGGER {name} AFTER UPDATE OF name ON rooms "
                f"FOR EACH ROW EXECUTE FUNCTION {name}()"
            )
            await conn.exec_driver_sql("DELETE FROM conversation_dirty_rooms")
            await conn.exec_driver_sql("UPDATE rooms SET description = 'missed' WHERE room_id = 'rm_a'")
            assert (await conn.exec_driver_sql("SELECT count(*) FROM conversation_dirty_rooms")).scalar() == 0
        else:
            await conn.exec_driver_sql(f"ALTER FUNCTION {name}() {drift.upper()}")
    if drift != "update_columns":
        with pytest.raises(DBAPIError, match="INSERT is not allowed in a non-volatile function"):
            async with engine.begin() as conn:
                await conn.exec_driver_sql("UPDATE rooms SET description = 'blocked' WHERE room_id = 'rm_a'")

    with pytest.raises(RuntimeError, match="repair_conversation_capture"):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    with pytest.raises(RuntimeError, match="repair_conversation_capture"):
        async with engine.begin() as conn:
            await conn.run_sync(check_or_repair)

    async with engine.begin() as conn:
        await conn.run_sync(lambda c: check_or_repair(c, apply=True))
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Remove repair's reconciliation rows to prove this write is captured.
        await conn.exec_driver_sql("DELETE FROM conversation_dirty_rooms")
        await conn.exec_driver_sql("UPDATE rooms SET description = 'repaired' WHERE room_id = 'rm_a'")
        assert (await conn.exec_driver_sql("SELECT room_id FROM conversation_dirty_rooms")).scalars().all() == ["rm_a"]


async def test_repair_is_atomic_and_accepts_equivalent_search_path(database):
    from scripts.repair_conversation_capture import check_or_repair
    engine, _, _, schema = database
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE conversation_dirty_rooms DISABLE ROW LEVEL SECURITY"))
    async with engine.connect() as conn:
        tx = await conn.begin()
        await conn.run_sync(lambda c: check_or_repair(c, apply=True))
        await tx.rollback()
    with pytest.raises(RuntimeError, match="repair_conversation_capture"):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    async with engine.begin() as conn:
        await conn.execute(text(f'SET LOCAL search_path TO "{schema}", public'))
        await conn.run_sync(lambda c: check_or_repair(c, apply=True))
    async with engine.begin() as conn:
        await conn.execute(text("SELECT set_config('search_path', :path, true)"), {"path": f"{schema},public"})
        await conn.run_sync(Base.metadata.create_all)


async def test_prepare_schema_retries_entire_deadlocked_transaction(database):
    from sqlalchemy import event
    from hub.services.schema_startup import prepare_schema
    engine, _, _, _ = database
    attempts = []
    def transient(metadata, connection, **kwargs):
        attempts.append(1)
        connection.exec_driver_sql("UPDATE rooms SET name = name || '-attempt' WHERE room_id = 'rm_a'")
        if len(attempts) == 1:
            connection.exec_driver_sql("DO $$ BEGIN RAISE EXCEPTION 'test retry' USING ERRCODE = '40P01'; END $$")
    event.listen(Base.metadata, "after_create", transient)
    try:
        await prepare_schema(engine, Base.metadata)
    finally:
        event.remove(Base.metadata, "after_create", transient)
    assert len(attempts) == 2
    async with engine.connect() as conn:
        name = (await conn.execute(text("SELECT name FROM rooms WHERE room_id = 'rm_a'"))).scalar()
        assert name.endswith("-attempt") and not name.endswith("-attempt-attempt")
    assert engine.sync_engine._conversation_capture_installed


async def test_previous_reinstall_order_can_deadlock_a_reader(database):
    """Controlled lock cycle; not an attribution of the production peer SQL."""
    import hashlib
    from sqlalchemy.exc import DBAPIError
    from hub.services.conversation_capture import capture_statements
    engine, _, _, schema = database
    suffix = '_' + hashlib.md5(schema.encode()).hexdigest()[:8]
    dirty_locked, source_locked = asyncio.Event(), asyncio.Event()
    async def projector():
        async with engine.begin() as conn:
            await conn.execute(text('LOCK TABLE conversation_dirty_rooms IN ROW EXCLUSIVE MODE'))
            dirty_locked.set()
            await source_locked.wait()
            await conn.execute(text('SELECT count(*) FROM users'))
    async def previous_startup():
        await dirty_locked.wait()
        async with engine.begin() as conn:
            for statement in capture_statements('postgresql', user_table=f'"{schema}"."users"', suffix=suffix):
                if statement.startswith('ALTER TABLE conversation_dirty_rooms'):
                    source_locked.set()
                await conn.exec_driver_sql(statement)
    results = await asyncio.wait_for(asyncio.gather(projector(), previous_startup(), return_exceptions=True), 10)
    failures = [r for r in results if isinstance(r, DBAPIError)]
    assert len(failures) == 1
    assert failures[0].orig.sqlstate == '40P01'


async def test_check_and_repair_preserve_ledger(database):
    from scripts.repair_conversation_capture import check_or_repair
    engine, sessions, ctx, _ = database
    initial = await sync(sessions, ctx)
    async with engine.begin() as conn:
        await conn.execute(text('CREATE TABLE _botcord_schema_migrations (version text PRIMARY KEY)'))
        await conn.execute(text("INSERT INTO _botcord_schema_migrations VALUES ('017_conversation_directory.sql')"))
    async with engine.begin() as conn:
        await conn.execute(text('SET TRANSACTION READ ONLY'))
        await conn.run_sync(check_or_repair)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: check_or_repair(c, apply=True))
        assert (await conn.execute(text('SELECT version FROM _botcord_schema_migrations'))).scalars().all() == ['017_conversation_directory.sql']

    async with sessions() as db:
        assert await project_pending(db, own_transaction=True) == 0
        assert await project_pending(db) == 2
        await db.commit()
    after = await sync(sessions, ctx, initial["next_cursor"])
    assert after["upserts"] == [] and after["next_cursor"] == initial["next_cursor"]


async def test_fresh_schema_with_separate_user_schema_and_new_engine_restart():
    source, users = 'capture_' + uuid.uuid4().hex, 'users_' + uuid.uuid4().hex
    admin = create_async_engine(URL)
    async with admin.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{source}"'))
        await conn.execute(text(f'CREATE SCHEMA "{users}"'))
    def new_engine():
        return create_async_engine(URL, connect_args={'server_settings': {'search_path': f'{source},public'}},
            execution_options={'schema_translate_map': {'public': users}})
    first, second = new_engine(), new_engine()
    try:
        from hub.services.schema_startup import prepare_schema
        await prepare_schema(first, Base.metadata)
        assert not getattr(second.sync_engine, '_conversation_capture_installed', False)
        await prepare_schema(second, Base.metadata)
        assert second.sync_engine._conversation_capture_installed
    finally:
        await first.dispose()
        await second.dispose()
        async with admin.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA "{source}" CASCADE'))
            await conn.execute(text(f'DROP SCHEMA "{users}" CASCADE'))
        await admin.dispose()
