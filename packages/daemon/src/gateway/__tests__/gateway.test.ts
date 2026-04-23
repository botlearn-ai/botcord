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
  GatewayConfig,
  GatewayInboundEnvelope,
  RuntimeAdapter,
  RuntimeRunResult,
} from "../types.js";
import type { GatewayLogger } from "../log.js";

function silentLogger(): GatewayLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

interface StartCall {
  ctx: ChannelStartContext;
  resolve: () => void;
  promise: Promise<void>;
}

class StubChannel implements ChannelAdapter {
  readonly type = "stub";
  readonly sends: ChannelSendContext[] = [];
  readonly stops: ChannelStopContext[] = [];
  starts: StartCall[] = [];

  constructor(public readonly id: string, public readonly accountId: string) {}

  async start(ctx: ChannelStartContext): Promise<void> {
    let resolveFn!: () => void;
    const p = new Promise<void>((r) => {
      resolveFn = r;
    });
    const call: StartCall = { ctx, resolve: resolveFn, promise: p };
    this.starts.push(call);
    ctx.abortSignal.addEventListener("abort", () => call.resolve(), { once: true });
    await p;
  }

  async stop(ctx: ChannelStopContext): Promise<void> {
    this.stops.push(ctx);
  }

  async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
    this.sends.push(ctx);
    return {};
  }

  async emit(env: GatewayInboundEnvelope): Promise<void> {
    await this.starts[this.starts.length - 1].ctx.emit(env);
  }
}

class StubRuntime implements RuntimeAdapter {
  constructor(public readonly id: string) {}
  async run(): Promise<RuntimeRunResult> {
    return { text: "runtime-reply", newSessionId: "sid-1" };
  }
}

function baseConfig(): GatewayConfig {
  return {
    channels: [
      { id: "botcord-main", type: "botcord", accountId: "ag_me" },
      { id: "botcord-b", type: "botcord", accountId: "ag_b" },
    ],
    defaultRoute: { runtime: "claude-code", cwd: "/tmp/cwd" },
    routes: [],
  };
}

describe("Gateway", () => {
  let dirs: string[] = [];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function makeTempPath(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "gw-gateway-"));
    dirs.push(dir);
    return path.join(dir, "sessions.json");
  }

  it("start() calls createChannel for each config entry, loads session store, starts ChannelManager", async () => {
    const createChannel = vi.fn((cfg: GatewayChannelConfig) => new StubChannel(cfg.id, cfg.accountId));
    const sessionStorePath = await makeTempPath();

    const gw = new Gateway({
      config: baseConfig(),
      sessionStorePath,
      createChannel,
      createRuntime: (id) => new StubRuntime(id),
      log: silentLogger(),
    });

    await gw.start();

    expect(createChannel).toHaveBeenCalledTimes(2);
    expect(createChannel.mock.calls[0][0].id).toBe("botcord-main");
    expect(createChannel.mock.calls[1][0].id).toBe("botcord-b");

    const snap = gw.snapshot();
    expect(Object.keys(snap.channels).sort()).toEqual(["botcord-b", "botcord-main"]);
    expect(snap.channels["botcord-main"].running).toBe(true);

    await gw.stop("test");
  });

  it("inbound envelope from a channel reaches the runtime and a reply is sent via that channel", async () => {
    const channels: StubChannel[] = [];
    const createChannel = (cfg: GatewayChannelConfig) => {
      const c = new StubChannel(cfg.id, cfg.accountId);
      channels.push(c);
      return c;
    };
    const runtime = new StubRuntime("claude-code");
    const createRuntime = vi.fn(() => runtime);

    const gw = new Gateway({
      config: {
        channels: [{ id: "botcord-main", type: "botcord", accountId: "ag_me" }],
        defaultRoute: { runtime: "claude-code", cwd: "/tmp/cwd" },
        routes: [],
      },
      sessionStorePath: await makeTempPath(),
      createChannel,
      createRuntime,
      log: silentLogger(),
    });

    await gw.start();
    const ch = channels[0];
    // Wait for ChannelManager's microtask that transitions starting→running.
    await new Promise((r) => setTimeout(r, 5));
    expect(ch.starts.length).toBe(1);

    const accept = vi.fn(async () => {});
    await ch.emit({
      message: {
        id: "m1",
        channel: "botcord-main",
        accountId: "ag_me",
        conversation: { id: "rm_oc_1", kind: "direct" },
        sender: { id: "ag_peer", kind: "agent" },
        text: "hi there",
        raw: {},
        receivedAt: Date.now(),
      },
      ack: { accept },
    });

    expect(accept).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledWith("claude-code", undefined);
    expect(ch.sends.length).toBe(1);
    expect(ch.sends[0].message.text).toBe("runtime-reply");
    expect(ch.sends[0].message.replyTo).toBe("m1");

    await gw.stop();
  });

  it("snapshot() returns { channels, turns } with expected shape", async () => {
    const createChannel = (cfg: GatewayChannelConfig) => new StubChannel(cfg.id, cfg.accountId);
    const gw = new Gateway({
      config: baseConfig(),
      sessionStorePath: await makeTempPath(),
      createChannel,
      createRuntime: (id) => new StubRuntime(id),
      log: silentLogger(),
    });

    const snap0 = gw.snapshot();
    expect(snap0).toHaveProperty("channels");
    expect(snap0).toHaveProperty("turns");
    expect(snap0.turns).toEqual({});

    await gw.start();
    const snap1 = gw.snapshot();
    expect(Object.keys(snap1.channels).length).toBe(2);
    await gw.stop();
  });

  it("stop() aborts running channels and is idempotent", async () => {
    const channels: StubChannel[] = [];
    const createChannel = (cfg: GatewayChannelConfig) => {
      const c = new StubChannel(cfg.id, cfg.accountId);
      channels.push(c);
      return c;
    };
    const gw = new Gateway({
      config: baseConfig(),
      sessionStorePath: await makeTempPath(),
      createChannel,
      createRuntime: (id) => new StubRuntime(id),
      log: silentLogger(),
    });

    await gw.start();
    await new Promise((r) => setTimeout(r, 5));
    await gw.stop("first");
    await gw.stop("second"); // idempotent

    for (const c of channels) {
      expect(c.stops.length).toBe(1);
      expect(c.starts[0].ctx.abortSignal.aborted).toBe(true);
    }
    expect(gw.snapshot().channels["botcord-main"].running).toBe(false);
  });
});
