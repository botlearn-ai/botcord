"""Real Postgres races and opt-in write-cost benchmark in disposable schemas."""
import asyncio
import datetime as dt
import json
import os
import re
import time
from pathlib import Path

import pytest
from sqlalchemy import event, select, text, update

from tests.test_conversation_cursor_postgres import database, sync, URL  # noqa: F401
from tests.test_app.test_conversation_sync import add_message
from hub.models import ConversationDirtyRoom, ConversationEntry, RoomMember
from hub.services.conversation_projection import project_pending

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(not URL, reason="requires disposable PostgreSQL")]


async def test_read_racing_new_message_keeps_new_message_unread(database):
    _, sessions, ctx, _ = database
    async with sessions() as db:
        await add_message(db, "rm_a", "old", 10)
        await db.commit()
    async with sessions() as reader:
        reader.sync_session.info["conversation_projecting"] = True
        await reader.execute(update(RoomMember).where(RoomMember.room_id == "rm_a")
            .values(last_viewed_at=dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=15)))
        await project_pending(reader)
        async def send():
            async with sessions() as writer:
                await add_message(writer, "rm_a", "new", 20)
                await writer.commit()
        task = asyncio.create_task(send())
        try:
            await asyncio.sleep(.05)
            assert not task.done()
            await reader.commit()
            await asyncio.wait_for(task, 10)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    result = await sync(sessions, ctx)
    row = next(r for r in result["upserts"] if r["room_id"] == "rm_a")
    assert row["unread_count"] == 1 and row["last_message_preview"] == "new"


async def test_raw_message_update_and_delete_replay_exactly_once(database):
    engine, sessions, ctx, _ = database
    async with sessions() as db:
        await add_message(db, "rm_a", "first", 10)
        await add_message(db, "rm_a", "second", 20)
        await db.commit()
    async with engine.begin() as conn:
        await conn.execute(text("UPDATE message_records SET recalled_at=now() WHERE msg_id='first'"))
        await conn.execute(text("DELETE FROM message_records WHERE msg_id='second'"))
    async with sessions() as db:
        db.sync_session.info["conversation_projecting"] = True
        assert await project_pending(db) == 1
        await db.commit()
        assert await project_pending(db) == 0
        row = await db.get(ConversationEntry, (ctx.user_id, "rm_a"))
        assert row.payload["unread_count"] == 0
        assert row.payload["last_message_preview"] == "Message recalled"


@pytest.mark.skipif(os.environ.get("CONVERSATION_WRITE_BENCHMARK") != "1", reason="explicit write benchmark")
async def test_write_cost_does_not_scale_with_history(database):
    engine, sessions, ctx, _ = database
    results = []
    for size in [1000, 100000]:
        # Fixture load bypasses capture only inside this disposable schema.
        # An explicit rebuild initializes the projection before measurements.
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE message_records DISABLE TRIGGER USER"))
            await conn.execute(text("DELETE FROM message_records WHERE room_id='rm_a'"))
            await conn.execute(text("""INSERT INTO message_records
                (hub_msg_id,msg_id,sender_id,receiver_id,room_id,state,envelope_json,ttl_sec,retry_count,mentioned,created_at)
                SELECT 'h_' || n,'m_' || n,'ag_bench','ag_sink','rm_a','delivered',
                    json_build_object('type','message','payload',json_build_object('text',repeat('x',1024)))::text,
                    3600,0,false,timestamp '2026-01-01' + n * interval '1 second'
                FROM generate_series(1,:size) n"""), {"size": size})
            await conn.execute(text("ALTER TABLE message_records ENABLE TRIGGER USER"))
            await conn.execute(text("UPDATE room_members SET last_viewed_at=NULL WHERE room_id='rm_a'"))
            await conn.execute(text("""INSERT INTO conversation_dirty_rooms (room_id,reasons) VALUES ('rm_a',8)
                ON CONFLICT (room_id) DO UPDATE SET reasons=8"""))
        async with sessions() as db:
            db.sync_session.info["conversation_projecting"] = True
            await project_pending(db)
            await db.commit()
        async with engine.begin() as conn:
            await conn.execute(text("ANALYZE message_records"))
            await conn.execute(text("ANALYZE conversation_messages"))
        statements = []
        def record(conn, cursor, sql, *args):
            statements.append(sql.lower())
        event.listen(engine.sync_engine, "before_cursor_execute", record)
        samples = []
        try:
            for i in range(5):
                statements.clear()
                start = time.perf_counter()
                async with sessions() as db:
                    for receiver in range(10):
                        async with db.begin_nested():
                            await add_message(db, "rm_a", f"send_{size}_{i}", size + i + 1, receiver=f"ag_{receiver}")
                    await db.commit()
                samples.append((time.perf_counter() - start) * 1000)
                source_queries = [s for s in statements if s.startswith('select') and
                    re.search(r'\bfrom\s+(?:"?\w+"?\.)?message_records\b', s)]
                assert len(source_queries) == 1
                assert 'msg_id =' in source_queries[0] and 'group by' not in source_queries[0]
            statements.clear()
            start = time.perf_counter()
            async with sessions() as db:
                before = await db.get(ConversationEntry, (ctx.user_id, "rm_a"))
                assert before.payload["unread_count"] == size + 5
                await db.execute(update(RoomMember).where(RoomMember.room_id == "rm_a")
                    .values(last_viewed_at=dt.datetime(2027, 1, 1, tzinfo=dt.timezone.utc)))
                await db.commit()
                row = await db.get(ConversationEntry, (ctx.user_id, "rm_a"), populate_existing=True)
                assert row.payload["unread_count"] == 0
            read_ms = (time.perf_counter() - start) * 1000
            assert not any(s.startswith('select') and ('message_records' in s or 'conversation_messages' in s) for s in statements)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", record)
        async with engine.connect() as conn:
            plan = (await conn.execute(text("""EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                SELECT id FROM message_records WHERE room_id='rm_a' AND msg_id=:msg
                AND coalesce(envelope_json::json->>'type','message') IN ('message','system')
                ORDER BY id LIMIT 1"""), {"msg": f"send_{size}_4"})).scalar()[0]["Plan"]
            latest_plan = (await conn.execute(text("""EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                SELECT * FROM conversation_messages WHERE room_id='rm_a'
                ORDER BY created_at DESC, canonical_id DESC LIMIT 1"""))).scalar()[0]["Plan"]
        for p in [plan, latest_plan]:
            assert p.get('Temp Written Blocks', 0) == 0
            assert p.get('Shared Hit Blocks', 0) + p.get('Shared Read Blocks', 0) < 100
        results.append({"historical_messages":size,"recipients":10,"samples":5,
            "send_median_ms":round(sorted(samples)[2],2),"mark_all_read_ms":round(read_ms,2),
            "source_lookups_per_send":1,"point_lookup_plan":plan,"latest_summary_plan":latest_plan})
    artifact={"database":"PostgreSQL 17, disposable local Docker schema", "scope":"service transactions, warm cache; not production SLA", "results":results}
    output=Path(os.environ.get("CONVERSATION_WRITE_BENCHMARK_OUTPUT", "/tmp/botcord-conversation-write-benchmark.json"))
    output.write_text(json.dumps(artifact,indent=2)+'\n')
    print(json.dumps(artifact))


async def test_upgrade_from_017_preserves_directory_and_installs_new_capture(database):
    from scripts.repair_conversation_capture import check_or_repair
    engine, sessions, ctx, schema = database
    async with sessions() as db:
        await add_message(db, "rm_a", "existing", 10)
        await db.commit()
    initial = await sync(sessions, ctx)
    migrations = Path(__file__).parents[1] / 'migrations'
    async with engine.begin() as conn:
        # Reconstruct the actual 017-only schema, not a fresh 018 schema with
        # CREATE IF NOT EXISTS statements that would hide missing-column bugs.
        await conn.execute(text('DROP TABLE conversation_messages, conversation_room_summaries, conversation_dirty_messages, conversation_dirty_readers'))
        await conn.execute(text('ALTER TABLE conversation_dirty_rooms DROP COLUMN reasons'))
        await conn.execute(text('ALTER TABLE conversation_entries DROP COLUMN read_member_id'))
        raw = await conn.get_raw_connection()
        for name in ['017_conversation_directory.sql','018_incremental_conversation_projection.sql']:
            sql = (migrations/name).read_text().replace('"public"."users"',f'"{schema}"."users"')
            await raw.driver_connection.execute(sql)
    async with engine.begin() as conn:
        await conn.run_sync(check_or_repair)
    async with sessions() as db:
        db.sync_session.info['conversation_projecting'] = True
        while await project_pending(db, limit=1):
            await db.commit()
    after = await sync(sessions, ctx, initial['next_cursor'])
    assert after['upserts'] == [] and after['next_cursor'] == initial['next_cursor']
    async with sessions() as db:
        await add_message(db, 'rm_a', 'incremental', 20)
        await db.commit()
        row = await db.get(ConversationEntry,(ctx.user_id,'rm_a'))
        assert row.payload['unread_count'] == 2
