import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ParsedArgs } from "../args.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";

// ── Working memory file I/O (v2: named sections + pinned goal) ──

interface WorkingMemory {
  version: 2;
  goal?: string;
  sections: Record<string, string>;
  updatedAt: string;
}

/** Legacy v1 format. */
interface WorkingMemoryV1 {
  version: 1;
  content: string;
  updatedAt: string;
}

const AGENT_ID_RE = /^ag_[A-Za-z0-9_-]+$/;
const SECTION_NAME_RE = /^[a-zA-Z0-9_]+$/;
const MAX_SECTION_CHARS = 10_000;
const MAX_GOAL_CHARS = 500;
const MAX_TOTAL_CHARS = 20_000;
const DEFAULT_SECTION = "notes";

function validateAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(`invalid agentId for memory path: ${agentId}`);
  }
}

function memoryDir(agentId: string): string {
  validateAgentId(agentId);
  return path.join(os.homedir(), ".botcord", "memory", agentId);
}

function memoryFilePath(agentId: string): string {
  return path.join(memoryDir(agentId), "working-memory.json");
}

function sanitizeSections(sections: unknown): Record<string, string> {
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(sections as Record<string, unknown>)) {
    if (SECTION_NAME_RE.test(key) && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function readMemory(agentId: string): WorkingMemory | null {
  const filePath = memoryFilePath(agentId);
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;

    // v2
    if (raw.version === 2 && typeof raw.sections === "object") {
      return {
        version: 2,
        goal: typeof raw.goal === "string" ? raw.goal : undefined,
        sections: sanitizeSections(raw.sections),
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      };
    }

    // v1 → v2 migration
    if (typeof raw.content === "string") {
      return {
        version: 2,
        sections: raw.content ? { notes: raw.content as string } : {},
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      };
    }

    throw new Error(`working memory file is invalid: ${filePath}`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function writeMemory(agentId: string, data: WorkingMemory): void {
  const dir = memoryDir(agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const filePath = memoryFilePath(agentId);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, filePath);
  chmodSync(filePath, 0o600);
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Command ───────────────────────────────────────────────────────

export async function memoryCommand(args: ParsedArgs, _globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord memory [subcommand] [options]

Subcommands:
  (none)            Show current working memory (all sections + goal)
  goal <text>       Set the agent's work goal
  set <content>     Update a section (default: "notes"). Use --section to target others
  clear             Clear all working memory
  clear-section     Clear a specific section (requires --section)

Options:
  --section <name>  Target section name (default: "notes")
  --file <path>     Read content from file instead of positional arg (for "set")
  --agent <id>      Use specific agent credentials`);
    return;
  }

  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  const agentId = creds.agentId;
  const sub = args.subcommand;

  // ── get (default) ─────────────────────────────────────────────
  if (!sub || sub === "get") {
    let wm: WorkingMemory | null;
    try {
      wm = readMemory(agentId);
    } catch (err: unknown) {
      outputError(`failed to read working memory: ${formatErrorMessage(err)}`);
    }
    if (!wm) {
      outputJson({ agent_id: agentId, goal: null, sections: {}, message: "working memory is empty" });
    } else {
      const totalChars = (wm.goal?.length ?? 0) +
        Object.values(wm.sections).reduce((sum, s) => sum + s.length, 0);
      outputJson({
        agent_id: agentId,
        goal: wm.goal ?? null,
        sections: wm.sections,
        updated_at: wm.updatedAt,
        total_chars: totalChars,
      });
    }
    return;
  }

  // ── goal ──────────────────────────────────────────────────────
  if (sub === "goal") {
    const goalText = args.positionals[0];
    if (!goalText || !goalText.trim()) {
      outputError('usage: botcord memory goal "your goal text"');
    }
    const goal = goalText.trim();
    if (goal.length > MAX_GOAL_CHARS) {
      outputError(`goal exceeds ${MAX_GOAL_CHARS} characters`);
    }

    try {
      const existing = readMemory(agentId) ?? { version: 2 as const, sections: {}, updatedAt: "" };
      existing.goal = goal;
      existing.updatedAt = new Date().toISOString();
      writeMemory(agentId, existing);
      outputJson({ agent_id: agentId, goal_updated: true, goal });
    } catch (err: unknown) {
      outputError(`failed to update goal: ${formatErrorMessage(err)}`);
    }
    return;
  }

  // ── set ───────────────────────────────────────────────────────
  if (sub === "set") {
    const sectionName = (typeof args.flags["section"] === "string" ? args.flags["section"] : DEFAULT_SECTION).trim();
    if (!SECTION_NAME_RE.test(sectionName)) {
      outputError("section name must contain only letters, digits, and underscores");
    }

    let content: string | undefined;
    const filePath = args.flags["file"];
    if (typeof filePath === "string") {
      try {
        content = readFileSync(filePath, "utf-8").trim();
      } catch (err: unknown) {
        outputError(`failed to read file "${filePath}": ${formatErrorMessage(err)}`);
      }
    } else {
      content = args.positionals[0];
    }

    const normalized = (content ?? "").trim();
    if (!normalized) {
      outputError(`content must not be empty. Use "botcord memory clear-section --section ${sectionName}" to delete a section`);
    }
    if (normalized.length > MAX_SECTION_CHARS) {
      outputError(`content exceeds ${MAX_SECTION_CHARS} characters`);
    }

    try {
      const existing = readMemory(agentId) ?? { version: 2 as const, sections: {}, updatedAt: "" };
      existing.sections[sectionName] = normalized;

      const totalChars = (existing.goal?.length ?? 0) +
        Object.values(existing.sections).reduce((sum, s) => sum + s.length, 0);
      if (totalChars > MAX_TOTAL_CHARS) {
        outputError(`total working memory exceeds ${MAX_TOTAL_CHARS} characters (current: ${totalChars})`);
      }

      existing.updatedAt = new Date().toISOString();
      writeMemory(agentId, existing);
      outputJson({
        agent_id: agentId,
        section: sectionName,
        updated: true,
        content_length: normalized.length,
        updated_at: existing.updatedAt,
      });
    } catch (err: unknown) {
      outputError(`failed to write working memory: ${formatErrorMessage(err)}`);
    }
    return;
  }

  // ── clear-section ─────────────────────────────────────────────
  if (sub === "clear-section") {
    const sectionName = typeof args.flags["section"] === "string" ? args.flags["section"].trim() : "";
    if (!sectionName) {
      outputError('usage: botcord memory clear-section --section <name>');
    }

    try {
      const existing = readMemory(agentId);
      if (!existing || !(sectionName in existing.sections)) {
        outputJson({ agent_id: agentId, section: sectionName, cleared: false, message: "section not found" });
        return;
      }
      delete existing.sections[sectionName];
      existing.updatedAt = new Date().toISOString();
      writeMemory(agentId, existing);
      outputJson({ agent_id: agentId, section: sectionName, cleared: true });
    } catch (err: unknown) {
      outputError(`failed to clear section: ${formatErrorMessage(err)}`);
    }
    return;
  }

  // ── clear ─────────────────────────────────────────────────────
  if (sub === "clear") {
    const filePath = memoryFilePath(agentId);
    if (!existsSync(filePath)) {
      outputJson({ agent_id: agentId, cleared: false, message: "working memory was already empty" });
      return;
    }

    try {
      unlinkSync(filePath);
      outputJson({ agent_id: agentId, cleared: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        outputJson({ agent_id: agentId, cleared: false, message: "working memory was already empty" });
      } else {
        outputError(`failed to clear working memory: ${formatErrorMessage(err)}`);
      }
    }
    return;
  }

  outputError(`unknown subcommand: ${sub}. Run "botcord memory --help" for usage.`);
}
