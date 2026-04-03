import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ParsedArgs } from "../args.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";

// ── Working memory file I/O ───────────────────────────────────────

interface WorkingMemory {
  version: 1;
  content: string;
  updatedAt: string;
}

const AGENT_ID_RE = /^ag_[A-Za-z0-9_-]+$/;
const MAX_WORKING_MEMORY_CHARS = 20_000;

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

function readMemory(agentId: string): WorkingMemory | null {
  const filePath = memoryFilePath(agentId);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<WorkingMemory> | null;
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.content !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      throw new Error(`working memory file is invalid: ${filePath}`);
    }
    return parsed as WorkingMemory;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function writeMemory(agentId: string, content: string): WorkingMemory {
  const dir = memoryDir(agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data: WorkingMemory = {
    version: 1,
    content,
    updatedAt: new Date().toISOString(),
  };
  const filePath = memoryFilePath(agentId);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, filePath);
  chmodSync(filePath, 0o600);
  return data;
}

function normalizeContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) {
    outputError('content must not be empty. Usage: botcord memory set "content" or botcord memory set --file path');
  }
  if (normalized.length > MAX_WORKING_MEMORY_CHARS) {
    outputError(`content exceeds ${MAX_WORKING_MEMORY_CHARS} characters`);
  }
  return normalized;
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Command ───────────────────────────────────────────────────────

export async function memoryCommand(args: ParsedArgs, _globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord memory [subcommand] [options]

Subcommands:
  (none)            Show current working memory
  set <content>     Replace working memory with new content (use --file to read from file)
  clear             Clear working memory

Options:
  --file <path>     Read content from file instead of positional arg (for "set")
  --agent <id>      Use specific agent credentials`);
    return;
  }

  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  const agentId = creds.agentId;
  const sub = args.subcommand;

  if (!sub || sub === "get") {
    let wm: WorkingMemory | null;
    try {
      wm = readMemory(agentId);
    } catch (err: unknown) {
      outputError(`failed to read working memory: ${formatErrorMessage(err)}`);
    }
    if (!wm) {
      outputJson({ agent_id: agentId, content: null, message: "working memory is empty" });
    } else {
      outputJson({
        agent_id: agentId,
        content: wm.content,
        updated_at: wm.updatedAt,
        content_length: wm.content.length,
      });
    }
    return;
  }

  if (sub === "set") {
    let content: string | undefined;

    const filePath = args.flags["file"];
    if (typeof filePath === "string") {
      try {
        content = normalizeContent(readFileSync(filePath, "utf-8"));
      } catch (err: unknown) {
        outputError(`failed to read file "${filePath}": ${formatErrorMessage(err)}`);
      }
    } else {
      content = args.positionals[0];
    }

    const normalizedContent = normalizeContent(content ?? "");

    let wm: WorkingMemory;
    try {
      wm = writeMemory(agentId, normalizedContent);
    } catch (err: unknown) {
      outputError(`failed to write working memory: ${formatErrorMessage(err)}`);
    }
    outputJson({
      agent_id: agentId,
      updated: true,
      content_length: wm.content.length,
      updated_at: wm.updatedAt,
    });
    return;
  }

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
