import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WAIT_MARKER_FILENAME,
  MAX_WAIT_MS,
  waitMarkerPath,
  resolveWaitMarkerPath,
  clearWaitMarker,
  consumeWaitMarker,
} from "../wait-marker.js";

describe("wait-marker", () => {
  let dir: string;
  let marker: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wait-marker-"));
    marker = waitMarkerPath(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (obj: unknown, at: string = marker) =>
    writeFile(at, JSON.stringify(obj), "utf8");

  it("returns null when no marker exists", () => {
    expect(consumeWaitMarker(marker)).toBeNull();
  });

  it("reads a valid marker, clamps to the deadline, and deletes the file", async () => {
    const now = 1_000_000;
    await write({ deadlineMs: now + 8_000, seconds: 8 });
    expect(consumeWaitMarker(marker, now)).toEqual({ deadlineMs: now + 8_000 });
    expect(existsSync(marker)).toBe(false);
  });

  it("preserves a reason string when present", async () => {
    const now = 1_000_000;
    await write({ deadlineMs: now + 5_000, reason: "letting alice answer" });
    expect(consumeWaitMarker(marker, now)).toEqual({
      deadlineMs: now + 5_000,
      reason: "letting alice answer",
    });
  });

  it("clamps a deadline beyond MAX_WAIT_MS down to now + MAX_WAIT_MS", async () => {
    const now = 1_000_000;
    await write({ deadlineMs: now + 10 * MAX_WAIT_MS });
    expect(consumeWaitMarker(marker, now)).toEqual({ deadlineMs: now + MAX_WAIT_MS });
  });

  it("returns null for a past deadline (and still deletes the file)", async () => {
    const now = 1_000_000;
    await write({ deadlineMs: now - 1 });
    expect(consumeWaitMarker(marker, now)).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it("returns null for malformed / non-numeric markers", async () => {
    await write({ nope: true });
    expect(consumeWaitMarker(marker)).toBeNull();
    await writeFile(marker, "{ not json", "utf8");
    expect(consumeWaitMarker(marker)).toBeNull();
  });

  it("clearWaitMarker removes a stale marker and is a no-op when absent", async () => {
    await write({ deadlineMs: Date.now() + 5_000 });
    clearWaitMarker(marker);
    expect(existsSync(marker)).toBe(false);
    expect(() => clearWaitMarker(marker)).not.toThrow();
  });

  it("scopes the path per queue and sanitizes the queue key", () => {
    const p = resolveWaitMarkerPath(dir, "botcord:ag_me:rm_g1:tp_x");
    expect(p).toBe(path.join(dir, ".botcord-wait.botcord_ag_me_rm_g1_tp_x.json"));
    // Distinct queues → distinct files (the core of the concurrency fix).
    expect(resolveWaitMarkerPath(dir, "botcord:ag_me:rm_g1:")).not.toBe(
      resolveWaitMarkerPath(dir, "botcord:ag_me:rm_g2:"),
    );
  });

  it("uses the documented legacy filename", () => {
    expect(WAIT_MARKER_FILENAME).toBe(".botcord-wait.json");
    expect(waitMarkerPath(dir)).toBe(path.join(dir, ".botcord-wait.json"));
  });
});
