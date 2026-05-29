# Owner Chat In-Flight Stream Cache PRD

## Summary

Owner-chat streaming is currently delivered over WebSocket only. If the owner refreshes the page, switches pages, or reconnects before the final assistant reply is produced, intermediate stream blocks are lost from the frontend state.

This PRD proposes a short-lived Redis cache for in-flight owner-chat stream blocks. The cache is not a long-term trace store. It exists only to restore the streaming UI while a run is still active, and expires shortly after the final reply is delivered.

## Problem

The current owner-chat path has real-time streaming, but the stream state is volatile:

- The Hub keeps trace routing in process memory.
- Stream blocks are forwarded to connected WebSocket clients.
- The frontend stores stream blocks in local UI state.
- Final replies are persisted as normal messages, but intermediate blocks are not recoverable after refresh.

This creates a bad experience for longer runs:

- The owner sees useful execution progress.
- They refresh or navigate away.
- They return before the final answer exists.
- The UI loses the in-progress execution state and appears blank, stuck, or less informative.

## Goals

- Preserve in-flight owner-chat stream blocks across page refresh, page navigation, and short WebSocket reconnects.
- Keep storage bounded with short TTLs and per-run caps.
- Avoid storing full raw runtime output, long reasoning traces, or large tool results by default.
- Preserve current real-time WebSocket behavior.
- Keep Postgres as the source of truth for final chat messages, not transient stream state.

## Non-Goals

- Do not build a permanent execution trace/audit system in this phase.
- Do not persist full token streams.
- Do not persist full raw tool outputs by default.
- Do not expose Redis to daemon processes.
- Do not make Redis availability required for live streaming.

## Current Flow

```text
Owner dashboard
  -> WebSocket send
  -> Hub creates owner-chat MessageRecord
  -> Hub registers in-memory trace subscription
  -> Hub notifies daemon inbox
  -> daemon executes runtime
  -> daemon POST /hub/stream-block
  -> Hub forwards stream_block over owner-chat WebSocket
  -> frontend stores blocks in local state
  -> daemon POST /hub/send final reply
  -> Hub persists final reply as MessageRecord
```

Current limitation: if the frontend reloads before the final reply, only the final message path is durable. Stream blocks live in memory/UI state only.

## Proposed Flow

The daemon should not dual-write. It should continue sending stream blocks only to the Hub.

The Hub should dual-output each stream block:

```text
Runtime
  -> daemon normalizes stream block
  -> daemon POST /hub/stream-block
  -> Hub validates trace ownership
  -> Hub compacts/truncates block
  -> Hub writes Redis in-flight cache
  -> Hub pushes stream_block over WebSocket
```

When the final assistant reply is delivered:

```text
daemon POST /hub/send
  -> Hub persists final MessageRecord
  -> Hub pushes final owner-chat message over WebSocket
  -> Hub marks Redis run completed
  -> Hub shortens Redis TTL
```

## Multi-Hub Fanout

Introducing Redis also gives us a clean path to support multiple Hub instances for owner-chat streaming.

Today, WebSocket connections are process-local. If the owner dashboard connects to Hub instance A, but a stream block request lands on Hub instance B, instance B cannot directly see the WebSocket held by instance A.

Redis should solve this with broadcast fanout, not by moving WebSocket ownership out of the Hub process.

```text
Browser owner-chat WS
  -> connected to Hub A

daemon POST /hub/stream-block
  -> load balancer routes request to Hub B
  -> Hub B validates trace ownership
  -> Hub B writes Redis in-flight cache
  -> Hub B publishes Redis fanout event
  -> all Hub instances receive the fanout event
  -> Hub A sees it has the local WebSocket
  -> Hub A sends stream_block to Browser
```

Redis responsibilities:

- **Cache**: short-lived replay data for refresh/reconnect recovery.
- **Pub/Sub fanout**: broadcast live owner-chat events to every Hub instance so the instance holding the WebSocket can deliver them.

Hub process responsibilities:

- Keep actual WebSocket objects in local memory.
- Subscribe to owner-chat Redis fanout events.
- On each event, check local `(user_id, agent_id)` WebSocket connections.
- Deliver the event only if this process has matching local connections.

This does not require sticky sessions for correctness. Sticky sessions may still reduce connection churn, but live event delivery should not depend on a stream-block HTTP request landing on the same Hub instance as the browser WebSocket.

### Fanout channels

MVP options:

```text
owner_chat_events
```

or sharded by agent:

```text
owner_chat_events:{agent_id}
```

Start with one channel if traffic is low and operational simplicity matters. Move to sharded channels when event volume requires it.

The fanout payload should include enough routing context:

```json
{
  "type": "stream_block",
  "trace_id": "h_...",
  "user_id": "usr_...",
  "agent_id": "ag_...",
  "room_id": "rm_oc_...",
  "seq": 12,
  "block": {
    "kind": "tool_call",
    "seq": 12,
    "payload": {
      "name": "web_search"
    }
  },
  "created_at": "2026-05-29T..."
}
```

Final owner-chat message, typing, and run status events can use the same fanout path:

- `stream_block`
- `message`
- `typing`
- `run_status`

### Ordering and dedupe

Write cache before publish:

```text
receive block -> compact -> write Redis cache -> publish fanout
```

This ensures that if WebSocket delivery fails, refresh/reconnect can still recover from Redis.

Every event must include `trace_id + seq` or `hub_msg_id` so frontend and Hub listeners can de-duplicate repeated events.

### Why not Redis consumer groups?

Redis consumer groups are queue-like: each event is delivered to one consumer in the group. Owner-chat fanout needs broadcast semantics because only the Hub process that owns the local WebSocket can send to that browser. Therefore each Hub instance should receive the event and decide locally whether to deliver it.

Redis Streams can still be used for replay/cache. Pub/Sub or a broadcast-style Stream reader should be used for live multi-instance fanout.

## Redis Data Model

Use Redis only for short-lived run state.

### Run metadata

Key:

```text
owner_chat_run:{trace_id}
```

Type: hash

Fields:

- `trace_id`
- `user_id`
- `agent_id`
- `room_id`
- `trigger_msg_id`
- `status`: `running | completed | failed`
- `started_at`
- `completed_at`
- `final_msg_id`
- `event_count`
- `last_seq`

Default TTL while running: 30-60 minutes.

TTL after completion: 2-5 minutes.

### Stream events

Key:

```text
owner_chat_run:{trace_id}:events
```

Type: Redis Stream preferred, Redis List acceptable for MVP.

Each event stores:

- `seq`
- `kind`
- `created_at`
- `payload_compact`
- `truncated`
- `size_bytes`

Redis Stream is preferred because it has natural append-only event IDs and reconnect semantics. A List is simpler if the frontend only needs full replay on refresh.

## Block Compaction

Before writing Redis, the Hub should normalize stream blocks into compact payloads.

Suggested defaults:

- Keep `assistant` text chunks only while the run is active.
- Keep `tool_call` name and compact parameters.
- Keep `tool_result` status and short result preview.
- Keep `reasoning` as metadata or short summary only, not full hidden reasoning.
- Keep `system` blocks only when useful for UX/debugging.
- Drop unknown oversized fields.

Caps:

- Max events per trace: reuse the current 200-block cap, or lower to 100 for persisted cache.
- Max compact payload per event: 4-8 KB.
- Max total cached bytes per run: configurable, e.g. 256 KB or 1 MB.

If a block exceeds the limit:

- Store `truncated: true`.
- Store a short preview.
- Do not store the full raw payload.

## API Changes

### Restore in-flight run

Add an owner-authenticated dashboard endpoint:

```text
GET /api/dashboard/chat/runs/{trace_id}/stream-blocks
```

Response:

```json
{
  "trace_id": "h_...",
  "status": "running",
  "room_id": "rm_oc_...",
  "agent_id": "ag_...",
  "events": [
    {
      "seq": 1,
      "kind": "tool_call",
      "created_at": "2026-05-29T...",
      "block": {
        "kind": "tool_call",
        "seq": 1,
        "payload": {
          "name": "web_search"
        }
      }
    }
  ]
}
```

Authorization rules:

- The requester must own the `agent_id`.
- The run must belong to the owner's owner-chat room.
- If Redis has expired the run, return `404` or an empty completed response.

### Optional active runs endpoint

If the frontend cannot reliably infer which trace to restore from local state or recent messages, add:

```text
GET /api/dashboard/chat/active-runs?agent_id=ag_...
```

This returns recent running owner-chat traces for the owner and agent.

## Frontend Behavior

On page load or owner-chat pane mount:

1. Load normal owner-chat messages.
2. Identify recent user messages without a final assistant reply, or call `active-runs`.
3. Fetch cached stream blocks for active traces.
4. Recreate streaming placeholders from cached events.
5. Continue receiving new blocks over WebSocket.
6. When the final assistant message arrives, merge it with the placeholder as today.

If cache restore fails, the UI should degrade gracefully and wait for the final message.

## Failure Modes

### Redis write fails

Live streaming should continue.

Behavior:

- Log warning.
- Push WS block if a client is connected.
- Do not fail `/hub/stream-block`.

Impact: refresh recovery may lose blocks during Redis outage.

### WebSocket push fails

Redis already has the block if write happens first.

Behavior:

- Keep Redis cache.
- Frontend can recover after reconnect.

### Hub process restarts

In-memory trace subscriptions are lost, but Redis run metadata can recover enough context for restore. A follow-up can replace in-memory trace routing with Redis-backed routing if needed.

### Final reply never arrives

Run expires automatically after the running TTL.

Optional enhancement:

- Mark stale runs `failed` before expiry if no block arrives for N minutes.

## Storage Policy

This feature should be explicitly short-lived.

Recommended defaults:

- Running TTL: 60 minutes.
- Completed TTL: 5 minutes.
- Failed/stale TTL: 10 minutes.
- Max persisted events per run: 100-200.
- Max compact event payload: 4-8 KB.
- Max total cache bytes per run: configurable.

This keeps storage proportional to active runs, not historical traffic.

## Rollout Plan

### Phase 1: Hub cache write

- Add Redis helper for owner-chat stream cache.
- Write run metadata when owner-chat WS creates a trigger message.
- Write compact stream events in `/hub/stream-block`.
- Shorten TTL when final owner-chat message arrives.

### Phase 2: Restore API

- Add `GET /api/dashboard/chat/runs/{trace_id}/stream-blocks`.
- Add tests for auth, running restore, completed TTL behavior, and expired runs.

### Phase 3: Frontend restore

- On owner-chat mount, restore active cached stream blocks.
- Merge restored blocks with live WebSocket blocks by `trace_id + seq`.
- Preserve existing final-message merge behavior.

### Phase 4: Hardening

- Add payload byte caps.
- Add Redis failure fallback tests.
- Add metrics for cache writes, restore hits, restore misses, and truncation.

## Acceptance Criteria

- Refreshing the owner-chat page during an active run restores previously streamed blocks.
- Switching away and back during an active run restores previously streamed blocks.
- Final assistant replies are still persisted through the existing message path.
- Redis cache expires shortly after final reply delivery.
- Redis outage does not break live WebSocket streaming.
- Cached events are compact/truncated and bounded by per-run limits.
- No daemon process needs Redis access.
