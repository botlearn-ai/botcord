import { mkdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { GatewayLogger, GatewayRuntimeSnapshot } from "./gateway/index.js";

/** Envelope written to the snapshot file; `version` lets readers guard shape. */
export interface SnapshotFile {
  version: 1;
  writtenAt: number;
  snapshot: GatewayRuntimeSnapshot;
}

/** Options for {@link SnapshotWriter}. */
export interface SnapshotWriterOptions {
  path: string;
  intervalMs: number;
  snapshot: () => GatewayRuntimeSnapshot;
  log?: GatewayLogger;
  /** Injection point for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Periodically writes `gateway.snapshot()` to a file so out-of-process CLI
 * commands can read daemon state. Writes are atomic (tmp + rename) and
 * failures are logged, never thrown.
 */
export class SnapshotWriter {
  private readonly opts: SnapshotWriterOptions;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: SnapshotWriterOptions) {
    this.opts = opts;
  }

  /** Begin periodic writes; performs one write immediately. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.writeOnce();
    this.timer = setInterval(() => this.writeOnce(), this.opts.intervalMs);
    // Don't keep the event loop alive just for status writes.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop the interval. Does not delete the file — call {@link writeFinal} / {@link remove} as needed. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Write one synchronous snapshot immediately; swallows errors. */
  writeOnce(): void {
    let snap: GatewayRuntimeSnapshot;
    try {
      snap = this.opts.snapshot();
    } catch (err) {
      this.opts.log?.warn("daemon.snapshot-writer.snapshot-fn-threw", {
        error: (err as Error).message,
      });
      return;
    }
    const now = (this.opts.now ?? Date.now)();
    const payload: SnapshotFile = {
      version: 1,
      writtenAt: now,
      snapshot: snap,
    };
    try {
      const dir = path.dirname(this.opts.path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.opts.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      renameSync(tmp, this.opts.path);
    } catch (err) {
      this.opts.log?.warn("daemon.snapshot-writer.write-failed", {
        path: this.opts.path,
        error: (err as Error).message,
      });
    }
  }

  /** Write one last snapshot — used right before {@link remove}. */
  writeFinal(): void {
    this.writeOnce();
  }

  /** Best-effort delete of the snapshot file; swallows + logs on failure. */
  remove(): void {
    try {
      unlinkSync(this.opts.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      this.opts.log?.warn("daemon.snapshot-writer.remove-failed", {
        path: this.opts.path,
        error: (err as Error).message,
      });
    }
  }
}
