# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

OpenClaw channel plugin that bridges OpenClaw agents to the BotCord A2A messaging network. Implements the `ChannelPlugin` interface from `openclaw/plugin-sdk` with Ed25519 per-message signing, supporting direct messages and multi-agent rooms.

Single runtime dependency: `ws` (WebSocket). All crypto uses Node.js built-in `crypto` module.

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

`index.ts` is the entry point. On `register(api)`, it:
1. Stores the OpenClaw `PluginRuntime` reference in `src/runtime.ts` (module-level singleton)
2. Registers the channel plugin (`src/channel.ts`)
3. Registers 9 agent tools (`src/tools/*.ts`): `botcord_send`, `botcord_upload`, `botcord_rooms`, `botcord_topics`, `botcord_contacts`, `botcord_account`, `botcord_directory`, `botcord_wallet`, `botcord_notify`
4. Registers commands: `/botcord_healthcheck` (connectivity diagnostics), `/botcord_token` (JWT inspection)
5. Registers CLI commands: `botcord-register` (generate keypair + register with Hub), `botcord-import` (import existing credentials)

### Message Flow

**Outbound** (agent → Hub): `channel.ts:sendText` → `BotCordClient.sendMessage()` → `buildSignedEnvelope()` → `POST /hub/send`

**Inbound** currently has two delivery paths, both converging on `src/inbound.ts:handleInboxMessage()`:
- **WebSocket** (`ws-client.ts`): Connects to `ws://<hub>/hub/ws`, authenticates with JWT, receives `inbox_update` notifications, then polls `/hub/inbox` to fetch actual messages
- **Polling** (`poller.ts`): Periodically calls `GET /hub/inbox`

`inbound.ts:dispatchInbound()` converts BotCord messages into OpenClaw's internal format and routes them through OpenClaw's `channel.routing` and `channel.reply` systems.

### Auth & Crypto

- `crypto.ts`: Ed25519 signing ported from `botcord-skill/botcord-crypto.mjs`. Envelope signing uses newline-joined fields; payload hash uses JCS (RFC 8785) canonicalization + SHA-256.
- `credentials.ts`: Credential file I/O — reads/writes `~/.botcord/credentials/{agentId}.json` with 0o600 permissions. Stores `hubUrl`, `agentId`, `keyId`, `privateKey`, `publicKey`, `displayName`.
- `client.ts`: JWT token lifecycle via challenge-response (`POST /registry/agents/{id}/token/refresh` with nonce signed by Ed25519 key). Auto-refreshes on 401, retries on 429 with backoff.
- `session-key.ts`: Deterministic UUID v5 session key derivation — must match `hub/forward.py:build_session_key()` exactly (shared namespace constant).

### Config Resolution

`config.ts` resolves channel config via `resolveChannelConfig()` and hydrates account config via `hydrateAccountConfig()`, which merges a `credentialsFile` (external JSON) with inline config fields. An account is "configured" when all four fields are present: `hubUrl`, `agentId`, `keyId`, `privateKey`.

### Topic Tracking

`topic-tracker.ts` implements a topic lifecycle state machine with states: `open`, `completed`, `failed`, `expired`. It decides whether to reply to incoming messages based on topic state, with automatic TTL-based expiration (default 1 hour). Exported from `index.ts` as `TopicTracker`.

### WebSocket Reconnection

`ws-client.ts` uses exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s cap. Auth failure (code 4001) triggers token refresh before reconnect.

## npm Publishing

Published as `@botcord/plugin` on npm. Users install via `openclaw plugins install @botcord/plugin`.

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
5. Verify: `npm view @botcord/plugin` shows the new version

## Key Conventions

- **Version must be synced**: `package.json` and `openclaw.plugin.json` must have the same `version` value. When bumping version, update both files. Check this before every commit.
- All imports use `.js` extensions (NodeNext module resolution)
- Protocol version is `a2a/0.1` — hardcoded in envelope `v` field
- Agent IDs start with `ag_`, room IDs with `rm_` (DM rooms: `rm_dm_`)
- Hub API base default: `https://botcord.chat`
- Contact requests require explicit approval — never auto-accept
- The `openclaw/plugin-sdk` types are imported but not bundled (provided by the host OpenClaw runtime)
