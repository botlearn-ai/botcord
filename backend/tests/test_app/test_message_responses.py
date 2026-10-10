"""Decisions, not delivery ACKs, drive message feedback."""
import datetime as dt

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from hub.models import MessageRecord, MessageResponseLink, MessageState
from hub.schemas import MessageEnvelope
from hub.services.message_responses import ResponseRunUpdate, record_response, update_run
from hub.services.room_message_activity import load_room_message_activity
from tests.test_app.test_app_dashboard_rooms import client, db_session, seed, _h  # noqa: F401

ROOM = "rm_pubopen01"


async def inputs(db, agent, ids=("m1", "m2")):
    for msg_id in ids:
        db.add(MessageRecord(hub_msg_id=f"h_{agent}_{msg_id}", msg_id=msg_id,
            sender_id="hu_test", receiver_id=agent, room_id=ROOM,
            envelope_json='{"type":"message"}', state=MessageState.delivered,
            ttl_sec=3600, mentioned=True, source_type="dashboard_human_room"))
    await db.commit()


async def action(db, agent, verb, ids=None, run="run1", **kw):
    return await update_run(db, agent, ResponseRunUpdate(run_id=run, room_id=ROOM,
        action=verb, message_ids=ids or [], **kw))


def reply(agent, ids=None, kind="final", msg_id="reply1", run="run1"):
    return MessageEnvelope(msg_id=msg_id, ts=1, type="message", **{"from": agent}, to=ROOM,
        payload={"text": "answer", "response": {"run_id": run, "kind": kind, "responds_to": ids or []}},
        payload_hash="hash", sig={"key_id": "key", "value": "sig"})


async def states(db):
    return {r.msg_id: r.response_status for r in (await db.execute(select(MessageRecord).where(
        MessageRecord.msg_id.in_(["m1", "m2", "m3"])
    ))).scalars().all()}


@pytest.mark.asyncio
async def test_batch_progress_final_and_no_reply_are_independent(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1", "m2", "m3"))
    await action(db, agent, "register", ["m1", "m2", "m3"])
    await action(db, agent, "start", ["m1", "m2"])
    await action(db, agent, "no_reply", ["m3"])
    await record_response(db, reply(agent, ["m1", "m2"], "progress", "progress"), ROOM)
    assert await states(db) == {"m1": "processing", "m2": "processing", "m3": "no_reply"}
    await record_response(db, reply(agent, ["m1", "m2"]), ROOM)
    await action(db, agent, "finish")
    await db.commit()
    assert await states(db) == {"m1": "completed", "m2": "completed", "m3": "no_reply"}
    activity = await load_room_message_activity(db, ROOM, ["m1", "m2", "m3"])
    assert activity["m1"][0]["reply_msg_id"] == "reply1"
    assert activity["m3"][0]["status"] == "no_reply"
    await record_response(db, reply(agent, ["m1", "m2"]), ROOM)
    assert len((await db.execute(select(MessageResponseLink))).scalars().all()) == 4


@pytest.mark.asyncio
async def test_stale_run_cannot_resolve_transferred_inputs(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent)
    await action(db, agent, "register", ["m1", "m2"])
    await action(db, agent, "start", ["m1"])
    await action(db, agent, "register", ["m1"], run="run2")
    with pytest.raises(HTTPException) as err:
        await record_response(db, reply(agent, ["m1"]), ROOM)
    assert err.value.status_code == 409
    await action(db, agent, "finish", outcome="interrupted")
    assert await states(db) == {"m1": "waiting", "m2": "interrupted"}


@pytest.mark.asyncio
async def test_batch_requires_selection_and_finish_is_not_reply(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent)
    await action(db, agent, "register", ["m1", "m2"])
    with pytest.raises(HTTPException):
        await record_response(db, reply(agent), ROOM)
    with pytest.raises(HTTPException):
        await action(db, agent, "finish", ["m1"])
    await action(db, agent, "finish")
    assert await states(db) == {"m1": "unconfirmed", "m2": "unconfirmed"}
    with pytest.raises(HTTPException):
        await action(db, agent, "register", ["m1", "m2"])


@pytest.mark.asyncio
async def test_agent_scope_room_scope_and_immutable_run_inputs(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent)
    with pytest.raises(HTTPException):
        await action(db, seed["agent2"], "register", ["m1"])
    await action(db, agent, "register", ["m1"])
    with pytest.raises(HTTPException):
        await action(db, agent, "register", ["m2"])
    with pytest.raises(HTTPException):
        await action(db, seed["agent2"], "start", ["m1"])
    with pytest.raises(HTTPException):
        await action(db, agent, "start", ["m2"])
    with pytest.raises(HTTPException):
        await record_response(db, reply(agent, ["m1"]), "rm_other")


@pytest.mark.asyncio
async def test_expiry_stops_spinner_and_rejects_late_reply(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1",))
    run = await action(db, agent, "register", ["m1"])
    await action(db, agent, "start", ["m1"])
    run.expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    await db.commit()
    assert (await load_room_message_activity(db, ROOM, ["m1"]))["m1"][0]["status"] == "interrupted"
    with pytest.raises(HTTPException):
        await record_response(db, reply(agent, ["m1"]), ROOM)
    with pytest.raises(HTTPException):
        await action(db, agent, "heartbeat")


@pytest.mark.asyncio
async def test_response_decision_api_and_activity_poll(client, db_session, seed):
    from hub.auth import create_agent_token
    agent = seed["agent1"]
    await inputs(db_session, agent, ("m1",))
    headers = _h(seed["token1"], agent)
    agent_headers = {"Authorization": f"Bearer {create_agent_token(agent)[0]}"}
    for verb, status in [("register", "waiting"), ("start", "processing"), ("no_reply", "no_reply")]:
        response = await client.post("/hub/response-runs", headers=agent_headers,
            json={"run_id": "api-run", "room_id": ROOM, "message_ids": ["m1"], "action": verb})
        assert response.status_code == 200, response.text
        response = await client.get(f"/api/dashboard/rooms/{ROOM}/messages", headers=headers,
                                    params={"activity_for": "m1"})
        assert response.json()["activity_updates"]["m1"][0]["status"] == status


@pytest.mark.asyncio
async def test_single_automatic_reply_and_transaction_rollback(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1",))
    await action(db, agent, "register", ["m1"])
    await db.commit()
    await record_response(db, reply(agent), ROOM)
    assert (await states(db))["m1"] == "completed"
    await db.rollback()
    assert (await states(db))["m1"] == "waiting"
    assert not (await db.execute(select(MessageResponseLink))).scalars().all()


@pytest.mark.asyncio
async def test_send_endpoint_commits_reply_and_state_once(client, db_session, seed, monkeypatch):
    from unittest.mock import AsyncMock
    from hub.auth import create_agent_token
    import hub.routers.hub as hub_router
    agent = seed["agent1"]
    await inputs(db_session, agent, ("m1",))
    await action(db_session, agent, "register", ["m1"])
    await action(db_session, agent, "start", ["m1"])
    await db_session.commit()
    # This test exercises transaction/fanout/idempotency. Envelope signing has
    # independent protocol-core coverage; keep this fixture's dummy key local.
    monkeypatch.setattr(hub_router, "_verify_envelope", AsyncMock())
    headers = {"Authorization": f"Bearer {create_agent_token(agent)[0]}"}
    body = reply(agent, ["m1"]).model_dump(by_alias=True)
    first = await client.post("/hub/send", json=body, headers=headers)
    assert first.status_code == 202, first.text
    assert (await states(db_session))["m1"] == "completed"
    await action(db_session, agent, "finish")
    await db_session.commit()
    retry = await client.post("/hub/send", json=body, headers=headers)
    assert retry.status_code == 202, retry.text
    assert retry.json()["hub_msg_id"] == first.json()["hub_msg_id"]
    links = (await db_session.execute(select(MessageResponseLink))).scalars().all()
    assert len(links) == 1
    body["payload"]["text"] = "different answer"
    changed = await client.post("/hub/send", json=body, headers=headers)
    assert changed.status_code == 409
    # A bad client must not reuse an INPUT ID as its outgoing reply ID.
    body["msg_id"] = "m1"
    collision = await client.post("/hub/send", json=body, headers=headers)
    assert collision.status_code == 409


@pytest.mark.asyncio
async def test_two_agents_keep_independent_response_state(db_session, seed):
    db = db_session
    await inputs(db, seed["agent1"], ("m1",))
    await inputs(db, seed["agent2"], ("m1",))
    await action(db, seed["agent1"], "register", ["m1"])
    await action(db, seed["agent2"], "register", ["m1"], run="other-run")
    await record_response(db, reply(seed["agent1"]), ROOM)
    activity = await load_room_message_activity(db, ROOM, ["m1"])
    assert {a["agent_id"]: a["status"] for a in activity["m1"]} == {
        seed["agent1"]: "completed", seed["agent2"]: "waiting",
    }


@pytest.mark.asyncio
async def test_empty_reply_does_not_complete_input(db_session, seed):
    agent = seed["agent1"]
    await inputs(db_session, agent, ("m1",))
    await action(db_session, agent, "register", ["m1"])
    empty = reply(agent)
    empty.payload["text"] = " "
    with pytest.raises(HTTPException) as err:
        await record_response(db_session, empty, ROOM)
    assert err.value.status_code == 422
    assert (await states(db_session))["m1"] == "waiting"
