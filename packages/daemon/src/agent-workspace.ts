/**
 * Per-agent on-disk workspace. Each provisioned agent gets a dedicated
 * directory tree under `~/.botcord/agents/{agentId}/`:
 *
 *   workspace/   — runtime cwd; seed Markdown files live here (LLM-owned)
 *   state/       — daemon-owned JSON (e.g. working-memory.json)
 *   codex-home/  — per-agent CODEX_HOME used by the codex adapter so codex
 *                  reads a daemon-written AGENTS.md (systemContext carrier)
 *                  and stores its sessions/ without touching ~/.codex.
 *
 * See docs/daemon-agent-workspace-plan.md §4 for the full layout rationale.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Accepted agent id pattern. Enforced at every path-builder entry so a
// malicious / malformed agentId (e.g. "../../etc") cannot escape
// ~/.botcord/agents/ and end up under `rmSync(..., { recursive: true })`
// in revokeAgent(deleteWorkspace: true).
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertSafeAgentId(agentId: string): void {
  if (!agentId) throw new Error("agentId is required");
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`unsafe agentId: ${JSON.stringify(agentId)}`);
  }
}

export function agentHomeDir(agentId: string): string {
  assertSafeAgentId(agentId);
  return path.join(homedir(), ".botcord", "agents", agentId);
}

export function agentWorkspaceDir(agentId: string): string {
  return path.join(agentHomeDir(agentId), "workspace");
}

export function agentStateDir(agentId: string): string {
  return path.join(agentHomeDir(agentId), "state");
}

/**
 * Per-agent CODEX_HOME. The codex adapter sets the `CODEX_HOME` env var
 * to this path so codex reads a daemon-managed `AGENTS.md` (written fresh
 * each turn with the agent's systemContext) and stores its `sessions/`
 * here — neither touching `~/.codex/` nor the agent's `workspace/` cwd.
 */
export function agentCodexHomeDir(agentId: string): string {
  return path.join(agentHomeDir(agentId), "codex-home");
}

export interface WorkspaceSeed {
  displayName?: string;
  bio?: string;
  runtime?: string;
  keyId?: string;
  /** ISO timestamp. */
  savedAt?: string;
}

const AGENTS_MD = `# Agent Workspace

This directory is your persistent workspace. You run with \`cwd\` set here.

## Files you own

- \`identity.md\` — who you are, your role, your boundaries. Read before responding.
- \`memory.md\` — long-lived facts, user preferences, past decisions. Update when
  you learn something durable. Prune when it grows stale.
- \`task.md\` — current task and plan. Update as you make progress. Clear when done.
- \`notes/\` — free-form scratch space.

## Boundaries

- Do not modify files outside this workspace unless the user explicitly asks.
- \`../state/\` (sibling directory, outside this workspace) is managed by the
  daemon — do not read or edit it directly.

## How to use this

You are **instructed** to skim \`identity.md\`, \`memory.md\`, \`task.md\` before each
response and to write back what changed after meaningful turns. Nothing in the
runtime enforces this — the daemon does not auto-load these files into your
context. Treat AGENTS.md as a convention, not a mechanism.
`;

const MEMORY_MD = `# Memory

<!--
Long-lived facts about the user, past decisions, and preferences that should
survive across conversations. Organize by topic. Keep entries short. Prune
regularly — AGENTS.md instructs the runtime to consult this file before each
response, but nothing loads it automatically; keep it short enough to be
worth re-reading.
-->
`;

const TASK_MD = `# Current Task

<!--
What are you working on right now? What is the plan? What is blocked?
Clear this file when the task is done.
-->
`;

const BIO_PLACEHOLDER = "_(none provided at provision time — edit this section)_";
const FIELD_PLACEHOLDER = "_(not set)_";

function renderIdentity(agentId: string, seed: WorkspaceSeed): string {
  const bio = seed.bio && seed.bio.trim().length > 0 ? seed.bio : BIO_PLACEHOLDER;
  return `# Identity

- **Agent ID**: ${agentId}
- **Display name**: ${seed.displayName ?? FIELD_PLACEHOLDER}
- **Runtime**: ${seed.runtime ?? FIELD_PLACEHOLDER}
- **Key ID**: ${seed.keyId ?? FIELD_PLACEHOLDER}
- **Created**: ${seed.savedAt ?? FIELD_PLACEHOLDER}

## Bio

${bio}

## Role

_(Describe what you do and for whom. Edit this section.)_

## Boundaries

_(What you will and will not do. Edit this section.)_
`;
}

function mkdirTolerant(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // mkdirSync with `recursive: true` only applies `mode` to directories it
  // creates. If the agent home / workspace / state already existed with
  // looser perms (a very common case on upgrades), tighten them now.
  // Best-effort: some filesystems (e.g. certain Windows / SMB mounts) reject
  // chmod and that is acceptable.
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
}

function writeIfMissing(filePath: string, content: string): void {
  if (existsSync(filePath)) return;
  writeFileSync(filePath, content, { mode: 0o600 });
}

/**
 * Best-effort link user's `~/.codex/auth.json` into the per-agent CODEX_HOME.
 * Prefers a symlink (auto-follows `codex login` refreshes) and falls back to
 * a copy on filesystems that reject symlinks. A no-op if the user has never
 * run `codex login` — codex will then prompt on first use.
 */
function linkCodexAuth(codexHome: string): void {
  const source = path.join(homedir(), ".codex", "auth.json");
  if (!existsSync(source)) return;
  const target = path.join(codexHome, "auth.json");
  try {
    if (existsSync(target) || isSymlink(target)) {
      if (isSymlink(target) && readlinkSync(target) === source) return;
      unlinkSync(target);
    }
  } catch {
    // Unlink failure is rare but tolerable — symlink/copy below will fail
    // loudly if the collision is real.
  }
  try {
    symlinkSync(source, target);
    return;
  } catch {
    // Fall through to copy on filesystems without symlink support.
  }
  try {
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  } catch {
    /* best-effort */
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Idempotently create the per-agent CODEX_HOME directory and link the
 * user's codex `auth.json` into it. Does NOT write an initial `AGENTS.md`
 * — the codex adapter writes it fresh per turn from `systemContext`.
 */
export function ensureAgentCodexHome(agentId: string): string {
  const dir = agentCodexHomeDir(agentId);
  mkdirTolerant(dir);
  linkCodexAuth(dir);
  return dir;
}

/**
 * Idempotently create the agent's home / workspace / state directories and
 * seed the workspace Markdown files. Existing files are never overwritten —
 * users' edits to AGENTS.md, memory.md, etc. are preserved across calls.
 * State files are not touched here; working-memory.ts owns `state/`.
 */
export function ensureAgentWorkspace(agentId: string, seed: WorkspaceSeed): void {
  if (!agentId) throw new Error("ensureAgentWorkspace: agentId is required");
  const home = agentHomeDir(agentId);
  const workspace = agentWorkspaceDir(agentId);
  const notes = path.join(workspace, "notes");
  const state = agentStateDir(agentId);

  mkdirTolerant(home);
  mkdirTolerant(workspace);
  mkdirTolerant(notes);
  mkdirTolerant(state);
  ensureAgentCodexHome(agentId);

  const agentsMdPath = path.join(workspace, "AGENTS.md");
  const claudeMdPath = path.join(workspace, "CLAUDE.md");
  writeIfMissing(agentsMdPath, AGENTS_MD);
  writeIfMissing(claudeMdPath, AGENTS_MD);
  writeIfMissing(path.join(workspace, "identity.md"), renderIdentity(agentId, seed));
  writeIfMissing(path.join(workspace, "memory.md"), MEMORY_MD);
  writeIfMissing(path.join(workspace, "task.md"), TASK_MD);
  writeIfMissing(path.join(notes, ".gitkeep"), "");
}
