"""Durable per-input facts; the legacy status remains a compatibility snapshot."""
import datetime as dt
from typing import Literal

from hub.models import MessageRecord, MessageResponseEvent

ResponseState = Literal[
    "queued", "waiting", "processing", "ignored", "no_reply", "replying",
    "completed", "failed", "interrupted", "unconfirmed",
]
ResponseReason = Literal[
    "attention_policy", "agent_decision", "queue_overflow", "batch_trimmed",
    "superseded", "cancelled", "runtime_error", "runtime_timeout",
    "reply_send_failed", "missing_decision", "auth_unavailable", "not_executed", "invalid_decision", "response_reporting_failed",
]
TERMINAL = {"ignored", "completed", "no_reply", "failed", "interrupted", "unconfirmed"}
RESOLVED = {"ignored", "completed", "no_reply"}
ACTIVE_ORDER = {"queued": 0, "waiting": 1, "processing": 2, "replying": 3}


def current_state(record: MessageRecord) -> str | None:
    return record.response_state or record.response_status


def transition(db, record: MessageRecord, run_id: str, state: ResponseState,
               reason: str | None = None, reply_msg_id: str | None = None):
    """Caller holds the delivery lock. Repeated reports cannot rewind a run.

    Snapshot and event share the caller's transaction with reply links/messages.
    No raw runtime error, prompt or message body belongs in this ledger.
    """
    previous = current_state(record)
    same_run = record.response_run_id == run_id
    if same_run and record.response_state == state:
        return
    if same_run and previous in ACTIVE_ORDER and state in ACTIVE_ORDER:
        if ACTIVE_ORDER[state] < ACTIVE_ORDER[previous]:
            return
    at = dt.datetime.now(dt.timezone.utc)
    record.response_run_id = run_id
    record.response_state = state
    record.response_status = None if state == "queued" else {"ignored": "no_reply", "replying": "processing"}.get(state, state)
    record.response_reason = reason
    record.response_updated_at = at
    record.response_reply_msg_id = reply_msg_id if state == "completed" else None
    db.add(MessageResponseEvent(
        run_id=run_id, agent_id=record.receiver_id, room_id=record.room_id,
        target_msg_id=record.msg_id, state=state, reason=reason,
        reply_msg_id=reply_msg_id, created_at=at,
    ))
