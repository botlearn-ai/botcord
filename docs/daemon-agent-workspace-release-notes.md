# Daemon agent workspace — release notes (draft)

Ship alongside the per-agent workspace feature.

## What changed

Every provisioned agent now gets its own directory at
`~/.botcord/agents/{agentId}/` with:

- `workspace/` — runtime `cwd`, seeded with `AGENTS.md`, `CLAUDE.md`,
  `identity.md`, `memory.md`, `task.md`, and an empty `notes/` folder. LLM-owned
  once it exists; the daemon will not overwrite these files.
- `state/working-memory.json` — daemon-owned runtime state. Moved here from
  `~/.botcord/daemon/memory/{agentId}/` (auto-migrated on first boot).

Provisioning without an explicit `cwd` now defaults to the per-agent workspace.
Existing agents are backfilled on daemon startup; credentials files are not
rewritten.

## Breaking behavior — Codex `workspace-write`

Codex non-owner turns run with `-s workspace-write`, which is scoped to the
turn's `cwd`. Before this change the daemon's `cwd` default was `$HOME`, so the
sandbox was effectively unlocked. After this change the default is
`~/.botcord/agents/{id}/workspace/`, and Codex can no longer write outside that
directory by default.

If you want a Codex agent to edit project code, set an explicit route in
`~/.botcord/daemon/config.json`:

```jsonc
{
  "routes": [
    {
      "match": { "accountId": "ag_..." },
      "adapter": "codex",
      "cwd": "/path/to/your/project"
    }
  ]
}
```

User-authored routes always win over the synthesized per-agent workspace
route.

## `revoke_agent` flag changes

`RevokeAgentParams` gains two optional fields:

- `deleteState` — default: same as `deleteCredentials`. Removes
  `~/.botcord/agents/{id}/state/`.
- `deleteWorkspace` — default: `false`. Requires explicit opt-in; removes the
  entire `~/.botcord/agents/{id}/` directory, including user-authored memory
  and notes.

Vanilla `revoke_agent` (no flags) now preserves `workspace/` by default. This
is a deliberate change — previously `revoke` only wiped credentials; now it
wipes credentials + runtime state but keeps LLM-authored workspace content.

`RevokeAgentResult` gains `stateDeleted` and `workspaceDeleted` booleans.

## Override trade-off

When an operator sets an explicit `cwd` (project directory, not the per-agent
workspace), the runtime starts in the project tree and **does not see**
`identity.md` / `memory.md` / `task.md`. Those files still exist under
`~/.botcord/agents/{id}/workspace/` but are outside the runtime's `cwd`. This
is an accepted trade-off for v1; operators are expected to manage their own
context surface (project `AGENTS.md`, `CLAUDE.md`, etc.) in overridden cwds.
