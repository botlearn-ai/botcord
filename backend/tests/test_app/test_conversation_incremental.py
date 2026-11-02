"""Write-side semantics and SQL cost, including per-recipient savepoints."""
import datetime as dt
import json

import pytest
from sqlalchemy import delete, event, select, update

from tests.test_app.test_conversation_sync import add_message, add_room, sync, manifest
from tests.test_app.test_app_humans import client, db_session, seed  # noqa: F401
from hub.models import (
    ConversationDirtyRoom, ConversationEntry, ConversationMessage, MessageRecord,
    Room, RoomMember, User,
)

pytestmark = pytest.mark.asyncio


def capture_sql(db):
    statements = []
    def capture(conn, cursor, statement, *args):
        statements.append(statement.lower())
    engine = db.bind.sync_engine
    event.listen(engine, "before_cursor_execute", capture)
    return statements, lambda: event.remove(engine, "before_cursor_execute", capture)


async def entry(db, seed, rid="rm_inc"):
    return await db.get(ConversationEntry, (seed["user_id"], rid), populate_existing=True)


async def setup(db, seed):
    await add_room(db, "rm_inc", [seed["human_id"]])
    await db.commit()


async def test_fanout_projects_once_at_outer_commit(db_session, seed, monkeypatch):
    await setup(db_session, seed)
    import hub.services.conversation_projection as projection
    original = projection.refresh_room
    calls = []
    async def counted(*args):
        calls.append(args[1])
        return await original(*args)
    monkeypatch.setattr(projection, "refresh_room", counted)
    for receiver in ["ag_one", "ag_two", "ag_three"]:
        async with db_session.begin_nested():
            await add_message(db_session, "rm_inc", "fanout", 10, receiver=receiver)
    assert calls == []
    await db_session.commit()
    assert calls == ["rm_inc"]
    assert (await entry(db_session, seed)).payload["unread_count"] == 1
    assert len((await db_session.scalars(select(ConversationMessage))).all()) == 1


async def test_message_changes_reconcile_logical_key_not_history(db_session, seed):
    await setup(db_session, seed)
    first = await add_message(db_session, "rm_inc", "first", 10)
    await db_session.commit()
    statements, stop = capture_sql(db_session)
    try:
        await add_message(db_session, "rm_inc", "new", 20)
        await db_session.commit()
    finally:
        stop()
    source_queries = [s for s in statements if s.startswith("select") and "from message_records" in s]
    assert source_queries and all("message_records.msg_id =" in s for s in source_queries)
    assert not any("group by" in s for s in source_queries)
    assert (await entry(db_session, seed)).payload["unread_count"] == 2
    first.recalled_at = dt.datetime.now(dt.timezone.utc)
    await db_session.commit()
    assert (await entry(db_session, seed)).payload["unread_count"] == 1


async def test_duplicate_receipt_and_own_message_semantics(db_session, seed):
    await setup(db_session, seed)
    await add_message(db_session, "rm_inc", "m", 10)
    await db_session.commit()
    version = (await entry(db_session, seed)).version
    await add_message(db_session, "rm_inc", "m", 10, receiver="ag_other")
    await add_message(db_session, "rm_inc", "receipt", 30, kind="ack")
    await db_session.commit()
    assert (await entry(db_session, seed)).version == version
    await add_message(db_session, "rm_inc", "mine", 20, sender=seed["human_id"])
    await db_session.commit()
    row = await entry(db_session, seed)
    assert row.payload["unread_count"] == 1 and row.payload["last_message_preview"] == "mine"


async def test_read_and_metadata_do_not_query_message_history(db_session, seed):
    await setup(db_session, seed)
    await add_message(db_session, "rm_inc", "m", 10)
    await db_session.commit()
    statements, stop = capture_sql(db_session)
    try:
        await db_session.execute(update(RoomMember).where(RoomMember.room_id == "rm_inc")
            .values(last_viewed_at=dt.datetime(2026, 2, 1, tzinfo=dt.timezone.utc)))
        await db_session.commit()
        await db_session.execute(update(Room).where(Room.room_id == "rm_inc").values(name="Changed"))
        await db_session.commit()
        await db_session.execute(update(User).where(User.id == seed["user_id"]).values(display_name="Changed"))
        await db_session.commit()
    finally:
        stop()
    assert not any(s.startswith("select") and ("from message_records" in s or "from conversation_messages" in s) for s in statements)
    row = await entry(db_session, seed)
    assert row.payload["unread_count"] == 0 and row.payload["name"] == "Changed"


async def test_partial_read_and_message_changes_in_same_transaction(db_session, seed):
    await setup(db_session, seed)
    for n in [10, 20, 30]:
        await add_message(db_session, "rm_inc", str(n), n)
    await db_session.commit()
    await db_session.execute(update(RoomMember).where(RoomMember.room_id == "rm_inc")
        .values(last_viewed_at=dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=20)))
    await add_message(db_session, "rm_inc", "late-old", 15)
    await add_message(db_session, "rm_inc", "new", 40)
    await db_session.commit()
    assert (await entry(db_session, seed)).payload["unread_count"] == 2


async def test_latest_recall_preserves_order_and_deletion_promotes_copy(db_session, seed):
    await setup(db_session, seed)
    first = await add_message(db_session, "rm_inc", "m", 10)
    other = await add_message(db_session, "rm_inc", "m", 20, receiver="ag_other")
    await db_session.commit()
    before = (await entry(db_session, seed)).payload.copy()
    first.recalled_at = dt.datetime.now(dt.timezone.utc)
    await db_session.commit()
    recalled = (await entry(db_session, seed)).payload
    assert recalled["last_message_at"] == before["last_message_at"]
    assert recalled["last_message_preview"] == "Message recalled" and recalled["unread_count"] == 0
    await db_session.delete(first)
    await db_session.commit()
    assert (await entry(db_session, seed)).payload["unread_count"] == 1
    projected = await db_session.get(ConversationMessage, ("rm_inc", "m"))
    assert projected.canonical_id == other.id
    other.envelope_json = json.dumps({"type": "ack"})
    await db_session.commit()
    assert (await entry(db_session, seed)).payload["last_message_at"] is None


async def test_rebuild_replay_and_rollback_are_idempotent(db_session, seed):
    await setup(db_session, seed)
    await add_message(db_session, "rm_inc", "m", 10)
    await db_session.commit()
    row = await entry(db_session, seed)
    before, version = row.payload.copy(), row.version
    for _ in range(2):
        db_session.add(ConversationDirtyRoom(room_id="rm_inc"))
        await db_session.commit()
        row = await entry(db_session, seed)
        assert row.payload == before and row.version == version
    await add_message(db_session, "rm_inc", "aborted", 20)
    from hub.services.conversation_projection import project_pending
    await project_pending(db_session)
    await db_session.rollback()
    row = await entry(db_session, seed)
    assert row.payload == before and row.version == version


async def test_nested_rollback_does_not_leak_projection(db_session, seed):
    await setup(db_session, seed)
    with pytest.raises(ValueError):
        async with db_session.begin_nested():
            await add_message(db_session, "rm_inc", "aborted", 10)
            raise ValueError("rollback savepoint")
    await add_message(db_session, "rm_inc", "kept", 20)
    await db_session.commit()
    row = await entry(db_session, seed)
    assert row.payload["last_message_preview"] == "kept" and row.payload["unread_count"] == 1


async def test_mixed_edits_match_reference_history_semantics(db_session, seed):
    """Compare the incremental view with an independent small-history oracle."""
    import random
    from hub.services.conversation_messages import utc
    from app.routers.dashboard import _preview_for_record
    rng = random.Random(8128)
    await setup(db_session, seed)
    member = await db_session.scalar(select(RoomMember).where(RoomMember.room_id == "rm_inc"))
    records = []
    for step in range(40):
        action = rng.choice(["add", "add", "copy", "recall", "type", "read", "delete"])
        if not records or action == "add":
            records.append(await add_message(db_session, "rm_inc", f"m{step}", rng.randrange(1, 100),
                sender=rng.choice(["ag_sender", seed["human_id"]])))
        elif action == "copy":
            source = rng.choice(records)
            copy = await add_message(db_session, "rm_inc", source.msg_id, rng.randrange(1, 100),
                receiver=f"ag_copy_{step}", sender=source.sender_id)
            records.append(copy)
        elif action == "recall":
            rng.choice(records).recalled_at = dt.datetime.now(dt.timezone.utc)
        elif action == "type":
            rng.choice(records).envelope_json = json.dumps({"type":rng.choice(["message", "ack"]), "payload":{"text":"edited"}})
        elif action == "read":
            member.last_viewed_at = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=rng.randrange(1, 100))
        elif action == "delete":
            source = rng.choice(records)
            records.remove(source)
            await db_session.delete(source)
        await db_session.commit()
        canonical = {}
        for record in sorted(records, key=lambda r:r.id):
            if json.loads(record.envelope_json).get("type", "message") in ["message", "system"]:
                canonical.setdefault(record.msg_id, record)
        latest = max(canonical.values(), key=lambda r:(utc(r.created_at),r.id), default=None)
        expected_unread = sum(r.sender_id != seed["human_id"] and r.recalled_at is None
            and (member.last_viewed_at is None or utc(r.created_at) > utc(member.last_viewed_at))
            for r in canonical.values())
        row = await entry(db_session, seed)
        assert row.payload["unread_count"] == expected_unread, (step, action)
        assert row.payload["last_message_preview"] == (_preview_for_record(latest)[1] if latest else None), (step, action)


async def test_read_change_only_projects_reader_account(db_session, seed, monkeypatch):
    import uuid
    import hub.services.conversation_projection as projection
    other = User(id=uuid.uuid4(), supabase_user_id=uuid.uuid4(), human_id="hu_other_reader", display_name="Other")
    db_session.add(other)
    await db_session.flush()
    await add_room(db_session, "rm_inc", [seed["human_id"], other.human_id])
    await add_message(db_session, "rm_inc", "m", 10)
    await db_session.commit()
    original = projection.conversation_summaries
    accounts = []
    async def counted(db, ctx, *args, **kwargs):
        accounts.append(ctx.user_id)
        return await original(db, ctx, *args, **kwargs)
    monkeypatch.setattr(projection, "conversation_summaries", counted)
    await db_session.execute(update(RoomMember).where(RoomMember.room_id == "rm_inc", RoomMember.agent_id == seed["human_id"])
        .values(last_viewed_at=dt.datetime(2026, 2, 1, tzinfo=dt.timezone.utc)))
    await db_session.commit()
    assert accounts == [seed["user_id"]]
    assert (await db_session.get(ConversationEntry,(other.id,"rm_inc"))).payload["unread_count"] == 1
