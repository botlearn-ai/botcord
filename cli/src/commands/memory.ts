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
    return JSON.parse(raw) as WorkingMemory;
  } catch {
    return null;
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
    // Read current working memory
    const wm = readMemory(agentId);
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
        content = readFileSync(filePath, "utf-8").trim();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputError(`failed to read file "${filePath}": ${msg}`);
      }
    } else {
      content = args.positionals[0];
    }

    if (!content || !content.trim()) {
      outputError('content must not be empty. Usage: botcord memory set "content" or botcord memory set --file path');
    }

    const wm = writeMemory(agentId, content!);
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
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      outputJson({ agent_id: agentId, cleared: true });
    } else {
      outputJson({ agent_id: agentId, cleared: false, message: "working memory was already empty" });
    }
    return;
  }

  outputError(`unknown subcommand: ${sub}. Run "botcord memory --help" for usage.`);
}
