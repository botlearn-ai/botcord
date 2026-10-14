"""Optional real PostgreSQL migration/locking checks in an isolated schema.

Run with RESPONSE_STATE_TEST_DATABASE_URL=postgresql+asyncpg://... pytest ...
"""
import asyncio
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from hub.models import Agent, Base, MessageRecord, MessageResponseEvent, MessageState
from fastapi import HTTPException
from hub.schemas import MessageEnvelope
from hub.services.message_responses import ResponseRunUpdate, record_response, update_run

URL = os.environ.get("RESPONSE_STATE_TEST_DATABASE_URL")
pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(not URL, reason="requires disposable PostgreSQL")]


async def test_migration_is_repeatable_and_concurrent_reports_are_idempotent():
    schema = "response_test_" + uuid.uuid4().hex
    admin = create_async_engine(URL)
    async with admin.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(URL,
        connect_args={"server_settings": {"search_path": schema}},
        execution_options={"schema_translate_map": {"public": schema}})
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            # Simulate upgrading the old schema rather than create_all alone.
            await conn.execute(text("DROP TABLE message_response_events"))
            for column in ["response_state", "response_reason", "response_updated_at"]:
                await conn.execute(text(f"ALTER TABLE message_records DROP COLUMN {column}"))
            await conn.execute(text("INSERT INTO message_records (hub_msg_id, msg_id, sender_id, receiver_id, envelope_json, ttl_sec, state, retry_count, mentioned, response_status) VALUES ('old', 'old', 'hu_old', 'ag_old', '{}', 3600, 'delivered', 0, false, 'no_reply')"))
        sql = (Path(__file__).parents[1] / "migrations/015_message_response_states.sql").read_text()
        async with engine.connect() as conn:
            raw = await conn.get_raw_connection()
            for _ in range(2):
                await raw.driver_connection.execute(sql)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as db:
            old = (await db.execute(select(MessageRecord).where(MessageRecord.msg_id == "old"))).scalar_one()
            assert old.response_status == "no_reply" and old.response_state is None
            db.add(Agent(agent_id="ag_data_test", display_name="Test"))
            db.add(MessageRecord(hub_msg_id="h1", msg_id="m1", sender_id="hu_test",
                receiver_id="ag_data_test", room_id="rm_test", envelope_json='{}',
                ttl_sec=3600, state=MessageState.delivered))
            await db.commit()

        async def report(action):
            async with sessions() as db:
                await update_run(db, "ag_data_test", ResponseRunUpdate(
                    run_id="run1", room_id="rm_test", action=action, message_ids=["m1"]))
                await db.commit()

        for action in ["queue", "register", "start", "no_reply"]:
            await asyncio.wait_for(asyncio.gather(*(report(action) for _ in range(4))), timeout=15)
        async with sessions() as db:
            events = (await db.execute(select(MessageResponseEvent).order_by(MessageResponseEvent.id))).scalars().all()
            assert [e.state for e in events] == ["queued", "waiting", "processing", "no_reply"]
            row = (await db.execute(select(MessageRecord).where(MessageRecord.msg_id == "m1"))).scalar_one()
            assert row.response_state == "no_reply"
        # A send may already have loaded its quote target before another
        # transaction resolves it. Locked reads must refresh that cached row.
        async with sessions() as db:
            db.add(MessageRecord(hub_msg_id="h2", msg_id="m2", sender_id="hu_test",
                receiver_id="ag_data_test", room_id="rm_test", envelope_json='{}',
                ttl_sec=3600, state=MessageState.delivered))
            await db.commit()
            await update_run(db, "ag_data_test", ResponseRunUpdate(
                run_id="run2", room_id="rm_test", action="register", message_ids=["m2"]))
            await db.commit()
        async with sessions() as stale:
            cached = (await stale.execute(select(MessageRecord).where(MessageRecord.msg_id == "m2"))).scalar_one()
            assert cached.response_state == "waiting"
            async with sessions() as deciding:
                await update_run(deciding, "ag_data_test", ResponseRunUpdate(
                    run_id="run2", room_id="rm_test", action="ignore", message_ids=["m2"]))
                await deciding.commit()
            envelope = MessageEnvelope(msg_id="reply2", ts=1, type="message", **{"from": "ag_data_test"}, to="rm_test",
                payload={"text": "answer", "response": {"run_id": "run2", "kind": "final", "responds_to": ["m2"]}},
                payload_hash="hash", sig={"key_id": "key", "value": "sig"})
            with pytest.raises(HTTPException) as error:
                await record_response(stale, envelope, "rm_test")
            assert error.value.status_code == 409
            assert cached.response_state == "ignored"
    finally:
        await engine.dispose()
        async with admin.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()
