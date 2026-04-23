/**
 * Working memory — persistent, account-scoped notes injected into every turn.
 *
 * Stored at `~/.botcord/agents/{agentId}/state/working-memory.json` (the
 * per-agent state dir owned by the daemon; see docs/daemon-agent-workspace-plan.md §8).
 *
 * Ported from plugin/src/memory.ts (dropping workspace + OpenClaw runtime
 * branches) and plugin/src/memory-protocol.ts (prompt builder).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { agentStateDir } from "./agent-workspace.js";
import { DAEMON_DIR_PATH } from "./config.js";
import { log as daemonLog } from "./log.js";

export interface WorkingMemory {
  version: 2;
  goal?: string;
  sections: Record<string, string>;
  updatedAt: string;
}

/** v1 shape kept only for one-way migration on read. */
interface WorkingMemoryV1 {
  version: 1;
  content: string;
  updatedAt: string;
}

const VALID_SECTION_KEY_RE = /^[a-zA-Z0-9_]+$/;

/** Characters per section; matches the plugin-side limit. */
export const MAX_SECTION_CHARS = 10_000;
export const MAX_GOAL_CHARS = 500;
export const MAX_TOTAL_CHARS = 20_000;
export const DEFAULT_SECTION = "notes";

const MEMORY_SIZE_WARN_CHARS = 2_000;
/** Tags that must not appear verbatim in injected memory content. */
const RESERVED_TAGS_RE = /<\/?(?:current_memory|section_\w+)\b[^>]*>/gi;

// ── Path resolution ────────────────────────────────────────────────

/**
 * Canonical per-agent state directory. Returns the new location
 * (`~/.botcord/agents/{agentId}/state`). The legacy location under
 * `~/.botcord/daemon/memory/{agentId}` is migrated lazily on first read —
 * see §8 of the daemon-agent-workspace plan.
 */
export function resolveMemoryDir(agentId: string): string {
  if (!agentId) throw new Error("resolveMemoryDir: agentId is required");
  return agentStateDir(agentId);
}

/** Legacy location retained for one-shot migration on read. */
function legacyMemoryDir(agentId: string): string {
  return path.join(DAEMON_DIR_PATH, "memory", agentId);
}

function workingMemoryPath(agentId: string): string {
  return path.join(resolveMemoryDir(agentId), "working-memory.json");
}

function legacyWorkingMemoryPath(agentId: string): string {
  return path.join(legacyMemoryDir(agentId), "working-memory.json");
}

// Migration conflict warnings are emitted at most once per agent per
// process. Reset only by daemon restart — good enough for a one-release
// transitional branch that gets removed later.
const warnedMigrationConflict = new Set<string>();

/**
 * Resolve the path to read from, migrating from the legacy location if
 * necessary. Returns the path the caller should read, or `null` when no
 * memory file exists anywhere.
 *
 * Migration branch (the `else if` on `legacyExists` below) is meant to be
 * deleted one release after this change ships; see plan §8 step 6.
 */
function resolveReadPath(agentId: string): string | null {
  const newPath = workingMemoryPath(agentId);
  const oldPath = legacyWorkingMemoryPath(agentId);
  const newExists = existsSync(newPath);
  const oldExists = existsSync(oldPath);

  if (newExists) {
    if (oldExists && !warnedMigrationConflict.has(agentId)) {
      warnedMigrationConflict.add(agentId);
      daemonLog.warn("working-memory: both new and legacy paths exist; using new", {
        agentId,
        oldPath,
        newPath,
      });
    }
    return newPath;
  }
  if (oldExists) {
    try {
      mkdirSync(path.dirname(newPath), { recursive: true, mode: 0o700 });
      try {
        renameSync(oldPath, newPath);
      } catch (err) {
        // EXDEV = legacy and new paths live on different filesystems
        // (bind mounts, tmpfs overlays). `renameSync` cannot cross fs
        // boundaries, so fall back to copy + unlink. Without this, the
        // next write would go to newPath while legacy still has the old
        // payload — silent divergence the reviewer of §8 flagged.
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          copyFileSync(oldPath, newPath);
          unlinkSync(oldPath);
        } else {
          throw err;
        }
      }
      return newPath;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      daemonLog.warn("working-memory: migration rename failed; reading legacy path", {
        agentId,
        oldPath,
        newPath,
        code: e.code,
        error: e.message ?? String(err),
      });
      return oldPath;
    }
  }
  return null;
}

// ── File I/O ───────────────────────────────────────────────────────

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Atomic write: tmp file + rename so a crash never leaves a half-file. */
function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, filePath);
}

function sanitizeSections(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (VALID_SECTION_KEY_RE.test(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

function normalize(raw: unknown): WorkingMemory | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version === 2 && r.sections && typeof r.sections === "object") {
    return {
      version: 2,
      goal: typeof r.goal === "string" ? r.goal : undefined,
      sections: sanitizeSections(r.sections),
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    };
  }
  if (r.version === 1 && typeof r.content === "string") {
    const v1 = r as unknown as WorkingMemoryV1;
    return {
      version: 2,
      sections: v1.content ? { [DEFAULT_SECTION]: v1.content } : {},
      updatedAt: typeof v1.updatedAt === "string" ? v1.updatedAt : "",
    };
  }
  return null;
}

export function readWorkingMemory(agentId: string): WorkingMemory | null {
  const p = resolveReadPath(agentId);
  if (!p) return null;
  return normalize(readJson<unknown>(p));
}

export function writeWorkingMemory(agentId: string, data: WorkingMemory): void {
  writeJsonAtomic(workingMemoryPath(agentId), data);
}

// ── Mutations used by the memory CLI ───────────────────────────────

export interface SetSectionResult {
  memory: WorkingMemory;
  totalChars: number;
  /** Whether the targeted section ended up present after the write. */
  sectionPresent: boolean;
}

/**
 * Upsert a section (or goal). Passing empty `content` with a `section`
 * deletes that section. `goal === ""` clears the goal.
 */
export function updateWorkingMemory(
  agentId: string,
  update: { goal?: string; section?: string; content?: string },
): SetSectionResult {
  if (update.goal === undefined && update.content === undefined) {
    throw new Error("updateWorkingMemory: must provide 'goal' or 'content'");
  }
  if (update.goal !== undefined && update.goal.length > MAX_GOAL_CHARS) {
    throw new Error(`goal exceeds ${MAX_GOAL_CHARS} characters`);
  }
  const sectionName = (update.section ?? DEFAULT_SECTION).trim();
  if (update.content !== undefined && !VALID_SECTION_KEY_RE.test(sectionName)) {
    throw new Error(
      "section name must contain only letters, digits, and underscores",
    );
  }
  if (
    update.content !== undefined &&
    update.content.length > MAX_SECTION_CHARS
  ) {
    throw new Error(
      `content exceeds ${MAX_SECTION_CHARS} characters for section '${sectionName}'`,
    );
  }

  const existing: WorkingMemory = readWorkingMemory(agentId) ?? {
    version: 2,
    sections: {},
    updatedAt: "",
  };

  if (update.goal !== undefined) {
    existing.goal = update.goal === "" ? undefined : update.goal;
  }
  if (update.content !== undefined) {
    if (update.content === "") delete existing.sections[sectionName];
    else existing.sections[sectionName] = update.content;
  }

  const totalChars =
    (existing.goal?.length ?? 0) +
    Object.values(existing.sections).reduce((s, v) => s + v.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new Error(
      `total working memory exceeds ${MAX_TOTAL_CHARS} characters (current: ${totalChars})`,
    );
  }

  existing.updatedAt = new Date().toISOString();
  writeWorkingMemory(agentId, existing);

  return {
    memory: existing,
    totalChars,
    sectionPresent:
      update.content !== undefined ? update.content !== "" : sectionName in existing.sections,
  };
}

/** Wipe the agent's working memory entirely (goal + all sections). */
export function clearWorkingMemory(agentId: string): void {
  const empty: WorkingMemory = {
    version: 2,
    sections: {},
    updatedAt: new Date().toISOString(),
  };
  writeWorkingMemory(agentId, empty);
}

// ── Prompt builder ─────────────────────────────────────────────────

function sanitizeMemoryContent(content: string): string {
  return content.replace(RESERVED_TAGS_RE, (tag) =>
    tag.replace(/</g, "‹").replace(/>/g, "›"),
  );
}

/**
 * Render a system-prompt block describing the agent's working memory. The
 * format intentionally mirrors the plugin's so a CLI-side agent sees the
 * same shape as an OpenClaw-hosted one.
 */
export function buildWorkingMemoryPrompt(opts: {
  workingMemory: WorkingMemory | null;
  warnLarge?: boolean;
}): string {
  const { workingMemory, warnLarge = true } = opts;

  const lines: string[] = [
    "[BotCord Working Memory]",
    "You have a persistent working memory that survives across turns and rooms.",
    "Use it to track your goal, important facts, pending commitments, and context worth remembering.",
    "",
    "Update via the daemon's `memory` CLI (or whatever tool the operator wires):",
    "- goal: a short pinned statement of what you're working on.",
    "- sections: named buckets (contacts, pending_tasks, preferences, etc.).",
    "- Updating one section never touches others. Empty content deletes a section.",
    "",
    "Only update when something meaningful changes. Keep each section tight.",
  ];

  if (!workingMemory) {
    lines.push("", "Your working memory is currently empty.");
    return lines.join("\n");
  }

  const entries = Object.entries(workingMemory.sections ?? {});
  const hasGoal = !!workingMemory.goal;
  const hasSections = entries.length > 0;

  if (!hasGoal && !hasSections) {
    lines.push("", "Your working memory is currently empty.");
    return lines.join("\n");
  }

  lines.push("", `Current working memory (last updated: ${workingMemory.updatedAt}):`);

  let totalChars = 0;
  if (hasGoal) {
    const goal = sanitizeMemoryContent(
      workingMemory.goal!.replace(/[\r\n]+/g, " ").trim(),
    );
    lines.push("", `Goal: ${goal}`);
    totalChars += goal.length;
  }
  for (const [name, content] of entries) {
    if (!content) continue;
    const body = sanitizeMemoryContent(content);
    lines.push("", `<section_${name}>`, body, `</section_${name}>`);
    totalChars += body.length;
  }

  if (warnLarge && totalChars > MEMORY_SIZE_WARN_CHARS) {
    lines.push(
      "",
      `⚠ Your working memory is ${totalChars} characters. Consider condensing sections to keep token usage low.`,
    );
  }

  return lines.join("\n");
}
