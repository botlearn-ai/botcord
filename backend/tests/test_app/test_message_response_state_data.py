"""Durable facts are separate from the unchanged legacy activity projection."""
import datetime as dt

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from hub.models import MessageRecord, MessageResponseEvent
from hub.services.message_responses import ResponseRunUpdate, update_run
from tests.test_app.test_message_responses import (  # noqa: F401
    ROOM, action, client, db_session, inputs, record_response, reply, seed,
)


async def facts(db, agent, msg="m1"):
    return (await db.execute(select(MessageRecord).where(
        MessageRecord.receiver_id == agent, MessageRecord.msg_id == msg,
    ))).scalar_one()


async def events(db, agent, msg="m1"):
    return (await db.execute(select(MessageResponseEvent).where(
        MessageResponseEvent.agent_id == agent, MessageResponseEvent.target_msg_id == msg,
    ).order_by(MessageResponseEvent.id))).scalars().all()


@pytest.mark.asyncio
async def test_lifecycle_records_ordered_idempotent_facts_and_legacy_status(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1",))
    for verb, state, legacy in [("queue", "queued", None), ("register", "waiting", "waiting"),
                               ("start", "processing", "processing"), ("replying", "replying", "processing")]:
        await action(db, agent, verb, ["m1"])
        await action(db, agent, verb, ["m1"])
        row = await facts(db, agent)
        assert (row.response_state, row.response_status) == (state, legacy)
        assert row.response_updated_at is not None
    # Out-of-order start cannot rewind reply intent or create a duplicate event.
    await action(db, agent, "start", ["m1"])
    await record_response(db, reply(agent, ["m1"], kind="progress", msg_id="p1"), ROOM)
    await record_response(db, reply(agent, ["m1"]), ROOM)
    await action(db, agent, "finish")
    await db.commit()
    await record_response(db, reply(agent, ["m1"]), ROOM)
    assert [e.state for e in await events(db, agent)] == ["queued", "waiting", "processing", "replying", "completed"]
    assert (await events(db, agent))[-1].reply_msg_id == "reply1"
    row = await facts(db, agent)
    assert (row.response_state, row.response_status, row.response_reply_msg_id) == ("completed", "completed", "reply1")


@pytest.mark.asyncio
async def test_ignore_and_processed_silence_are_distinct_without_rewriting_history(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1", "m2", "old"))
    old = await facts(db, agent, "old")
    old.response_status = "no_reply"
    await action(db, agent, "register", ["m1", "m2", "old"])
    await action(db, agent, "ignore", ["m1"], reason="attention_policy")
    await action(db, agent, "start", ["m2"])
    await action(db, agent, "no_reply", ["m2"], reason="agent_decision")
    await action(db, agent, "finish")
    for msg, state, reason in [("m1", "ignored", "attention_policy"), ("m2", "no_reply", "agent_decision")]:
        row = await facts(db, agent, msg)
        assert (row.response_state, row.response_status, row.response_reason) == (state, "no_reply", reason)
    assert old.response_state is None
    assert await events(db, agent, "old") == []
    # A new attempt must not claim a resolved input, even if an older daemon reports start.
    await action(db, agent, "register", ["m1", "m2"], run="retry")
    with pytest.raises(HTTPException):
        await action(db, agent, "start", ["m1"], run="retry")
    assert (await facts(db, agent)).response_state == "ignored"


@pytest.mark.asyncio
async def test_illegal_decisions_do_not_partially_mutate_a_batch(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent)
    await action(db, agent, "register", ["m1", "m2"])
    await action(db, agent, "start", ["m2"])
    with pytest.raises(HTTPException):
        await action(db, agent, "ignore", ["m1", "m2"])
    assert (await facts(db, agent)).response_state == "waiting"
    await action(db, agent, "replying", ["m2"])
    with pytest.raises(HTTPException):
        await action(db, agent, "no_reply", ["m1", "m2"])
    assert (await facts(db, agent)).response_state == "waiting"


@pytest.mark.asyncio
async def test_queue_merge_records_actual_inputs_and_fences_old_attempts(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent)
    await action(db, agent, "queue", ["m1"], run="q1")
    await action(db, agent, "queue", ["m2"], run="q2")
    await action(db, agent, "register", ["m1", "m2"], run="q2")
    with pytest.raises(HTTPException):
        await action(db, agent, "register", ["m1"], run="q1")
    await action(db, agent, "finish", run="q1", outcome="interrupted", reason="not_executed")
    await record_response(db, reply(agent, ["m1", "m2"], run="q2"), ROOM)
    assert (await facts(db, agent)).response_state == "completed"
    assert [(e.run_id, e.state) for e in await events(db, agent)] == [
        ("q1", "queued"), ("q2", "waiting"), ("q2", "completed"),
    ]


@pytest.mark.asyncio
async def test_trimmed_inputs_and_unstarted_queue_cleanup_get_terminal_facts(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent)
    await action(db, agent, "queue", ["m1", "m2"])
    await action(db, agent, "register", ["m2"])
    row = await facts(db, agent)
    assert (row.response_state, row.response_reason) == ("failed", "batch_trimmed")
    await action(db, agent, "queue", ["m1"], run="new-queue")
    await action(db, agent, "finish", run="new-queue", outcome="interrupted", reason="not_executed")
    assert (await facts(db, agent)).response_state == "interrupted"
    assert [e.state for e in await events(db, agent)] == ["queued", "failed", "queued", "interrupted"]


@pytest.mark.asyncio
async def test_queued_lease_and_agent_scope_are_enforced(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1",))
    with pytest.raises(HTTPException):
        await action(db, seed["agent2"], "queue", ["m1"])
    run = await action(db, agent, "queue", ["m1"])
    with pytest.raises(HTTPException):
        await action(db, agent, "start", ["m1"])
    await action(db, agent, "heartbeat")
    run.expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    with pytest.raises(HTTPException):
        await action(db, agent, "register", ["m1"])
    # Expiry is a fact for the later projection, not a fabricated decision.
    assert [e.state for e in await events(db, agent)] == ["queued"]


@pytest.mark.asyncio
async def test_reply_event_and_snapshot_roll_back_with_the_send(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1",))
    await action(db, agent, "register", ["m1"])
    await db.commit()
    await record_response(db, reply(agent), ROOM)
    assert (await events(db, agent))[-1].state == "completed"
    await db.rollback()
    assert (await facts(db, agent)).response_state == "waiting"
    assert [e.state for e in await events(db, agent)] == ["waiting"]


@pytest.mark.asyncio
async def test_api_persists_distinct_decision_and_rejects_freeform_reason(client, db_session, seed):
    from hub.auth import create_agent_token
    agent = seed["agent1"]
    await inputs(db_session, agent, ("m1",))
    headers = {"Authorization": f"Bearer {create_agent_token(agent)[0]}"}
    body = {"run_id": "api", "room_id": ROOM, "message_ids": ["m1"]}
    for verb in ["queue", "register", "ignore"]:
        response = await client.post("/hub/response-runs", headers=headers,
            json={**body, "action": verb, **({"reason": "attention_policy"} if verb == "ignore" else {})})
        assert response.status_code == 200, response.text
    row = await facts(db_session, agent)
    assert (row.response_state, row.response_status) == ("ignored", "no_reply")
    invalid = await client.post("/hub/response-runs", headers=headers,
        json={**body, "action": "ignore", "reason": "raw runtime exception with secret"})
    assert invalid.status_code == 422
    assert len(await events(db_session, agent)) == 3


@pytest.mark.asyncio
async def test_two_agents_have_separate_events_and_retry_history(db_session, seed):
    db = db_session
    a, b = seed["agent1"], seed["agent2"]
    for agent, run in [(a, "a1"), (b, "b1")]:
        await inputs(db, agent, ("m1",))
        await action(db, agent, "register", ["m1"], run=run)
    await action(db, a, "ignore", ["m1"], run="a1", reason="attention_policy")
    await action(db, b, "finish", run="b1", outcome="failed", reason="runtime_error")
    await action(db, b, "register", ["m1"], run="b2")
    await record_response(db, reply(b, ["m1"], run="b2"), ROOM)
    assert [e.state for e in await events(db, a)] == ["waiting", "ignored"]
    assert [e.state for e in await events(db, b)] == ["waiting", "failed", "waiting", "completed"]


@pytest.mark.asyncio
async def test_new_queue_can_recover_expired_execution_but_not_a_live_one(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1",))
    run = await action(db, agent, "register", ["m1"])
    await action(db, agent, "start", ["m1"])
    with pytest.raises(HTTPException):
        await action(db, agent, "queue", ["m1"], run="new")
    run.expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    await action(db, agent, "queue", ["m1"], run="new")
    assert (await facts(db, agent)).response_state == "queued"
    with pytest.raises(HTTPException):
        await record_response(db, reply(agent, ["m1"]), ROOM)


@pytest.mark.asyncio
async def test_queue_cleanup_cannot_mislabel_a_running_execution(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1",))
    await action(db, agent, "queue", ["m1"])
    await action(db, agent, "register", ["m1"])
    await action(db, agent, "start", ["m1"])
    await action(db, agent, "finish", outcome="interrupted", reason="not_executed", only_if_queued=True)
    assert (await facts(db, agent)).response_state == "processing"
    await action(db, agent, "finish", outcome="failed", reason="runtime_error")
    row = await facts(db, agent)
    assert (row.response_state, row.response_reason) == ("failed", "runtime_error")
    with pytest.raises(HTTPException):
        await action(db, agent, "heartbeat", only_if_queued=True)
