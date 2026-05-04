import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_GATEWAYS_DIR = path.join(
  homedir(),
  ".botcord",
  "daemon",
  "gateways",
);

const DEFAULT_DEBOUNCE_MS = 1000;

/**
 * On-disk cursor + provider-state for one third-party gateway. Kept separate
 * from `secret-store` so high-frequency cursor advancements don't churn the
 * secret file (and so cursor doesn't end up in any secret backup).
 */
export interface ThirdPartyGatewayState {
  cursor?: string;
  providerState?: Record<string, unknown>;
  updatedAt: string;
}

export function defaultGatewayStatePath(
  gatewayId: string,
  override?: string,
): string {
  if (override && override.length > 0) return override;
  return path.join(DEFAULT_GATEWAYS_DIR, `${gatewayId}.state.json`);
}

function readState(file: string): ThirdPartyGatewayState {
  if (!existsSync(file)) return { updatedAt: new Date(0).toISOString() };
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ThirdPartyGatewayState;
  } catch {
    return { updatedAt: new Date(0).toISOString() };
  }
}

function writeStateSync(file: string, state: ThirdPartyGatewayState): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export interface GatewayStateStoreOptions {
  /** Override the on-disk path; defaults to `~/.botcord/daemon/gateways/{id}.state.json`. */
  override?: string;
  /** Debounce window for batching writes; defaults to 1000ms. Use `0` for sync writes (tests). */
  debounceMs?: number;
}

/**
 * Per-gateway state store with debounced writes. Reads are always synchronous
 * against the in-memory snapshot, so the polling loop sees its own writes
 * even before they are flushed to disk. `flush()` is exposed for shutdown
 * paths and tests; `close()` flushes and clears the timer.
 */
const MAX_FLUSH_RETRIES = 10;

export class GatewayStateStore {
  private readonly file: string;
  private readonly debounceMs: number;
  private state: ThirdPartyGatewayState;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private flushRetryCount = 0;
  /** W9: most recent write error surfaced for diagnostics. Cleared on success. */
  lastError: Error | null = null;

  constructor(gatewayId: string, opts: GatewayStateStoreOptions = {}) {
    this.file = defaultGatewayStatePath(gatewayId, opts.override);
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.state = readState(this.file);
  }

  /** Read the current cursor (in-memory; reflects pending writes). */
  getCursor(): string | undefined {
    return this.state.cursor;
  }

  /** Read the current provider-state bag. Mutating the returned object does not persist. */
  getProviderState(): Record<string, unknown> | undefined {
    return this.state.providerState;
  }

  getSnapshot(): ThirdPartyGatewayState {
    return { ...this.state };
  }

  /** Update cursor + optional provider state and schedule a debounced flush. */
  update(patch: {
    cursor?: string;
    providerState?: Record<string, unknown>;
  }): void {
    if (patch.cursor !== undefined) this.state.cursor = patch.cursor;
    if (patch.providerState !== undefined) {
      this.state.providerState = patch.providerState;
    }
    this.state.updatedAt = new Date().toISOString();
    this.scheduleFlush();
  }

  /**
   * Force a synchronous write of the pending state, if any.
   *
   * W9: on write failure, leave `dirty=true` and re-arm the debounce timer
   * so a subsequent `update()` (or background timer fire) retries instead of
   * silently dropping the pending state. The error is also re-thrown so
   * callers that explicitly invoke `flush()` (shutdown paths, tests) see it.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    try {
      writeStateSync(this.file, this.state);
      this.dirty = false;
      this.lastError = null;
      this.flushRetryCount = 0;
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      // Keep dirty=true so the next update() re-arms a flush. We also
      // schedule a retry now in case the caller has nothing else queued.
      this.scheduleFlushRetry();
      throw this.lastError;
    }
  }

  /** Flush and stop accepting future debounced writes. */
  close(): void {
    this.flush();
  }

  /** On-disk path; exposed for tests and diagnostics. */
  get filePath(): string {
    return this.file;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.debounceMs <= 0) {
      // W9: synchronous mode — re-throw on failure so the caller sees the
      // problem instead of having the data silently disappear.
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.dirty) return;
      try {
        writeStateSync(this.file, this.state);
        this.dirty = false;
        this.lastError = null;
        this.flushRetryCount = 0;
      } catch (err) {
        // W9: keep dirty=true and re-arm so the failed write retries.
        this.lastError = err instanceof Error ? err : new Error(String(err));
        this.scheduleFlushRetry();
      }
    }, this.debounceMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /**
   * Re-arm the debounce timer after a write failure. Bounded delay (capped
   * at 5s) so transient failures do not become a hot-spin retry loop.
   * After MAX_FLUSH_RETRIES consecutive failures, log and stop retrying so
   * a permanently broken write path cannot loop indefinitely. `lastError` is
   * left set so callers can detect persistent failure.
   */
  private scheduleFlushRetry(): void {
    if (this.debounceMs <= 0) return; // sync mode: caller decides
    if (this.timer) return;
    this.flushRetryCount += 1;
    if (this.flushRetryCount > MAX_FLUSH_RETRIES) {
      // Persistent failure — give up. lastError remains set for diagnostics.
      console.error(
        `[state-store] flush failed ${MAX_FLUSH_RETRIES} times; giving up on ${this.file}`,
        this.lastError,
      );
      return;
    }
    const retryMs = Math.min(Math.max(this.debounceMs, 250), 5000);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.dirty) return;
      try {
        writeStateSync(this.file, this.state);
        this.dirty = false;
        this.lastError = null;
        this.flushRetryCount = 0;
      } catch (err) {
        this.lastError = err instanceof Error ? err : new Error(String(err));
        this.scheduleFlushRetry();
      }
    }, retryMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }
}
