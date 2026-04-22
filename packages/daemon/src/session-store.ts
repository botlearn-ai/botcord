import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SESSIONS_PATH, DAEMON_DIR_PATH, type AdapterName } from "./config.js";

export interface SessionEntry {
  agentId: string;
  roomId: string;
  topic?: string | null;
  backend: AdapterName;
  /** Adapter-native session id (Claude Code UUID / Codex session id / ...). */
  backendSid: string;
  cwd: string;
  updatedAt: number;
}

interface StoreFile {
  version: 1;
  sessions: Record<string, SessionEntry>;
}

function keyOf(agentId: string, roomId: string, topic?: string | null): string {
  return topic ? `${agentId}:${roomId}:${topic}` : `${agentId}:${roomId}`;
}

export class SessionStore {
  private data: StoreFile = { version: 1, sessions: {} };
  private loaded = false;
  private flushScheduled = false;

  private load(): void {
    if (this.loaded) return;
    if (existsSync(SESSIONS_PATH)) {
      try {
        const raw = JSON.parse(readFileSync(SESSIONS_PATH, "utf8")) as StoreFile;
        if (raw && raw.sessions && typeof raw.sessions === "object") {
          this.data = { version: 1, sessions: raw.sessions };
        }
      } catch {
        // corrupt file — start fresh rather than crashing
        this.data = { version: 1, sessions: {} };
      }
    }
    this.loaded = true;
  }

  get(agentId: string, roomId: string, topic?: string | null): SessionEntry | null {
    this.load();
    return this.data.sessions[keyOf(agentId, roomId, topic)] ?? null;
  }

  upsert(entry: SessionEntry): void {
    this.load();
    const key = keyOf(entry.agentId, entry.roomId, entry.topic ?? undefined);
    this.data.sessions[key] = { ...entry, updatedAt: Date.now() };
    this.scheduleFlush();
  }

  reset(agentId: string, roomId: string, topic?: string | null): void {
    this.load();
    const key = keyOf(agentId, roomId, topic);
    if (this.data.sessions[key]) {
      delete this.data.sessions[key];
      this.scheduleFlush();
    }
  }

  all(): SessionEntry[] {
    this.load();
    return Object.values(this.data.sessions);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Coalesce writes within the event loop tick.
    setImmediate(() => {
      this.flushScheduled = false;
      this.flushSync();
    });
  }

  /** Synchronous atomic write. Safe to call from signal handlers. */
  flushSync(): void {
    if (!this.loaded) return;
    try {
      mkdirSync(DAEMON_DIR_PATH, { recursive: true, mode: 0o700 });
    } catch {
      // best-effort
    }
    const tmp = SESSIONS_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, SESSIONS_PATH);
  }
}

export const SESSION_FILE_PATH = path.resolve(SESSIONS_PATH);
