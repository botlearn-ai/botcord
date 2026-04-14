/**
 * Working Memory & Room State — persistent local storage for agent memory.
 *
 * Working memory is account-scoped:
 *   ~/.botcord/memory/{agentId}/working-memory.json
 *
 * Room state is workspace-scoped (per OpenClaw agent instance):
 *   {workspace}/memory/botcord/rooms/{roomId}.json
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getBotCordRuntime, getConfig } from "./runtime.js";
import { resolveAccountConfig } from "./config.js";
import { isLegacyOnboarded } from "./credentials.js";
import type { BotCordClient as BotCordClientType } from "./client.js";

// ── Types ──────────────────────────────────────────────────────────

export type WorkingMemory = {
  version: 2;
  goal?: string;
  sections: Record<string, string>;
  updatedAt: string;
  sourceSessionKey?: string;
};

/** Legacy v1 format — single content string. */
type WorkingMemoryV1 = {
  version: 1;
  content: string;
  updatedAt: string;
  sourceSessionKey?: string;
};

/** Migrate v1 to v2: move content into a "notes" section. */
function migrateV1toV2(v1: WorkingMemoryV1): WorkingMemory {
  return {
    version: 2,
    sections: v1.content ? { notes: v1.content } : {},
    updatedAt: v1.updatedAt,
    sourceSessionKey: v1.sourceSessionKey,
  };
}

export type RoomState = {
  version: 1;
  checkpointMsgId?: string;
  lastSeenAt?: string;
  mentionBacklog?: number;
  openTopicHints?: Array<{ topicId: string; title?: string; status?: string }>;
  note?: string;
  updatedAt: string;
};

// ── Directory resolution ──────────────────────────────────────────

/**
 * Resolve the working memory directory (account-scoped).
 *
 * Uses ~/.botcord/memory/{agentId}/ so that all OpenClaw agents sharing the
 * same BotCord account read/write the same working memory.
 * Falls back to ~/.botcord/memory/ when agentId is unavailable.
 */
export function resolveMemoryDir(): string {
  try {
    const cfg = getConfig();
    const agentId = resolveAccountConfig(cfg)?.agentId;
    if (agentId) {
      return path.join(os.homedir(), ".botcord", "memory", agentId);
    }
  } catch {
    // config not initialized — fall through
  }
  return path.join(os.homedir(), ".botcord", "memory");
}

/**
 * Resolve the workspace-scoped base directory.
 *
 * Uses OpenClaw's workspace API so each agent instance has isolated state.
 * Returns null when the workspace API is unavailable.
 */
function resolveWorkspaceDir(): string | null {
  try {
    const runtime = getBotCordRuntime();
    const cfg = getConfig();
    const workspaceDir =
      (runtime as any).agent?.resolveAgentWorkspaceDir?.(cfg) ??
      (runtime as any).agent?.ensureAgentWorkspace?.(cfg);
    if (typeof workspaceDir === "string" && workspaceDir) {
      return path.join(workspaceDir, "memory/botcord");
    }
  } catch {
    // runtime not initialized or API unavailable
  }
  return null;
}

/**
 * Resolve the room state directory (workspace-scoped).
 *
 * Falls back to the account-scoped memory dir when workspace API is unavailable.
 */
export function resolveRoomStateDir(): string {
  return resolveWorkspaceDir() ?? resolveMemoryDir();
}

// ── Atomic file helpers ────────────────────────────────────────────

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Atomic write: write to a unique .tmp file, then rename over the target.
 * Uses PID + timestamp suffix to avoid collisions from concurrent writers.
 * Prevents half-written files on crash.
 */
function writeJsonFileAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

// ── Working Memory ─────────────────────────────────────────────────

function workingMemoryPath(memDir?: string): string {
  return path.join(memDir ?? resolveMemoryDir(), "working-memory.json");
}

const VALID_SECTION_KEY_RE = /^[a-zA-Z0-9_]+$/;

function sanitizeSections(sections: unknown): Record<string, string> {
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(sections as Record<string, unknown>)) {
    if (VALID_SECTION_KEY_RE.test(key) && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function normalizeWorkingMemory(raw: any): WorkingMemory | null {
  if (!raw || typeof raw !== "object") return null;
  // Already v2
  if (raw.version === 2 && typeof raw.sections === "object") {
    return {
      version: 2,
      goal: typeof raw.goal === "string" ? raw.goal : undefined,
      sections: sanitizeSections(raw.sections),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      sourceSessionKey: typeof raw.sourceSessionKey === "string" ? raw.sourceSessionKey : undefined,
    };
  }
  // v1 → v2 migration
  if (raw.version === 1 && typeof raw.content === "string") {
    return migrateV1toV2(raw as WorkingMemoryV1);
  }
  // Unknown or no version — try to treat as v1 if content exists
  if (typeof raw.content === "string") {
    return migrateV1toV2({ version: 1, content: raw.content, updatedAt: raw.updatedAt ?? "" });
  }
  return null;
}

export function readWorkingMemory(memDir?: string): WorkingMemory | null {
  const primary = readJsonFile<unknown>(workingMemoryPath(memDir));
  const normalized = primary ? normalizeWorkingMemory(primary) : null;
  if (normalized) return normalized;
  if (memDir) return null;

  // Migration fallback: try the old workspace-scoped path so existing memory
  // is not lost after upgrading to account-scoped storage.
  const wsDir = resolveWorkspaceDir();
  if (wsDir) {
    const legacy = readJsonFile<unknown>(path.join(wsDir, "working-memory.json"));
    if (legacy) return normalizeWorkingMemory(legacy);
  }
  return null;
}

export function writeWorkingMemory(
  data: WorkingMemory,
  memDir?: string,
): void {
  writeJsonFileAtomic(workingMemoryPath(memDir), data);
}

// ── Seed (lazy init) ──────────────────────────────────────────────

/**
 * Read working memory with lazy seed from Hub API.
 *
 * If local memory file does not exist:
 * 1. Check the legacy onboardedAt flag → skip seed if set (migration bridge).
 * 2. Fetch default memory from GET /hub/memory/default.
 * 3. Write the seed to local file and return it.
 *
 * This is the ONLY entry point that should be used on the "display path"
 * (i.e., injecting memory into the agent prompt). Write-tool internal reads
 * (read-before-update) should continue using readWorkingMemory() directly.
 */
export async function readOrSeedWorkingMemory(params: {
  client: BotCordClientType;
  credentialsFile?: string;
  memDir?: string;
}): Promise<WorkingMemory | null> {
  const { client, credentialsFile, memDir } = params;

  // 1. Local file exists → return as-is
  const existing = readWorkingMemory(memDir);
  if (existing) return existing;

  // 2. Migration bridge: agent already onboarded under legacy system → skip seed
  if (credentialsFile && isLegacyOnboarded(credentialsFile)) return null;

  // 3. Fetch seed from Hub API
  try {
    const seed = await client.getDefaultMemory();
    if (seed && typeof seed === "object" && seed.version === 2) {
      const wm: WorkingMemory = {
        version: 2,
        goal: typeof seed.goal === "string" ? seed.goal : undefined,
        sections: seed.sections && typeof seed.sections === "object" ? seed.sections as Record<string, string> : {},
        updatedAt: new Date().toISOString(),
      };
      writeWorkingMemory(wm, memDir);
      return wm;
    }
  } catch {
    // Offline / network error → no onboarding guidance, but don't block
  }

  return null;
}

// ── Room State ─────────────────────────────────────────────────────

function roomStatePath(roomId: string, memDir?: string): string {
  return path.join(memDir ?? resolveRoomStateDir(), "rooms", `${roomId}.json`);
}

export function readRoomState(
  roomId: string,
  memDir?: string,
): RoomState | null {
  return readJsonFile<RoomState>(roomStatePath(roomId, memDir));
}

export function writeRoomState(
  roomId: string,
  data: RoomState,
  memDir?: string,
): void {
  writeJsonFileAtomic(roomStatePath(roomId, memDir), data);
}

/**
 * Merge partial updates into an existing room state (or create new).
 * Returns the merged state.
 */
export function updateRoomState(
  roomId: string,
  updates: Partial<Omit<RoomState, "version">>,
  memDir?: string,
): RoomState {
  const existing = readRoomState(roomId, memDir);
  const merged: RoomState = {
    version: 1,
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  writeRoomState(roomId, merged, memDir);
  return merged;
}
