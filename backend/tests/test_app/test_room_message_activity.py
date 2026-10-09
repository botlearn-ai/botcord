"""Progress stays scoped to authorized rooms and individual recipients."""
import json

import pytest

from hub.models import MessageRecord, MessageState
from tests.test_app.test_app_dashboard_rooms import client, db_session, seed, _h  # noqa: F401


@pytest.mark.asyncio
async def test_room_activity_refresh_without_new_messages(client, db_session, seed):
    record = MessageRecord(
        hub_msg_id="h_activity", msg_id="m_activity", sender_id="hu_test",
        receiver_id=seed["agent1"], room_id="rm_pubopen01",
        envelope_json=json.dumps({"type": "message", "payload": {"text": "Help"}}),
        state=MessageState.queued, ttl_sec=3600, mentioned=True,
        source_type="dashboard_human_room",
    )
    db_session.add(record)
    await db_session.commit()
    path = "/api/dashboard/rooms/rm_pubopen01/messages"
    headers = _h(seed["token1"], seed["agent1"])
    response = await client.get(path, headers=headers)
    message = next(m for m in response.json()["messages"] if m["msg_id"] == "m_activity")
    assert message["reply_activity"][0]["status"] == "waiting"
    for state, status in [(MessageState.processing, "processing"), (MessageState.failed, "failed")]:
        record.state = state
        record.last_error = "private internal exception"
        await db_session.commit()
        response = await client.get(path, params={"after": "h_activity", "activity_for": "m_activity"}, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["messages"] == []
        activity = response.json()["activity_updates"]["m_activity"]
        assert activity[0]["status"] == status
        assert "private internal exception" not in response.text
    # Public readers cannot inspect execution progress, nor use IDs to query another room.
    assert (await client.get(path, params={"activity_for": "m_activity"})).json()["activity_updates"] == {}
    other = await client.get("/api/dashboard/rooms/rm_priv0001/messages", params={"activity_for": "m_activity"}, headers=headers)
    assert other.json()["activity_updates"]["m_activity"] == []
    # A reply from the right agent completes just that recipient.
    record.state = MessageState.delivered
    db_session.add(MessageRecord(
        hub_msg_id="h_answer", msg_id="m_answer", sender_id=seed["agent1"],
        receiver_id="hu_test", room_id="rm_pubopen01", reply_to_msg_id="m_activity",
        envelope_json=json.dumps({"type": "message", "payload": {"text": "Answer"}}),
        state=MessageState.delivered, ttl_sec=3600,
    ))
    await db_session.commit()
    response = await client.get(path, params={"activity_for": "m_activity"}, headers=headers)
    assert response.json()["activity_updates"]["m_activity"][0]["status"] == "completed"


@pytest.mark.asyncio
async def test_activity_excludes_unmentioned_agents_and_tracks_fanout(db_session, seed):
    from hub.services.room_message_activity import load_room_message_activity
    for i, (receiver, mentioned, state) in enumerate([
        (seed["agent1"], True, MessageState.processing),
        (seed["agent2"], False, MessageState.queued),
        ("hu_test", True, MessageState.queued),
    ]):
        db_session.add(MessageRecord(
            hub_msg_id=f"h_fanout_{i}", msg_id="m_fanout", sender_id="hu_test",
            receiver_id=receiver, room_id="rm_pubopen01", envelope_json='{}',
            state=state, ttl_sec=3600, mentioned=mentioned, source_type="dashboard_human_room",
        ))
    await db_session.commit()
    activity = await load_room_message_activity(db_session, "rm_pubopen01", ["m_fanout"])
    assert [a["agent_id"] for a in activity["m_fanout"]] == [seed["agent1"]]


@pytest.mark.asyncio
async def test_trace_takes_precedence_over_quote_and_keeps_other_agent_pending(db_session, seed):
    from hub.services.room_message_activity import load_room_message_activity
    for hub_id, msg_id, receiver in [
        ("h_old", "m_old", seed["agent1"]),
        ("h_new", "m_new", seed["agent1"]),
        ("h_other", "m_new", seed["agent2"]),
    ]:
        db_session.add(MessageRecord(
            hub_msg_id=hub_id, msg_id=msg_id, sender_id="hu_test", receiver_id=receiver,
            room_id="rm_pubopen01", envelope_json='{}', state=MessageState.processing,
            ttl_sec=3600, mentioned=True, source_type="dashboard_human_room",
        ))
    db_session.add(MessageRecord(
        hub_msg_id="h_reply", msg_id="m_reply", sender_id=seed["agent1"], receiver_id="hu_test",
        room_id="rm_pubopen01", reply_to_msg_id="m_old",
        envelope_json=json.dumps({"type": "message", "trace_id": "h_new", "payload": {"text": "Answer"}}),
        state=MessageState.delivered, ttl_sec=3600,
    ))
    await db_session.commit()
    activity = await load_room_message_activity(db_session, "rm_pubopen01", ["m_old", "m_new"])
    assert activity["m_old"][0]["status"] == "processing"
    states = {a["agent_id"]: a["status"] for a in activity["m_new"]}
    assert states == {seed["agent1"]: "completed", seed["agent2"]: "processing"}
