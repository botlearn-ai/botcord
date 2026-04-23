# Daemon Agent Workspace Plan

**Status**: Draft
**Date**: 2026-04-23
**Scope**: Give every BotCord agent its own on-disk workspace directory, generate it at provision time, and default the runtime `cwd` to that workspace instead of the daemon's shared `defaultRoute.cwd`.

---

## 1. Background

Today `provisionAgent` (`packages/daemon/src/provision.ts:133`) only writes one thing to disk per new agent: `~/.botcord/credentials/{agentId}.json`. The `cwd` that actually gets handed to Claude Code / Codex at turn time comes from `config.defaultRoute.cwd` (falling back to `homedir()` in `initDefaultConfig`, `config.ts:264`), unless an operator has manually set a route.

Consequences:

- Every agent on one daemon shares the same cwd by default — usually `$HOME`. Runtime sandboxes (`codex -s workspace-write`) end up scoped to the whole home directory, and agents can read/write each other's files.
- There is no designated place for an agent to keep its own long-lived Markdown state (identity, memory, task list). Runtime-side memory (working-memory.json) is daemon-owned JSON that the LLM can't naturally edit.
- Users who want per-agent isolation have to hand-craft `config.routes` entries before the first turn.

This plan gives every agent a dedicated, self-contained directory and makes that directory the default `cwd`.

## 2. Goals

- Each provisioned agent gets `~/.botcord/agents/{agentId}/workspace/` with a small set of seed Markdown files.
- Provisioning without an explicit `cwd` defaults to that workspace; explicit `cwd` still wins.
- Existing daemons and already-provisioned agents work unchanged; workspaces are backfilled lazily on next boot.
- Working-memory state moves under the agent directory so everything per-agent lives in one tree.
- Revoking an agent does not delete user-authored workspace content by default.

## 3. Non-goals

- Moving `~/.botcord/credentials/{agentId}.json` into the agent directory. Credentials are shared with `protocol-core`, plugin, and CLI; migrating them is a separate follow-up.
- Changing `system-context.ts` injection behavior. Workspace Markdown is additive — the systemContext path stays as-is in v1.
- User-customizable templates. v1 ships one built-in template set; overrides come later if requested.

---

## 4. Directory layout

```
~/.botcord/
  credentials/
    {agentId}.json              # unchanged in v1
  daemon/
    config.json                 # unchanged
    sessions.json               # unchanged
    snapshot.json               # unchanged
  agents/
    {agentId}/
      workspace/                # runtime cwd
        AGENTS.md               # runtime-facing rules entry
        CLAUDE.md               # duplicate of AGENTS.md content (NOT a symlink)
        identity.md             # rendered from provision params
        memory.md               # long-lived notes, LLM-owned
        task.md                 # current task / plan, LLM-owned
        notes/                  # free-form, LLM-owned
      state/
        working-memory.json     # moved from ~/.botcord/daemon/memory/{id}/
```

Files inside `workspace/` are considered **user/LLM-owned** once they exist. `state/` is **daemon-owned** — the daemon may rewrite it freely.

### Trade-off when the operator overrides `cwd`

§7 lets an explicit `cwd` (e.g. a real project directory) win over the per-agent workspace. When that happens, the runtime starts inside the project tree and **does not see** `identity.md` / `memory.md` / `task.md` — those files still exist under `~/.botcord/agents/{id}/workspace/` but are outside the runtime's cwd, so `AGENTS.md` conventions there are invisible.

v1 accepts this trade-off: operators who override `cwd` are assumed to manage their own context surface in the project dir (project's own `AGENTS.md`, `CLAUDE.md`, etc.). The daemon does **not**:

- copy seed files into the project dir (would pollute a user-owned tree),
- symlink them in (banned — see "Why CLAUDE.md is a separate file" above),
- merge workspace markdown into `systemContext` (§3 explicitly keeps `system-context.ts` untouched in v1).

If per-agent memory needs to follow the agent into project cwds, that's a v2 feature — likely via optional `systemContext` injection of `identity.md` / `memory.md`. Call it out in release notes so operators know what they lose by overriding `cwd`.

### Why CLAUDE.md is a separate file, not a symlink

- Symlinks break on Windows without developer mode, and `mklink` requires elevation.
- Tarballs, `rsync`, cloud sync tools (Dropbox/iCloud), and some editors follow or mangle symlinks inconsistently.
- The cost of a duplicate file is negligible (a few KB of static text).

Both files get written with identical content at `ensureAgentWorkspace` time. They are written **only if missing** (see §6), so users who edit one are not forced to keep the other in sync — divergence is their choice.

---

## 5. Template contents

All templates live in code as template literals exported from `agent-workspace.ts`. No external template files in v1.

### 5.1 AGENTS.md / CLAUDE.md (same content)

```markdown
# Agent Workspace

This directory is your persistent workspace. You run with `cwd` set here.

## Files you own

- `identity.md` — who you are, your role, your boundaries. Read before responding.
- `memory.md` — long-lived facts, user preferences, past decisions. Update when
  you learn something durable. Prune when it grows stale.
- `task.md` — current task and plan. Update as you make progress. Clear when done.
- `notes/` — free-form scratch space.

## Boundaries

- Do not modify files outside this workspace unless the user explicitly asks.
- `../state/` (sibling directory, outside this workspace) is managed by the
  daemon — do not read or edit it directly.

## How to use this

You are **instructed** to skim `identity.md`, `memory.md`, `task.md` before each
response and to write back what changed after meaningful turns. Nothing in the
runtime enforces this — the daemon does not auto-load these files into your
context. Treat AGENTS.md as a convention, not a mechanism.
```

### 5.2 identity.md (rendered from provision params)

```markdown
# Identity

- **Agent ID**: {{agentId}}
- **Display name**: {{displayName}}
- **Runtime**: {{runtime}}
- **Key ID**: {{keyId}}
- **Created**: {{savedAt}}

## Bio

{{bio or "_(none provided at provision time — edit this section)_"}}

## Role

_(Describe what you do and for whom. Edit this section.)_

## Boundaries

_(What you will and will not do. Edit this section.)_
```

Interpolation is plain string replacement; no template engine. Empty `bio` renders the parenthetical hint.

### 5.3 memory.md

```markdown
# Memory

<!--
Long-lived facts about the user, past decisions, and preferences that should
survive across conversations. Organize by topic. Keep entries short. Prune
regularly — AGENTS.md instructs the runtime to consult this file before each
response, but nothing loads it automatically; keep it short enough to be
worth re-reading.
-->
```

### 5.4 task.md

```markdown
# Current Task

<!--
What are you working on right now? What is the plan? What is blocked?
Clear this file when the task is done.
-->
```

`notes/` is created as an empty directory with a `.gitkeep` (empty file) so it survives clean checkouts if the user versions the workspace.

---

## 6. Module: `agent-workspace.ts`

New file at `packages/daemon/src/agent-workspace.ts`. Exports:

```ts
export function agentHomeDir(agentId: string): string;
export function agentWorkspaceDir(agentId: string): string;
export function agentStateDir(agentId: string): string;

export interface WorkspaceSeed {
  displayName?: string;
  bio?: string;
  runtime?: string;
  keyId?: string;
  savedAt?: string; // ISO timestamp
}

export function ensureAgentWorkspace(
  agentId: string,
  seed: WorkspaceSeed,
): void;
```

`ensureAgentWorkspace` semantics:

1. `mkdirSync` the three directories (`agentHomeDir`, `workspace`, `workspace/notes`, `state`) with mode `0700`, `recursive: true`. Never throws on already-exists.
2. For each of `AGENTS.md`, `CLAUDE.md`, `identity.md`, `memory.md`, `task.md`: **if the file does not exist**, write the rendered template. If it exists, leave it alone (including modification time).
3. Ensure `workspace/notes/.gitkeep` exists.
4. No writes to `state/` — that is §8's job.

Failures: any error other than `EEXIST` on directory creation or file write propagates. Callers in provision wrap in the existing rollback (§7).

Idempotency is load-bearing: boot-time backfill (§9) calls this for every discovered credential on every start.

---

## 7. Wire into `provisionAgent`

File: `packages/daemon/src/provision.ts:133`.

`materializeCredentials` has two branches: a **fast path** when `params.credentials` is provided by Hub (agentId comes from `c.agentId`) and a **slow path** where the daemon calls `register()` and agentId comes from `reg.agentId`. The default-cwd logic must sit in both branches with the correct id source.

Changes:

1. **Validate explicit cwd up front**. Replace the current `assertSafeCwd(params.cwd)` at `provision.ts:137` with:

   ```ts
   const explicitCwd = params.credentials?.cwd ?? params.cwd;
   assertSafeCwd(explicitCwd);
   ```

   This closes a pre-existing hole: today `params.credentials.cwd` is never validated and can smuggle an arbitrary path (e.g. `/etc`) into the credentials file. The check moves once, catches both sources.

2. **Default cwd in `materializeCredentials`**. Drop the `const cwd = ...` line at 212. In each branch, after the agentId is known, compute:

   - Fast path (after line 216 validates `c.agentId`):

     ```ts
     const cwd = explicitCwd ?? agentWorkspaceDir(c.agentId);
     ```

   - Slow path (after line 257's `reg = await ctx.register(...)`):

     ```ts
     const cwd = explicitCwd ?? agentWorkspaceDir(reg.agentId);
     ```

   Threading `explicitCwd` into `materializeCredentials` is simplest via a second parameter; alternatively compute it twice from the same `params` object. Pick whichever produces the smaller diff.

   `record.cwd` is now always set. Downstream code (`toGatewayConfig`, dispatcher) can treat it as required when present on disk.

3. **Create workspace** after `writeCredentialsFile` succeeds and before `addChannel`:

   ```ts
   ensureAgentWorkspace(credentials.agentId, {
     displayName: credentials.displayName,
     bio: params.bio,
     runtime: credentials.runtime,
     keyId: credentials.keyId,
     savedAt: credentials.savedAt,
   });
   ```

4. **Rollback extension**: if `ensureAgentWorkspace` throws, unlink the credentials file and re-throw. Do **not** `rm -rf` the agent directory on rollback — partial contents might be from a pre-existing workspace we shouldn't have touched. Leaving orphaned seed files is cheap; the next provision attempt with the same id is idempotent.

5. `assertKnownRuntime` already runs before credentials are written; no change.

---

## 8. Move working-memory under agent dir

File: `packages/daemon/src/working-memory.ts`.

- Old path: `~/.botcord/daemon/memory/{agentId}/working-memory.json`
- New path: `~/.botcord/agents/{agentId}/state/working-memory.json`

Implementation:

1. Path constants come from `agent-workspace.ts` (`agentStateDir`).
2. **Read path resolution** — before every read:
   - If `newPath` exists → read `newPath`. Do nothing with `oldPath` even if it exists (new wins).
   - Else if `oldPath` exists → `renameSync(oldPath, newPath)` then read `newPath`. `ensureAgentWorkspace` already created `state/`, so the destination directory exists.
   - Else → return empty / initial state as today.
3. **Write path** — always write to `newPath`. Never write to `oldPath`.
4. **Conflict case** (both paths exist — shouldn't happen if §9 runs, but defensive): new wins, old is left in place, emit a `daemonLog.warn({ agentId, oldPath, newPath })` once per process so it's visible but not disruptive.
5. Wrap the rename in try/catch. On rename failure, log a warning and fall back to reading `oldPath` directly — don't error. The next write will land in `newPath` and fix state naturally.
6. Delete the migration branch (steps 2's "else if" and step 4) one release after the change ships.

No change to JSON schema or public API of the working-memory module.

---

## 9. Startup backfill for existing agents

File: `packages/daemon/src/daemon.ts` — inside the `startDaemon` boot flow, immediately after `resolveBootAgents()` (around line 238) and **before** the `toGatewayConfig(...)` call at line 255.

`agent-discovery.ts` is deliberately kept side-effect-lean (path resolution and credential parsing only). Workspace creation is a boot-flow concern — the `daemon.ts` site has the logger, the full boot agent list, and the `agentRuntimes` map under construction, so the same iteration that populates `agentRuntimes` also calls `ensureAgentWorkspace`:

```ts
const agentRuntimes: Record<string, { runtime?: string; cwd?: string }> = {};
for (const a of boot.agents) {
  if (a.runtime || a.cwd) {
    agentRuntimes[a.agentId] = { runtime: a.runtime, cwd: a.cwd };
  }
  try {
    ensureAgentWorkspace(a.agentId, {
      displayName: a.displayName,
      runtime: a.runtime,
      keyId: a.keyId,
      savedAt: a.savedAt,
      // `bio` is not in BootAgent today; leave undefined — template renders placeholder.
    });
  } catch (err) {
    daemonLog.warn("ensureAgentWorkspace failed at boot; continuing", {
      agentId: a.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

**Failure policy: warn-and-continue.** One agent's broken workspace (permission denied, filesystem full, etc.) must not block the other agents from starting. The agent still gets a gateway channel; runtime turns will fail with a clearer error if the workspace is truly unusable.

**No credential mutation.** If an existing credential file has no `cwd`, the daemon does not rewrite it — `toGatewayConfig` (§10) supplies the workspace fallback dynamically. Rationale: credentials are co-owned with plugin and CLI; daemon should not silently mutate them during boot.

**BootAgent shape.** If `resolveBootAgents()` today doesn't surface `displayName` / `keyId` / `savedAt` on each entry, extend its return type to include them (they're already read from the credentials file during discovery — just not exposed). This is a local change to `agent-discovery.ts`, not a scope bump.

---

## 10. Per-agent route via `toGatewayConfig`

File: `packages/daemon/src/daemon-config-map.ts:117` (`toGatewayConfig`). **Do not touch** `gateway/router.ts` — the router stays a pure function of `GatewayConfig`.

The daemon already synthesizes a per-agent terminal route for agents whose credentials carry a `runtime` field (current code at lines 155–166). Two targeted changes make that route the universal per-agent default:

1. **Always synthesize, not only when runtime is present.** Change the guard from `if (!meta?.runtime) continue` to "synthesize for every agent in `agentIds`". Agents without a cached runtime inherit `defaultRoute.runtime`.
2. **Workspace-based cwd fallback**:

   ```ts
   for (const agentId of agentIds) {
     const meta = agentRuntimes[agentId] ?? {};
     routes.push({
       match: { accountId: agentId },
       runtime: meta.runtime ?? defaultRoute.runtime,
       cwd: meta.cwd || agentWorkspaceDir(agentId),
     });
   }
   ```

   `meta.cwd` comes from the credentials file (populated by §7 for new agents, absent for legacy agents). When absent, the route pins the agent to its own workspace directory. `config.defaultRoute.cwd` is no longer the end of the line for per-agent turns — it only applies to hypothetical messages that match no `accountId`, which in practice doesn't happen (channels are all agent-scoped).

Ordering inside `config.routes` is unchanged: user-authored `cfg.routes[]` are mapped first (line 148), then the synthesized per-agent routes are appended. First match wins, so explicit operator routes still override the per-agent default.

### 10.1 Managed routes vs. user routes

Per-agent workspace routes are **synthesized** by the daemon and must be owned separately from user-authored `cfg.routes[]`. Today `GatewayRoute` has no `source`/`managed` marker, and `gateway.config.routes` is a flat array: a naive "remove all routes with `match.accountId === id`" on revoke would blow away an operator's explicit route.

Solution: keep synthesized per-agent routes in a **separate bucket** inside the gateway, never inside `cfg.routes`.

- Extend `Gateway` with an internal `managedRoutes: Map<accountId, GatewayRoute>` (keyed by accountId to make add/remove O(1) and unambiguous — each agent gets exactly one synthesized route).
- Extend `GatewayConfig` with a **read-only** `managedRoutes?: GatewayRoute[]` field populated from that map (for snapshot/debug purposes), but route matching reads it directly from the map.
- Router matching order (new): `cfg.routes[] → managedRoutes → cfg.defaultRoute`. User routes always win; synthesized routes only apply when nothing user-authored matches. `resolveRoute`'s signature takes the extra `managedRoutes` input (simple array parameter, no `Map` in the pure function).

`toGatewayConfig` populates `managedRoutes` instead of appending to `routes` — move lines 155–166 of the current impl into the managed bucket. User `cfg.routes[]` stays untouched.

### 10.2 Gateway API surface

Add three methods on `Gateway`:

```ts
/** Replace all managed routes atomically. Used by reload_config. */
replaceManagedRoutes(routes: Map<string, GatewayRoute>): void;

/** Add or update one managed route. Used by provision hot-add. */
upsertManagedRoute(accountId: string, route: GatewayRoute): void;

/** Drop one managed route. Used by revoke / removeChannel. */
removeManagedRoute(accountId: string): void;
```

These are pure in-memory ops. The dispatcher reads the current map on every `resolveRoute` call, so the next turn picks up the change.

### 10.3 Provision hot-add

In `provisionAgent`, after `addChannel` succeeds:

```ts
await ctx.gateway.addChannel({ ... });
ctx.gateway.upsertManagedRoute(credentials.agentId, {
  match: { accountId: credentials.agentId },
  runtime: credentials.runtime ?? defaultRoute.runtime,
  cwd: credentials.cwd ?? agentWorkspaceDir(credentials.agentId),
});
```

Rollback: if `upsertManagedRoute` fails (it shouldn't — pure map op), or if a later step fails, `removeManagedRoute(agentId)` runs alongside the existing config/credentials rollback.

### 10.4 Revoke + channel removal

In `revokeAgent` and anywhere `removeChannel` is called, follow up with `removeManagedRoute(agentId)`. Because the map is keyed by accountId, there's no ambiguity — user routes with the same accountId are safe because they live in `cfg.routes[]`, a different bucket.

### 10.5 `reload_config` rebuilds managed routes

Current `reloadConfig()` at `provision.ts:455` only reconciles channels. Comment at line 585 (`setRoute`) already admits "changes apply at next `reload_config` — it does not mutate the live router immediately", and today `reload_config` doesn't actually rebuild routes either. Fix that here:

After the existing channel reconcile loop, re-run the managed-route synthesis:

```ts
const freshCfg = loadConfig();
const freshAgents = resolveConfiguredAgentIds(freshCfg) ?? [];
const agentRuntimes = readAgentRuntimesFromCredentials(freshAgents);
const managed = buildManagedRoutes(freshAgents, agentRuntimes, freshCfg.defaultRoute);
ctx.gateway.replaceManagedRoutes(managed);
```

`buildManagedRoutes` is the same logic extracted from `toGatewayConfig` — share it. After this change, `set_route` + `reload_config` becomes a functional flow (writes to `cfg.routes[]`, then reload rebuilds both user-route-derived gateway state **and** re-synthesizes managed routes).

**Properties:**

- New agents use their own workspace (credentials.cwd is set by §7).
- Legacy agents with no credentials.cwd also land in their own workspace (path helper).
- Operator `config.routes` entries still win — and are never touched by add/remove/reload bookkeeping.
- `set_route` + `reload_config` now actually applies without a restart.
- Router stays a pure function; dispatcher signature extended by one parameter.

**Properties:**

- New agents use their own workspace (credentials.cwd is set by §7).
- Legacy agents with no credentials.cwd also land in their own workspace (path helper).
- Operator `config.routes` entries still win.
- Router stays a pure function; no dispatcher signature change.

---

## 11. Revoke policy (cross-package change)

Revoke touches three packages; the wire contract has to land in lockstep or the new flags will be silently dropped.

### 11.1 `packages/protocol-core`

Extend `RevokeAgentParams` with:

```ts
export interface RevokeAgentParams {
  agentId: string;
  deleteCredentials?: boolean;   // existing
  deleteState?: boolean;         // NEW — default = value of deleteCredentials
  deleteWorkspace?: boolean;     // NEW — default = false
}
```

Extend the ack result type (whatever `RevokeAgentResult` is called today — the shape returned via `ControlAck.result` from `revoke_agent`):

```ts
export interface RevokeAgentResult {
  agentId: string;
  removed: boolean;
  credentialsDeleted: boolean;   // existing
  stateDeleted: boolean;         // NEW
  workspaceDeleted: boolean;     // NEW
}
```

### 11.2 Hub control-frame validation

If Hub validates `revoke_agent` params against an allowlist / schema before forwarding to the daemon (check `backend/hub/` — control-plane plan §5.3 is the relevant section), add `deleteState` and `deleteWorkspace` to that allowlist. Unknown fields must not be stripped silently. Same for whatever Hub-side test contract exists for the frame shape.

### 11.3 `packages/daemon/src/provision.ts:281` (`revokeAgent`)

- Always leave `agents/{id}/workspace/` alone by default. User-authored memory/notes are precious.
- `deleteState` (default = `deleteCredentials`): when true, `rm -rf ~/.botcord/agents/{id}/state/` after credentials cleanup. Keeps the revoke-but-preserve-notes case ergonomic — revoking typically wants state gone too, but not necessarily the workspace.
- `deleteWorkspace` (default **false**): when true, `rm -rf ~/.botcord/agents/{id}/` entirely (subsumes state deletion). Requires explicit opt-in from the caller.
- **Managed-route cleanup**: after `gateway.removeChannel(agentId)`, call `gateway.removeManagedRoute(agentId)`. This runs unconditionally — whether or not credentials are deleted — because the channel is gone and the synthesized per-agent route is now dangling. User-authored `cfg.routes[]` entries with the same accountId are a different bucket and are not touched (see §10.1).
- Execution order: `removeChannel` → `removeManagedRoute` → credentials → state → workspace. Each disk step is independent and best-effort; a failure at one step logs a warning and does not prevent the next (matches the existing `deleteCredentials` pattern). The two in-memory gateway ops run first so the running turn (if any) is aborted before disk state goes away.
- Return `{ ...existing, stateDeleted, workspaceDeleted }`.

### 11.4 Tests / contracts

- Update daemon `provision.test.ts` revoke cases: default flags preserve workspace + state; `deleteState` alone preserves workspace; `deleteWorkspace` removes everything.
- Update any control-plane contract fixtures under `docs/daemon-control-plane-api-contract.md` / related test files so the new fields appear in the example payloads.
- If Hub has request/response snapshot tests for `revoke_agent`, regenerate them.

---

## 12. Codex sandbox implication (documentation-only)

Codex non-owner turns use `-s workspace-write` (`codex.ts:155`), scoped to `cwd`. Before this plan, `cwd` was typically `$HOME` and the sandbox was nearly useless. After this plan, `cwd` is `~/.botcord/agents/{id}/workspace/` by default, and Codex can only write inside that directory.

Users who want an agent to edit project code must set an explicit route:

```jsonc
// ~/.botcord/daemon/config.json
{
  "routes": [
    {
      "match": { "accountId": "ag_..." },
      "adapter": "codex",
      "cwd": "/Users/me/code/myproject"
    }
  ]
}
```

Call this out in the daemon README + release notes when the change ships. Not a code change — but load-bearing for user expectations.

---

## 13. Testing

New tests in `packages/daemon/src/__tests__/`:

- `agent-workspace.test.ts`:
  - Creates all directories + seed files from a clean slate.
  - Second call does not overwrite a modified `memory.md`.
  - `notes/.gitkeep` is present.
  - `identity.md` interpolation handles missing `bio` / `runtime`.

- Extend `provision.test.ts`:
  - Provisioning without `cwd` (slow path) → credentials.cwd equals `agentWorkspaceDir(reg.agentId)`, workspace dir and 5 seed files exist.
  - Provisioning without `cwd` (fast path, Hub supplies `credentials`) → credentials.cwd equals `agentWorkspaceDir(c.agentId)`.
  - Provisioning with explicit `params.cwd` → credentials.cwd honors the override; workspace still gets built.
  - Provisioning with explicit `params.credentials.cwd` pointing outside `$HOME` → `assertSafeCwd` rejects **before** any disk write.
  - Rollback: if `ensureAgentWorkspace` throws, credentials file is unlinked.

- Extend daemon boot test (whichever file covers `startDaemon` / the boot flow):
  - Legacy discovered agent without workspace → `ensureAgentWorkspace` runs, credentials file is not mutated.
  - `ensureAgentWorkspace` throwing for one agent does not abort boot; other agents still come up.

- Extend `daemon-config-map.test.ts` (covering `toGatewayConfig` + `buildManagedRoutes`):
  - Agent with `agentRuntimes[id].cwd` set → synthesized managed route uses that cwd.
  - Agent with no `cwd` in its meta → synthesized managed route cwd equals `agentWorkspaceDir(id)`.
  - Agent with no `runtime` in its meta → synthesized managed route runtime falls back to `defaultRoute.runtime` (behavior change from the pre-plan guard).
  - Managed routes land in `GatewayConfig.managedRoutes` (or its map equivalent), **not** in `GatewayConfig.routes`.
  - `cfg.routes[]` is passed through to `GatewayConfig.routes` unchanged.

- New `router.test.ts` cases for the extra parameter:
  - User `cfg.routes[]` match wins over a managed route for the same `accountId`.
  - No user match + managed match → managed wins.
  - No user match + no managed match → `defaultRoute` wins.

- New gateway tests for managed-route API:
  - `upsertManagedRoute` adds a route; next `resolveRoute` picks it up without restart.
  - `upsertManagedRoute` on an existing accountId replaces the prior entry (not duplicate).
  - `removeManagedRoute` drops the entry; `cfg.routes[]` with the same accountId is untouched.
  - `replaceManagedRoutes(new Map())` wipes synthesized routes without touching `cfg.routes[]`.

- Extend provision test for hot-add:
  - After `provisionAgent`, `gateway.snapshot()` (or a managed-route accessor) shows exactly one managed route for the new agent pointing at its workspace.
  - `provisionAgent` rollback path also removes the managed route if a later step fails.
  - After `revokeAgent`, that managed route is removed — and an operator-authored `cfg.routes[]` entry with the same accountId still exists.

- New `reload_config` test:
  - Edit `config.json` routes + add a new agent discoverable on disk → `reload_config` adds the channel, rebuilds managed routes, and does not duplicate user routes.

- Extend `provision.test.ts` for revoke (defaults follow §11.3: `deleteCredentials` defaults true, `deleteState` defaults to whatever `deleteCredentials` resolves to, `deleteWorkspace` defaults false):
  - Default flags (vanilla revoke) → **credentials deleted, state deleted, workspace preserved**.
  - `deleteCredentials: false` (explicit opt-out) → credentials kept, state kept (mirrors `deleteCredentials`), workspace kept.
  - `deleteWorkspace: true` → entire `~/.botcord/agents/{id}/` directory removed (subsumes state).
  - `deleteState: false, deleteCredentials: true` → credentials gone, state + workspace preserved.
  - `removeManagedRoute` is called in every case, including when `deleteCredentials: false` — the channel is revoked regardless of whether disk state survives.

- `working-memory.test.ts`:
  - New-path read/write (new exists) → reads new, ignores old even if present.
  - Only old path exists → one-shot `renameSync`, subsequent read comes from new.
  - Neither exists → returns empty state.
  - Rename failure → falls back to reading old path and logs warning (doesn't throw).

---

## 14. Rollout

- **Land order matters** because of §11's cross-package change:
  1. `protocol-core` type extensions for `RevokeAgentParams` / `RevokeAgentResult` land first (backward-compatible — new fields are optional).
  2. Daemon changes (§§6–10) land next, behind no flag — boot backfill makes it safe for existing installs.
  3. Hub control-frame allowlist update lands last (or together with daemon, since Hub is the caller).
- One release later, delete the working-memory migration branch (§8 steps 2's "else if" and step 4).
- Credentials relocation (into `agents/{id}/credentials.json`) is a separate plan; not bundled here.

## 15. Open questions

- Should the daemon track per-file mtimes in `state/` and offer the runtime a "what changed since last turn" diff? (Out of scope for this plan.)
- Should `ensureAgentWorkspace` write a `.botcord-agent` sentinel file for future tooling to detect agent-owned directories? Probably yes, but first version can skip.
- Windows paths: `homedir()` already handles them; `0700` permissions degrade to best-effort on NTFS — acceptable.
