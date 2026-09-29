# Bounded SEND stage diagnostics — 2026-09-29

This implementation increment starts at reviewed `7ac8836a` and implements a
focused part of the reviewed callsite plan. It produces correlated structured
logs for future SEND attempts. It does not change the notification algorithm,
SQL, transactions, retry policy, response contract or deployment configuration.
Historical event attribution and production recovery remain unproven.

## Implemented capture

`BOTCORD_SEND_STAGE_DIAGNOSTICS=true` opts in at process startup. The default is
off. Each process captures at most the first **10 handler entries in each
monotonic-clock minute**, with at most **256 stage records plus one summary per
captured attempt**. These fixed caps are not caller-controlled. Sampling is
first-arrival selection, not random or representative; multiple workers each
have their own quota. There is no total dropped-operation counter. Stage caps
count attempted scopes, not recipients or SQL executions; summary reports
captured and dropped stage counts and an explicit truncation flag. No stage
records are accumulated in memory. A truncated capture is not a complete tree.

The scope starts inside `send_message`, after FastAPI dependencies and body
validation, and ends when that handler returns or raises. It does **not** cover
request entry, dependency time, response serialization or response-body
completion. A server-generated operation UUID separates repeated attempts with
the same logical message. `server_request_id` reuses the ID echoed by the
existing middleware. `message_id_sha256`, `receiver_id_sha256` and
`delivery_id_sha256` are SHA256 hashes of the exact identifiers (UTF-8 with
surrogatepass), allowing local equality correlation without arbitrary raw
client strings. Delivery hashes come from the actual realtime event, including
conflict-reused delivery IDs where already supplied by the send path.

Captured stages are:

| Stage | Boundary |
|---|---|
| `send.handler` | Handler body, including room or direct dispatch |
| `room.fanout_write_and_attention` | Room recipient record loop and subsequent inbound attention stamping; excludes prior eligibility/reply lookups |
| `room.commit` | Room fanout transaction commit |
| `notify` | One existing inbox notification invocation, carrying receiver/delivery hashes |
| `notify.resume` | Existing cloud resume helper, with skipped / returned_false / returned_true distinguished |
| `notify.condition` | Condition acquisition and notify_all, or skipped when absent |
| `notify.ws_send` | Each existing awaited WS send_json invocation |
| `notify.realtime` | Await of realtime publisher, including its best-effort handling |
| `room.sender_publish` | Separate sender dashboard publication |
| `publish` | Actual publisher body, with completed / handled_error / error / cancelled |
| `publish.execute`, `publish.commit`, `publish.rollback` | Corresponding awaited database calls inside original publisher failure boundaries |

Stages use fixed source-code names and server-local numeric `stage_id` and
`parent_stage_id`, monotonic duration, and Unix start time. Nested notify and
publisher stages can be joined to receiver/delivery fields through the parent
chain. No stage ID is a Sentry span ID. No high-cardinality metric labels are
created. Each record carries the active Sentry trace/span IDs observed at
handler entry when available; these are **context snapshots**, not newly
created Sentry stage spans. This patch does not establish integration parentage,
SQL origin, SDK sampling decisions or deployed-source equivalence. The local
installed SDK used by tests is `sentry-sdk 2.57.0`.

## Outcomes and behavior preservation

`completed` means the named code boundary returned normally; it is not client
receipt or incident recovery. For `notify.realtime` and `room.sender_publish`,
normal completion can include a best-effort publisher failure: inspect the
nested `publish` outcome and execute/commit/rollback records. A publisher
execute/commit exception followed by successful rollback records
`handled_error`; a rollback exception still propagates and records `error`.
Cancellation still propagates and does not introduce a rollback absent from the
original code. Existing WS disconnect/error cleanup remains intact. A cloud
helper false return is not a successful provider resume; its internal reason
is outside this slice.

Capture ownership is the current asyncio task. Inherited background tasks,
including processing/presence broadcasts, cannot append critical-path records.
The capture has constant-size state, and is marked inactive and reset on
handler completion/cancellation. Background references cannot grow a record
list or continue capture after completion. Concurrent handlers have separate
operation IDs and scopes even when their message IDs match.

New diagnostic logs include no payload, token, arbitrary headers, topic/goal,
SQL parameters, raw identifiers or exception strings. Fixed outcome values are
allowlisted. Logging/JSON sink exceptions are swallowed by the diagnostic
emitter. This change does not redact or remove pre-existing application logs.

## Tests and limitations

Focused tests exercise disabled capture, failing diagnostic sinks, concurrent
same-message attempts, parent linkage, stage/operation limits and truncation,
background task exclusion, surrogate-containing identifiers, publisher success,
execute/commit/rollback failures, publisher cancellation, notify resume/WS
cancellation, cloud false return and WS disconnect cleanup. A real in-memory
SQLite HTTP room send verifies 202, committed receiver inbox content, echoed
server request ID linkage, message/receiver/delivery hashes and room commit /
notification / sender stages. The SQLite suite replaces PostgreSQL publication;
a separate test compiles the unchanged actual publisher function from its
source to exercise its real exception boundaries against controlled async DB
doubles. Neither test proves PostgreSQL wire behavior.

Deferred: middleware entry-to-body-complete timing; actual SDK child spans and
parent/origin validation; matched PostgreSQL/asyncpg reproduction; explicit
background presence/reaction scopes; direct-write/commit stages; owner-chat WS
stages; stable WS connection IDs and aggregate receiver/connection counts;
cloud provider-attempt internals; a fixed-workload overhead benchmark and
production collection/acceptance. Direct sends can emit handler/notify/publisher
stages but do not have room-write stages. Self-delivery publisher calls remain
visible within the handler, without a dedicated self-delivery callsite stage.
No runtime sampling setting, push, deployment or release was performed.

Future rollout must retain the caps and compare diagnostics-off/on overhead
under a matched workload. Ops collection should join stage records by operation
ID and parent_stage_id, then correlate the original message/delivery IDs by
hash; it must not interpret adjacent timestamps or normal publisher-wrapper
return as causal attribution or delivery success.

Validation results:

- Required `uv run pytest tests/`: **1601 passed, 30 skipped, 3049 warnings**, 356.92s.
  This run collected the original 10 new diagnostic cases. All final product
  code was present; the later three test-only additions were collected in the
  separate final focused run below.
- Final `uv run pytest tests/test_send_stage_diagnostics.py tests/test_room.py::test_send_stage_diagnostics_room_linkage -q`:
  **13 passed, 7 warnings**, 3.82s. This includes the additional HTTP room send
  and both notify-cancellation cases.
- `git diff --check`: passed. No live database, runtime or deployment validation.
