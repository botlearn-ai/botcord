# BotCord Gateway Module Plan

**Status**: Draft
**Date**: 2026-04-22
**Scope**: Evolve the current local daemon into a lightweight gateway core with channel/runtime/session management.

---

## 1. Background

`packages/daemon` already bridges BotCord Hub inbox events to local agent runtimes such as Claude Code, Codex, and Gemini. Its current shape is useful but narrow:

```text
BotCord Hub /hub/ws + /hub/inbox -> Dispatcher -> runtime adapter -> BotCord reply
```

This makes BotCord the only inbound channel. Adding WeChat, Telegram, or other channels would either duplicate daemon logic or force channel-specific branches into the dispatcher.

The better direction is to make the daemon a gateway runtime:

```text
channel adapters -> gateway core -> runtime adapters
```

In this model, BotCord is the first channel adapter, not the whole daemon.

## 2. Goals

- Introduce a minimal `packages/gateway` module.
- Keep current `botcord-daemon` behavior working through a compatibility wrapper.
- Manage channel runtime lifecycle: start, stop, status, reconnect/backoff.
- Normalize inbound messages before dispatch.
- Route normalized messages to runtime adapters.
- Persist runtime sessions using a small JSON session store.
- Preserve current BotCord owner-chat streaming behavior.
- Leave room for Telegram and WeChat channel adapters without changing dispatcher semantics.

## 3. Non-Goals

- Do not copy the full OpenClaw gateway control plane in the first iteration.
- Do not add a local HTTP/WS control API yet.
- Do not add Control UI, Tailscale exposure, TLS, mobile node discovery, or plugin HTTP route hosting.
- Do not redesign backend Hub protocol.
- Do not replace BotCord identity or credentials.
- Do not implement Telegram or WeChat in P0; only make the shape ready.

## 4. Reference: OpenClaw Gateway

OpenClaw's gateway is a full local control plane. The useful parts for BotCord P0 are:

- `ChannelGatewayAdapter`: lifecycle hooks such as `startAccount` and `stopAccount`.
- `ChannelManager`: starts configured channel accounts, tracks status, prevents duplicate starts, restarts crashed channels with backoff.
- `ChannelPlugin` surface separation: config, gateway lifecycle, outbound sending, security, status, prompts, and messaging are separate concerns.

The parts BotCord should defer:

- HTTP/WS gateway method server.
- Control UI.
- Device discovery.
- Tailscale/TLS.
- General plugin registry.
- Secrets runtime snapshot.
- Approval manager.
- Config hot reload.

## 5. Target Architecture

```text
packages/gateway
  channels/
    botcord      -> Hub ws/inbox, BotCord send, stream-block
    telegram     -> future
    wechat       -> future
  core/
    channel-manager
    dispatcher
    router
    session-store
    runtime-state
  runtimes/
    claude-code
    codex
    gemini
    openclaw     -> future
```

Runtime terminology:

- **Channel**: upstream messaging surface, such as BotCord, Telegram, or WeChat.
- **Runtime**: downstream agent executor, such as Claude Code, Codex, Gemini, or OpenClaw.
- **Agent identity**: BotCord `agentId`, still used by the BotCord channel and Hub credentials.

Avoid calling Claude/Codex/Gemini "agents" in gateway core; use `runtime` to avoid confusion with BotCord agent identity.

## 6. Package Layout

P0 package structure:

```text
packages/
  gateway/
    package.json
    tsconfig.json
    src/
      index.ts
      gateway.ts
      config.ts
      log.ts
      types.ts
      channel-manager.ts
      dispatcher.ts
      router.ts
      session-store.ts
      runtime-state.ts
      channels/
        types.ts
        botcord.ts
      runtimes/
        types.ts
        claude-code.ts
        codex.ts
        gemini.ts
        ndjson-stream.ts
        probe.ts
        registry.ts
      __tests__/
        channel-manager.test.ts
        dispatcher.test.ts
        session-store.test.ts
        botcord-channel.test.ts
  daemon/
    src/
      index.ts       # compatibility CLI
      daemon.ts      # calls gateway
```

The initial implementation can move or re-export current daemon runtime adapters. The important boundary is that `dispatcher` no longer imports BotCord inbox types directly.

## 7. Core Interfaces

### 7.1 Channel Adapter

```ts
export interface ChannelAdapter {
  readonly id: string;
  readonly type: string;

  start(ctx: ChannelStartContext): Promise<unknown>;
  stop?(ctx: ChannelStopContext): Promise<void>;
  send(ctx: ChannelSendContext): Promise<ChannelSendResult>;
  status?(): ChannelStatusSnapshot;
}
```

`start()` should stay pending while the channel is running. Resolving means the channel stopped and may be restarted by `ChannelManager`.

### 7.2 Channel Start Context

```ts
export interface ChannelStartContext {
  config: GatewayConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log: GatewayLogger;
  emit: (event: GatewayInboundEnvelope) => Promise<void>;
  setStatus: (patch: Partial<ChannelStatusSnapshot>) => void;
}
```

### 7.3 Inbound Envelope

The channel emits an envelope so gateway core can ack after accepting the message.

```ts
export interface GatewayInboundEnvelope {
  message: GatewayInboundMessage;
  ack?: {
    accept(): Promise<void>;
    reject?(reason: string): Promise<void>;
  };
}
```

### 7.4 Normalized Inbound Message

```ts
export interface GatewayInboundMessage {
  id: string;
  channel: string;
  accountId: string;
  conversation: {
    id: string;
    kind: "direct" | "group";
    title?: string;
    threadId?: string | null;
  };
  sender: {
    id: string;
    name?: string;
    kind: "user" | "agent" | "system";
  };
  text?: string;
  raw: unknown;
  replyTo?: string | null;
  mentioned?: boolean;
  receivedAt: number;
  trace?: {
    id: string;
    streamable?: boolean;
  };
}
```

### 7.5 Outbound Message

```ts
export interface GatewayOutboundMessage {
  channel: string;
  accountId: string;
  conversationId: string;
  threadId?: string | null;
  text: string;
  replyTo?: string | null;
  traceId?: string | null;
}
```

### 7.6 Runtime Adapter

Reuse the current daemon adapter shape with naming cleanup:

```ts
export interface RuntimeAdapter {
  readonly id: string;
  run(opts: RuntimeRunOptions): Promise<RuntimeRunResult>;
  probe?(): RuntimeProbeResult;
}
```

The current `AgentBackend` can be renamed or aliased to `RuntimeAdapter`.

## 8. Config Shape

P0 config:

```json
{
  "channels": [
    {
      "id": "botcord-main",
      "type": "botcord",
      "accountId": "ag_xxx",
      "agentId": "ag_xxx"
    }
  ],
  "defaultRoute": {
    "runtime": "claude-code",
    "cwd": "/Users/me",
    "extraArgs": ["--permission-mode", "plan"],
    "queueMode": "serial",
    "trustLevel": "trusted"
  },
  "routes": [
    {
      "match": {
        "channel": "botcord",
        "conversationPrefix": "rm_oc_"
      },
      "runtime": "claude-code",
      "cwd": "/Users/me/project",
      "extraArgs": ["--permission-mode", "acceptEdits"],
      "queueMode": "cancel-previous",
      "trustLevel": "owner"
    }
  ],
  "streamBlocks": true
}
```

Compatibility mapping from existing daemon config:

```json
{
  "agentId": "ag_xxx",
  "defaultRoute": {
    "adapter": "claude-code",
    "cwd": "/Users/me"
  },
  "routes": []
}
```

maps to:

```json
{
  "channels": [
    {
      "id": "botcord-main",
      "type": "botcord",
      "accountId": "ag_xxx",
      "agentId": "ag_xxx"
    }
  ],
  "defaultRoute": {
    "runtime": "claude-code",
    "cwd": "/Users/me"
  },
  "routes": []
}
```

## 9. Routing

Routing should match normalized message fields, not channel-specific payloads.

Supported P0 match fields:

```ts
export interface RouteMatch {
  channel?: string;
  accountId?: string;
  conversationId?: string;
  conversationPrefix?: string;
  conversationKind?: "direct" | "group";
  senderId?: string;
  mentioned?: boolean;
}
```

First match wins. If no route matches, use `defaultRoute`.

## 10. Session Management

P0 uses a JSON file with atomic writes, similar to current daemon `SessionStore`.

Session key:

```text
runtime + channel + accountId + conversationKind + conversationId + threadId?
```

Examples:

```text
claude-code:botcord:ag_xxx:direct:rm_oc_abc
codex:telegram:default:group:-10012345:thread_99
gemini:wechat:main:direct:wxid_xxx
```

Stored entry:

```ts
export interface GatewaySessionEntry {
  key: string;
  runtime: string;
  runtimeSessionId: string;
  channel: string;
  accountId: string;
  conversationKind: "direct" | "group";
  conversationId: string;
  threadId?: string | null;
  cwd: string;
  updatedAt: number;
}
```

Rules:

- Read session before running a turn.
- Write session only when the runtime returns a new session id.
- Do not write session for cancelled turns.
- Corrupt session file should be ignored and rewritten from empty state.

## 11. Queue and Concurrency

P0 queue model:

- Queue key: `channel + accountId + conversationId + threadId`.
- Different queue keys may run concurrently.
- Same queue key follows route `queueMode`.

Supported modes:

- `serial`: run messages in order.
- `cancel-previous`: abort the running turn and let the newest message take over.

Default:

- Owner/direct channels: `cancel-previous`.
- Group/public channels: `serial`.

The first implementation can keep the current cancel-previous behavior and add `serial` before non-BotCord channels ship.

## 12. Ack Semantics

P0 target: accepted-once.

Flow:

1. Channel receives upstream message.
2. Channel normalizes it and emits `GatewayInboundEnvelope`.
3. Dispatcher validates text and route.
4. Once dispatcher owns the turn or enqueues it, call `ack.accept()`.
5. Runtime failure is reported via channel reply when appropriate; it is not handled by upstream redelivery.

BotCord adapter mapping:

- Poll `/hub/inbox` with `ack=false`.
- Emit envelopes with `accept()` calling `ackMessages([hub_msg_id])`.
- Use in-memory seen-message cache to suppress duplicates if ack fails and Hub requeues.

Telegram/Webhook future mapping:

- Webhook HTTP 2xx is equivalent to `accept()`.
- Polling offset commit is equivalent to `accept()`.

## 13. Streaming

Gateway core should not know BotCord stream-block details. Use an optional channel stream hook:

```ts
export interface ChannelAdapter {
  streamBlock?(ctx: ChannelStreamBlockContext): Promise<void>;
}
```

BotCord implementation:

- Only stream when `message.trace.streamable === true`.
- Use inbound `hub_msg_id` as `traceId`.
- Forward assistant text/tool-use blocks to `/hub/stream-block`.

Other channels can ignore `streamBlock` until they support progressive output.

## 14. Runtime State Snapshot

Minimal status model:

```ts
export interface GatewayRuntimeSnapshot {
  channels: Record<string, ChannelStatusSnapshot>;
  turns: Record<string, TurnStatusSnapshot>;
}

export interface ChannelStatusSnapshot {
  channel: string;
  accountId: string;
  running: boolean;
  connected?: boolean;
  restartPending?: boolean;
  reconnectAttempts?: number;
  lastStartAt?: number;
  lastStopAt?: number;
  lastError?: string | null;
}

export interface TurnStatusSnapshot {
  key: string;
  channel: string;
  accountId: string;
  conversationId: string;
  runtime: string;
  cwd: string;
  startedAt: number;
}
```

`botcord-daemon status` can print this later. P0 can keep the current status output but store this shape internally.

## 15. Security Defaults

Each route should declare a trust level:

```ts
type TrustLevel = "owner" | "trusted" | "public";
```

Defaults:

- `owner`: may use relaxed runtime permission flags when explicitly configured.
- `trusted`: conservative by default.
- `public`: conservative and no implicit filesystem-changing permission.

Suggested policy:

- BotCord owner-chat (`rm_oc_`) can default to `trustLevel: "owner"`.
- BotCord group rooms default to `trusted` or `public` depending on future room policy.
- Telegram/WeChat group chats should default to `public`.

Gateway core should not parse natural language into privileged BotCord operations. Extra actions should still go through explicit tools or CLI commands.

## 16. Migration Plan

### P0.1: Add Gateway Types and Stores

- Add `packages/gateway`.
- Add `ChannelAdapter`, `RuntimeAdapter`, normalized message types.
- Add JSON session store.
- Add route matcher.
- Add tests for route matching and session keys.

### P0.2: Move Runtime Adapters

- Move or re-export daemon `claude-code`, `codex`, `gemini` adapters into `packages/gateway/src/runtimes`.
- Keep daemon imports working through compatibility exports if needed.
- Rename `AgentBackend` to `RuntimeAdapter` or introduce an alias.

### P0.3: BotCord Channel Adapter

- Move BotCord Hub WS/inbox logic behind `BotCordChannelAdapter`.
- Normalize BotCord inbox messages into `GatewayInboundMessage`.
- Implement `send()` with `BotCordClient.sendMessage`.
- Implement `streamBlock()` with `/hub/stream-block`.
- Keep two-phase ack.

### P0.4: Gateway Dispatcher

- Update dispatcher to consume `GatewayInboundEnvelope`.
- Resolve route from normalized fields.
- Resolve session key with new format.
- Run selected runtime adapter.
- Call channel `send()` for final reply.
- Call channel `streamBlock()` for streamed blocks.

### P0.5: Daemon Compatibility

- Keep `botcord-daemon init/start/stop/status/logs/doctor`.
- Convert existing daemon config to gateway config in memory.
- Existing users should not need to rewrite config for P0.
- Keep existing daemon tests passing or add equivalent gateway tests.

### P1: Multi-Channel Readiness

- Add `serial` queue mode.
- Add richer status snapshot.
- Add route CLI for channel/account/conversation match fields.
- Add `gateway doctor` style runtime/channel probe output.

### P2: New Channels

- Add Telegram channel first.
- Add WeChat channel after Telegram because auth/session semantics are more complex.
- Revisit whether local HTTP endpoint is needed for webhooks.

## 17. Test Plan

Unit tests:

- Route matching: first match wins, default route fallback.
- Session key generation: direct/group/threaded examples.
- JSON session store: atomic write, corrupt file recovery.
- ChannelManager: duplicate starts, stop aborts, restart backoff.
- Dispatcher: empty text skip, own-message skip, route not found, runtime error reply.
- BotCord adapter: inbox normalization, ack accept, send mapping, stream-block mapping.

Integration tests:

- Current owner-chat flow still works through `botcord-daemon`.
- BotCord inbox message -> normalized message -> runtime adapter -> BotCord reply.
- Stream blocks use inbound `hub_msg_id` as trace id.
- Cancelled turn does not write session.
- Runtime session id is reused on second message.

Commands:

```bash
cd packages/gateway && npm test
cd packages/gateway && npx tsc --noEmit
cd packages/daemon && npm test
cd packages/daemon && npx tsc --noEmit
```

## 18. Open Questions

- Should `packages/daemon` remain published forever, or become an alias package for `@botcord/gateway`?
- Should gateway config live at `~/.botcord/gateway/config.json` while daemon keeps reading `~/.botcord/daemon/config.json`?
- Should one gateway process support multiple BotCord agent identities in P1?
- For Telegram/WeChat webhooks, should gateway expose a local HTTP server, or should channels start their own transport?
- Should BotCord backend know about external channels, or should external channels remain local-only for now?

## 19. Recommended First PR

First PR should be intentionally boring:

- Add `packages/gateway` with types, route matcher, session key/store, and tests.
- Do not move current daemon behavior yet.
- Add a small design note in `docs/README.md` linking this plan.

Second PR should migrate BotCord daemon internals to call gateway core.

This keeps review small and avoids breaking the already working daemon while the new boundaries settle.
