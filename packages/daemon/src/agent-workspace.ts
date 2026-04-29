/**
 * Per-agent on-disk workspace. Each provisioned agent gets a dedicated
 * directory tree under `~/.botcord/agents/{agentId}/`:
 *
 *   workspace/   — runtime cwd; seed Markdown files live here (LLM-owned)
 *   state/       — daemon-owned JSON (e.g. working-memory.json)
 *   codex-home/  — per-agent CODEX_HOME used by the codex adapter so codex
 *                  reads a daemon-written AGENTS.md (systemContext carrier)
 *                  and stores its sessions/ without touching ~/.codex.
 *   hermes-home/      — per-agent HERMES_HOME used by the hermes-acp
 *                       adapter (carries .env, state.db, skills/) so
 *                       hermes-acp's per-user state stays isolated.
 *   hermes-workspace/ — per-agent runtime cwd for hermes-acp; the adapter
 *                       writes systemContext into AGENTS.md here every turn.
 *                       Kept separate from `workspace/` so daemon-written
 *                       systemContext does not clobber the user/agent-
 *                       editable workspace AGENTS.md.
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

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

/**
 * Per-agent HERMES_HOME. Carries the hermes-acp `.env`, `state.db`, and
 * `skills/` so each daemon-managed agent has an isolated hermes config
 * tree and never reads/writes the user's `~/.hermes`.
 */
export function agentHermesHomeDir(agentId: string): string {
  return path.join(agentHomeDir(agentId), "hermes-home");
}

/**
 * Per-agent runtime cwd for hermes-acp. Distinct from `workspace/` so the
 * adapter can rewrite `AGENTS.md` here every turn (carrying the dynamic
 * systemContext) without clobbering the user/agent-editable workspace
 * `AGENTS.md`. hermes discovers `AGENTS.md` from cwd upward, so the file
 * must live alongside the spawn cwd.
 */
export function agentHermesWorkspaceDir(agentId: string): string {
  return path.join(agentHomeDir(agentId), "hermes-workspace");
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

- \`identity.md\` is **auto-loaded** by the daemon and injected into every turn's
  system context as the \`[BotCord Identity]\` block. Edits to this file (yours,
  the dashboard's via \`applyAgentIdentity\`, or a hello-snapshot reapply) take
  effect on the next turn — no restart needed.
- \`memory.md\` and \`task.md\` are **convention, not mechanism**. The daemon does
  not auto-load them; you are instructed to skim them before responding and to
  write back what changed after meaningful turns. Keep them tight enough to be
  worth re-reading.
`;

const MEMORY_MD = `# Memory

<!--
Long-lived facts about the user, past decisions, and preferences that should
survive across conversations. Organize by topic. Keep entries short. Prune
regularly — AGENTS.md instructs you to consult this file before each
response, but nothing loads it automatically (unlike identity.md); keep it
short enough to be worth re-reading.
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

const HERMES_PROVIDER_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "HERMES_INFERENCE_MODEL",
  "HERMES_INFERENCE_PROVIDER",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
]);

function parseEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

/**
 * Seed per-agent Hermes credentials from the user's normal ~/.hermes/.env.
 * Only provider/model variables are copied; BotCord credentials, chat tokens,
 * and unrelated integration secrets are intentionally left behind.
 */
function mergeHermesProviderEnv(targetEnv: string): void {
  const sourceEnv = path.join(homedir(), ".hermes", ".env");
  if (!existsSync(sourceEnv)) return;

  let targetContent = "";
  try {
    targetContent = existsSync(targetEnv) ? readFileSync(targetEnv, "utf8") : "";
  } catch {
    targetContent = "";
  }
  const targetKeys = parseEnvKeys(targetContent);
  const additions: string[] = [];

  let sourceContent = "";
  try {
    sourceContent = readFileSync(sourceEnv, "utf8");
  } catch {
    return;
  }

  for (const rawLine of sourceContent.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) continue;
    const key = match[1];
    if (!HERMES_PROVIDER_ENV_KEYS.has(key) || targetKeys.has(key)) continue;
    additions.push(rawLine);
    targetKeys.add(key);
  }
  if (additions.length === 0) return;

  const prefix = targetContent.endsWith("\n") || targetContent.length === 0 ? "" : "\n";
  const header =
    targetContent.includes("Imported from ~/.hermes/.env")
      ? ""
      : "# Imported provider credentials from ~/.hermes/.env for BotCord-managed Hermes.\n";
  writeFileSync(targetEnv, `${targetContent}${prefix}${header}${additions.join("\n")}\n`, {
    mode: 0o600,
  });
}

function seedHermesConfig(hermesHome: string): void {
  const source = path.join(homedir(), ".hermes", "config.yaml");
  const target = path.join(hermesHome, "config.yaml");
  if (!existsSync(source) || existsSync(target)) return;
  try {
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  } catch {
    /* best-effort */
  }
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
 * Idempotently create the per-agent CODEX_HOME directory, link the
 * user's codex `auth.json` into it, and seed the bundled BotCord skills
 * under `<dir>/skills/` so the codex runtime (which sees this as
 * `CODEX_HOME`, not the user's `~/.codex`) can discover them. Does NOT
 * write an initial `AGENTS.md` — the codex adapter writes it fresh per
 * turn from `systemContext`.
 */
export function ensureAgentCodexHome(agentId: string): string {
  const dir = agentCodexHomeDir(agentId);
  mkdirTolerant(dir);
  linkCodexAuth(dir);
  seedCodexSkills(dir);
  return dir;
}

/**
 * Idempotently create the per-agent HERMES_HOME and HERMES workspace
 * directories. Writes a stub `.env` inside HERMES_HOME so hermes-acp's
 * `_load_env` does not log "No .env found" on every spawn; users can edit
 * this file to add API keys / model overrides. Also seeds the bundled
 * BotCord skills under `<hermes-home>/skills/` so hermes-acp's skill
 * loader (which only sees this isolated HERMES_HOME, not `~/.hermes`)
 * can discover them.
 */
export function ensureAgentHermesWorkspace(
  agentId: string,
  opts: { attached?: boolean } = {},
): {
  hermesHome: string;
  hermesWorkspace: string;
} {
  const hermesHome = agentHermesHomeDir(agentId);
  const hermesWorkspace = agentHermesWorkspaceDir(agentId);
  mkdirTolerant(hermesWorkspace);
  // Attach mode: HERMES_HOME points at the user's `~/.hermes/profiles/<n>/`
  // so we MUST NOT touch the per-agent isolated home. The cwd
  // (`hermesWorkspace`) is still ours and `prepareTurn` writes AGENTS.md
  // there — that's the only thing the daemon is allowed to author when
  // attached to a user-owned profile.
  if (opts.attached) {
    return { hermesHome, hermesWorkspace };
  }
  mkdirTolerant(hermesHome);
  writeIfMissing(
    path.join(hermesHome, ".env"),
    "# hermes-agent environment overrides for this BotCord agent.\n" +
      "# Add e.g. HERMES_INFERENCE_PROVIDER=openrouter, OPENROUTER_API_KEY=...\n",
  );
  seedHermesConfig(hermesHome);
  mergeHermesProviderEnv(path.join(hermesHome, ".env"));
  seedHermesAgentSkills(hermesHome);
  return { hermesHome, hermesWorkspace };
}

/**
 * Bundled BotCord skills shipped inside `@botcord/cli/skills/`. Skill
 * content (SKILL.md + helper scripts) is runtime-agnostic; only the
 * discovery path differs:
 *   - Claude Code: `<workspace>/.claude/skills/<name>/`
 *   - Codex:       `<codex-home>/skills/<name>/`
 *   - Hermes:      `<hermes-home>/skills/<name>/`
 * Seeded fresh per `ensureAgent*` call (force-overwrite) so daemon
 * upgrades propagate.
 */
const BUNDLED_SKILLS = ["botcord", "botcord-user-guide"] as const;

function resolveBundledCliSkillsRoot(): string | null {
  try {
    const pkgJsonPath = require.resolve("@botcord/cli/package.json");
    const root = path.join(path.dirname(pkgJsonPath), "skills");
    return existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

/**
 * Copy bundled skill directories into `destSkillsDir`, force-overwriting
 * any prior copy of each named skill. Other entries in `destSkillsDir`
 * are left alone so user-authored skills survive. Best-effort: silently
 * skips on copy failure or when the bundled CLI isn't resolvable.
 */
function copyBundledSkills(destSkillsDir: string): void {
  const sourceRoot = resolveBundledCliSkillsRoot();
  if (!sourceRoot) return;
  mkdirTolerant(destSkillsDir);
  for (const name of BUNDLED_SKILLS) {
    const src = path.join(sourceRoot, name);
    if (!existsSync(src)) continue;
    const dst = path.join(destSkillsDir, name);
    try {
      cpSync(src, dst, { recursive: true, force: true, dereference: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Seed Claude Code's `.claude/skills/` discovery dir under the agent
 * workspace. The `claude` adapter spawns with `--setting-sources project`
 * so this dir is auto-discovered.
 */
function seedClaudeCodeSkills(workspace: string): void {
  mkdirTolerant(path.join(workspace, ".claude"));
  copyBundledSkills(path.join(workspace, ".claude", "skills"));
}

/**
 * Seed Codex's `<CODEX_HOME>/skills/` discovery dir. The codex adapter
 * sets `CODEX_HOME=<agent>/codex-home/`, isolating per-agent skills from
 * the user's global `~/.codex/skills/` — so skills must be seeded here
 * for Codex agents to discover them.
 */
function seedCodexSkills(codexHome: string): void {
  copyBundledSkills(path.join(codexHome, "skills"));
}

/**
 * Seed Hermes's `<HERMES_HOME>/skills/` discovery dir. hermes-acp's
 * skill loader scans `$HERMES_HOME/skills/` (primary) plus any
 * `skills.external_dirs` from config; the daemon points hermes-acp at
 * the per-agent `<hermes-home>/`, so the user's global
 * `~/.hermes/skills/` is invisible — bundled skills must be seeded here.
 */
function seedHermesAgentSkills(hermesHome: string): void {
  copyBundledSkills(path.join(hermesHome, "skills"));
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
  ensureAgentHermesWorkspace(agentId);

  const agentsMdPath = path.join(workspace, "AGENTS.md");
  const claudeMdPath = path.join(workspace, "CLAUDE.md");
  writeIfMissing(agentsMdPath, AGENTS_MD);
  writeIfMissing(claudeMdPath, AGENTS_MD);
  writeIfMissing(path.join(workspace, "identity.md"), renderIdentity(agentId, seed));
  writeIfMissing(path.join(workspace, "memory.md"), MEMORY_MD);
  writeIfMissing(path.join(workspace, "task.md"), TASK_MD);
  writeIfMissing(path.join(notes, ".gitkeep"), "");
  seedClaudeCodeSkills(workspace);
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

/**
 * Read the agent's `identity.md` verbatim, if it exists. Returns the raw
 * contents (including the leading `# Identity` heading) so callers can
 * splice it into the system context. Returns `null` when the workspace
 * has not been provisioned yet, the file is empty, or the read fails.
 *
 * Each call hits disk — same contract as `readWorkingMemory`, so a
 * dashboard-driven edit (`applyAgentIdentity` from a control frame, or
 * a hello-snapshot reapply, or the agent's own self-edit) is visible
 * on the very next turn without restarting the gateway.
 */
export function readIdentity(agentId: string): string | null {
  assertSafeAgentId(agentId);
  const file = path.join(agentWorkspaceDir(agentId), "identity.md");
  try {
    const raw = readFileSync(file, "utf8");
    return raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}
