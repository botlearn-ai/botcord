/**
 * Per-agent on-disk workspace. Each provisioned agent gets a dedicated
 * directory tree under `~/.botcord/agents/{agentId}/`:
 *
 *   workspace/   — runtime cwd; seed Markdown files live here (LLM-owned)
 *   state/       — daemon-owned JSON (e.g. working-memory.json)
 *   codex-home/  — per-agent CODEX_HOME used by the codex adapter so codex
 *                  reads a daemon-written AGENTS.md (systemContext carrier)
 *                  and stores its sessions/ without touching ~/.codex.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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

/** Patch fields accepted by {@link applyAgentIdentity}. `bio = null` clears it. */
export interface AgentIdentityPatch {
  displayName?: string;
  bio?: string | null;
}

/**
 * Result of applying an identity patch. `changed` is true only when the
 * file was rewritten on disk; `skipped` reports why (no-op vs. unable).
 */
export interface AgentIdentityApplyResult {
  changed: boolean;
  skipped?: "missing-file" | "no-change" | "unparseable";
}

const DISPLAY_NAME_LINE = /^- \*\*Display name\*\*: .*$/m;
// Match the Bio section's body. Anchor on the next `##` heading when one
// exists, otherwise consume to end-of-file — keeps the rewrite working when
// the user has stripped Role/Boundaries sections.
const BIO_SECTION = /(## Bio\n\n)([\s\S]*?)(\n+##\s|$)/;

/**
 * Surgically rewrite the `Display name` and `Bio` fields inside an existing
 * `identity.md`, preserving anything the user has authored elsewhere
 * (Role / Boundaries / arbitrary new sections). No-op when the file is
 * missing — provisioning will create it with the correct values, and
 * subsequent hello snapshots simply reapply the dashboard truth.
 *
 * The identity.md template carries `Role` / `Boundaries` headings after
 * `## Bio`; we anchor the Bio rewrite on "next `##`" so user-added
 * paragraphs inside Bio are replaced wholesale (the dashboard is the
 * source of truth) without disturbing siblings.
 */
export function applyAgentIdentity(
  agentId: string,
  patch: AgentIdentityPatch,
): AgentIdentityApplyResult {
  assertSafeAgentId(agentId);
  const file = path.join(agentWorkspaceDir(agentId), "identity.md");
  if (!existsSync(file)) {
    return { changed: false, skipped: "missing-file" };
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { changed: false, skipped: "missing-file" };
  }

  const original = text;
  let touched = false;

  if (typeof patch.displayName === "string") {
    const value = patch.displayName.length > 0 ? patch.displayName : FIELD_PLACEHOLDER;
    if (DISPLAY_NAME_LINE.test(text)) {
      // Use a function replacer so `$1`, `$&` etc. inside the value are
      // treated literally rather than as backreferences.
      text = text.replace(DISPLAY_NAME_LINE, () => `- **Display name**: ${value}`);
      touched = true;
    } else {
      // Heavily-edited file without the canonical metadata block — bail
      // out rather than guess where to splice.
      return { changed: false, skipped: "unparseable" };
    }
  }

  if (patch.bio !== undefined) {
    const bioText =
      patch.bio !== null && patch.bio.trim().length > 0
        ? patch.bio.trim()
        : BIO_PLACEHOLDER;
    if (BIO_SECTION.test(text)) {
      text = text.replace(BIO_SECTION, (_match, head, _body, tail) => `${head}${bioText}${tail}`);
      touched = true;
    } else {
      return { changed: false, skipped: "unparseable" };
    }
  }

  if (!touched || text === original) {
    return { changed: false, skipped: "no-change" };
  }

  writeFileSync(file, text, { mode: 0o600 });
  return { changed: true };
}
