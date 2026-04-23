import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gateway } from "../gateway.js";
import type {
  ChannelAdapter,
  ChannelSendContext,
  ChannelSendResult,
  ChannelStartContext,
  ChannelStopContext,
  GatewayChannelConfig,
  RuntimeAdapter,
  RuntimeRunResult,
} from "../types.js";
import type { GatewayLogger } from "../log.js";

function silentLogger(): GatewayLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

class StubChannel implements ChannelAdapter {
  readonly type = "stub";
  readonly sends: ChannelSendContext[] = [];
  readonly stops: ChannelStopContext[] = [];
  starts: ChannelStartContext[] = [];

  constructor(public readonly id: string, public readonly accountId: string) {}

  async start(ctx: ChannelStartContext): Promise<void> {
    this.starts.push(ctx);
    await new Promise<void>((resolve) => {
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async stop(ctx: ChannelStopContext): Promise<void> {
    this.stops.push(ctx);
  }

  async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
    this.sends.push(ctx);
    return {};
  }
}

class StubRuntime implements RuntimeAdapter {
  readonly id = "claude-code";
  async run(): Promise<RuntimeRunResult> {
    return { text: "ok", newSessionId: "s1" };
  }
}

describe("Gateway.addChannel / removeChannel", () => {
  let dirs: string[] = [];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function makeTempPath(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "gw-add-"));
    dirs.push(dir);
    return path.join(dir, "sessions.json");
  }

  it("addChannel starts a new channel without restarting existing ones", async () => {
    const createChannel = vi.fn(
      (cfg: GatewayChannelConfig) => new StubChannel(cfg.id, cfg.accountId),
    );
    const gw = new Gateway({
      config: {
        channels: [{ id: "ag_a", type: "stub", accountId: "ag_a" }],
        defaultRoute: { runtime: "claude-code", cwd: "/tmp" },
        routes: [],
      },
      sessionStorePath: await makeTempPath(),
      createChannel,
      createRuntime: () => new StubRuntime(),
      log: silentLogger(),
    });

    await gw.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(createChannel).toHaveBeenCalledTimes(1);

    await gw.addChannel({ id: "ag_b", type: "stub", accountId: "ag_b" });
    await new Promise((r) => setTimeout(r, 5));

    expect(createChannel).toHaveBeenCalledTimes(2);
    const snap = gw.snapshot();
    expect(Object.keys(snap.channels).sort()).toEqual(["ag_a", "ag_b"]);
    expect(snap.channels["ag_a"].running).toBe(true);
    expect(snap.channels["ag_b"].running).toBe(true);

    await gw.stop();
  });

  it("addChannel rejects duplicate id", async () => {
    const createChannel = (cfg: GatewayChannelConfig) =>
      new StubChannel(cfg.id, cfg.accountId);
    const gw = new Gateway({
      config: {
        channels: [{ id: "ag_a", type: "stub", accountId: "ag_a" }],
        defaultRoute: { runtime: "claude-code", cwd: "/tmp" },
        routes: [],
      },
      sessionStorePath: await makeTempPath(),
      createChannel,
      createRuntime: () => new StubRuntime(),
      log: silentLogger(),
    });
    await gw.start();

    await expect(
      gw.addChannel({ id: "ag_a", type: "stub", accountId: "ag_a" }),
    ).rejects.toThrow(/already registered/);
    await gw.stop();
  });

  it("removeChannel stops the channel and drops it from the snapshot", async () => {
    const channels: StubChannel[] = [];
    const createChannel = (cfg: GatewayChannelConfig) => {
      const c = new StubChannel(cfg.id, cfg.accountId);
      channels.push(c);
      return c;
    };
    const gw = new Gateway({
      config: {
        channels: [
          { id: "ag_a", type: "stub", accountId: "ag_a" },
          { id: "ag_b", type: "stub", accountId: "ag_b" },
        ],
        defaultRoute: { runtime: "claude-code", cwd: "/tmp" },
        routes: [],
      },
      sessionStorePath: await makeTempPath(),
      createChannel,
      createRuntime: () => new StubRuntime(),
      log: silentLogger(),
    });

    await gw.start();
    await new Promise((r) => setTimeout(r, 5));

    await gw.removeChannel("ag_a", "test");

    const snap = gw.snapshot();
    expect(Object.keys(snap.channels)).toEqual(["ag_b"]);
    const a = channels.find((c) => c.id === "ag_a")!;
    expect(a.stops.length).toBe(1);
    expect(a.starts[0].abortSignal.aborted).toBe(true);
    // ag_b untouched
    const b = channels.find((c) => c.id === "ag_b")!;
    expect(b.stops.length).toBe(0);

    await gw.stop();
  });

  it("removeChannel is a no-op on unknown id", async () => {
    const gw = new Gateway({
      config: {
        channels: [{ id: "ag_a", type: "stub", accountId: "ag_a" }],
        defaultRoute: { runtime: "claude-code", cwd: "/tmp" },
        routes: [],
      },
      sessionStorePath: await makeTempPath(),
      createChannel: (cfg) => new StubChannel(cfg.id, cfg.accountId),
      createRuntime: () => new StubRuntime(),
      log: silentLogger(),
    });
    await gw.start();
    await expect(gw.removeChannel("ag_nope")).resolves.toBeUndefined();
    await gw.stop();
  });
});
