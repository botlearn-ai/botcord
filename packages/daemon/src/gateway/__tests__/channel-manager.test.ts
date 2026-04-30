import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelManager } from "../channel-manager.js";
import type {
  ChannelAdapter,
  ChannelStartContext,
  ChannelStopContext,
  GatewayConfig,
  GatewayInboundEnvelope,
  GatewayInboundMessage,
} from "../types.js";
import type { GatewayLogger } from "../log.js";

interface StartCall {
  ctx: ChannelStartContext;
  resolve: () => void;
  reject: (err: unknown) => void;
  promise: Promise<void>;
}

class FakeChannel implements ChannelAdapter {
  readonly id: string;
  readonly type = "fake";
  readonly starts: StartCall[] = [];
  readonly stopCalls: ChannelStopContext[] = [];
  aborted = false;

  constructor(id: string) {
    this.id = id;
  }

  async start(ctx: ChannelStartContext): Promise<void> {
    let resolveFn!: () => void;
    let rejectFn!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    const call: StartCall = { ctx, resolve: resolveFn, reject: rejectFn, promise };
    this.starts.push(call);
    ctx.abortSignal.addEventListener("abort", () => {
      this.aborted = true;
    });
    await promise;
  }

  async stop(ctx: ChannelStopContext): Promise<void> {
    this.stopCalls.push(ctx);
  }

  async send(): Promise<{ providerMessageId?: string | null }> {
    return {};
  }

  latest(): StartCall {
    const c = this.starts[this.starts.length - 1];
    if (!c) throw new Error("start not called");
    return c;
  }

  async emitNow(env: GatewayInboundEnvelope): Promise<void> {
    await this.latest().ctx.emit(env);
  }
}

function makeLogger(): GatewayLogger & { warns: unknown[][]; errors: unknown[][]; infos: unknown[][] } {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  const infos: unknown[][] = [];
  return {
    info: (msg, meta) => {
      infos.push([msg, meta]);
    },
    warn: (msg, meta) => {
      warns.push([msg, meta]);
    },
    error: (msg, meta) => {
      errors.push([msg, meta]);
    },
    debug: () => {},
    warns,
    errors,
    infos,
  };
}

function makeConfig(channelIds: string[]): GatewayConfig {
  return {
    channels: channelIds.map((id) => ({ id, type: "fake", accountId: `acc_${id}` })),
    defaultRoute: { runtime: "claude-code", cwd: "/tmp" },
  };
}

function makeMessage(id = "m_1", channel = "c1"): GatewayInboundMessage {
  return {
    id,
    channel,
    accountId: "acc_c1",
    conversation: { id: "rm_1", kind: "direct" },
    sender: { id: "ag_x", kind: "user" },
    text: "hi",
    raw: {},
    receivedAt: 0,
  };
}

async function flush(): Promise<void> {
  // Let queued microtasks drain (state transitions from starting → running).
  await Promise.resolve();
  await Promise.resolve();
}

describe("ChannelManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("startAll calls channel.start on each channel", async () => {
    const c1 = new FakeChannel("c1");
    const c2 = new FakeChannel("c2");
    const log = makeLogger();
    const mgr = new ChannelManager({
      config: makeConfig(["c1", "c2"]),
      channels: [c1, c2],
      log,
      emit: async () => {},
    });
    await mgr.startAll();
    expect(c1.starts).toHaveLength(1);
    expect(c2.starts).toHaveLength(1);
  });

  it("status reports running true with lastStartAt after start", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
    });
    const before = Date.now();
    await mgr.startAll();
    await flush();
    const snap = mgr.status()["c1"];
    expect(snap.running).toBe(true);
    expect(snap.lastStartAt).toBeGreaterThanOrEqual(before);
    expect(snap.accountId).toBe("acc_c1");
  });

  it("stopAll aborts and returns once start resolves", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
    });
    await mgr.startAll();
    await flush();
    const stopP = mgr.stopAll("test");
    // stopAll aborts, and the fake channel resolves on abort by our prompt.
    c1.latest().resolve();
    await stopP;
    expect(c1.aborted).toBe(true);
    expect(c1.stopCalls).toHaveLength(1);
    expect(c1.stopCalls[0]?.reason).toBe("test");
    expect(mgr.status()["c1"].running).toBe(false);
  });

  it("stopAll is idempotent", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
    });
    await mgr.startAll();
    await flush();
    const stopP = mgr.stopAll();
    c1.latest().resolve();
    await stopP;
    // Second call: no pending promises, returns quickly.
    await mgr.stopAll();
    expect(mgr.status()["c1"].running).toBe(false);
  });

  it("startAll is a no-op for already running channels", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
    });
    await mgr.startAll();
    await flush();
    await mgr.startAll();
    await flush();
    expect(c1.starts).toHaveLength(1);
  });

  it("emit passthrough: ctx.emit reaches opts.emit", async () => {
    const c1 = new FakeChannel("c1");
    const received: GatewayInboundEnvelope[] = [];
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async (env) => {
        received.push(env);
      },
    });
    await mgr.startAll();
    await flush();
    const env: GatewayInboundEnvelope = { message: makeMessage("m_1", "c1") };
    await c1.emitNow(env);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(env);
  });

  it("drops malformed envelope (missing id) without throwing", async () => {
    const c1 = new FakeChannel("c1");
    const log = makeLogger();
    const received: GatewayInboundEnvelope[] = [];
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log,
      emit: async (env) => {
        received.push(env);
      },
    });
    await mgr.startAll();
    await flush();
    const bad = {
      message: { ...makeMessage(), id: "" },
    } as GatewayInboundEnvelope;
    await expect(c1.emitNow(bad)).resolves.toBeUndefined();
    expect(received).toHaveLength(0);
    expect(log.warns.some((w) => String(w[0]).includes("malformed"))).toBe(true);
  });

  it("restarts after backoff when channel rejects; reconnectAttempts increments", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
      backoffMs: { initial: 1000, max: 60_000, factor: 2 },
    });
    await mgr.startAll();
    await flush();
    // Crash the channel.
    c1.latest().reject(new Error("boom"));
    await flush();
    expect(mgr.status()["c1"].restartPending).toBe(true);
    expect(mgr.status()["c1"].lastError).toBe("boom");

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(c1.starts).toHaveLength(2);
    expect(mgr.status()["c1"].reconnectAttempts).toBe(1);
    expect(mgr.status()["c1"].restartPending).toBe(false);
    // Clean up.
    c1.latest().resolve();
    await mgr.stopAll();
  });

  it("does not restart after permanent channel stop", async () => {
    const c1 = new FakeChannel("c1");
    const log = makeLogger();
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log,
      emit: async () => {},
      backoffMs: { initial: 1000, max: 60_000, factor: 2 },
    });
    await mgr.startAll();
    await flush();
    const err = new Error("agent not claimed; local binding revoked") as Error & {
      code?: string;
    };
    err.code = "channel_permanent_stop";
    c1.latest().reject(err);
    await flush();
    expect(mgr.status()["c1"].restartPending).toBeFalsy();
    expect(c1.starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(c1.starts).toHaveLength(1);
    expect(log.infos.some((entry) => entry[0] === "channel stopped permanently")).toBe(true);
  });

  it("restarts when channel resolves (graceful) without stopAll", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
      backoffMs: { initial: 1000, max: 60_000, factor: 2 },
    });
    await mgr.startAll();
    await flush();
    c1.latest().resolve();
    await flush();
    expect(mgr.status()["c1"].restartPending).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(c1.starts).toHaveLength(2);
    c1.latest().resolve();
    await mgr.stopAll();
  });

  it("stopAll cancels a pending restart timer", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
      backoffMs: { initial: 1000 },
    });
    await mgr.startAll();
    await flush();
    c1.latest().reject(new Error("crash"));
    await flush();
    expect(mgr.status()["c1"].restartPending).toBe(true);
    await mgr.stopAll();
    expect(mgr.status()["c1"].restartPending).toBe(false);
    // Advance time well past backoff — no new start should occur.
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(c1.starts).toHaveLength(1);
  });

  it("backoff grows exponentially and caps at max", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
      backoffMs: { initial: 1000, max: 4000, factor: 2 },
    });
    await mgr.startAll();
    await flush();

    // Crash #1 — schedule at 1000ms.
    c1.latest().reject(new Error("e1"));
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    await flush();
    expect(c1.starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(c1.starts).toHaveLength(2);

    // Crash #2 — schedule at 2000ms.
    c1.latest().reject(new Error("e2"));
    await flush();
    await vi.advanceTimersByTimeAsync(1999);
    await flush();
    expect(c1.starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(c1.starts).toHaveLength(3);

    // Crash #3 — schedule at 4000ms (capped from 4000).
    c1.latest().reject(new Error("e3"));
    await flush();
    await vi.advanceTimersByTimeAsync(3999);
    await flush();
    expect(c1.starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(c1.starts).toHaveLength(4);

    // Crash #4 — still capped at 4000ms.
    c1.latest().reject(new Error("e4"));
    await flush();
    await vi.advanceTimersByTimeAsync(3999);
    await flush();
    expect(c1.starts).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(c1.starts).toHaveLength(5);

    c1.latest().resolve();
    await mgr.stopAll();
  });

  it("long successful run resets backoff to initial", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
      backoffMs: { initial: 1000, max: 60_000, factor: 2 },
    });
    await mgr.startAll();
    await flush();

    // Crash twice so backoff grows to 2000.
    c1.latest().reject(new Error("e1"));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    c1.latest().reject(new Error("e2"));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(c1.starts).toHaveLength(3);

    // Now run for > 30s before crashing; backoff should reset to initial.
    await vi.advanceTimersByTimeAsync(31_000);
    c1.latest().reject(new Error("e3"));
    await flush();
    // Next restart should be at initial (1000), not 4000.
    await vi.advanceTimersByTimeAsync(999);
    await flush();
    expect(c1.starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(c1.starts).toHaveLength(4);

    c1.latest().resolve();
    await mgr.stopAll();
  });

  it("getChannel returns the adapter instance", () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
    });
    expect(mgr.getChannel("c1")).toBe(c1);
    expect(mgr.getChannel("nope")).toBeUndefined();
  });

  it("startAll can be re-entered after stopAll", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
    });
    await mgr.startAll();
    await flush();
    const stopP = mgr.stopAll();
    c1.latest().resolve();
    await stopP;

    await mgr.startAll();
    await flush();
    expect(c1.starts).toHaveLength(2);
    c1.latest().resolve();
    await mgr.stopAll();
  });

  it("passes accountId from config into ChannelStartContext", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
    });
    await mgr.startAll();
    await flush();
    expect(c1.latest().ctx.accountId).toBe("acc_c1");
    c1.latest().resolve();
    await mgr.stopAll();
  });

  it("setStatus merges patches into the channel snapshot", async () => {
    const c1 = new FakeChannel("c1");
    const mgr = new ChannelManager({
      config: makeConfig(["c1"]),
      channels: [c1],
      log: makeLogger(),
      emit: async () => {},
    });
    await mgr.startAll();
    await flush();
    c1.latest().ctx.setStatus({ connected: true });
    expect(mgr.status()["c1"].connected).toBe(true);
    expect(mgr.status()["c1"].running).toBe(true);
    c1.latest().resolve();
    await mgr.stopAll();
  });
});
