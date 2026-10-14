"""Member-visible reply progress, keyed by the original message and receiver."""
import datetime as dt
import json
from typing import get_args

from sqlalchemy import JSON, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from hub.models import Agent, MessageRecord, MessageResponseRun
from hub.services.message_responses import expired
from hub.services.message_response_states import ResponseReason, ResponseState, ACTIVE_ORDER
from hub.policy import is_direct_room_id


def project_response(record: MessageRecord, run: MessageResponseRun | None) -> dict:
    """Read-only projection of the current attempt; never synthesize durable events."""
    state = record.response_state
    reason = record.response_reason if record.response_reason in get_args(ResponseReason) else None
    derived = False
    if state not in get_args(ResponseState):
        # Old no_reply does not distinguish a policy skip from a runtime decision.
        state = record.response_status
        if state not in get_args(ResponseState) or state == "no_reply":
            state = "unknown"
        reason = None
    if state in ACTIVE_ORDER:
        valid_run = run is not None and run.agent_id == record.receiver_id and run.room_id == record.room_id
        valid_run = valid_run and record.msg_id in run.message_ids
        if not valid_run:
            state, reason, derived = "unconfirmed", "run_missing", True
        elif run.status not in ("queued", "running"):
            state, reason, derived = "unconfirmed", "missing_decision", True
        elif expired(run):
            state, reason, derived = "interrupted", "lease_expired", True
        elif (state == "queued") != (run.status == "queued"):
            state, reason, derived = "unconfirmed", "inconsistent_run", True
    updated_at = record.response_updated_at
    if updated_at is not None:
        if updated_at.tzinfo is None:
            updated_at = updated_at.replace(tzinfo=dt.timezone.utc)
        updated_at = updated_at.astimezone(dt.timezone.utc).isoformat()
    return {"response_state": state, "reason": reason, "derived": derived, "updated_at": updated_at}


async def load_room_message_activity(db: AsyncSession, room_id: str, msg_ids: list[str]) -> dict:
    activity = {msg_id: [] for msg_id in msg_ids}
    if not msg_ids:
        return activity
    rows = (await db.execute(
        select(MessageRecord, Agent.display_name, Agent.avatar_url)
        .join(Agent, Agent.agent_id == MessageRecord.receiver_id)
        .where(MessageRecord.room_id == room_id, MessageRecord.msg_id.in_(msg_ids))
        .order_by(MessageRecord.id)
    )).all()
    if not rows:
        return activity
    run_ids = {record.response_run_id for record, _, _ in rows if record.response_run_id}
    runs = {run.run_id: run for run in (await db.execute(
        select(MessageResponseRun).where(MessageResponseRun.run_id.in_(run_ids))
    )).scalars().all()} if run_ids else {}
    # A quote can point at an older message. Prefer the runtime's trace_id,
    # which identifies the actual trigger, over the visible quote pointer.
    triggers = {record.hub_msg_id: record.msg_id for record, _, _ in rows}
    trace_id = (
        cast(MessageRecord.envelope_json, JSON)["trace_id"].as_string()
        if db.bind is not None and db.bind.dialect.name == "postgresql"
        else func.json_extract(MessageRecord.envelope_json, "$.trace_id")
    )
    reply_rows = (await db.execute(
        select(MessageRecord).where(
            MessageRecord.room_id == room_id,
            MessageRecord.id > min(record.id for record, _, _ in rows),
            MessageRecord.sender_id.in_({record.receiver_id for record, _, _ in rows}),
            or_(MessageRecord.reply_to_msg_id.in_(msg_ids), trace_id.in_(triggers)),
        )
    )).scalars().all()
    replied = set()
    failed = set()
    for reply in reply_rows:
        try:
            envelope = json.loads(reply.envelope_json)
        except (ValueError, TypeError):
            continue
        # Explicit response metadata is authoritative; its quote pointer is
        # presentation only and must never complete a different legacy input.
        if isinstance(envelope.get("payload"), dict) and envelope["payload"].get("response") is not None:
            continue
        target = triggers.get(envelope["trace_id"]) if envelope.get("trace_id") else reply.reply_to_msg_id
        if target is None:
            continue
        if envelope.get("type") == "message":
            replied.add((target, reply.sender_id))
        elif envelope.get("type") == "error":
            failed.add((target, reply.sender_id))
    for record, name, avatar in rows:
        if record.recalled_at or (record.sender_id == record.receiver_id and record.source_type != "dashboard_user_chat"):
            continue
        projection = project_response(record, runs.get(record.response_run_id))
        state = record.state.value
        if record.response_status:
            status = record.response_status
            run = runs.get(record.response_run_id)
            if status in ("waiting", "processing") and (run is None or expired(run)):
                status = "interrupted"
            elif status in ("waiting", "processing") and run.status != "running":
                status = "unconfirmed"
        elif (record.msg_id, record.receiver_id) in replied or state == "done":
            status = "completed"
        elif state == "failed" or (record.msg_id, record.receiver_id) in failed:
            status = "failed"
        elif state == "processing":
            # An inbox lease says nothing about the agent's response decision.
            status = "waiting"
        elif state in ("delivered", "acked"):
            status = "unconfirmed"
        else:
            status = "waiting"
        if record.response_state:
            status = {"queued": "waiting", "ignored": "no_reply", "replying": "processing",
                      "unknown": "unconfirmed"}.get(projection["response_state"], projection["response_state"])
        elif projection["response_state"] == "unknown":
            # Reply evidence is useful for old messages; ACK/done alone is not
            # evidence of a response or of an agent's attention decision.
            if (record.msg_id, record.receiver_id) in replied:
                projection.update(response_state="completed", derived=True)
            elif state == "failed" or (record.msg_id, record.receiver_id) in failed:
                projection.update(response_state="failed", derived=True)
            if not (room_id.startswith("rm_oc_") or is_direct_room_id(room_id) or record.mentioned
                    or record.response_status):
                status = "unconfirmed"
        activity[record.msg_id].append({
            **projection,
            "agent_id": record.receiver_id,
            "agent_name": name or record.receiver_id,
            "avatar_url": avatar,
            "status": status,
            "basis": "run" if record.response_state or record.response_status else "legacy",
            "reply_msg_id": record.response_reply_msg_id,
            "run_id": record.response_run_id,
            # Do not expose internal exception strings or credentials to room members.
            "error": ("delivery_expired" if record.last_error == "TTL_EXPIRED" else "agent_execution_failed")
            if status == "failed" else None,
        })
    return activity
