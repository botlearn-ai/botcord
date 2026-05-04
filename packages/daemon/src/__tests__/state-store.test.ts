import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
