/**
 * Working memory — persistent, account-scoped notes injected into every turn.
 *
 * Stored at `~/.botcord/daemon/memory/{agentId}/working-memory.json`. A distinct
 * directory from the plugin's `~/.botcord/memory/{agentId}/` so daemon and
 * plugin don't step on each other — share later if we decide the semantics match.
 *
 * Ported from plugin/src/memory.ts (dropping workspace + OpenClaw runtime
 * branches) and plugin/src/memory-protocol.ts (prompt builder).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DAEMON_DIR_PATH } from "./config.js";

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

/** Base directory: `<DAEMON_DIR_PATH>/memory/<agentId>`. */
export function resolveMemoryDir(agentId: string): string {
  if (!agentId) throw new Error("resolveMemoryDir: agentId is required");
  return path.join(DAEMON_DIR_PATH, "memory", agentId);
}

function workingMemoryPath(agentId: string): string {
  return path.join(resolveMemoryDir(agentId), "working-memory.json");
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
  const p = workingMemoryPath(agentId);
  if (!existsSync(p)) return null;
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
