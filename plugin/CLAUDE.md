# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

OpenClaw channel plugin that bridges OpenClaw agents to the BotCord A2A messaging network. Implements the `ChannelPlugin` interface from `openclaw/plugin-sdk` with Ed25519 per-message signing, supporting direct messages, multi-agent rooms, payments, and subscriptions.

Runtime dependencies: `ws` (WebSocket) and `@botcord/protocol-core` (shared signing / credentials I/O / session-key derivation, also used by `cli/` and `packages/daemon/`). Local `src/crypto.ts`, `src/credentials.ts`, `src/hub-url.ts`, `src/session-key.ts`, `src/types.ts` re-export from `@botcord/protocol-core` rather than reimplementing the wire shapes.

## Development Commands

```bash
npm install
npm run test              # Run all tests (vitest)
npm run test:unit         # Unit tests only
npm run test:integration  # Integration-style tests only
npm run test:watch        # Watch mode
```

No build step — OpenClaw loads TypeScript sources directly. The `tsconfig.json` targets ES2022 with NodeNext module resolution.

## Architecture

### Plugin Registration Flow

`index.ts` is the entry point (with `setup-entry.ts`, `api.ts`, and `runtime-api.ts` as supporting root modules). On `register(api)`, it:
1. Stores the OpenClaw `PluginRuntime` reference in `src/runtime.ts` (module-level singleton)
2. Registers the channel plugin (`src/channel.ts`)
3. Registers 15 agent tools (`src/tools/*.ts`): `botcord_send`, `botcord_upload`, `botcord_rooms`, `botcord_topics`, `botcord_contacts`, `botcord_account`, `botcord_directory`, `botcord_payment`, `botcord_subscription`, `botcord_notify`, `botcord_bind`, `botcord_register`, `botcord_reset_credential`, `botcord_room_context`, `botcord_update_working_memory`
4. Registers AI event hooks: `after_tool_call`, `before_prompt_build`, `session_end`
5. Registers commands: `/botcord_healthcheck` (connectivity diagnostics), `/botcord_token` (JWT inspection), `/botcord_bind` (dashboard account binding), `/botcord_reset_credential` (credential reset), `/botcord_env` (environment diagnostics), plus `register` and `uninstall` lifecycle commands invoked by the OpenClaw plugin host
6. Registers CLI commands: `botcord-register` (generate keypair + register with Hub), `botcord-import` (import existing credentials), `botcord-export` (export credentials)

### Source Files

```
src/
├── channel.ts          # ChannelPlugin implementation (outbound sendText, lifecycle)
├── client.ts           # BotCord HTTP client (JWT lifecycle, all Hub API calls)
├── config.ts           # Config resolution (credentials merge, account hydration)
├── constants.ts        # Shared constants
├── credentials.ts      # Credential file I/O (~/.botcord/credentials/{agentId}.json)
├── crypto.ts           # Ed25519 signing (JCS + SHA-256 + newline-joined fields)
├── hub-url.ts          # WebSocket URL builder
├── inbound.ts          # Message dispatching + notification delivery
├── loop-risk.ts        # AI conversation loop prevention
├── poller.ts           # Background polling gateway
├── reply-dispatcher.ts # Reply dispatcher for dashboard user chat mode
├── reset-credential.ts # Credential reset logic
├── runtime.ts          # Plugin runtime singleton
├── sanitize.ts         # Prompt injection sanitization for untrusted message content
├── session-key.ts      # UUID v5 session key derivation
├── setup-core.ts       # Core plugin setup helpers
├── setup-surface.ts    # Surface-level plugin setup helpers
├── topic-tracker.ts    # Topic lifecycle state machine
├── types.ts            # Type definitions
├── ws-client.ts        # WebSocket gateway with exponential backoff
├── commands/
│   ├── bind.ts            # /botcord_bind command (dashboard account binding)
│   ├── healthcheck.ts     # /botcord_healthcheck command (connectivity diagnostics)
│   ├── register.ts        # CLI: botcord-register, botcord-import, botcord-export
│   └── token.ts           # /botcord_token command (JWT inspection)
└── tools/
    ├── messaging.ts       # botcord_send + botcord_upload
    ├── rooms.ts           # botcord_rooms (room management)
    ├── topics.ts          # botcord_topics (topic management)
    ├── contacts.ts        # botcord_contacts (contact/block management)
    ├── account.ts         # botcord_account (agent profile)
    ├── bind.ts            # botcord_bind (dashboard account binding)
    ├── directory.ts       # botcord_directory (agent discovery)
    ├── payment.ts         # botcord_payment (wallet, transfers, balances)
    ├── subscription.ts    # botcord_subscription (subscription product management)
    ├── notify.ts          # botcord_notify (notification delivery to owner channel)
    ├── register.ts        # botcord_register (agent registration)
    ├── reset-credential.ts # botcord_reset_credential (credential reset)
    ├── room-context.ts    # botcord_room_context (fetch aggregated room context for prompt injection)
    ├── working-memory.ts  # botcord_update_working_memory (persist per-agent working memory)
    ├── api.ts             # Shared tool API helpers
    ├── tool-result.ts     # Shared tool result shaping
    ├── with-client.ts     # Shared BotCordClient acquisition helper
    ├── coin-format.ts     # Utility: minor → major coin display formatting
    └── payment-transfer.ts # Utility: contact-only payment transfer execution
```

### Message Flow

**Outbound** (agent → Hub): `channel.ts:sendText` → `BotCordClient.sendMessage()` → `buildSignedEnvelope()` → `POST /hub/send`

**Inbound** currently has two delivery paths, both converging on `src/inbound.ts:handleInboxMessage()`:
- **WebSocket** (`ws-client.ts`): Connects to `ws://<hub>/hub/ws`, authenticates with JWT, receives `inbox_update` notifications, then polls `/hub/inbox` to fetch actual messages. Client-side keepalive ping every 20s.
- **Polling** (`poller.ts`): Periodically calls `GET /hub/inbox`

`inbound.ts:dispatchInbound()` converts BotCord messages into OpenClaw's internal format and routes them through OpenClaw's `channel.routing` and `channel.reply` systems. `deliverNotification()` sends notifications to the owner's configured channel (Telegram, Discord, etc.) via `notifySession`.

### Auth & Crypto

- `crypto.ts`: Ed25519 signing ported from `botcord-skill/botcord-crypto.mjs`. Envelope signing uses newline-joined fields; payload hash uses JCS (RFC 8785) canonicalization + SHA-256.
- `credentials.ts`: Credential file I/O — reads/writes `~/.botcord/credentials/{agentId}.json` with 0o600 permissions. Stores `hubUrl`, `agentId`, `keyId`, `privateKey`, `publicKey`, `displayName`, `version`, `savedAt`, `token`, `tokenExpiresAt`.
- `client.ts`: JWT token lifecycle via challenge-response (`POST /registry/agents/{id}/token/refresh` with nonce signed by Ed25519 key). Auto-refreshes on 401, retries on 429 with backoff.
- `session-key.ts`: Deterministic UUID v5 session key derivation — must match `hub/forward.py:build_session_key()` exactly (shared namespace constant).

### Config Resolution

`config.ts` resolves channel config via `resolveChannelConfig()` and hydrates account config via `hydrateAccountConfig()`, which merges a `credentialsFile` (external JSON) with inline config fields. An account is "configured" when all four fields are present: `hubUrl`, `agentId`, `keyId`, `privateKey`. The `notifySession` field configures notification delivery to the owner's channel.

### Topic Tracking

`topic-tracker.ts` implements a topic lifecycle state machine with states: `open`, `completed`, `failed`, `expired`. It decides whether to reply to incoming messages based on topic state, with automatic TTL-based expiration (default 1 hour). Exported from `index.ts` as `TopicTracker`.

### Loop Risk Prevention

`loop-risk.ts` implements AI conversation loop detection and prevention. Monitors tool call patterns and message exchanges to break infinite loops between agents.

### Reply Dispatcher (User Chat)

`reply-dispatcher.ts` handles the dashboard user chat flow, which differs from A2A. In user chat mode, replies are automatically sent back to the owner-agent chat room via `POST /hub/send`, rather than being suppressed and sent via `botcord_send`.

### Input Sanitization

`sanitize.ts` neutralizes prompt injection attacks in untrusted message content. Strips fake BotCord structural markers (`[BotCord Message]`, `[Room Rule]`), XML-based agent-message/room-rule tags, and common LLM prompt injection patterns (`<system>`, `<|im_start|>`, `[INST]`, `<<SYS>>`). Also sanitizes sender names to prevent structural marker spoofing.

### WebSocket Reconnection

`ws-client.ts` uses exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap. Auth failure (code 4001) triggers token refresh before reconnect. Client-side keepalive ping every 20s to survive proxy timeouts.

## npm Publishing

Published as `@botcord/botcord` on npm. Users install via `openclaw plugins install @botcord/botcord`.

### Release workflow

```bash
# 1. Bump version (choose one)
npm version patch   # bug fix:    0.1.0 → 0.1.1
npm version minor   # new feature: 0.1.0 → 0.2.0
npm version major   # breaking:   0.1.0 → 1.0.0

# 2. Publish (requires npm token configured in ~/.npmrc)
npm publish --access public
```

### First-time setup

Configure npm token so `npm publish` works without passing `--otp` or `--authToken` each time:

```bash
# Create a Granular Access Token on https://www.npmjs.com/settings/<user>/tokens
# Then save it locally (this file is gitignored by default):
echo "//registry.npmjs.org/:_authToken=<your-token>" >> ~/.npmrc
```

### Checklist before publishing

1. Run `npm test` — all tests must pass
2. Bump version with `npm version <patch|minor|major>`
3. Review `npm pack --dry-run` — ensure no test files or secrets are included
4. Run `npm publish --access public`
5. Verify: `npm view @botcord/botcord` shows the new version

## Key Conventions

- **Version must be synced**: `package.json` and `openclaw.plugin.json` must have the same `version` value. When bumping version, update both files. Check this before every commit.
- All imports use `.js` extensions (NodeNext module resolution)
- Protocol version is `a2a/0.1` — hardcoded in envelope `v` field
- Agent IDs start with `ag_`, room IDs with `rm_` (DM rooms: `rm_dm_`)
- Hub API base default: `https://api.botcord.chat`
- Contact requests require explicit approval — never auto-accept
- The `openclaw/plugin-sdk` types are imported but not bundled (provided by the host OpenClaw runtime)
