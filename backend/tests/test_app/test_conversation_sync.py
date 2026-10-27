"""Conversation deltas use current membership and stable message summaries."""
import datetime as dt
import json

import pytest
from sqlalchemy import delete, select

from tests.test_app.test_app_humans import client, db_session, seed  # noqa: F401
from hub.models import Agent, MessageRecord, ParticipantType, Room, RoomMember, RoomRole


async def add_room(db, rid, participants, owner=None):
    db.add(Room(room_id=rid, name=rid, owner_id=owner or participants[0], description=""))
    await db.flush()
    for pid in participants:
        db.add(RoomMember(room_id=rid, agent_id=pid, role=RoomRole.member,
                          participant_type=ParticipantType.human if pid.startswith("hu_") else ParticipantType.agent))
    await db.flush()


async def add_message(db, rid, mid, seconds, kind="message", receiver="ag_receiver", sender="ag_sender"):
    message = MessageRecord(hub_msg_id=f"hub_{mid}_{receiver}", msg_id=mid, sender_id=sender,
                            receiver_id=receiver, room_id=rid, ttl_sec=3600,
                            created_at=dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=seconds),
                            envelope_json=json.dumps({"from": sender, "type": kind, "payload": {"text": mid}}))
    db.add(message)
    await db.flush()
    return message


async def sync(client, seed, known=None, limit=100):
    response = await client.post("/api/conversations/sync", headers={"Authorization": f"Bearer {seed['token']}"},
                                 json={"known": known or {}, "limit": limit})
    assert response.status_code == 200, response.text
    return response.json()


def manifest(response):
    return {room["room_id"]: room["revision"] for room in response["upserts"]}


@pytest.mark.asyncio
async def test_auth_required(client):
    response = await client.post("/api/conversations/sync", json={})
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_latest_message_order_and_unchanged_delta(client, seed, db_session):
    for rid in ["rm_old", "rm_new", "rm_empty"]:
        await add_room(db_session, rid, [seed["human_id"]])
    await add_message(db_session, "rm_old", "old", 10)
    await add_message(db_session, "rm_new", "new", 20)
    # Delivery copies count once. Receipts must not make an old room jump.
    await add_message(db_session, "rm_new", "new", 20, receiver="ag_other")
    await add_message(db_session, "rm_old", "receipt", 30, kind="ack")
    await db_session.commit()
    first = await sync(client, seed)
    assert [r["room_id"] for r in first["upserts"]] == ["rm_new", "rm_old", "rm_empty"]
    assert first["upserts"][0]["unread_count"] == 1
    assert first["upserts"][1]["last_message_preview"] == "old"
    second = await sync(client, seed, manifest(first))
    assert second["upserts"] == []
    assert second["removed_ids"] == []
    assert second["has_more"] is False
    await add_message(db_session, "rm_old", "receipt2", 40, kind="result")
    await db_session.commit()
    assert (await sync(client, seed, manifest(first)))["upserts"] == []


@pytest.mark.asyncio
async def test_metadata_read_recall_and_membership_changes(client, seed, db_session):
    await add_room(db_session, "rm_a", [seed["human_id"]])
    message = await add_message(db_session, "rm_a", "hello", 10)
    await db_session.commit()
    initial = await sync(client, seed)
    known = manifest(initial)
    room = (await db_session.execute(select(Room).where(Room.room_id == "rm_a"))).scalar_one()
    room.name = "Renamed"
    await db_session.commit()
    renamed = await sync(client, seed, known)
    assert renamed["upserts"][0]["name"] == "Renamed"
    known.update(manifest(renamed))
    member = (await db_session.execute(select(RoomMember).where(RoomMember.room_id == "rm_a"))).scalar_one()
    member.last_viewed_at = dt.datetime(2026, 1, 2, tzinfo=dt.timezone.utc)
    await db_session.commit()
    read = await sync(client, seed, known)
    assert read["upserts"][0]["unread_count"] == 0
    known.update(manifest(read))
    message.recalled_at = dt.datetime(2026, 1, 2, tzinfo=dt.timezone.utc)
    await db_session.commit()
    recalled = await sync(client, seed, known)
    assert recalled["upserts"][0]["last_message_preview"] == "Message recalled"
    assert recalled["upserts"][0]["last_message_at"] == initial["upserts"][0]["last_message_at"]
    known.update(manifest(recalled))
    await db_session.execute(delete(RoomMember).where(RoomMember.room_id == "rm_a"))
    await db_session.commit()
    removed = await sync(client, seed, known)
    assert removed["removed_ids"] == ["rm_a"]
    assert removed["upserts"] == []


@pytest.mark.asyncio
async def test_all_owned_bots_are_batched_and_multibot_membership_is_preserved(client, seed, db_session):
    db_session.add_all([Agent(agent_id=aid, display_name=aid, user_id=seed["user_id"])
                        for aid in ["ag_one", "ag_two"]])
    await db_session.flush()
    await add_room(db_session, "rm_shared", ["ag_one", "ag_two"])
    await add_room(db_session, "rm_mine", ["ag_one", seed["human_id"]])
    await add_room(db_session, "rm_private_other", ["ag_unowned"])
    await db_session.commit()
    result = await sync(client, seed, {"rm_private_other": "forged"})
    rows = {r["room_id"]: r for r in result["upserts"]}
    assert set(rows) == {"rm_shared", "rm_mine"}
    assert {b["agent_id"] for b in rows["rm_shared"]["_originAgents"]} == {"ag_one", "ag_two"}
    assert rows["rm_mine"]["_originAgent"] is None
    assert result["removed_ids"] == ["rm_private_other"]
    # Revoking ownership removes previously observed rooms on next sync.
    bot = (await db_session.execute(select(Agent).where(Agent.agent_id == "ag_one"))).scalar_one()
    bot.user_id = None
    other = (await db_session.execute(select(Agent).where(Agent.agent_id == "ag_two"))).scalar_one()
    other.user_id = None
    await db_session.commit()
    assert (await sync(client, seed, manifest(result)))["removed_ids"] == ["rm_shared"]


@pytest.mark.asyncio
async def test_batches_do_not_skip_changes_between_pages(client, seed, db_session):
    for i in range(3):
        await add_room(db_session, f"rm_{i}", [seed["human_id"]])
        await add_message(db_session, f"rm_{i}", f"message_{i}", i)
    await db_session.commit()
    first = await sync(client, seed, limit=1)
    assert first["upserts"][0]["room_id"] == "rm_2"
    assert first["has_more"]
    known = manifest(first)
    await add_message(db_session, "rm_0", "newest", 100)
    await db_session.commit()
    second = await sync(client, seed, known, limit=1)
    assert second["upserts"][0]["room_id"] == "rm_0"
    known.update(manifest(second))
    third = await sync(client, seed, known, limit=1)
    assert third["upserts"][0]["room_id"] == "rm_1"
    assert not third["has_more"]
    known.update(manifest(third))
    assert (await sync(client, seed, known))["upserts"] == []
