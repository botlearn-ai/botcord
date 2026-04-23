/**
 * Activity tracker — per-(agent, room, topic) record of the most recent
 * inbound message, regardless of whether the subsequent turn succeeded.
 *
 * Why not reuse SessionStore? SessionStore is only written after the adapter
 * returns `newSessionId`, which skips turns that errored, timed out, were
 * cancelled, or ran on an adapter that doesn't do resume (Codex after 方案 A).
 * The cross-room digest needs to reflect "which rooms am I actually talking
 * in right now", so it reads from here instead.
 *
 * Stored at `<DAEMON_DIR>/activity.json`. Atomic write, 0o600.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DAEMON_DIR_PATH } from "./config.js";

export const ACTIVITY_PATH = path.join(DAEMON_DIR_PATH, "activity.json");
/** Max preview length per entry — keeps the digest tight + cap bytes on disk. */
export const ACTIVITY_PREVIEW_CHARS = 120;

export interface ActivityEntry {
  agentId: string;
  roomId: string;
  roomName?: string;
  topic: string | null;
  lastActivityAt: number;
  /** Sanitized snippet of the last inbound message; may be empty. */
  lastInboundPreview: string;
  /** What kind of peer spoke last: "agent" | "human" | "owner". */
  lastSenderKind: "agent" | "human" | "owner";
  lastSender: string;
}

interface StoreFile {
  version: 1;
  entries: Record<string, ActivityEntry>;
}

function keyOf(agentId: string, roomId: string, topic: string | null): string {
  return topic ? `${agentId}:${roomId}:${topic}` : `${agentId}:${roomId}`;
}

export class ActivityTracker {
  private data: StoreFile = { version: 1, entries: {} };
  private loaded = false;
  private flushScheduled = false;
  private readonly filePath: string;

  constructor(opts?: { filePath?: string }) {
    this.filePath = opts?.filePath ?? ACTIVITY_PATH;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoreFile;
      if (raw && raw.entries && typeof raw.entries === "object") {
        this.data = { version: 1, entries: raw.entries };
      }
    } catch {
      // Corrupt file — start fresh rather than crashing.
      this.data = { version: 1, entries: {} };
    }
  }

  record(entry: Omit<ActivityEntry, "lastActivityAt"> & { lastActivityAt?: number }): void {
    this.load();
    const key = keyOf(entry.agentId, entry.roomId, entry.topic);
    const stored: ActivityEntry = {
      ...entry,
      lastInboundPreview: entry.lastInboundPreview.slice(0, ACTIVITY_PREVIEW_CHARS),
      lastActivityAt: entry.lastActivityAt ?? Date.now(),
    };
    this.data.entries[key] = stored;
    this.scheduleFlush();
  }

  get(agentId: string, roomId: string, topic: string | null): ActivityEntry | null {
    this.load();
    return this.data.entries[keyOf(agentId, roomId, topic)] ?? null;
  }

  /**
   * Return entries for a given agent, ordered most-recent first and filtered
   * to activity within `windowMs`. When `excludeKey` is provided, the matching
   * entry (the caller's current turn) is removed.
   */
  listActive(opts: {
    agentId: string;
    windowMs?: number;
    excludeKey?: string;
  }): ActivityEntry[] {
    this.load();
    const window = opts.windowMs ?? 2 * 60 * 60 * 1000;
    const cutoff = Date.now() - window;
    const out: ActivityEntry[] = [];
    for (const [k, e] of Object.entries(this.data.entries)) {
      if (e.agentId !== opts.agentId) continue;
      if (e.lastActivityAt < cutoff) continue;
      if (opts.excludeKey && k === opts.excludeKey) continue;
      out.push(e);
    }
    out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return out;
  }

  keyFor(agentId: string, roomId: string, topic: string | null): string {
    return keyOf(agentId, roomId, topic);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flushSync();
    });
  }

  /** Synchronous atomic write. Safe from signal handlers. */
  flushSync(): void {
    if (!this.loaded) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    } catch {
      // best-effort
    }
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}
