import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dispatcher, type RuntimeFactory } from "../dispatcher.js";
import { SessionStore } from "../session-store.js";
import type {
  ChannelAdapter,
  ChannelSendContext,
  ChannelSendResult,
  ChannelStreamBlockContext,
  GatewayConfig,
  GatewayInboundEnvelope,
  GatewayInboundMessage,
  RuntimeAdapter,
  RuntimeRunOptions,
  RuntimeRunResult,
  StreamBlock,
} from "../types.js";
import type { GatewayLogger } from "../log.js";

function silentLogger(): GatewayLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

interface FakeChannelOptions {
  id?: string;
  withStream?: boolean;
  sendImpl?: (ctx: ChannelSendContext) => Promise<ChannelSendResult> | ChannelSendResult;
  streamImpl?: (ctx: ChannelStreamBlockContext) => Promise<void> | void;
}

class FakeChannel implements ChannelAdapter {
  readonly id: string;
  readonly type = "fake";
  readonly sends: ChannelSendContext[] = [];
  readonly streams: ChannelStreamBlockContext[] = [];
  private readonly sendImpl?: FakeChannelOptions["sendImpl"];
  private readonly streamImpl?: FakeChannelOptions["streamImpl"];
  streamBlock?: (ctx: ChannelStreamBlockContext) => Promise<void>;

  constructor(opts: FakeChannelOptions = {}) {
    this.id = opts.id ?? "botcord";
    this.sendImpl = opts.sendImpl;
    this.streamImpl = opts.streamImpl;
    if (opts.withStream !== false) {
      this.streamBlock = async (ctx) => {
        this.streams.push(ctx);
        if (this.streamImpl) await this.streamImpl(ctx);
      };
    }
  }

  async start(): Promise<void> {}
  async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
    this.sends.push(ctx);
    if (this.sendImpl) return this.sendImpl(ctx);
    return {};
  }
}

interface FakeRuntimeOptions {
  id?: string;
  reply?: string;
  newSessionId?: string | ((opts: RuntimeRunOptions) => string);
  delayMs?: number;
  throwError?: Error | string;
  errorText?: string;
  blocks?: StreamBlock[];
  hang?: boolean;
  observeRun?: (opts: RuntimeRunOptions) => void;
}

class FakeRuntime implements RuntimeAdapter {
  readonly id: string;
  readonly calls: RuntimeRunOptions[] = [];
  private readonly opts: FakeRuntimeOptions;

  constructor(opts: FakeRuntimeOptions = {}) {
    this.id = opts.id ?? "claude-code";
    this.opts = opts;
  }

  async run(options: RuntimeRunOptions): Promise<RuntimeRunResult> {
    this.calls.push(options);
    this.opts.observeRun?.(options);
    if (this.opts.blocks) {
      for (const b of this.opts.blocks) options.onBlock?.(b);
    }
    if (this.opts.hang) {
      // Never resolve naturally; wait for abort.
      await new Promise<void>((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    }
    if (this.opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    if (this.opts.throwError) {
      throw typeof this.opts.throwError === "string"
        ? new Error(this.opts.throwError)
        : this.opts.throwError;
    }
    const newSessionId =
      typeof this.opts.newSessionId === "function"
        ? this.opts.newSessionId(options)
        : this.opts.newSessionId ?? "sid-1";
    return {
      text: this.opts.reply ?? "hello back",
      newSessionId,
      ...(this.opts.errorText ? { error: this.opts.errorText } : {}),
    };
  }
}

function makeMessage(partial: Partial<GatewayInboundMessage> = {}): GatewayInboundMessage {
  return {
    id: partial.id ?? "hub_msg_abc",
    channel: partial.channel ?? "botcord",
    accountId: partial.accountId ?? "ag_me",
    conversation: partial.conversation ?? {
      id: "rm_oc_1",
      kind: "direct",
    },
    sender: partial.sender ?? { id: "ag_peer", name: "peer", kind: "agent" },
    text: partial.text ?? "hello",
    raw: partial.raw ?? {},
    replyTo: partial.replyTo ?? null,
    mentioned: partial.mentioned,
    receivedAt: partial.receivedAt ?? Date.now(),
    trace: partial.trace,
  };
}

function makeEnvelope(
  partial: Partial<GatewayInboundMessage> = {},
  ack?: {
    accept: () => Promise<void>;
    reject?: (reason: string) => Promise<void>;
  },
): GatewayInboundEnvelope {
  return { message: makeMessage(partial), ack };
}

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    channels: [{ id: "botcord", type: "botcord", accountId: "ag_me" }],
    defaultRoute: {
      runtime: "claude-code",
      cwd: "/tmp/default",
    },
    routes: [],
    ...overrides,
  };
}

async function makeStore(): Promise<{ store: SessionStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "gw-dispatcher-"));
  const store = new SessionStore({ path: path.join(dir, "sessions.json") });
  await store.load();
  return { store, dir };
}

describe("Dispatcher", () => {
  let tempDirs: string[];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function scaffold(args: {
    config?: GatewayConfig;
    channel?: FakeChannel;
    runtimeFactory?: RuntimeFactory;
    turnTimeoutMs?: number;
  }) {
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = args.channel ?? new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const dispatcher = new Dispatcher({
      config: args.config ?? baseConfig(),
      channels,
      runtime: args.runtimeFactory ?? (() => new FakeRuntime()),
      sessionStore: store,
      log: silentLogger(),
      turnTimeoutMs: args.turnTimeoutMs,
    });
    return { dispatcher, channel, store };
  }

  it("skips empty text and still acks", async () => {
    const { dispatcher, channel } = await scaffold({});
    const accept = vi.fn(async () => {});
    await dispatcher.handle(makeEnvelope({ text: "   " }, { accept }));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(channel.sends.length).toBe(0);
  });

  it("skips own-message (sender.id === accountId) and still acks", async () => {
    const runtime = new FakeRuntime();
    const { dispatcher, channel } = await scaffold({
      runtimeFactory: () => runtime,
    });
    const accept = vi.fn(async () => {});
    await dispatcher.handle(
      makeEnvelope({ sender: { id: "ag_me", kind: "agent" } }, { accept }),
    );
    expect(accept).toHaveBeenCalledTimes(1);
    expect(runtime.calls.length).toBe(0);
    expect(channel.sends.length).toBe(0);
  });

  it("happy path: routes, runs, writes session, sends reply with correct fields", async () => {
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "new-sid" });
    const { dispatcher, channel, store } = await scaffold({
      runtimeFactory: () => runtime,
    });

    await dispatcher.handle(
      makeEnvelope({
        id: "msg_1",
        conversation: { id: "rm_oc_1", kind: "direct", threadId: "t_1" },
        trace: { id: "trace_1", streamable: false },
      }),
    );

    expect(runtime.calls.length).toBe(1);
    expect(runtime.calls[0].cwd).toBe("/tmp/default");
    expect(runtime.calls[0].trustLevel).toBe("trusted");
    expect(channel.sends.length).toBe(1);
    const out = channel.sends[0].message;
    expect(out.conversationId).toBe("rm_oc_1");
    expect(out.threadId).toBe("t_1");
    expect(out.replyTo).toBe("msg_1");
    expect(out.traceId).toBe("trace_1");
    expect(out.text).toBe("ok");

    expect(store.all().length).toBe(1);
    expect(store.all()[0].runtimeSessionId).toBe("new-sid");
    expect(store.all()[0].threadId).toBe("t_1");
  });

  it("reuses session id on second message with same queue key", async () => {
    const seen: Array<string | null> = [];
    const runtime = new FakeRuntime({
      newSessionId: (opts) => {
        seen.push(opts.sessionId);
        return "sid-" + (seen.length + 1);
      },
    });
    const { dispatcher } = await scaffold({ runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({
        id: "msg_1",
        conversation: { id: "rm_1", kind: "group" },
      }),
    );
    await dispatcher.handle(
      makeEnvelope({
        id: "msg_2",
        conversation: { id: "rm_1", kind: "group" },
      }),
    );
    expect(seen).toEqual([null, "sid-2"]);
  });

  it("drops the stored session when runtime signals an invalid resume (empty newSessionId + error)", async () => {
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      // Turn 1: normal success, writes sid-1.
      if (callNo === 1) return new FakeRuntime({ reply: "ok", newSessionId: "sid-1" });
      // Turn 2: simulate Claude Code's "--resume <missing-uuid>" failure:
      //   adapter wipes newSessionId and sets error.
      return new FakeRuntime({ newSessionId: "", errorText: "No conversation found" });
    };
    const { dispatcher, store } = await scaffold({ runtimeFactory });

    await dispatcher.handle(
      makeEnvelope({ id: "msg_1", conversation: { id: "rm_x", kind: "direct" } }),
    );
    expect(store.all().length).toBe(1);
    expect(store.all()[0].runtimeSessionId).toBe("sid-1");

    await dispatcher.handle(
      makeEnvelope({ id: "msg_2", conversation: { id: "rm_x", kind: "direct" } }),
    );
    // Stale entry must be gone so the next turn starts fresh instead of
    // re-resuming the missing UUID forever.
    expect(store.all().length).toBe(0);
  });

  it("does not crash when an errored turn has no prior session entry", async () => {
    const runtime = new FakeRuntime({ newSessionId: "", errorText: "boom" });
    const { dispatcher, store } = await scaffold({ runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ id: "msg_1", conversation: { id: "rm_y", kind: "direct" } }),
    );
    expect(store.all().length).toBe(0);
  });

  it("cancel-previous: prior turn is aborted and does not write session, new turn writes", async () => {
    const prior = new FakeRuntime({ hang: true, newSessionId: "prior-sid" });
    const newer = new FakeRuntime({ reply: "newer", newSessionId: "newer-sid" });
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      return callNo === 1 ? prior : newer;
    };

    const { dispatcher, channel, store } = await scaffold({ runtimeFactory });

    const first = dispatcher.handle(
      makeEnvelope({
        id: "msg_1",
        conversation: { id: "rm_oc_a", kind: "direct" },
      }),
    );
    // Give the prior run a tick to register.
    await Promise.resolve();
    await Promise.resolve();

    await dispatcher.handle(
      makeEnvelope({
        id: "msg_2",
        conversation: { id: "rm_oc_a", kind: "direct" },
      }),
    );

    await first.catch(() => undefined);

    expect(prior.calls[0].signal.aborted).toBe(true);
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("newer");
    expect(store.all().length).toBe(1);
    expect(store.all()[0].runtimeSessionId).toBe("newer-sid");
  });

  it("serial queue: second message waits for the first to finish", async () => {
    const order: string[] = [];
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      const tag = `r${callNo}`;
      return new FakeRuntime({
        reply: tag,
        observeRun: () => order.push(`start:${tag}`),
        delayMs: 20,
        newSessionId: "sid",
      });
    };
    const config = baseConfig({
      defaultRoute: {
        runtime: "claude-code",
        cwd: "/tmp/default",
        queueMode: "serial",
      },
    });
    const { dispatcher, channel } = await scaffold({ config, runtimeFactory });

    const p1 = dispatcher.handle(
      makeEnvelope({
        id: "m1",
        conversation: { id: "rm_g1", kind: "group" },
      }),
    );
    const p2 = dispatcher.handle(
      makeEnvelope({
        id: "m2",
        conversation: { id: "rm_g1", kind: "group" },
      }),
    );
    await Promise.all([p1, p2]);

    expect(order).toEqual(["start:r1", "start:r2"]);
    expect(channel.sends.map((s) => s.message.text)).toEqual(["r1", "r2"]);
  });

  it("different queue keys run concurrently", async () => {
    const running: Set<string> = new Set();
    let maxConcurrent = 0;
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      const tag = `r${callNo}`;
      return new FakeRuntime({
        reply: tag,
        newSessionId: "sid",
        observeRun: () => {
          running.add(tag);
          maxConcurrent = Math.max(maxConcurrent, running.size);
        },
        delayMs: 20,
      });
    };
    const config = baseConfig({
      defaultRoute: {
        runtime: "claude-code",
        cwd: "/tmp/default",
        queueMode: "serial",
      },
    });
    const { dispatcher } = await scaffold({ config, runtimeFactory });

    const p1 = dispatcher.handle(
      makeEnvelope({
        id: "m1",
        conversation: { id: "rm_a", kind: "group" },
      }),
    );
    const p2 = dispatcher.handle(
      makeEnvelope({
        id: "m2",
        conversation: { id: "rm_b", kind: "group" },
      }),
    );
    await Promise.all([p1, p2]);
    expect(maxConcurrent).toBe(2);
  });

  it("streaming: forwards blocks when trace.streamable === true and channel has streamBlock", async () => {
    const blocks: StreamBlock[] = [
      { raw: { type: "a" }, kind: "assistant_text", seq: 1 },
      { raw: { type: "b" }, kind: "tool_use", seq: 2 },
    ];
    const runtime = new FakeRuntime({ blocks, newSessionId: "sid" });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({
        trace: { id: "trace_abc", streamable: true },
      }),
    );
    // streamBlock is fire-and-forget; give microtasks a chance.
    await new Promise((r) => setTimeout(r, 5));
    expect(channel.streams.length).toBe(2);
    expect(channel.streams[0].traceId).toBe("trace_abc");
    expect(channel.streams.map((s) => (s.block as StreamBlock).seq)).toEqual([1, 2]);
  });

  it("streaming: does not forward blocks when streamable is false", async () => {
    const blocks: StreamBlock[] = [{ raw: {}, kind: "assistant_text", seq: 1 }];
    const runtime = new FakeRuntime({ blocks, newSessionId: "sid" });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "trace_abc", streamable: false } }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(channel.streams.length).toBe(0);
  });

  it("channel without streamBlock: blocks dropped silently, turn still completes", async () => {
    const blocks: StreamBlock[] = [{ raw: {}, kind: "assistant_text", seq: 1 }];
    const runtime = new FakeRuntime({ blocks, newSessionId: "sid", reply: "ok" });
    const channel = new FakeChannel({ withStream: false });
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "t1", streamable: true } }),
    );
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("ok");
  });

  it("runtime throws: sends error reply, does not write session", async () => {
    const runtime = new FakeRuntime({ throwError: "boom" });
    const channel = new FakeChannel();
    const { dispatcher, store } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(makeEnvelope({ id: "m1" }));
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toContain("Runtime error");
    expect(channel.sends[0].message.text).toContain("boom");
    expect(store.all().length).toBe(0);
  });

  it("runtime timeout: aborts, sends error reply, does not write session", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new FakeRuntime({ hang: true, newSessionId: "never" });
      const channel = new FakeChannel();
      const { dispatcher, store } = await scaffold({
        channel,
        runtimeFactory: () => runtime,
        turnTimeoutMs: 1000,
      });

      const p = dispatcher.handle(makeEnvelope({ id: "m1" }));
      await vi.advanceTimersByTimeAsync(1001);
      await p;

      expect(runtime.calls[0].signal.aborted).toBe(true);
      expect(channel.sends.length).toBe(1);
      expect(channel.sends[0].message.text).toContain("timeout");
      expect(store.all().length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns() reports in-flight entries and removes them on completion", async () => {
    const runtime = new FakeRuntime({
      delayMs: 30,
      newSessionId: "sid",
      reply: "ok",
    });
    const { dispatcher } = await scaffold({ runtimeFactory: () => runtime });

    const p = dispatcher.handle(
      makeEnvelope({
        id: "m1",
        conversation: { id: "rm_oc_x", kind: "direct" },
      }),
    );
    // Let the turn begin.
    await Promise.resolve();
    await Promise.resolve();

    const inFlight = dispatcher.turns();
    const keys = Object.keys(inFlight);
    expect(keys.length).toBe(1);
    expect(inFlight[keys[0]].conversationId).toBe("rm_oc_x");
    expect(inFlight[keys[0]].runtime).toBe("claude-code");

    await p;
    expect(Object.keys(dispatcher.turns()).length).toBe(0);
  });

  it("ack.accept() is called before runtime.run() starts", async () => {
    const order: string[] = [];
    const runtime = new FakeRuntime({
      observeRun: () => order.push("run"),
      newSessionId: "sid",
    });
    const { dispatcher } = await scaffold({ runtimeFactory: () => runtime });
    const accept = vi.fn(async () => {
      order.push("accept");
    });

    await dispatcher.handle(makeEnvelope({}, { accept }));
    expect(order).toEqual(["accept", "run"]);
  });

  it("route match wins over default: uses match's cwd / runtime / extraArgs", async () => {
    const calls: RuntimeRunOptions[] = [];
    const runtime = new FakeRuntime({
      newSessionId: "sid",
      observeRun: (opts) => calls.push(opts),
    });
    const seenIds: string[] = [];
    const runtimeFactory: RuntimeFactory = (id, extraArgs) => {
      seenIds.push(id);
      expect(extraArgs).toEqual(["--flag", "value"]);
      return runtime;
    };
    const config = baseConfig({
      defaultRoute: {
        runtime: "codex",
        cwd: "/tmp/default",
      },
      routes: [
        {
          match: { conversationPrefix: "rm_oc_" },
          runtime: "claude-code",
          cwd: "/tmp/match",
          extraArgs: ["--flag", "value"],
          trustLevel: "owner",
        },
      ],
    });
    const { dispatcher } = await scaffold({ config, runtimeFactory });

    await dispatcher.handle(
      makeEnvelope({ conversation: { id: "rm_oc_z", kind: "direct" } }),
    );
    expect(seenIds).toEqual(["claude-code"]);
    expect(calls[0].cwd).toBe("/tmp/match");
    expect(calls[0].trustLevel).toBe("owner");
    expect(calls[0].extraArgs).toEqual(["--flag", "value"]);
  });

  it("buildSystemContext: return value reaches runtime.run as systemContext", async () => {
    const observed: Array<string | undefined> = [];
    const runtime = new FakeRuntime({
      newSessionId: "sid",
      observeRun: (opts) => observed.push(opts.systemContext),
    });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const seenMessages: GatewayInboundMessage[] = [];
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      buildSystemContext: (msg) => {
        seenMessages.push(msg);
        return "hello-context";
      },
    });

    await dispatcher.handle(makeEnvelope({ id: "msg_sc_1", text: "go" }));
    expect(seenMessages.length).toBe(1);
    expect(seenMessages[0].id).toBe("msg_sc_1");
    expect(observed).toEqual(["hello-context"]);
  });

  it("buildSystemContext: hook is awaited before runtime.run runs", async () => {
    const order: string[] = [];
    const runtime = new FakeRuntime({
      newSessionId: "sid",
      observeRun: (opts) => {
        order.push(`run:${opts.systemContext ?? "none"}`);
      },
    });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      buildSystemContext: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push("build-done");
        return "async-ctx";
      },
    });

    await dispatcher.handle(makeEnvelope({}));
    expect(order).toEqual(["build-done", "run:async-ctx"]);
  });

  it("buildSystemContext: returning undefined → runtime receives undefined systemContext", async () => {
    const observed: Array<string | undefined> = [];
    const runtime = new FakeRuntime({
      newSessionId: "sid",
      observeRun: (opts) => observed.push(opts.systemContext),
    });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      buildSystemContext: () => undefined,
    });

    await dispatcher.handle(makeEnvelope({}));
    expect(observed).toEqual([undefined]);
  });

  it("buildSystemContext: empty string is treated as undefined (not passed through)", async () => {
    const observed: Array<string | undefined> = [];
    const runtime = new FakeRuntime({
      newSessionId: "sid",
      observeRun: (opts) => observed.push(opts.systemContext),
    });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      buildSystemContext: () => "",
    });

    await dispatcher.handle(makeEnvelope({}));
    expect(observed).toEqual([undefined]);
  });

  it("buildSystemContext: throwing hook is logged as warn, turn runs with undefined", async () => {
    const observed: Array<string | undefined> = [];
    const runtime = new FakeRuntime({
      newSessionId: "sid",
      reply: "ok",
      observeRun: (opts) => observed.push(opts.systemContext),
    });
    const warnSpy = vi.fn();
    const logger: GatewayLogger = {
      info: () => {},
      warn: warnSpy,
      error: () => {},
      debug: () => {},
    };
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => runtime,
      sessionStore: store,
      log: logger,
      buildSystemContext: () => {
        throw new Error("memory read failed");
      },
    });

    await dispatcher.handle(makeEnvelope({ id: "msg_err" }));
    expect(observed).toEqual([undefined]);
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("ok");
    const warnMessages = warnSpy.mock.calls.map((c) => c[0]);
    expect(
      warnMessages.some((m: string) => m.includes("buildSystemContext threw")),
    ).toBe(true);
  });

  it("onInbound: observer is invoked with the message between ack and runtime.run", async () => {
    const order: string[] = [];
    const runtime = new FakeRuntime({
      newSessionId: "sid",
      observeRun: () => order.push("run"),
    });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const seen: string[] = [];
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      onInbound: (msg) => {
        order.push("observe");
        seen.push(msg.id);
      },
    });
    const accept = vi.fn(async () => {
      order.push("ack");
    });

    await dispatcher.handle(makeEnvelope({ id: "msg_obs_1" }, { accept }));
    expect(order).toEqual(["ack", "observe", "run"]);
    expect(seen).toEqual(["msg_obs_1"]);
  });

  it("onInbound: observer throwing does not break the turn", async () => {
    const runtime = new FakeRuntime({ newSessionId: "sid", reply: "ok" });
    const warnSpy = vi.fn();
    const logger: GatewayLogger = {
      info: () => {},
      warn: warnSpy,
      error: () => {},
      debug: () => {},
    };
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => runtime,
      sessionStore: store,
      log: logger,
      onInbound: () => {
        throw new Error("observer boom");
      },
    });

    await dispatcher.handle(makeEnvelope({ id: "msg_obs_2" }));
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("ok");
    const warnMessages = warnSpy.mock.calls.map((c) => c[0]);
    expect(warnMessages.some((m: string) => m.includes("onInbound"))).toBe(true);
  });

  it("unset queueMode + direct conversation → cancel-previous", async () => {
    const prior = new FakeRuntime({ hang: true, newSessionId: "prior" });
    const newer = new FakeRuntime({ reply: "newer", newSessionId: "newer" });
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      return callNo === 1 ? prior : newer;
    };
    // defaultRoute has no queueMode.
    const { dispatcher, channel } = await scaffold({ runtimeFactory });

    const p1 = dispatcher.handle(
      makeEnvelope({
        id: "m1",
        conversation: { id: "rm_oc_dm", kind: "direct" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await dispatcher.handle(
      makeEnvelope({
        id: "m2",
        conversation: { id: "rm_oc_dm", kind: "direct" },
      }),
    );
    await p1.catch(() => undefined);

    expect(prior.calls[0].signal.aborted).toBe(true);
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("newer");
  });

  it("cancel-previous: three rapid-fire messages — only the newest turn runs, no concurrent runtime.run()", async () => {
    // Controllable gate per runtime instance so we can drive timing.
    function newGate() {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let startedSignal!: () => void;
      const started = new Promise<void>((r) => {
        startedSignal = r;
      });
      return { gate, release, started, startedSignal };
    }

    const allGates: Array<ReturnType<typeof newGate>> = [];

    let activeRuns = 0;
    let maxActive = 0;
    const completedReplies: string[] = [];

    const runtimeFactory: RuntimeFactory = () => {
      const g = newGate();
      allGates.push(g);
      return {
        id: "claude-code",
        async run(opts: RuntimeRunOptions): Promise<RuntimeRunResult> {
          activeRuns += 1;
          maxActive = Math.max(maxActive, activeRuns);
          g.startedSignal();
          try {
            await new Promise<void>((resolve, reject) => {
              if (opts.signal.aborted) {
                reject(new Error("aborted"));
                return;
              }
              opts.signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
              g.gate.then(resolve);
            });
          } catch (err) {
            activeRuns -= 1;
            throw err;
          }
          activeRuns -= 1;
          const reply = `reply-${opts.text}`;
          completedReplies.push(reply);
          return { text: reply, newSessionId: `sid-${opts.text}` };
        },
      };
    };

    const { dispatcher, channel, store } = await scaffold({ runtimeFactory });

    // Fire message #1 — starts running and blocks on its gate.
    const p1 = dispatcher.handle(
      makeEnvelope({
        id: "m1",
        text: "one",
        conversation: { id: "rm_oc_race", kind: "direct" },
      }),
    );
    await vi.waitFor(() => {
      expect(allGates.length).toBeGreaterThanOrEqual(1);
    });
    await allGates[0].started;

    // Fire #2 and #3 back-to-back. Under the old racing implementation,
    // #2 could observe `current === null` after #1's abort and start a
    // second concurrent runtime.run() alongside #3's.
    const p2 = dispatcher.handle(
      makeEnvelope({
        id: "m2",
        text: "two",
        conversation: { id: "rm_oc_race", kind: "direct" },
      }),
    );
    const p3 = dispatcher.handle(
      makeEnvelope({
        id: "m3",
        text: "three",
        conversation: { id: "rm_oc_race", kind: "direct" },
      }),
    );

    // Wait for the newest runtime to start. It may be the 2nd or 3rd
    // constructed instance, depending on whether #2 was superseded before
    // it reached runTurn (expected under the fixed implementation).
    await vi.waitFor(() => {
      expect(allGates.length).toBeGreaterThanOrEqual(2);
      // At least one gate after index 0 should have started.
      const anyLaterStarted = allGates
        .slice(1)
        .some(() => true); // placeholder; real check below via Promise.race
      expect(anyLaterStarted).toBe(true);
    });
    await Promise.race(allGates.slice(1).map((g) => g.started));

    // Release every gate so any runtime still alive completes.
    for (const g of allGates) g.release();

    await Promise.allSettled([p1, p2, p3]);

    // Critical: never more than one runtime.run() concurrently.
    expect(maxActive).toBe(1);
    // Exactly one reply, and it's the newest message's reply.
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("reply-three");
    expect(completedReplies).toEqual(["reply-three"]);
    // Session persisted for newest only.
    expect(store.all().length).toBe(1);
    expect(store.all()[0].runtimeSessionId).toBe("sid-three");
  });

  it("cancel-previous aborts prior reply path — no stale send after supersede", async () => {
    // Simulate the race: runtime A's run() resolves while a cancel-previous
    // for message B is already racing through the queue. The prior turn's
    // post-runtime block must observe the abort signal and drop silently
    // instead of sending a stale reply.
    //
    // Key trick: the fake runtime for A does NOT honour the abort signal —
    // it only resolves when we explicitly call `resolveA`. We call
    // `resolveA` only after message B has arrived and aborted A's
    // controller. That exactly reproduces "signal aborted after runtime.run
    // resolved but before post-runtime work".
    let resolveA!: (v: RuntimeRunResult) => void;
    const aResult = new Promise<RuntimeRunResult>((r) => {
      resolveA = r;
    });
    const runtimeA: RuntimeAdapter = {
      id: "claude-code",
      async run(): Promise<RuntimeRunResult> {
        return aResult;
      },
    };
    const runtimeB = new FakeRuntime({ reply: "B-reply", newSessionId: "sid-B" });
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      return callNo === 1 ? runtimeA : runtimeB;
    };

    const { dispatcher, channel, store } = await scaffold({ runtimeFactory });

    // Start A. Its runtime.run is pending on the gate.
    const pA = dispatcher.handle(
      makeEnvelope({
        id: "msgA",
        text: "A",
        conversation: { id: "rm_oc_race2", kind: "direct" },
      }),
    );
    // Let the dispatcher reach `await runtime.run`.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Fire B — cancel-previous aborts A's controller and awaits prev.done.
    const pB = dispatcher.handle(
      makeEnvelope({
        id: "msgB",
        text: "B",
        conversation: { id: "rm_oc_race2", kind: "direct" },
      }),
    );
    // Give runCancelPrevious a tick to reach the abort + await prev.done.
    await Promise.resolve();
    await Promise.resolve();

    // Now resolve A's runtime. A would have happily sent "A-reply" and
    // written its session under the old code; with the fix it must observe
    // its aborted signal and bail silently.
    resolveA({ text: "A-reply", newSessionId: "sid-A" });

    await Promise.allSettled([pA, pB]);

    // Prior reply was suppressed; only B's reply went out.
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("B-reply");
    // Session was written for B only, not A.
    expect(store.all().length).toBe(1);
    expect(store.all()[0].runtimeSessionId).toBe("sid-B");
  });

  it("cancel-previous does not write session for superseded turn", async () => {
    // Same setup as above, but asserted specifically on the session store.
    let resolveA!: (v: RuntimeRunResult) => void;
    const aResult = new Promise<RuntimeRunResult>((r) => {
      resolveA = r;
    });
    const runtimeA: RuntimeAdapter = {
      id: "claude-code",
      async run(): Promise<RuntimeRunResult> {
        return aResult;
      },
    };
    const runtimeB = new FakeRuntime({ reply: "B", newSessionId: "sid-B" });
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      return callNo === 1 ? runtimeA : runtimeB;
    };

    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    // Spy on sessionStore.set to prove A never triggered a write.
    const setSpy = vi.spyOn(store, "set");
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: runtimeFactory,
      sessionStore: store,
      log: silentLogger(),
    });

    const pA = dispatcher.handle(
      makeEnvelope({
        id: "msgA",
        text: "A",
        conversation: { id: "rm_oc_race3", kind: "direct" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const pB = dispatcher.handle(
      makeEnvelope({
        id: "msgB",
        text: "B",
        conversation: { id: "rm_oc_race3", kind: "direct" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    resolveA({ text: "A-reply", newSessionId: "sid-A" });

    await Promise.allSettled([pA, pB]);

    // store.set must have been called exactly once — for B.
    expect(setSpy).toHaveBeenCalledTimes(1);
    const written = setSpy.mock.calls[0][0];
    expect(written.runtimeSessionId).toBe("sid-B");
  });

  it("timeout error reply still sent (not suppressed by supersede-drop check)", async () => {
    // A turn that times out has `signal.aborted === true` AND
    // `slot.timedOut === true`. The supersede check must only short-circuit
    // on the (aborted && !timedOut) case; timeouts still emit their error.
    vi.useFakeTimers();
    try {
      const runtime = new FakeRuntime({ hang: true, newSessionId: "never" });
      const channel = new FakeChannel();
      const { dispatcher, store } = await scaffold({
        channel,
        runtimeFactory: () => runtime,
        turnTimeoutMs: 500,
      });

      const p = dispatcher.handle(makeEnvelope({ id: "m1" }));
      await vi.advanceTimersByTimeAsync(501);
      await p;

      expect(runtime.calls[0].signal.aborted).toBe(true);
      expect(channel.sends.length).toBe(1);
      expect(channel.sends[0].message.text).toContain("timeout");
      expect(store.all().length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
