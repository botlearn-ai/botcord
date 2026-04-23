# Daemon Agent Discovery P1

**Status**: Draft
**Date**: 2026-04-23
**Scope**: Let `botcord-daemon` start without an explicit agent list by discovering local BotCord credential files at boot.

---

## 1. Background

Today `botcord-daemon` requires `~/.botcord/daemon/config.json` to contain either:

- legacy `agentId: "ag_..."`
- canonical `agents: ["ag_...", ...]`

At startup, `packages/daemon` translates that static list into one gateway channel per agent. This already supports multiple agents if the list is present before daemon boot, but it creates two problems:

- local identity state is duplicated between daemon config and `~/.botcord/credentials/*.json`;
- users must know and maintain the agent list before daemon start.

P1 changes only the boot-time source of agent identities. The daemon should be able to start with no explicit agent list and bind every valid local BotCord credential file it finds.

## 2. Goals

- Allow daemon config to omit both `agentId` and `agents`.
- Discover BotCord agent identities from local credential files at daemon startup.
- Start one BotCord gateway channel per discovered valid credential.
- Preserve existing explicit `agents` and legacy `agentId` behavior for compatibility.
- Keep the current static gateway lifecycle: channels are discovered once at boot.
- Keep runtime routing, session persistence, activity tracking, status snapshots, and owner-chat streaming behavior unchanged.

## 3. Non-Goals

- No runtime hot-add or hot-remove of agent identities.
- No `fs.watch` or config hot reload.
- No new gateway `addChannel` / `removeChannel` API.
- No OpenClaw plugin multi-account behavior change.
- No migration that rewrites existing daemon config files.
- No backend Hub protocol change.

Runtime dynamic add/remove is a P2 feature. P1 should make that later work easier, but should not implement it.

## 4. Identity Source Rules

The daemon resolves agent ids in this order:

1. If `config.agents` is present and non-empty, use it.
2. Else if legacy `config.agentId` is present, use `[agentId]`.
3. Else discover agents from the credentials directory.

Default credentials directory:

```text
~/.botcord/credentials
```

Discovery should inspect `*.json` files in that directory and load each candidate with the same credential parser used by the runtime, `loadStoredCredentials()`.

The canonical identity is the credential file's internal `agentId`, not the filename.

## 5. Discovered Credential Model

Add a daemon-layer helper, for example:

```text
packages/daemon/src/agent-discovery.ts
```

Suggested surface:

```ts
export interface DiscoveredAgentCredential {
  agentId: string;
  credentialsFile: string;
  hubUrl: string;
  displayName?: string;
}

export interface AgentDiscoveryResult {
  agents: DiscoveredAgentCredential[];
  warnings: string[];
}

export function discoverAgentCredentials(opts?: {
  credentialsDir?: string;
  readDir?: typeof readdirSync;
  stat?: typeof statSync;
  loadCredentials?: typeof loadStoredCredentials;
}): AgentDiscoveryResult;
```

The injectable filesystem hooks keep unit tests deterministic.

## 6. Error Handling

Discovery should be tolerant:

- Missing credentials directory: return no agents and no fatal error.
- Non-JSON files: ignore.
- Invalid JSON or invalid credential shape: skip and add a warning.
- Credential file with missing/invalid `agentId`: skip and add a warning.
- Duplicate `agentId`: keep one and add a warning.

Duplicate policy for P1:

- Prefer the file with the newest `mtimeMs`.
- If mtime is equal or unavailable, prefer lexical path order.

This deterministic rule avoids random channel selection when stale credential copies exist.

## 7. Config Shape

`DaemonConfig` should allow this shape:

```json
{
  "defaultRoute": {
    "adapter": "claude-code",
    "cwd": "/Users/alice"
  },
  "routes": [],
  "streamBlocks": true
}
```

Optional future-proof field:

```json
{
  "agentDiscovery": {
    "enabled": true,
    "credentialsDir": "~/.botcord/credentials"
  }
}
```

For P1, this field is optional. If omitted, discovery is enabled only when no explicit `agents` / `agentId` exists.

If `agentDiscovery.enabled === false` and no explicit agent list exists, config loading should fail with a clear error.

## 8. Gateway Config Mapping

`toGatewayConfig()` currently calls `resolveAgentIds(cfg)` and emits:

```ts
{
  id: agentId,
  type: "botcord",
  accountId: agentId,
  agentId,
}
```

P1 should keep this shape.

The daemon layer should pass resolved boot agents into the mapper instead of forcing `toGatewayConfig()` to know about filesystem discovery. That keeps config translation pure.

Suggested split:

```ts
resolveConfiguredAgentIds(cfg): string[] | null
resolveBootAgents(cfg, discovery): DiscoveredAgentCredential[]
toGatewayConfig(cfg, { agentIds }): GatewayConfig
```

For explicit config, credential path remains the default:

```text
~/.botcord/credentials/<agentId>.json
```

For discovered config, the exact discovered `credentialsFile` should be preserved and passed to channel creation.

## 9. Channel Creation

`startDaemon()` currently passes one global `credentialsPath` override into `createBotCordChannel()`.

P1 needs a per-agent credential path map:

```ts
const credentialPathByAgentId = new Map<string, string>();
```

When creating a channel:

```ts
createBotCordChannel({
  id: chCfg.id,
  accountId: chCfg.accountId,
  agentId,
  credentialsPath: credentialPathByAgentId.get(agentId) ?? opts.credentialsPath,
  hubBaseUrl: opts.hubBaseUrl,
})
```

Explicit config can leave the map empty and preserve current behavior.

## 10. Startup Behavior

If discovery finds one or more agents:

```text
daemon starting
  agents: ["ag_one", "ag_two"]
  source: "credentials"
  credentialsDir: "~/.botcord/credentials"
```

If discovery finds none:

- daemon should still start;
- `Gateway` starts with zero channels;
- status should show no running channels;
- logs should explain that no local BotCord credentials were found.

Starting with zero channels is useful because it makes P2 hot-add possible without another config migration. In P1, users still need to restart after adding a credential.

## 11. CLI Impact

`botcord-daemon init` should no longer require `--agent`.

New behavior:

```text
botcord-daemon init [--agent <ag_xxx> ...] [--cwd <path>]
```

- If `--agent` is provided, write `agents`.
- If no `--agent` is provided, write config without `agents`.
- Help text should say agent identities are auto-discovered from `~/.botcord/credentials`.

`botcord-daemon config` should show whether identities are explicit or discovered.

`botcord-daemon status` can continue reading snapshot output. If no channels exist, it should print a clear empty state.

`botcord-daemon doctor` should use the same boot-agent resolution as daemon start, so discovered credentials are reported even when config has no `agents`.

## 12. Tests

Add focused tests:

- discovery returns empty result for missing credentials dir;
- discovery loads valid credential files and returns internal `agentId`;
- discovery ignores non-JSON files;
- discovery skips invalid credentials and records warnings;
- duplicate `agentId` uses deterministic newest-file policy;
- `loadConfig()` accepts config without `agentId` / `agents`;
- `cmdInit` can write config without agents;
- `toGatewayConfig()` can receive boot agent ids and emit matching channels;
- `startDaemon()` passes discovered per-agent credential paths into channel creation;
- `doctor` reports discovered channels when config has no explicit agents.

## 13. Acceptance Criteria

- A user with `~/.botcord/credentials/ag_a.json` and `ag_b.json` can run:

```text
botcord-daemon init --cwd /repo
botcord-daemon start
```

and the daemon starts two BotCord channels without `agents` in config.

- Existing configs with `agents` or `agentId` continue to behave the same.
- Adding a credential while daemon is already running does not start a new channel until restart.
- Removing a credential while daemon is already running does not stop an existing channel until restart.
- Invalid credential files do not prevent daemon startup unless all identity sources are explicit and invalid at channel start.

## 14. P2 Follow-Up

P2 should add runtime reconciliation:

- credential directory watcher with debounce and periodic rescan;
- `Gateway.reconcileChannels()`;
- `ChannelManager.addChannel()` / `removeChannel()`;
- `Dispatcher.addChannel()` / `removeChannel()`;
- dynamic system-context builder reconciliation;
- status events for added/removed identities.

P1 should avoid designs that make this harder, but should not introduce the dynamic API early.
