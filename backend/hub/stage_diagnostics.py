"""Opt-in bounded SEND diagnostics; no payloads or exception strings.

Task ownership deliberately excludes inherited background tasks. This is a
structured-log slice, not a replacement for SDK/driver span attribution.
"""
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
import hashlib
import json
import logging
import os
import time
import uuid

import sentry_sdk

logger = logging.getLogger(__name__)
# Fixed ceilings keep an accidentally enabled process bounded. Enable at startup.
ENABLED = os.getenv("BOTCORD_SEND_STAGE_DIAGNOSTICS", "").lower() == "true"
MAX_OPERATIONS_PER_MINUTE = 10
MAX_STAGES = 256
_window = 0
_operations = 0
_current = ContextVar("send_stage_diagnostics", default=None)


@dataclass
class Capture:
    request_id: str
    message_id_sha256: str
    owner: object
    operation_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    trace_id: str | None = None
    sentry_span_id: str | None = None
    count: int = 0
    dropped: int = 0
    parent: int | None = None
    active: bool = True


def _capture():
    capture = _current.get()
    if capture is not None and capture.active and capture.owner is asyncio.current_task():
        return capture
    return None


def _emit(capture, fields):
    try:
        logger.info("hub.send.stage %s", json.dumps({
            "operation_id": capture.operation_id,
            "server_request_id": capture.request_id,
            "message_id_sha256": capture.message_id_sha256,
            "sentry_trace_id": capture.trace_id,
            "sentry_span_id": capture.sentry_span_id,
            **fields,
        }, sort_keys=True))
    except Exception:
        # Diagnostics must not affect message delivery, including sink failures.
        pass


@contextmanager
def operation(request_id: str, message_id: str):
    global _window, _operations
    if not ENABLED:
        yield
        return
    window = int(time.monotonic() // 60)
    if window != _window:
        _window, _operations = window, 0
    if _operations >= MAX_OPERATIONS_PER_MINUTE:
        yield
        return
    _operations += 1
    capture = Capture(request_id, hashlib.sha256(message_id.encode("utf-8", errors="surrogatepass")).hexdigest(), asyncio.current_task())
    try:
        span = sentry_sdk.get_current_span()
        if span is not None:
            capture.trace_id = span.trace_id
            capture.sentry_span_id = span.span_id
    except Exception:
        pass
    token = _current.set(capture)
    try:
        with stage("send.handler"):
            yield
    finally:
        capture.active = False
        _current.reset(token)
        _emit(capture, {"stage": "capture.summary", "captured_stages": capture.count,
                        "dropped_stages": capture.dropped, "truncated": capture.dropped > 0})


# All field values are internal counts/outcomes; identities are hashed separately.
@contextmanager
def stage(name: str, *, receiver_id=None, delivery_id=None):
    capture = _capture()
    result = {}
    if capture is None:
        yield result
        return
    if capture.count >= MAX_STAGES:
        capture.dropped += 1
        yield result
        return
    capture.count += 1
    stage_id, parent = capture.count, capture.parent
    capture.parent = stage_id
    started = time.monotonic()
    utc_started = time.time()
    outcome = "completed"
    try:
        yield result
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except BaseException:
        outcome = "error"
        raise
    finally:
        capture.parent = parent
        fields = {"stage": name, "stage_id": stage_id, "parent_stage_id": parent,
                  "started_unix": utc_started, "duration_ms": (time.monotonic() - started) * 1000,
                  "outcome": outcome}
        for key, value in (("receiver_id", receiver_id), ("delivery_id", delivery_id)):
            if isinstance(value, str):
                fields[key + "_sha256"] = hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).hexdigest()
        # Fixed allowlist; never serialize arbitrary result values or exceptions.
        if result.get("outcome") in ("skipped", "returned_false", "returned_true", "handled_error") and outcome == "completed":
            fields["outcome"] = result["outcome"]
        _emit(capture, fields)
