import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRuntimeSnapshot } from "../gateway/index.js";
import { SnapshotWriter } from "../snapshot-writer.js";

function emptySnapshot(): GatewayRuntimeSnapshot {
  return { channels: {}, turns: {} };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("SnapshotWriter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "snapshot-writer-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a snapshot atomically on start()", () => {
    const file = path.join(dir, "snapshot.json");
    const w = new SnapshotWriter({
      path: file,
      intervalMs: 10_000,
      snapshot: () => emptySnapshot(),
      now: () => 1_700_000_000_000,
    });
    w.start();
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed).toEqual({
      version: 1,
      writtenAt: 1_700_000_000_000,
      snapshot: { channels: {}, turns: {} },
    });
    w.stop();
  });

  it("writes on the configured interval cadence", () => {
    vi.useFakeTimers();
    try {
      const file = path.join(dir, "snapshot.json");
      const fn = vi.fn(() => emptySnapshot());
      const w = new SnapshotWriter({
        path: file,
        intervalMs: 1_000,
        snapshot: fn,
      });
      w.start();
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(3_500);
      expect(fn).toHaveBeenCalledTimes(4); // 1 immediate + 3 ticks
      w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() clears the interval", () => {
    vi.useFakeTimers();
    try {
      const file = path.join(dir, "snapshot.json");
      const fn = vi.fn(() => emptySnapshot());
      const w = new SnapshotWriter({
        path: file,
        intervalMs: 500,
        snapshot: fn,
      });
      w.start();
      expect(fn).toHaveBeenCalledTimes(1);
      w.stop();
      vi.advanceTimersByTime(10_000);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writeFinal() writes a fresh snapshot after stop()", () => {
    const file = path.join(dir, "snapshot.json");
    let ts = 1000;
    const w = new SnapshotWriter({
      path: file,
      intervalMs: 10_000,
      snapshot: () => emptySnapshot(),
      now: () => ts,
    });
    w.start();
    w.stop();
    ts = 2000;
    w.writeFinal();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.writtenAt).toBe(2000);
  });

  it("logs (and does not throw) when the snapshot fn throws", () => {
    const file = path.join(dir, "snapshot.json");
    const log = makeLogger();
    const w = new SnapshotWriter({
      path: file,
      intervalMs: 10_000,
      snapshot: () => {
        throw new Error("boom");
      },
      log,
    });
    expect(() => w.start()).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      "daemon.snapshot-writer.snapshot-fn-threw",
      expect.objectContaining({ error: "boom" }),
    );
    expect(existsSync(file)).toBe(false);
    w.stop();
  });

  it("remove() deletes the file and tolerates ENOENT", () => {
    const file = path.join(dir, "snapshot.json");
    const w = new SnapshotWriter({
      path: file,
      intervalMs: 10_000,
      snapshot: () => emptySnapshot(),
    });
    w.start();
    expect(existsSync(file)).toBe(true);
    w.remove();
    expect(existsSync(file)).toBe(false);
    // Second remove with no file: must not throw.
    expect(() => w.remove()).not.toThrow();
    w.stop();
  });
});
