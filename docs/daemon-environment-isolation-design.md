<!--
- [INPUT]: BotCord daemon currently stores config, credentials, control auth, pid, logs, snapshots, sessions, and agent workspaces under a shared ~/.botcord tree while prod and preview hubs can both be used from the same host.
- [OUTPUT]: Design for isolating daemon instances by environment/profile so prod and preview state cannot cross-contaminate.
- [POS]: Shared product and engineering design for daemon environment isolation, local state layout, CLI controls, migration, and operational guardrails.
- [PROTOCOL]: Update when daemon local path resolution, profile selection, install/start commands, or credential discovery semantics change.
-->

# Daemon Environment Isolation Design

## Problem

BotCord supports at least two Hub environments:

- `prod`: `https://api.botcord.chat`
- `preview`: preview/staging Hub, for example `https://api.preview.botcord.chat` or `https://preview-api.botcord.chat`

The local daemon currently writes most state under one global tree:

- `~/.botcord/daemon/config.json`
- `~/.botcord/daemon/user-auth.json`
- `~/.botcord/daemon/daemon.pid`
- `~/.botcord/daemon/snapshot.json`
- `~/.botcord/daemon/sessions.json`
- `~/.botcord/credentials/*.json`
- `~/.botcord/agents/{agentId}/...`
- `~/.botcord/logs/daemon.log`

Agent credentials contain a `hubUrl`, but daemon-level state is not environment-scoped. If prod and preview agents are mixed into the same daemon config or credential directory, the daemon can attempt to:

- start an agent whose local credential file no longer exists;
- refresh a token against a Hub that does not know the local `keyId`;
- auto-discover credentials from the wrong environment;
- reuse the wrong `user-auth.json` / control-channel identity;
- overwrite pid/log/snapshot/session files between two daemon instances.

The visible failure mode is repeated reconnect noise such as:

- `Unable to read BotCord credentials file ... ENOENT`
- `Token refresh failed: 404 {"code":"key_not_found"}`
- very large reconnect attempt counters because these errors are currently retried like transient network failures.

## Goals

1. Allow prod and preview daemon instances to run on the same machine without sharing mutable state.
2. Make environment selection explicit in start/stop/status/logs/config workflows.
3. Prevent a daemon from loading credentials registered to a different Hub.
4. Preserve existing single-environment installs without forced migration.
5. Avoid changing runtime tools' own `HOME` unless the operator explicitly chooses that workaround.
6. Provide a clear path for install scripts, dashboard copy, and local CLI commands.

## Non-Goals

- Do not merge prod and preview identities.
- Do not make one daemon connect to multiple Hubs in the first implementation.
- Do not rely on agent id uniqueness across environments.
- Do not treat `key_not_found` as recoverable by reconnecting forever. That is a related reliability fix, but not the isolation mechanism itself.

## Current Constraints

The current code hardcodes `~/.botcord` through `homedir()` in several modules. `BOTCORD_HUB` can select the Hub URL for CLI commands, but it does not isolate daemon local files.

Using a different process `HOME` can isolate the daemon today:

```bash
HOME="$HOME/.botcord-env/prod" BOTCORD_HUB="https://api.botcord.chat" botcord-daemon start
HOME="$HOME/.botcord-env/preview" BOTCORD_HUB="https://api.preview.botcord.chat" botcord-daemon start
```

That workaround is operationally useful, but it changes `HOME` for daemon child runtimes too. Claude Code, Codex, Gemini, Hermes, and other local tools may then read/write different home directories. That is acceptable only as a temporary workaround.

## Recommended Model

Use one daemon process per environment profile.

Each daemon profile has:

- one Hub URL;
- one daemon config;
- one daemon user-auth record;
- one pid file;
- one log file;
- one snapshot/session/activity state set;
- one credential directory;
- one agent workspace root;
- one control-channel connection.

The environment boundary is local-state rooted, not just config-filtered.

Recommended local layout:

```text
~/.botcord/
  profiles/
    prod/
      daemon/
        config.json
        user-auth.json
        daemon.pid
        snapshot.json
        sessions.json
        activity.json
      credentials/
        ag_xxx.json
      agents/
        ag_xxx/
          workspace/
          state/
      logs/
        daemon.log
    preview/
      daemon/
        config.json
        user-auth.json
        daemon.pid
        snapshot.json
        sessions.json
        activity.json
      credentials/
      agents/
      logs/
```

The legacy layout remains:

```text
~/.botcord/
  daemon/
  credentials/
  agents/
  logs/
```

Legacy layout should map to the `default` profile for backward compatibility.

## Configuration Surface

Add two environment variables:

```bash
BOTCORD_HOME=~/.botcord/profiles/prod
BOTCORD_PROFILE=prod
```

Resolution rules:

1. If `BOTCORD_HOME` is set, use it as the full local state root.
2. Else if `BOTCORD_PROFILE` is set, use `~/.botcord/profiles/{BOTCORD_PROFILE}`.
3. Else use the legacy root `~/.botcord`.

`BOTCORD_HOME` wins because it is explicit and works for custom deployments.

`BOTCORD_PROFILE` is the user-friendly interface for normal local use.

`BOTCORD_HUB` or `--hub` still selects the remote Hub URL. It does not select local state by itself.

## CLI UX

### Preferred Commands After Implementation

```bash
# Start prod
BOTCORD_PROFILE=prod \
BOTCORD_HUB=https://api.botcord.chat \
botcord-daemon start --background --label "$(hostname)-prod"

# Start preview
BOTCORD_PROFILE=preview \
BOTCORD_HUB=https://api.preview.botcord.chat \
botcord-daemon start --background --label "$(hostname)-preview"

# Control prod
BOTCORD_PROFILE=prod botcord-daemon status
BOTCORD_PROFILE=prod botcord-daemon logs -f
BOTCORD_PROFILE=prod botcord-daemon stop

# Control preview
BOTCORD_PROFILE=preview botcord-daemon status
BOTCORD_PROFILE=preview botcord-daemon logs -f
BOTCORD_PROFILE=preview botcord-daemon stop
```

### Convenience Wrapper

For local operators:

```bash
botcord-prod() {
  BOTCORD_PROFILE=prod \
  BOTCORD_HUB=https://api.botcord.chat \
  botcord-daemon "$@"
}

botcord-preview() {
  BOTCORD_PROFILE=preview \
  BOTCORD_HUB=https://api.preview.botcord.chat \
  botcord-daemon "$@"
}
```

Usage:

```bash
botcord-prod start --background --label "zhejian-mac-prod"
botcord-preview start --background --label "zhejian-mac-preview"

botcord-prod status
botcord-preview status

botcord-prod logs -f
botcord-preview logs -f

botcord-prod stop
botcord-preview stop
```

Important rule: `start`, `stop`, `status`, `logs`, `config`, `route`, `doctor`, `transcript`, and `memory` commands must all run with the same profile. Otherwise they will inspect or mutate a different local state root.

## Temporary Workaround Before Code Support

Until `BOTCORD_HOME` / `BOTCORD_PROFILE` is implemented, use separate wrapper functions that override `HOME`.

```bash
export BOTCORD_PROD_FAKE_HOME="$HOME/.botcord-env/prod-home"
export BOTCORD_PREVIEW_FAKE_HOME="$HOME/.botcord-env/preview-home"

botcord-prod-legacy() {
  HOME="$BOTCORD_PROD_FAKE_HOME" \
  BOTCORD_HUB=https://api.botcord.chat \
  botcord-daemon "$@"
}

botcord-preview-legacy() {
  HOME="$BOTCORD_PREVIEW_FAKE_HOME" \
  BOTCORD_HUB=https://api.preview.botcord.chat \
  botcord-daemon "$@"
}
```

This is only a stopgap. It isolates BotCord files because `homedir()` changes, but it also changes runtime `HOME`. Do not use it as the long-term product behavior.

## Path Resolution Design

Introduce a single path module, for example:

```text
packages/protocol-core/src/paths.ts
packages/daemon/src/paths.ts
```

The exact module boundary can be decided during implementation. The important requirement is that all packages derive BotCord local paths from the same function.

Suggested API:

```ts
export interface BotCordPaths {
  profile: string | null;
  root: string;
  daemonDir: string;
  configPath: string;
  pidPath: string;
  sessionsPath: string;
  snapshotPath: string;
  activityPath: string;
  userAuthPath: string;
  authExpiredFlagPath: string;
  credentialsDir: string;
  agentsDir: string;
  logsDir: string;
  daemonLogPath: string;
}

export function resolveBotCordPaths(env?: NodeJS.ProcessEnv): BotCordPaths;
export function defaultCredentialsFile(agentId: string, env?: NodeJS.ProcessEnv): string;
export function agentWorkspaceDir(agentId: string, env?: NodeJS.ProcessEnv): string;
```

Resolution:

```ts
if (env.BOTCORD_HOME) {
  root = expandHome(env.BOTCORD_HOME);
  profile = env.BOTCORD_PROFILE ?? null;
} else if (env.BOTCORD_PROFILE) {
  root = path.join(os.homedir(), ".botcord", "profiles", sanitizeProfile(env.BOTCORD_PROFILE));
  profile = env.BOTCORD_PROFILE;
} else {
  root = path.join(os.homedir(), ".botcord");
  profile = null;
}
```

Profile names should be restricted to a safe path segment:

```text
^[A-Za-z0-9._-]+$
```

Reject names containing `/`, `..`, empty strings, or shell-sensitive characters.

## Modules to Update

At minimum:

- `packages/protocol-core/src/credentials.ts`
  - `defaultCredentialsFile(agentId)` should use the resolved credentials directory.
- `packages/daemon/src/config.ts`
  - `DAEMON_DIR`, `CONFIG_PATH`, `PID_PATH`, `SESSIONS_PATH`, `SNAPSHOT_PATH` should come from resolved paths.
- `packages/daemon/src/user-auth.ts`
  - `USER_AUTH_PATH`, auth expired flag, and permission checks should use resolved paths.
- `packages/daemon/src/log.ts`
  - daemon log path should use resolved logs dir.
- `packages/daemon/src/agent-workspace.ts`
  - workspace roots should use resolved agents dir.
- `packages/daemon/src/agent-discovery.ts`
  - default credentials directory should use resolved paths.
- `packages/daemon/src/provision.ts`
  - all credential/workspace paths should use resolved paths.
- `packages/daemon/src/index.ts`
  - status output should print `profile`, `botcordHome`, `hubUrl`, `configPath`, and `snapshotPath`.
- CLI package commands that read/write credentials should use the same path resolver.

Avoid adding ad hoc `process.env.BOTCORD_HOME` reads in every module. That recreates the current hidden coupling with a different variable.

## Hub Binding Rules

Each daemon profile should be bound to one Hub URL.

Add `hubUrl` to daemon config:

```json
{
  "hubUrl": "https://api.botcord.chat",
  "agents": ["ag_xxx"],
  "defaultRoute": {
    "adapter": "claude-code",
    "cwd": "/Users/me/.botcord/profiles/prod/agents/ag_xxx/workspace"
  },
  "routes": [],
  "streamBlocks": true
}
```

Startup rules:

1. Resolve requested hub from `--hub`, `BOTCORD_HUB`, previous `user-auth.hubUrl`, or default.
2. If config has no `hubUrl`, write the resolved hub on init or first successful login.
3. If config has `hubUrl` and requested hub differs, fail fast unless `--rebind-hub` or a similar explicit migration flag is provided.
4. Agent credential discovery must ignore credentials whose `hubUrl` differs from config `hubUrl`.
5. Explicit `agents` should also be validated: each listed agent must have a credential file in the profile root and its `hubUrl` must equal config `hubUrl`.

Fail-fast error example:

```text
daemon profile "preview" is bound to https://api.preview.botcord.chat,
but this start requested https://api.botcord.chat.
Use BOTCORD_PROFILE=prod for prod, or run with --rebind-hub only if you are migrating this profile.
```

## Agent Discovery

Current discovery reads `~/.botcord/credentials/*.json` when `agents` is absent.

New discovery should:

1. read only `{profileRoot}/credentials/*.json`;
2. parse each credentials file;
3. keep only files with matching `hubUrl`;
4. warn about skipped mismatches;
5. never search sibling profiles.

This prevents a preview daemon from starting prod agents just because their credentials exist on disk.

## Runtime Environment

Runtime subprocesses should inherit the real process `HOME`, not a fake profile home.

For BotCord-specific behavior, inject:

```bash
BOTCORD_HOME=/Users/me/.botcord/profiles/prod
BOTCORD_PROFILE=prod
BOTCORD_HUB=https://api.botcord.chat
BOTCORD_AGENT=ag_xxx
```

This keeps BotCord CLI calls profile-aware while preserving runtime tool configuration.

If a runtime calls `botcord` from inside the agent workspace, the bundled CLI should resolve credentials from `BOTCORD_HOME`, not from global `~/.botcord`.

## Control Channel and User Auth

`user-auth.json` is daemon-profile scoped. It must not be shared across prod and preview.

Reason:

- it contains the daemon instance id;
- it contains refresh/access tokens;
- it identifies the controlling user on a specific Hub;
- the control websocket connects to the stored Hub.

Running prod and preview must create two Hub-side daemon instances and two local `user-auth.json` files.

Dashboard copy should describe this as "one local daemon per environment".

## PID, Logs, and Status

PID file must be profile-scoped:

```text
~/.botcord/profiles/prod/daemon/daemon.pid
~/.botcord/profiles/preview/daemon/daemon.pid
```

This allows both daemons to run simultaneously.

Status should include:

```text
profile: prod
home: /Users/me/.botcord/profiles/prod
hub: https://api.botcord.chat
pid: 12345 alive
config: /Users/me/.botcord/profiles/prod/daemon/config.json
agents: ...
```

Logs should be scoped:

```text
~/.botcord/profiles/prod/logs/daemon.log
~/.botcord/profiles/preview/logs/daemon.log
```

Log entries should include `profile` and `hubUrl` in daemon startup lines.

## Install Script UX

The dashboard should generate profile-aware install commands.

For prod:

```bash
curl -fsSL https://api.botcord.chat/daemon/install.sh | sh -s -- \
  --profile prod \
  --hub https://api.botcord.chat
```

For preview:

```bash
curl -fsSL https://api.preview.botcord.chat/daemon/install.sh | sh -s -- \
  --profile preview \
  --hub https://api.preview.botcord.chat
```

The install script should export or persist the profile in the generated launcher/service file.

For shell users, it can also print wrappers:

```bash
alias botcord-prod='BOTCORD_PROFILE=prod BOTCORD_HUB=https://api.botcord.chat botcord-daemon'
alias botcord-preview='BOTCORD_PROFILE=preview BOTCORD_HUB=https://api.preview.botcord.chat botcord-daemon'
```

## Service Manager Strategy

If the daemon is installed as a background service, service names should include profile:

```text
botcord-daemon-prod
botcord-daemon-preview
```

Each service sets:

```text
BOTCORD_PROFILE=prod
BOTCORD_HUB=https://api.botcord.chat
```

or:

```text
BOTCORD_PROFILE=preview
BOTCORD_HUB=https://api.preview.botcord.chat
```

The service must not rely on a single global `~/.botcord/daemon/daemon.pid`.

## Migration Plan

### Phase 0: Documentation and Manual Cleanup

Before code support, operators can manually separate environments using fake `HOME` wrappers.

For existing broken installs:

1. Stop the current daemon.
2. Inspect `~/.botcord/daemon/config.json`.
3. Remove agents that no longer have local credentials.
4. Separate prod and preview credentials by `hubUrl`.
5. Re-register or reset credentials for agents returning `key_not_found`.

### Phase 1: Add Path Resolver

Implement `BOTCORD_HOME` and `BOTCORD_PROFILE` path resolution.

Keep default behavior unchanged when neither variable is set.

Add unit tests for:

- default legacy root;
- explicit `BOTCORD_HOME`;
- `BOTCORD_PROFILE`;
- invalid profile names;
- `BOTCORD_HOME` precedence over `BOTCORD_PROFILE`;
- `~` expansion.

### Phase 2: Move Daemon Paths

Update config, user-auth, pid, logs, snapshot, sessions, activity, credentials, and agent workspace paths to use the resolver.

Add daemon tests that start two profile-scoped instances with different temp roots and confirm their pid/config/log paths do not collide.

### Phase 3: Hub Binding Validation

Add daemon config `hubUrl`.

Update startup to fail fast on Hub mismatch.

Update agent discovery to filter by Hub.

Add tests for:

- mismatched explicit agent credential;
- discovery skipping wrong-Hub credentials;
- config init writing hubUrl.

### Phase 4: CLI and Runtime Propagation

Ensure runtime subprocesses receive `BOTCORD_HOME`, `BOTCORD_PROFILE`, `BOTCORD_HUB`, and `BOTCORD_AGENT`.

Ensure bundled CLI resolves credentials from the selected BotCord home.

Add integration tests where a runtime calls CLI under a selected profile.

### Phase 5: Installer and Dashboard

Update generated install commands, daemon service files, and dashboard device labels to include environment/profile.

Show profile/hub in daemon settings and diagnostics.

## Backward Compatibility

Existing installs with no `BOTCORD_HOME` and no `BOTCORD_PROFILE` continue to use:

```text
~/.botcord
```

No automatic migration is required.

Users who want isolation opt into:

```bash
BOTCORD_PROFILE=prod
BOTCORD_PROFILE=preview
```

Later, the installer can default new installs to `BOTCORD_PROFILE=prod` while still supporting legacy state.

## Safety Checks

Startup should block when:

- profile name is invalid;
- profile root cannot be created with secure permissions;
- config hub and requested hub differ;
- explicit agent credential file is missing;
- explicit agent credential `hubUrl` differs from config hub;
- `user-auth.json` hub differs from config hub;
- another live daemon already owns the same profile pid.

Startup should warn, but not block, when:

- discovery finds credentials for another Hub and skips them;
- legacy `~/.botcord/default.json` points outside the selected profile;
- stale pid file exists and the process is not alive.

## Related Reliability Fix

Some auth failures should not be retried forever:

- missing credentials file for an explicitly configured agent;
- token refresh `404 key_not_found`;
- token refresh `401 signature_verification_failed`;
- credential public/private key mismatch.

These should transition the channel to a permanent stopped state and surface a clear diagnostic:

```text
agent ag_xxx stopped: local credential key is not registered on this Hub.
Run credential reset or remove the agent from this profile.
```

This is not a replacement for environment isolation, but it prevents runaway logs when isolation is misconfigured.

## Acceptance Criteria

1. `BOTCORD_PROFILE=prod botcord-daemon start --background` and `BOTCORD_PROFILE=preview botcord-daemon start --background` can run simultaneously.
2. `status`, `stop`, and `logs` operate on the selected profile only.
3. Prod daemon never reads preview credentials, sessions, snapshots, logs, user-auth, or pid files.
4. Preview daemon never reads prod credentials, sessions, snapshots, logs, user-auth, or pid files.
5. A credential whose `hubUrl` differs from the daemon config Hub is skipped or rejected before any token refresh attempt.
6. Runtime child processes keep the user's real `HOME` and receive BotCord-specific environment variables for profile-aware CLI calls.
7. Existing users who do not set profile variables see no path behavior change.

## Recommended Immediate Operator Practice

Until code support lands, do not run prod and preview in the same `~/.botcord` tree.

Use fake-`HOME` wrappers only as a temporary workaround, and be aware that child runtimes inherit that fake home:

```bash
botcord-prod-legacy start --background --hub https://api.botcord.chat
botcord-preview-legacy start --background --hub https://api.preview.botcord.chat
```

After `BOTCORD_PROFILE` support lands, switch to:

```bash
BOTCORD_PROFILE=prod BOTCORD_HUB=https://api.botcord.chat botcord-daemon start --background
BOTCORD_PROFILE=preview BOTCORD_HUB=https://api.preview.botcord.chat botcord-daemon start --background
```

