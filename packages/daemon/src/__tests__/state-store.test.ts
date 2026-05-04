import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayStateStore,
  defaultGatewayStatePath,
} from "../gateway/channels/state-store.js";

describe("state-store", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "botcord-state-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("derives the default state path under ~/.botcord/daemon/gateways", () => {
    const file = defaultGatewayStatePath("gw_abc");
    expect(
      file.endsWith(path.join(".botcord", "daemon", "gateways", "gw_abc.state.json")),
    ).toBe(true);
  });

  it("round-trips cursor + provider state across instances when flushed", () => {
    const file = path.join(tmp, "gw.state.json");
    const store = new GatewayStateStore("gw", { override: file, debounceMs: 0 });
    store.update({ cursor: "cur-1", providerState: { typingTicket: "tk1" } });
    expect(store.getCursor()).toBe("cur-1");
    expect(existsSync(file)).toBe(true);

    const reopened = new GatewayStateStore("gw", { override: file, debounceMs: 0 });
    expect(reopened.getCursor()).toBe("cur-1");
    expect(reopened.getProviderState()).toEqual({ typingTicket: "tk1" });
  });

  it("debounces multiple writes into a single flush", async () => {
    const file = path.join(tmp, "gw.state.json");
    const store = new GatewayStateStore("gw", { override: file, debounceMs: 30 });
    store.update({ cursor: "a" });
    store.update({ cursor: "b" });
    store.update({ cursor: "c" });
    // No file written yet — debounce window still open.
    expect(existsSync(file)).toBe(false);

    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { cursor?: string };
    expect(onDisk.cursor).toBe("c");
    store.close();
  });

  it("W9: write failure leaves state dirty and surfaces lastError", () => {
    // Point the file at a path whose parent path is a regular file — mkdirSync
    // recursive cannot turn that into a directory, so writeStateSync throws.
    const blockerFile = path.join(tmp, "blocker");
    require("node:fs").writeFileSync(blockerFile, "x");
    const file = path.join(blockerFile, "child.state.json");
    const store = new GatewayStateStore("gw", { override: file, debounceMs: 0 });
    expect(() => store.update({ cursor: "v1" })).toThrow();
    expect(store.lastError).not.toBeNull();
    // Repair: remove the blocker so the next write succeeds, and assert the
    // pending state is still in memory and is written by the next update().
    require("node:fs").rmSync(blockerFile, { force: true });
    store.update({ cursor: "v2" });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).cursor).toBe("v2");
    expect(store.lastError).toBeNull();
    store.close();
  });

  it("W3: scheduleFlushRetry stops after MAX_FLUSH_RETRIES and sets lastError", async () => {
    // Use an unwritable path by making parent a regular file — persistent failure.
    const blockerFile = path.join(tmp, "blocker2");
    writeFileSync(blockerFile, "x");
    const file = path.join(blockerFile, "child.state.json");

    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const store = new GatewayStateStore("gw-retry", {
      override: file,
      // debounceMs > 0 so scheduleFlushRetry arms timers (not sync mode).
      // The retry clamps to 250ms but with fake timers we advance manually.
      debounceMs: 10,
    });

    store.update({ cursor: "fail" });

    // Advance through 11 timer ticks (debounce + 10 retries); each retry is
    // 250ms (the clamped minimum). The 11th tick should trigger "giving up".
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(300);
    }

    // lastError must be set (persistent failure)
    expect(store.lastError).not.toBeNull();
    // "giving up" log emitted exactly once
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toMatch(/giving up/);

    vi.useRealTimers();
    errSpy.mockRestore();
  });

  it("flush() forces an immediate synchronous write", () => {
    const file = path.join(tmp, "gw.state.json");
    const store = new GatewayStateStore("gw", { override: file, debounceMs: 5_000 });
    store.update({ cursor: "x" });
    expect(existsSync(file)).toBe(false);
    store.flush();
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).cursor).toBe("x");
    store.close();
  });
});
