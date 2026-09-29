import ast
import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hub import stage_diagnostics as diagnostics
from hub.routers import hub


@pytest.fixture
def capture(monkeypatch):
    records = []
    monkeypatch.setattr(diagnostics, "ENABLED", True)
    monkeypatch.setattr(diagnostics, "_operations", 0)
    monkeypatch.setattr(diagnostics.logger, "info", lambda template, data: records.append(json.loads(data)))
    return records


def publisher():
    # conftest replaces the production publisher globally for SQLite. Compile
    # its actual source unchanged to exercise the real failure boundaries.
    tree = ast.parse(Path(hub.__file__).read_text())
    function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                    and n.name == "_publish_agent_realtime_event")
    namespace = dict(vars(hub))
    exec(compile(ast.Module(body=[function], type_ignores=[]), hub.__file__, "exec"), namespace)
    return namespace[function.name]


@pytest.mark.asyncio
async def test_disabled_and_sink_failure_do_not_change_result(capture, monkeypatch):
    monkeypatch.setattr(diagnostics, "ENABLED", False)
    with diagnostics.operation("server", "private payload"):
        assert await hub.notify_inbox("ag_unconnected") == 0
    assert capture == []
    monkeypatch.setattr(diagnostics, "ENABLED", True)
    monkeypatch.setattr(diagnostics.logger, "info", lambda *args: (_ for _ in ()).throw(RuntimeError("sink")))
    with diagnostics.operation("server", "private payload"):
        assert await hub.notify_inbox("ag_unconnected") == 0
    assert diagnostics._current.get() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [None, "execute", "commit", "rollback", "cancel"])
async def test_publisher_semantics(capture, failure):
    db = SimpleNamespace(execute=AsyncMock(), commit=AsyncMock(), rollback=AsyncMock())
    if failure in ("execute", "rollback"):
        db.execute.side_effect = ValueError("SECRET exception")
    if failure == "commit":
        db.commit.side_effect = ValueError("SECRET exception")
    if failure == "rollback":
        db.rollback.side_effect = RuntimeError("SECRET rollback")
    if failure == "cancel":
        db.execute.side_effect = asyncio.CancelledError()
    event = {"type": "message", "agent_id": "ag_test", "payload": "SECRET body", "hub_msg_id": "delivery"}
    with diagnostics.operation("server", "SECRET message"):
        if failure == "rollback":
            with pytest.raises(RuntimeError):
                await publisher()(db, event)
        elif failure == "cancel":
            with pytest.raises(asyncio.CancelledError):
                await publisher()(db, event)
        else:
            assert await publisher()(db, event) is None
    by_name = {r["stage"]: r for r in capture}
    assert by_name["publish"]["outcome"] == {
        None: "completed", "execute": "handled_error", "commit": "handled_error",
        "rollback": "error", "cancel": "cancelled",
    }[failure]
    if failure in ("execute", "rollback", "cancel"):
        db.commit.assert_not_awaited()
    if failure in (None, "cancel"):
        db.rollback.assert_not_awaited()
    else:
        db.rollback.assert_awaited_once()
    assert "SECRET" not in json.dumps(capture)


@pytest.mark.asyncio
async def test_caps_parentage_and_background_exclusion(capture, monkeypatch):
    monkeypatch.setattr(diagnostics, "MAX_STAGES", 3)
    monkeypatch.setattr(diagnostics, "MAX_OPERATIONS_PER_MINUTE", 1)
    async def background():
        with diagnostics.stage("background"):
            await asyncio.sleep(0)
    with diagnostics.operation("one", "logical"):
        with diagnostics.stage("outer"):
            await asyncio.create_task(background())
            with diagnostics.stage("inner"):
                pass
        for _ in range(10):
            with diagnostics.stage("dropped"):
                pass
    with diagnostics.operation("two", "logical"):
        with diagnostics.stage("second_operation"):
            pass
    stages = {r["stage"]: r for r in capture}
    assert set(stages) == {"send.handler", "outer", "inner", "capture.summary"}
    assert stages["inner"]["parent_stage_id"] == stages["outer"]["stage_id"]
    assert stages["outer"]["parent_stage_id"] == stages["send.handler"]["stage_id"]
    assert stages["capture.summary"]["captured_stages"] == 3
    assert stages["capture.summary"]["dropped_stages"] == 10
    assert stages["capture.summary"]["truncated"] is True


@pytest.mark.asyncio
async def test_concurrent_same_message_separate_operations(capture):
    async def send(request):
        with diagnostics.operation(request, "same"):
            await asyncio.sleep(0)
            with diagnostics.stage("notification"):
                await asyncio.sleep(0)
    await asyncio.gather(send("first"), send("second"))
    summaries = [r for r in capture if r["stage"] == "capture.summary"]
    assert len({r["operation_id"] for r in summaries}) == 2
    assert {r["message_id_sha256"] for r in summaries} == {hashlib.sha256(b"same").hexdigest()}
    for summary in summaries:
        assert {r["server_request_id"] for r in capture if r["operation_id"] == summary["operation_id"]} == {summary["server_request_id"]}


@pytest.mark.asyncio
async def test_notify_resume_condition_ws_outcomes(capture, monkeypatch):
    from hub.services import cloud_agent
    resume = AsyncMock(return_value=False)
    monkeypatch.setattr(cloud_agent, "resume_cloud_agent_for_inbox", resume)
    class Socket:
        send_json = AsyncMock(side_effect=RuntimeError("SECRET"))
        client_state = "test"
    socket = Socket()
    monkeypatch.setitem(hub._ws_connections, "ag_sample", {socket})
    with diagnostics.operation("server", "logical"):
        assert await hub.notify_inbox("ag_sample", db=object()) == 0
    by_name = {r["stage"]: r for r in capture}
    assert by_name["notify.resume"]["outcome"] == "returned_false"
    assert by_name["notify.condition"]["outcome"] == "skipped"
    assert by_name["notify.ws_send"]["outcome"] == "error"
    assert "ag_sample" not in hub._ws_connections
    assert "SECRET" not in json.dumps(capture)


@pytest.mark.asyncio
async def test_surrogate_ids_and_failure_cleanup(capture):
    with pytest.raises(ValueError, match="business"):
        with diagnostics.operation("server", "\ud800"):
            with diagnostics.stage("notify", receiver_id="\ud800", delivery_id="\ud800"):
                raise ValueError("business")
    assert diagnostics._current.get() is None
    assert {r["outcome"] for r in capture if "outcome" in r} == {"error"}


@pytest.mark.asyncio
@pytest.mark.parametrize("at", ["resume", "ws"])
async def test_notify_cancellation_propagates_and_cleans_scope(capture, monkeypatch, at):
    from hub.services import cloud_agent
    resume = AsyncMock(side_effect=asyncio.CancelledError() if at == "resume" else None)
    monkeypatch.setattr(cloud_agent, "resume_cloud_agent_for_inbox", resume)
    class Socket:
        send_json = AsyncMock(side_effect=asyncio.CancelledError())
        client_state = "test"
    socket = Socket()
    monkeypatch.setitem(hub._ws_connections, "ag_cancel", {socket})
    with pytest.raises(asyncio.CancelledError):
        with diagnostics.operation("server", "logical"):
            await hub.notify_inbox("ag_cancel", db=object())
    assert diagnostics._current.get() is None
    by_name = {r["stage"]: r for r in capture}
    assert by_name["notify"]["outcome"] == "cancelled"
    assert by_name["send.handler"]["outcome"] == "cancelled"
    assert by_name["notify.resume" if at == "resume" else "notify.ws_send"]["outcome"] == "cancelled"
    assert socket in hub._ws_connections["ag_cancel"]
