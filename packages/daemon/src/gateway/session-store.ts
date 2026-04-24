import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayLogger } from "./log.js";
import type { GatewaySessionEntry, SessionKeyInput } from "./types.js";

export const DEFAULT_SESSION_STORE_MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Derive the canonical session-store key for a runtime + channel + conversation. */
export function sessionKey(input: SessionKeyInput): string {
  const base = `${input.runtime}:${input.channel}:${input.accountId}:${input.conversationKind}:${input.conversationId}`;
  const thread = input.threadId;
  if (typeof thread === "string" && thread.length > 0) {
    return `${base}:${thread}`;
  }
  return base;
}

/** Options for constructing a `SessionStore`. */
export interface SessionStoreOptions {
  path: string;
  log?: GatewayLogger;
  /** Optional TTL for persisted entries. Omit to disable automatic pruning. */
  maxEntryAgeMs?: number;
}

interface StoreFile {
  version: 1;
  entries: Record<string, GatewaySessionEntry>;
}

function emptyFile(): StoreFile {
  return { version: 1, entries: {} };
}

function isValidShape(x: unknown): x is StoreFile {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return o.version === 1 && !!o.entries && typeof o.entries === "object";
}

/** JSON-backed session store for runtime resume ids, keyed by `sessionKey()`. */
export class SessionStore {
  private readonly filePath: string;
  private readonly log?: GatewayLogger;
  private readonly maxEntryAgeMs?: number;
  private data: StoreFile = emptyFile();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: SessionStoreOptions) {
    this.filePath = opts.path;
    this.log = opts.log;
    if (Number.isFinite(opts.maxEntryAgeMs) && opts.maxEntryAgeMs! > 0) {
      this.maxEntryAgeMs = opts.maxEntryAgeMs;
    }
  }

  /** Load entries from disk. Tolerates missing or corrupt files. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.data = emptyFile();
        this.loaded = true;
        return;
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isValidShape(parsed)) {
        this.data = { version: 1, entries: parsed.entries };
      } else {
        this.log?.warn("gateway.session-store.invalid-shape", { path: this.filePath });
        this.data = emptyFile();
      }
    } catch (err) {
      this.log?.warn("gateway.session-store.parse-error", {
        path: this.filePath,
        error: (err as Error).message,
      });
      this.data = emptyFile();
    }
    this.loaded = true;
    if (this.maxEntryAgeMs !== undefined) {
      await this.pruneExpired({ maxAgeMs: this.maxEntryAgeMs });
    }
  }

  /** Look up an entry by its full session key. */
  get(key: string): GatewaySessionEntry | undefined {
    return this.data.entries[key];
  }

  /** Upsert an entry and persist the store atomically. */
  async set(entry: GatewaySessionEntry): Promise<void> {
    const callerTs = entry.updatedAt;
    const updatedAt = Number.isFinite(callerTs) && callerTs > 0 ? callerTs : Date.now();
    this.data.entries[entry.key] = { ...entry, updatedAt };
    await this.persist();
  }

  /** Remove an entry and persist the store atomically. */
  async delete(key: string): Promise<void> {
    if (this.data.entries[key] !== undefined) {
      delete this.data.entries[key];
    }
    await this.persist();
  }

  /** Snapshot of all entries (for status/debugging). */
  all(): GatewaySessionEntry[] {
    return Object.values(this.data.entries);
  }

  /** Remove entries whose `updatedAt` is older than `maxAgeMs`; returns count removed. */
  async pruneExpired(opts: { maxAgeMs: number; now?: number }): Promise<number> {
    const maxAgeMs = opts.maxAgeMs;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;
    const now = Number.isFinite(opts.now) ? opts.now! : Date.now();
    const cutoff = now - maxAgeMs;
    let removed = 0;
    for (const [key, entry] of Object.entries(this.data.entries)) {
      if (!Number.isFinite(entry.updatedAt) || entry.updatedAt < cutoff) {
        delete this.data.entries[key];
        removed += 1;
      }
    }
    if (removed > 0) {
      this.log?.info("gateway.session-store.pruned-expired", {
        path: this.filePath,
        removed,
        maxAgeMs,
      });
      await this.persist();
    }
    return removed;
  }

  private persist(): Promise<void> {
    const next = this.writeQueue.then(() => this.flushOnce());
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async flushOnce(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
