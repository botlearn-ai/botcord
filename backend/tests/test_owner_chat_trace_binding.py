"""Regression tests for owner-chat reply ↔ run trace binding.

The owner-chat WS pushes reasoning stream blocks keyed by the trigger's
``trace_id`` (== trigger ``hub_msg_id``). The final agent reply must carry the
SAME trace_id so the dashboard merges the reasoning above the answer instead of
orphaning it into a separate placeholder. Previously the Hub guessed the trace
from "most recent registered trace", which mis-attributed replies when turns
overlapped. Now the daemon stamps an explicit ``trace_id`` on the reply and the
Hub honors it.
"""

import datetime

import pytest

from hub.routers import owner_chat_ws


class _FakeWS:
    """Minimal stand-in for a connected owner-chat WebSocket."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)


@pytest.mark.asyncio
async def test_explicit_trace_id_wins_over_most_recent_and_preserves_others(
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = "u_trace_bind"
    agent_id = "ag_trace_bind"
    room_id = owner_chat_ws._build_owner_chat_room_id(user_id, agent_id)

    # Two overlapping runs registered for the same (user, agent). run1 is the
    # one that actually produced this reply; run2 is a newer, still-in-flight
    # turn whose trace the legacy "most recent" heuristic would wrongly pick.
    run1 = "h_run1"
    run2 = "h_run2"
    owner_chat_ws._oc_trace_subs[run1] = (user_id, agent_id)
    owner_chat_ws._oc_trace_subs[run2] = (user_id, agent_id)
    owner_chat_ws._oc_trace_block_count[run1] = 0
    owner_chat_ws._oc_trace_block_count[run2] = 0

    ws = _FakeWS()
    owner_chat_ws._oc_ws_connections[(user_id, agent_id)] = {ws}

    completed: list[str] = []

    async def _fake_mark_completed(tid: str, *, final_msg_id: str) -> None:
        completed.append(tid)

    monkeypatch.setattr(
        owner_chat_ws.owner_chat_cache, "mark_run_completed", _fake_mark_completed
    )

    try:
        await owner_chat_ws.notify_oc_ws_message(
            room_id=room_id,
            hub_msg_id="h_reply_1",
            sender_id=agent_id,
            trace_id=run1,
            text="the answer",
            created_at=datetime.datetime.now(datetime.timezone.utc),
        )

        # The pushed message carries the explicit trace, not the most-recent run2.
        assert len(ws.sent) == 1
        assert ws.sent[0]["ext"]["trace_id"] == run1

        # Only run1 is cleaned up / completed; the concurrent run2 survives.
        assert run1 not in owner_chat_ws._oc_trace_subs
        assert run2 in owner_chat_ws._oc_trace_subs
        assert completed == [run1]
    finally:
        owner_chat_ws._oc_ws_connections.pop((user_id, agent_id), None)
        owner_chat_ws._cleanup_trace(run1)
        owner_chat_ws._cleanup_trace(run2)


@pytest.mark.asyncio
async def test_legacy_no_trace_id_falls_back_to_most_recent(
    monkeypatch: pytest.MonkeyPatch,
):
    """Trace-less senders keep the old behavior: most-recent trace, pop all."""
    user_id = "u_legacy"
    agent_id = "ag_legacy"
    room_id = owner_chat_ws._build_owner_chat_room_id(user_id, agent_id)

    older = "h_older"
    newer = "h_newer"
    owner_chat_ws._oc_trace_subs[older] = (user_id, agent_id)
    owner_chat_ws._oc_trace_subs[newer] = (user_id, agent_id)

    ws = _FakeWS()
    owner_chat_ws._oc_ws_connections[(user_id, agent_id)] = {ws}

    monkeypatch.setattr(
        owner_chat_ws.owner_chat_cache,
        "mark_run_completed",
        lambda *a, **k: _noop(),
    )

    try:
        await owner_chat_ws.notify_oc_ws_message(
            room_id=room_id,
            hub_msg_id="h_reply_2",
            sender_id=agent_id,
            text="legacy answer",
        )
        assert ws.sent[0]["ext"]["trace_id"] == newer
        # Legacy path pops all matched traces.
        assert older not in owner_chat_ws._oc_trace_subs
        assert newer not in owner_chat_ws._oc_trace_subs
    finally:
        owner_chat_ws._oc_ws_connections.pop((user_id, agent_id), None)
        owner_chat_ws._cleanup_trace(older)
        owner_chat_ws._cleanup_trace(newer)


@pytest.mark.asyncio
async def test_error_frame_fails_explicit_trace_and_preserves_shape(
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = "u_error"
    agent_id = "ag_error"
    room_id = owner_chat_ws._build_owner_chat_room_id(user_id, agent_id)
    trace_id = "h_trigger_error"
    owner_chat_ws._oc_trace_subs[trace_id] = (user_id, agent_id)
    owner_chat_ws._oc_trace_block_count[trace_id] = 3

    ws = _FakeWS()
    owner_chat_ws._oc_ws_connections[(user_id, agent_id)] = {ws}

    failed: list[str] = []

    async def _fake_mark_failed(tid: str) -> None:
        failed.append(tid)

    monkeypatch.setattr(
        owner_chat_ws.owner_chat_cache, "mark_run_failed", _fake_mark_failed
    )

    try:
        await owner_chat_ws.notify_oc_ws_error(
            room_id=room_id,
            hub_msg_id=trace_id,
            trace_id=trace_id,
            code="missing_credentials",
            message="Cloud agent is temporarily unavailable. Please retry in a moment.",
        )

        assert ws.sent == [
            {
                "type": "error",
                "hub_msg_id": trace_id,
                "trace_id": trace_id,
                "room_id": room_id,
                "message": "Cloud agent is temporarily unavailable. Please retry in a moment.",
                "created_at": ws.sent[0]["created_at"],
                "error": {
                    "code": "missing_credentials",
                    "message": "Cloud agent is temporarily unavailable. Please retry in a moment.",
                    "retryable": True,
                },
            }
        ]
        assert failed == [trace_id]
        assert trace_id not in owner_chat_ws._oc_trace_subs
        assert trace_id not in owner_chat_ws._oc_trace_block_count
    finally:
        owner_chat_ws._oc_ws_connections.pop((user_id, agent_id), None)
        owner_chat_ws._cleanup_trace(trace_id)


async def _noop() -> None:
    return None
