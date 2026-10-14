"""Member projections use response facts, not inbox ACKs or other attempts."""
import datetime as dt
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from hub.models import MessageRecord, MessageResponseEvent, MessageState
from hub.services.room_message_activity import load_room_message_activity, project_response
from tests.test_app.test_message_responses import inputs, action, reply, ROOM
from tests.test_app.test_app_dashboard_rooms import client, db_session, seed, _h  # noqa: F401


def snapshot(state, **kw):
    return SimpleNamespace(response_state=state, response_status=None, response_reason=None,
                           response_updated_at=None, receiver_id="a", room_id="r", msg_id="m", **kw)


def execution(status="running", **kw):
    return SimpleNamespace(status=status, agent_id="a", room_id="r", message_ids=["m"],
                           expires_at=dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=180), **kw)


@pytest.mark.parametrize("state", ["queued", "waiting", "processing", "replying"])
def test_active_projection_and_expiry(state):
    record = snapshot(state)
    run = execution("queued" if state == "queued" else "running")
    assert project_response(record, run)["response_state"] == state
    run.expires_at -= dt.timedelta(seconds=181)
    result = project_response(record, run)
    assert (result["response_state"], result["reason"], result["derived"]) == ("interrupted", "lease_expired", True)
    assert record.response_state == state
    # A subsequent valid lease is projected from facts, never stuck interrupted.
    run.expires_at += dt.timedelta(seconds=181)
    assert project_response(record, run)["response_state"] == state


@pytest.mark.parametrize("state", ["ignored", "no_reply", "completed", "failed", "interrupted", "unconfirmed"])
def test_terminal_facts_survive_expiry_or_missing_run(state):
    record = snapshot(state)
    record.response_reason = "agent_decision"
    run = execution("finished")
    run.expires_at -= dt.timedelta(days=1)
    for current in [run, None]:
        result = project_response(record, current)
        assert result["response_state"] == state
        assert result["derived"] is False
        assert result["reason"] == "agent_decision"


@pytest.mark.parametrize("mutation,reason", [("agent_id", "run_missing"), ("room_id", "run_missing"),
                                           ("message_ids", "run_missing"), ("finished", "missing_decision"),
                                           ("queued", "inconsistent_run"), ("missing", "run_missing")])
def test_unverifiable_active_runs_are_not_claimed_as_thinking(mutation, reason):
    run = execution()
    if mutation == "missing":
        run = None
    elif mutation in ("finished", "queued"):
        run.status = mutation
    else:
        setattr(run, mutation, [] if mutation == "message_ids" else "other")
    result = project_response(snapshot("processing"), run)
    assert result["response_state"] == "unconfirmed"
    assert result["reason"] == reason


def test_legacy_silence_is_unknown_and_reason_is_allowlisted():
    record = snapshot(None)
    record.response_status = "no_reply"
    record.response_reason = "secret exception"
    assert project_response(record, None)["response_state"] == "unknown"
    record.response_state = "failed"
    assert project_response(record, None)["reason"] is None


@pytest.mark.asyncio
async def test_unmentioned_agent_input_and_retry_use_current_attempt(db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1",))
    record = (await db.execute(select(MessageRecord).where(MessageRecord.msg_id == "m1"))).scalar_one()
    record.sender_id = seed["agent2"]
    record.source_type = "agent"
    record.mentioned = False
    await action(db, agent, "queue", ["m1"])
    first = (await load_room_message_activity(db, ROOM, ["m1"]))["m1"][0]
    assert first["response_state"] == "queued"
    assert first["status"] == "waiting"
    await action(db, agent, "finish", outcome="failed", reason="runtime_error")
    await action(db, agent, "queue", ["m1"], run="retry")
    events_before = await db.scalar(select(func.count()).select_from(MessageResponseEvent))
    result = (await load_room_message_activity(db, ROOM, ["m1"]))["m1"][0]
    assert result["run_id"] == "retry"
    assert result["response_state"] == "queued"
    assert result["reason"] is None
    assert result["updated_at"].endswith("+00:00")
    assert await db.scalar(select(func.count()).select_from(MessageResponseEvent)) == events_before
    record.recalled_at = dt.datetime.now(dt.timezone.utc)
    assert (await load_room_message_activity(db, ROOM, ["m1"]))["m1"] == []


@pytest.mark.asyncio
async def test_poll_exposes_distinct_ignored_no_reply_and_replying(client, db_session, seed):
    db, agent = db_session, seed["agent1"]
    await inputs(db, agent, ("m1", "m2", "m3"))
    run = await action(db, agent, "register", ["m1", "m2", "m3"])
    await action(db, agent, "ignore", ["m1"], reason="attention_policy")
    await action(db, agent, "start", ["m2", "m3"])
    await action(db, agent, "no_reply", ["m2"], reason="agent_decision")
    await action(db, agent, "replying", ["m3"])
    await db.commit()
    path = f"/api/dashboard/rooms/{ROOM}/messages"
    response = await client.get(path, headers=_h(seed["token1"], agent), params={"activity_for": "m1,m2,m3"})
    assert response.status_code == 200
    rows = response.json()["activity_updates"]
    assert [rows[x][0]["response_state"] for x in ["m1", "m2", "m3"]] == ["ignored", "no_reply", "replying"]
    assert [rows[x][0]["status"] for x in ["m1", "m2", "m3"]] == ["no_reply", "no_reply", "processing"]
    assert rows["m1"][0]["reason"] == "attention_policy"
    before = await db.scalar(select(func.count()).select_from(MessageResponseEvent))
    run.expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    await db.commit()
    refreshed = await client.get(path, headers=_h(seed["token1"], agent),
                                 params={"after": f"h_{agent}_m3", "activity_for": "m1,m2,m3"})
    assert refreshed.json()["messages"] == []
    latest = refreshed.json()["activity_updates"]
    assert [latest[x][0]["response_state"] for x in ["m1", "m2", "m3"]] == ["ignored", "no_reply", "interrupted"]
    assert latest["m3"][0]["reason"] == "lease_expired"
    assert latest["m3"][0]["updated_at"] == rows["m3"][0]["updated_at"]
    assert await db.scalar(select(func.count()).select_from(MessageResponseEvent)) == before
    assert (await client.get(path, params={"activity_for": "m1"})).json()["activity_updates"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("delivery", [MessageState.acked, MessageState.done, MessageState.processing])
async def test_delivery_never_proves_thinking_or_reply(db_session, seed, delivery):
    await inputs(db_session, seed["agent1"], ("m1",))
    record = (await db_session.execute(select(MessageRecord).where(MessageRecord.msg_id == "m1"))).scalar_one()
    record.state = delivery
    result = (await load_room_message_activity(db_session, ROOM, ["m1"]))["m1"][0]
    assert result["response_state"] == "unknown"


def test_timestamp_is_utc_without_changing_the_fact():
    record = snapshot("completed")
    stamp = dt.datetime(2026, 10, 14, 12, tzinfo=dt.timezone(dt.timedelta(hours=8)))
    record.response_updated_at = stamp
    assert project_response(record, None)["updated_at"] == "2026-10-14T04:00:00+00:00"
    assert record.response_updated_at is stamp


@pytest.mark.asyncio
async def test_recipient_states_and_old_trace_evidence_stay_independent(db_session, seed):
    from hub.services.message_responses import record_response
    db, first, second = db_session, seed["agent1"], seed["agent2"]
    await inputs(db, first, ("m1",))
    await inputs(db, second, ("m1",))
    await action(db, first, "register", ["m1"], run="first")
    await action(db, second, "register", ["m1"], run="second")
    await action(db, first, "ignore", ["m1"], run="first", reason="attention_policy")
    await record_response(db, reply(second, ["m1"], run="second"), ROOM)
    results = {x["agent_id"]: x for x in (await load_room_message_activity(db, ROOM, ["m1"]))["m1"]}
    assert results[first]["response_state"] == "ignored"
    assert results[first]["reply_msg_id"] is None
    assert results[second]["response_state"] == "completed"
    assert results[second]["reply_msg_id"] == "reply1"
    assert await load_room_message_activity(db, "other-room", ["m1"]) == {"m1": []}
