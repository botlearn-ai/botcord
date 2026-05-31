import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WAIT_MARKER_FILENAME,
  MAX_WAIT_MS,
  waitMarkerPath,
  clearWaitMarker,
  consumeWaitMarker,
} from "../wait-marker.js";

describe("wait-marker", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wait-marker-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (obj: unknown) =>
    writeFile(waitMarkerPath(dir), JSON.stringify(obj), "utf8");

  it("returns null when no marker exists", () => {
    expect(consumeWaitMarker(dir)).toBeNull();
  });

  it("reads a valid marker, clamps to the deadline, and deletes the file", async () => {
    const now = 1_000_000;
    await write({ deadlineMs: now + 8_000, seconds: 8 });
    const marker = consumeWaitMarker(dir, now);
    expect(marker).toEqual({ deadlineMs: now + 8_000 });
    // File consumed.
    expect(existsSync(waitMarkerPath(dir))).toBe(false);
  });

  it("preserves a reason string when present", async () => {
    const now = 1_000_000;
    await write({ deadlineMs: now + 5_000, reason: "letting alice answer" });
    expect(consumeWaitMarker(dir, now)).toEqual({
      deadlineMs: now + 5_000,
      reason: "letting alice answer",
    });
  });

  it("clamps a deadline beyond MAX_WAIT_MS down to now + MAX_WAIT_MS", async () => {
    const now = 1_000_000;
    await write({ deadlineMs: now + 10 * MAX_WAIT_MS });
    expect(consumeWaitMarker(dir, now)).toEqual({ deadlineMs: now + MAX_WAIT_MS });
  });

  it("returns null for a past deadline (and still deletes the file)", async () => {
    const now = 1_000_000;
    await write({ deadlineMs: now - 1 });
    expect(consumeWaitMarker(dir, now)).toBeNull();
    expect(existsSync(waitMarkerPath(dir))).toBe(false);
  });

  it("returns null for malformed / non-numeric markers", async () => {
    await write({ nope: true });
    expect(consumeWaitMarker(dir)).toBeNull();
    await writeFile(waitMarkerPath(dir), "{ not json", "utf8");
    expect(consumeWaitMarker(dir)).toBeNull();
  });

  it("clearWaitMarker removes a stale marker and is a no-op when absent", async () => {
    await write({ deadlineMs: Date.now() + 5_000 });
    clearWaitMarker(dir);
    expect(existsSync(waitMarkerPath(dir))).toBe(false);
    // No throw on a clean dir.
    expect(() => clearWaitMarker(dir)).not.toThrow();
  });

  it("uses the documented filename", () => {
    expect(WAIT_MARKER_FILENAME).toBe(".botcord-wait.json");
    expect(waitMarkerPath(dir)).toBe(path.join(dir, ".botcord-wait.json"));
  });
});
