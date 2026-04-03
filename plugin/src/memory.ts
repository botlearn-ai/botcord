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

// ── Types ──────────────────────────────────────────────────────────

export type WorkingMemory = {
  version: 1;
  content: string;
  updatedAt: string;
  sourceSessionKey?: string;
};

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
 * Resolve the room state directory (workspace-scoped).
 *
 * Uses OpenClaw's workspace API so each agent instance has its own room state.
 * Falls back to ~/.botcord/memory/ when the workspace API is unavailable.
 */
export function resolveRoomStateDir(): string {
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
    // runtime not initialized or API unavailable — fall through
  }
  return path.join(os.homedir(), ".botcord", "memory");
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

export function readWorkingMemory(memDir?: string): WorkingMemory | null {
  return readJsonFile<WorkingMemory>(workingMemoryPath(memDir));
}

export function writeWorkingMemory(
  data: WorkingMemory,
  memDir?: string,
): void {
  writeJsonFileAtomic(workingMemoryPath(memDir), data);
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
