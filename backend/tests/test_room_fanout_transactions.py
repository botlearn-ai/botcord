"""Transaction and delivery-ID coverage for agent room fanout."""

import asyncio
import os
import uuid
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from sqlalchemy import event, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from hub.models import Base, ConversationMessage, MessageRecord, Room, RoomMember, RoomRole
from hub.routers import hub
from hub.schemas import MessageEnvelope

ROOM_ID = "rm_fanout"
SENDER_ID = "ag_sender"
RECEIVERS = [f"ag_receiver_{index}" for index in range(9)]


@pytest_asyncio.fixture(params=["sqlite", "postgresql"])
async def database(request):
    url = "sqlite+aiosqlite:///:memory:"
    options = {}
    admin = None
    if request.param == "postgresql":
        url = os.environ.get("ROOM_FANOUT_TEST_DATABASE_URL")
        if not url:
            pytest.skip("requires disposable PostgreSQL")
        schema = "room_fanout_" + uuid.uuid4().hex
        admin = create_async_engine(url)
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        options = {
            "connect_args": {"server_settings": {"search_path": schema, "statement_timeout": "5000"}},
            "execution_options": {"schema_translate_map": {"public": schema}},
        }

    engine = create_async_engine(url, **options)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions.begin() as db:
            db.add(Room(
                room_id=ROOM_ID, name="Fanout", owner_id=SENDER_ID,
                members=[
                    RoomMember(agent_id=SENDER_ID, role=RoomRole.owner),
                    *(RoomMember(agent_id=receiver) for receiver in RECEIVERS),
                ],
            ))
        sql = []

        @event.listens_for(engine.sync_engine, "before_cursor_execute")
        def record_statement(_conn, _cursor, statement, _parameters, _context, _executemany):
            sql.append(statement.upper())

        yield sessions, sql, request.param
    finally:
        await engine.dispose()
        if admin:
            async with admin.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
            await admin.dispose()


@pytest.fixture
def sender(monkeypatch, database):
    sessions, _, _ = database
    envelope = MessageEnvelope(
        msg_id=str(uuid.uuid4()), ts=0, from_=SENDER_ID, to=ROOM_ID, type="message",
        payload={"text": "Fanout body"}, payload_hash="", sig={"key_id": "", "value": ""},
        mentions=[RECEIVERS[0]],
    )
    notify = AsyncMock()
    publish = AsyncMock()
    bump = AsyncMock(return_value={RECEIVERS[0]})
    monkeypatch.setattr(hub, "_check_duplicate_content", lambda *_: None)
    monkeypatch.setattr(hub, "notify_inbox", notify)
    monkeypatch.setattr(hub, "_publish_agent_realtime_event", publish)
    monkeypatch.setattr(hub, "maybe_bump_for_inbound_many", bump)

    async def send():
        async with sessions() as db:
            return await hub._send_room_message(envelope, None, db)

    return envelope, send, notify, publish, bump


def existing_record(envelope, receiver_id, hub_msg_id):
    return MessageRecord(
        hub_msg_id=hub_msg_id, msg_id=envelope.msg_id, sender_id=SENDER_ID,
        receiver_id=receiver_id, room_id=ROOM_ID,
        envelope_json=envelope.model_dump_json(by_alias=True), ttl_sec=envelope.ttl_sec,
        mentioned=receiver_id in envelope.mentions,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("partial", [False, True])
async def test_room_fanout_returns_persisted_ids_on_send_and_retry(database, sender, partial):
    sessions, sql, _ = database
    envelope, send, notify, publish, bump = sender
    if partial:
        async with sessions.begin() as db:
            db.add(existing_record(envelope, RECEIVERS[0], "previously-persisted-id"))
    sql.clear()

    response = await send()
    retry = await send()

    async with sessions() as db:
        rows = (await db.scalars(select(MessageRecord))).all()
        projected = (await db.scalars(select(ConversationMessage))).one()
    ids = {row.receiver_id: row.hub_msg_id for row in rows}
    assert len(rows) == 9
    assert set(ids) == set(RECEIVERS)
    assert {row.receiver_id for row in rows if row.mentioned} == {RECEIVERS[0]}
    assert response.hub_msg_id == retry.hub_msg_id == ids[RECEIVERS[0]]
    if partial:
        assert response.hub_msg_id == "previously-persisted-id"
    assert projected.msg_id == envelope.msg_id
    assert projected.preview == "Fanout body"

    assert notify.await_count == 18
    for call in notify.await_args_list:
        receiver_id = call.args[0]
        assert call.kwargs["realtime_event"]["hub_msg_id"] == ids[receiver_id]
        assert call.kwargs["resume_cloud"] == (receiver_id == RECEIVERS[0])
    assert publish.await_count == 2
    assert all(call.args[1]["hub_msg_id"] == response.hub_msg_id for call in publish.await_args_list)
    assert bump.await_count == 2
    assert all(call.kwargs["receiver_ids"] == set(RECEIVERS) for call in bump.await_args_list)
    assert sum(statement.startswith("INSERT INTO") and "MESSAGE_RECORDS" in statement for statement in sql) == 18
    assert not any("SAVEPOINT" in statement for statement in sql)


@pytest.mark.asyncio
async def test_concurrent_room_fanout_returns_winners_persisted_ids(database, sender):
    sessions, sql, dialect = database
    if dialect != "postgresql":
        pytest.skip("requires concurrent PostgreSQL connections")
    _, send, notify, _, bump = sender
    first_writer_ready = asyncio.Event()
    allow_first_commit = asyncio.Event()

    async def hold_first_writer(*_args, **_kwargs):
        if not first_writer_ready.is_set():
            first_writer_ready.set()
            await allow_first_commit.wait()
        return {RECEIVERS[0]}

    bump.side_effect = hold_first_writer
    try:
        async with asyncio.TaskGroup() as group:
            first = group.create_task(send())
            await asyncio.wait_for(first_writer_ready.wait(), timeout=5)
            second = group.create_task(send())
            async with asyncio.timeout(5):
                while sum(statement.startswith("INSERT INTO MESSAGE_RECORDS") for statement in sql) < 10:
                    await asyncio.sleep(0.01)
            assert not second.done()
            allow_first_commit.set()
    finally:
        allow_first_commit.set()

    async with sessions() as db:
        rows = (await db.scalars(select(MessageRecord))).all()
    ids = {row.receiver_id: row.hub_msg_id for row in rows}
    assert len(rows) == 9
    assert first.result().hub_msg_id == second.result().hub_msg_id == ids[RECEIVERS[0]]
    assert notify.await_count == 18
    assert all(call.kwargs["realtime_event"]["hub_msg_id"] == ids[call.args[0]]
               for call in notify.await_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize("unique_id_collision", [False, True])
async def test_failed_room_fanout_rolls_back_and_does_not_notify(database, sender, monkeypatch, unique_id_collision):
    sessions, _, _ = database
    envelope, send, notify, publish, bump = sender
    if unique_id_collision:
        # The second insert violates the hub_msg_id constraint after the first
        # recipient's row and trigger work have already been written.
        monkeypatch.setattr(hub, "generate_hub_msg_id", lambda: "same-hub-id")
        expected = IntegrityError
    else:
        bump.side_effect = RuntimeError("precommit failure")
        expected = RuntimeError

    with pytest.raises(expected):
        await send()

    async with sessions() as db:
        assert (await db.scalars(select(MessageRecord).where(MessageRecord.msg_id == envelope.msg_id))).all() == []
        assert await db.get(ConversationMessage, (ROOM_ID, envelope.msg_id)) is None
    notify.assert_not_awaited()
    publish.assert_not_awaited()
