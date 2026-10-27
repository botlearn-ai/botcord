"""Cursor correctness and query shape; no history aggregation on sync reads."""
import base64
import json

import pytest
from sqlalchemy import delete, event, select, text, update
from tests.test_app.test_app_humans import client, db_session, seed  # noqa: F401
from tests.test_app.test_conversation_sync import add_room, add_message
from hub.models import ConversationAccount, ConversationChange, ConversationDirtyRoom, ConversationEntry, Room, RoomMember
from hub.services.conversation_projection import project_pending


async def sync(client, seed, cursor=None, limit=100):
    result = await client.post("/api/conversations/sync", headers={"Authorization": f"Bearer {seed['token']}"}, json={"cursor": cursor, "limit": limit})
    assert result.status_code == 200, result.text
    return result.json()


@pytest.mark.asyncio
async def test_no_change_and_single_change_reads_never_touch_message_history(client, seed, db_session):
    for i in range(3):
        await add_room(db_session, f"rm_{i}", [seed["human_id"]])
        await add_message(db_session, f"rm_{i}", f"m_{i}", i)
    await db_session.commit()
    first = await sync(client, seed)
    assert first["reset"] and len(first["upserts"]) == 3
    statements = []
    engine = db_session.get_bind()
    def record(conn, cursor, sql, *args):
        statements.append(sql.lower())
    event.listen(engine, "before_cursor_execute", record)
    try:
        empty = await sync(client, seed, first["next_cursor"])
        assert empty["upserts"] == [] and empty["removed_ids"] == []
        assert not any("message_records" in sql for sql in statements)
        await add_message(db_session, "rm_0", "new", 10)
        await db_session.commit()
        statements.clear()
        changed = await sync(client, seed, empty["next_cursor"])
        assert [r["room_id"] for r in changed["upserts"]] == ["rm_0"]
        assert not any("message_records" in sql for sql in statements)
    finally:
        event.remove(engine, "before_cursor_execute", record)


@pytest.mark.asyncio
async def test_snapshot_keyset_catches_room_moving_above_page_boundary(client, seed, db_session):
    for i in range(4):
        await add_room(db_session, f"rm_{i}", [seed["human_id"]])
        await add_message(db_session, f"rm_{i}", f"m_{i}", i)
    await db_session.commit()
    page = await sync(client, seed, limit=1)
    assert page["upserts"][0]["room_id"] == "rm_3"
    collected = {r["room_id"]: r for r in page["upserts"]}
    # rm_0 now moves before the cursor, so the subsequent delta must recover it.
    await add_message(db_session, "rm_0", "moved", 100)
    await db_session.commit()
    for _ in range(12):
        if not page["has_more"]:
            break
        page = await sync(client, seed, page["next_cursor"], limit=1)
        collected.update({r["room_id"]: r for r in page["upserts"]})
    assert not page["has_more"]
    assert set(collected) == {f"rm_{i}" for i in range(4)}
    assert collected["rm_0"]["last_message_preview"] == "moved"


@pytest.mark.asyncio
async def test_raw_membership_removal_creates_tombstone_and_blocks_old_upserts(client, seed, db_session):
    await add_room(db_session, "rm_a", [seed["human_id"]])
    await db_session.commit()
    first = await sync(client, seed)
    await db_session.execute(text("UPDATE rooms SET name = 'Renamed' WHERE room_id = 'rm_a'"))
    await db_session.commit()
    await db_session.execute(delete(RoomMember).where(RoomMember.room_id == "rm_a"))
    await db_session.commit()
    removed = await sync(client, seed, first["next_cursor"], limit=1)
    # Even an earlier rename event must never expose a now-revoked summary.
    assert removed["upserts"] == []
    assert removed["removed_ids"] == ["rm_a"]
    assert (await sync(client, seed))["upserts"] == []


@pytest.mark.asyncio
async def test_projection_failure_rolls_back_source_and_cursor(client, seed, db_session, monkeypatch):
    await add_room(db_session, "rm_a", [seed["human_id"]])
    await db_session.commit()
    first = await sync(client, seed)
    async def broken(*args, **kwargs):
        raise RuntimeError("projection failed")
    with monkeypatch.context() as patch:
        patch.setattr("hub.services.conversation_projection.conversation_summaries", broken)
        await db_session.execute(update(Room).where(Room.room_id == "rm_a").values(name="Must roll back"))
        with pytest.raises(RuntimeError, match="projection failed"):
            await db_session.commit()
        with pytest.raises(RuntimeError, match="rollback is required"):
            await db_session.commit()
        await db_session.rollback()
    row = (await db_session.execute(select(Room).where(Room.room_id == "rm_a"))).scalar_one()
    assert row.name == "rm_a"
    result = await sync(client, seed, first["next_cursor"])
    assert not result["upserts"] and result["next_cursor"] == first["next_cursor"]


@pytest.mark.asyncio
async def test_expired_or_rebuilt_cursor_resets_and_wrong_account_is_rejected(client, seed, db_session):
    await add_room(db_session, "rm_a", [seed["human_id"]])
    await db_session.commit()
    first = await sync(client, seed)
    token = json.loads(base64.urlsafe_b64decode(first["next_cursor"]))
    token["epoch"] = "old-epoch"
    expired = base64.urlsafe_b64encode(json.dumps(token).encode()).decode()
    reset = await sync(client, seed, expired)
    assert reset["reset"] and reset["upserts"][0]["room_id"] == "rm_a"
    token["account"] = "different-account"
    bad = base64.urlsafe_b64encode(json.dumps(token).encode()).decode()
    result = await client.post("/api/conversations/sync", headers={"Authorization": f"Bearer {seed['token']}"}, json={"cursor": bad})
    assert result.status_code == 400
    await db_session.execute(update(ConversationAccount).values(version=10, floor=5))
    await db_session.commit()
    assert (await sync(client, seed, first["next_cursor"]))["reset"]


@pytest.mark.asyncio
async def test_receipts_and_duplicate_deliveries_create_no_directory_change(client, seed, db_session):
    await add_room(db_session, "rm_a", [seed["human_id"]])
    await add_message(db_session, "rm_a", "hello", 1)
    await db_session.commit()
    first = await sync(client, seed)
    await add_message(db_session, "rm_a", "hello", 1, receiver="another")
    await add_message(db_session, "rm_a", "receipt", 5, kind="ack")
    await db_session.commit()
    result = await sync(client, seed, first["next_cursor"])
    assert result["upserts"] == []
    assert result["next_cursor"] == first["next_cursor"]


@pytest.mark.asyncio
async def test_outbox_replay_is_idempotent(client, seed, db_session):
    await add_room(db_session, "rm_a", [seed["human_id"]])
    await db_session.commit()
    first = await sync(client, seed)
    db_session.add(ConversationDirtyRoom(room_id="rm_a"))
    await db_session.commit()
    assert (await sync(client, seed, first["next_cursor"]))["upserts"] == []
    assert len((await db_session.execute(select(ConversationChange))).scalars().all()) == 1
