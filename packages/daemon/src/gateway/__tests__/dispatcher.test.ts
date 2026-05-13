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
  ChannelTypingContext,
  GatewayConfig,
  GatewayInboundEnvelope,
  GatewayInboundMessage,
  RuntimeAdapter,
  RuntimeRunOptions,
  RuntimeRunResult,
  RuntimeStatusEvent,
  StreamBlock,
} from "../types.js";
import type { GatewayLogger } from "../log.js";

function silentLogger(): GatewayLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

interface FakeChannelOptions {
  id?: string;
  type?: string;
  withStream?: boolean;
  withTyping?: boolean;
  sendImpl?: (ctx: ChannelSendContext) => Promise<ChannelSendResult> | ChannelSendResult;
  streamImpl?: (ctx: ChannelStreamBlockContext) => Promise<void> | void;
  typingImpl?: (ctx: ChannelTypingContext) => Promise<void> | void;
}

class FakeChannel implements ChannelAdapter {
  readonly id: string;
  readonly type: string;
  readonly sends: ChannelSendContext[] = [];
  readonly streams: ChannelStreamBlockContext[] = [];
  readonly typings: ChannelTypingContext[] = [];
  private readonly sendImpl?: FakeChannelOptions["sendImpl"];
  private readonly streamImpl?: FakeChannelOptions["streamImpl"];
  private readonly typingImpl?: FakeChannelOptions["typingImpl"];
  streamBlock?: (ctx: ChannelStreamBlockContext) => Promise<void>;
  typing?: (ctx: ChannelTypingContext) => Promise<void>;

  constructor(opts: FakeChannelOptions = {}) {
    this.id = opts.id ?? "botcord";
    this.type = opts.type ?? "fake";
    this.sendImpl = opts.sendImpl;
    this.streamImpl = opts.streamImpl;
    this.typingImpl = opts.typingImpl;
    if (opts.withStream !== false) {
      this.streamBlock = async (ctx) => {
        this.streams.push(ctx);
        if (this.streamImpl) await this.streamImpl(ctx);
      };
    }
    if (opts.withTyping !== false) {
      this.typing = async (ctx) => {
        this.typings.push(ctx);
        if (this.typingImpl) await this.typingImpl(ctx);
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
  /** Status events emitted before any blocks. */
  preStatus?: RuntimeStatusEvent[];
  /** Interleaved scripted events (status + blocks) replayed in order. */
  events?: Array<
    | { kind: "block"; block: StreamBlock }
    | { kind: "status"; event: RuntimeStatusEvent }
  >;
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
    if (this.opts.preStatus) {
      for (const s of this.opts.preStatus) options.onStatus?.(s);
    }
    if (this.opts.blocks) {
      for (const b of this.opts.blocks) options.onBlock?.(b);
    }
    if (this.opts.events) {
      for (const ev of this.opts.events) {
        if (ev.kind === "status") options.onStatus?.(ev.event);
        else options.onBlock?.(ev.block);
      }
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

  it("applies composeUserTurn before handing text to the runtime", async () => {
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid-1" });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      composeUserTurn: (msg) => `WRAPPED:${msg.text}`,
    });
    await dispatcher.handle(makeEnvelope({ id: "msg_1", text: "hello" }));
    expect(runtime.calls.length).toBe(1);
    expect(runtime.calls[0].text).toBe("WRAPPED:hello");
  });

  it("defers multimodal-only BotCord messages until the next text turn and preserves order", async () => {
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid-1" });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      composeUserTurn: (msg) => {
        const raw = msg.raw as { batch?: Array<{ text?: string }> };
        return (raw.batch ?? [{ text: msg.text }]).map((m) => m.text).join("\n");
      },
    });
    const acceptMedia = vi.fn(async () => {});
    const acceptText = vi.fn(async () => {});

    await dispatcher.handle(makeEnvelope({
      id: "h_media",
      text: '{"attachments":[{"filename":"a.png"}]}\nAttachments\na.png',
      raw: {
        hub_msg_id: "h_media",
        text: '{"attachments":[{"filename":"a.png"}]}\nAttachments\na.png',
        envelope: {
          type: "message",
          payload: { attachments: [{ filename: "a.png", url: "/hub/files/f_1" }] },
        },
      },
    }, { accept: acceptMedia }));

    expect(acceptMedia).toHaveBeenCalledTimes(1);
    expect(runtime.calls.length).toBe(0);

    await dispatcher.handle(makeEnvelope({
      id: "h_text",
      text: "please inspect this",
      raw: {
        hub_msg_id: "h_text",
        text: "please inspect this",
        envelope: { type: "message", payload: { text: "please inspect this" } },
      },
    }, { accept: acceptText }));

    expect(acceptText).toHaveBeenCalledTimes(1);
    expect(runtime.calls.length).toBe(1);
    expect(runtime.calls[0].text).toBe(
      '{"attachments":[{"filename":"a.png"}]}\nAttachments\na.png\nplease inspect this',
    );
  });

  it("falls back to raw text when composeUserTurn throws", async () => {
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid-1" });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      composeUserTurn: () => {
        throw new Error("boom");
      },
    });
    await dispatcher.handle(makeEnvelope({ id: "msg_1", text: "hello" }));
    expect(runtime.calls.length).toBe(1);
    expect(runtime.calls[0].text).toBe("hello");
  });

  it("fires onOutbound after a reply is dispatched", async () => {
    const runtime = new FakeRuntime({ reply: "hello back", newSessionId: "sid-1" });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const outbound: string[] = [];
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      onOutbound: (msg) => {
        outbound.push(msg.text);
      },
    });
    await dispatcher.handle(makeEnvelope({ id: "msg_1", text: "hi" }));
    expect(outbound).toEqual(["hello back"]);
  });

  it("does not crash when onOutbound throws", async () => {
    const runtime = new FakeRuntime({ reply: "hello back", newSessionId: "sid-1" });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      onOutbound: () => {
        throw new Error("boom");
      },
    });
    await dispatcher.handle(makeEnvelope({ id: "msg_1", text: "hi" }));
    // Reply still went out; no assertion needed beyond the absence of a throw.
    expect(channel.sends.length).toBe(1);
  });

  it("does not crash when an errored turn has no prior session entry", async () => {
    const runtime = new FakeRuntime({ newSessionId: "", errorText: "boom" });
    const { dispatcher, store } = await scaffold({ runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ id: "msg_1", conversation: { id: "rm_y", kind: "direct" } }),
    );
    expect(store.all().length).toBe(0);
  });

  it("runtime empty text with error: sends owner-chat error reply", async () => {
    const runtime = new FakeRuntime({ reply: "", newSessionId: "", errorText: "missing openclawAgent" });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(makeEnvelope({ id: "msg_error" }));

    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toContain("Runtime error");
    expect(channel.sends[0].message.text).toContain("missing openclawAgent");
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

    // Use an `rm_oc_` room so the dispatcher's reply gating does not drop
    // the runtime text — non-owner-chat rooms intentionally suppress
    // result.text since the agent is expected to use `botcord_send`.
    const p1 = dispatcher.handle(
      makeEnvelope({
        id: "m1",
        conversation: { id: "rm_oc_g1", kind: "group" },
      }),
    );
    const p2 = dispatcher.handle(
      makeEnvelope({
        id: "m2",
        conversation: { id: "rm_oc_g1", kind: "group" },
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
    // Use only assistant_text so we don't trip the thinking-synthesis path
    // (covered separately below); this test stays focused on basic forwarding.
    const blocks: StreamBlock[] = [
      { raw: { type: "a" }, kind: "assistant_text", seq: 1 },
      { raw: { type: "b" }, kind: "assistant_text", seq: 2 },
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
    // Dispatcher re-sequences on the wire so synthesized thinking blocks
    // interleave cleanly. Two assistant_text blocks → wire seq 1, 2.
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

  // ---------------------------------------------------------------------------
  // typing / thinking lifecycle (design: runtime-typing-thinking-status-design.md)
  // ---------------------------------------------------------------------------

  it("typing: fires channel.typing once before runtime.run when trace is streamable", async () => {
    const observed: Array<{ typings: number; calls: number }> = [];
    const runtime = new FakeRuntime({
      observeRun: () => {
        // Snapshot the typing count at the moment runtime.run is invoked so we
        // can prove typing.started fired BEFORE the runtime started.
        observed.push({ typings: channel.typings.length, calls: 1 });
      },
      reply: "ok",
      newSessionId: "sid",
    });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "trace_t", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(channel.typings.length).toBe(1);
    expect(channel.typings[0].traceId).toBe("trace_t");
    expect(channel.typings[0].conversationId).toBe("rm_oc_1");
    expect(observed[0]?.typings).toBe(1);
  });

  it("typing: does not require channel streamBlock support", async () => {
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid" });
    const channel = new FakeChannel({ withStream: false });
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "trace_t", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(channel.typings.length).toBe(1);
    expect(channel.streams.length).toBe(0);
    expect(channel.sends.length).toBe(1);
  });

  it("typing: fires for non-BotCord channels even when streamable is false", async () => {
    const channel = new FakeChannel({ id: "gw_provider", type: "telegram" });
    const { dispatcher } = await scaffold({
      channel,
      runtimeFactory: () => new FakeRuntime({ reply: "ok", newSessionId: "sid" }),
    });

    await dispatcher.handle(
      makeEnvelope({ channel: "gw_provider", trace: { id: "t1", streamable: false } }),
    );
    expect(channel.typings.length).toBe(1);
  });

  it("typing: not fired for BotCord rooms when streamable is false", async () => {
    const channel = new FakeChannel({ type: "botcord" });
    const { dispatcher } = await scaffold({
      channel,
      runtimeFactory: () => new FakeRuntime({ reply: "ok", newSessionId: "sid" }),
    });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "t1", streamable: false } }),
    );
    expect(channel.typings.length).toBe(0);
  });

  it("typing: refreshes while a provider turn is still running", async () => {
    vi.useFakeTimers();
    try {
      const channel = new FakeChannel({ id: "gw_tg", type: "telegram" });
      const runtime = new FakeRuntime({ delayMs: 8500, reply: "ok", newSessionId: "sid" });
      const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

      const pending = dispatcher.handle(
        makeEnvelope({
          channel: "gw_tg",
          conversation: { id: "telegram:user:42", kind: "direct" },
          trace: { id: "telegram:42:1", streamable: true },
        }),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(channel.typings.length).toBe(1);

      await vi.advanceTimersByTimeAsync(4000);
      expect(channel.typings.length).toBe(2);

      await vi.advanceTimersByTimeAsync(4000);
      expect(channel.typings.length).toBe(3);

      await vi.advanceTimersByTimeAsync(500);
      await pending;

      await vi.advanceTimersByTimeAsync(4000);
      expect(channel.typings.length).toBe(3);
      expect(channel.sends.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("typing: not fired when channel has no typing capability", async () => {
    const channel = new FakeChannel({ withTyping: false });
    const { dispatcher } = await scaffold({
      channel,
      runtimeFactory: () => new FakeRuntime({ reply: "ok", newSessionId: "sid" }),
    });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "t1", streamable: true } }),
    );
    expect(channel.typings.length).toBe(0);
  });

  it("typing: failure in channel.typing must not break the turn", async () => {
    const channel = new FakeChannel({
      typingImpl: () => {
        throw new Error("typing exploded");
      },
    });
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid" });
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "t1", streamable: true } }),
    );
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("ok");
  });

  it("thinking: synthesized before first non-assistant block", async () => {
    const blocks: StreamBlock[] = [
      { raw: { type: "system", subtype: "init" }, kind: "system", seq: 1 },
      { raw: { type: "assistant" }, kind: "assistant_text", seq: 2 },
    ];
    const runtime = new FakeRuntime({ blocks, reply: "ok", newSessionId: "sid" });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    // [synthesized thinking, system, assistant_text]
    expect(channel.streams.length).toBe(3);
    const kinds = channel.streams.map((s) => (s.block as StreamBlock).kind);
    expect(kinds).toEqual(["thinking", "system", "assistant_text"]);
    expect(channel.streams.map((s) => (s.block as StreamBlock).seq)).toEqual([1, 2, 3]);
    const thinkingRaw = channel.streams[0].block as StreamBlock;
    expect((thinkingRaw.raw as { phase: string }).phase).toBe("started");
    expect((thinkingRaw.raw as { source: string }).source).toBe("dispatcher");
  });

  it("thinking: NOT synthesized when first block is assistant_text", async () => {
    const blocks: StreamBlock[] = [
      { raw: { type: "assistant" }, kind: "assistant_text", seq: 1 },
    ];
    const runtime = new FakeRuntime({ blocks, reply: "ok", newSessionId: "sid" });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(channel.streams.length).toBe(1);
    expect((channel.streams[0].block as StreamBlock).kind).toBe("assistant_text");
  });

  it("thinking: re-enters thinking on tool_use after assistant_text exits it, then closes on terminal", async () => {
    const blocks: StreamBlock[] = [
      { raw: { type: "assistant" }, kind: "assistant_text", seq: 1 },
      { raw: { type: "tool" }, kind: "tool_use", seq: 2 },
    ];
    const runtime = new FakeRuntime({ blocks, reply: "ok", newSessionId: "sid" });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    // [assistant_text, synthesized thinking.started, tool_use, terminal thinking.stopped]
    expect(channel.streams.length).toBe(4);
    const kinds = channel.streams.map((s) => (s.block as StreamBlock).kind);
    expect(kinds).toEqual(["assistant_text", "thinking", "tool_use", "thinking"]);
    const terminal = channel.streams[3].block as StreamBlock;
    expect((terminal.raw as { phase: string }).phase).toBe("stopped");
  });

  it("thinking: runtime onStatus(thinking.started) suppresses dispatcher synthesis and forwards label", async () => {
    const runtime = new FakeRuntime({
      events: [
        {
          kind: "status",
          event: { kind: "thinking", phase: "started", label: "Searching web" },
        },
        { kind: "block", block: { raw: { type: "tool" }, kind: "tool_use", seq: 1 } },
      ],
      reply: "ok",
      newSessionId: "sid",
    });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    // [labeled thinking, tool_use, terminal thinking.stopped] — no auto-synthesized bare thinking.
    expect(channel.streams.length).toBe(3);
    const first = channel.streams[0].block as StreamBlock;
    expect(first.kind).toBe("thinking");
    expect((first.raw as { label: string }).label).toBe("Searching web");
    expect((first.raw as { source: string }).source).toBe("runtime");
    expect((channel.streams[1].block as StreamBlock).kind).toBe("tool_use");
    const terminal = channel.streams[2].block as StreamBlock;
    expect(terminal.kind).toBe("thinking");
    expect((terminal.raw as { phase: string }).phase).toBe("stopped");
  });

  it("thinking: runtime onStatus(typing.started) is idempotent — no second /hub/typing call", async () => {
    const runtime = new FakeRuntime({
      preStatus: [{ kind: "typing", phase: "started" }],
      reply: "ok",
      newSessionId: "sid",
    });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    // Dispatcher pre-fires once before runtime.run; runtime's redundant
    // typing.started status event must not trigger a second hub ping.
    expect(channel.typings.length).toBe(1);
  });

  it("thinking: timeout path emits terminal thinking.stopped + no extra frames after abort", async () => {
    const runtime = new FakeRuntime({
      blocks: [{ raw: {}, kind: "system", seq: 1 }],
      hang: true,
    });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({
      channel,
      runtimeFactory: () => runtime,
      turnTimeoutMs: 30,
    });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );

    // Timeout reply is sent in owner-chat.
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toMatch(/Runtime timeout/);
    // [synth thinking.started, system, terminal thinking.stopped]
    const kinds = channel.streams.map((s) => (s.block as StreamBlock).kind);
    expect(kinds).toEqual(["thinking", "system", "thinking"]);
    const terminal = channel.streams[2].block as StreamBlock;
    expect((terminal.raw as { phase: string }).phase).toBe("stopped");
    // Nothing else should sneak in after the timeout's abort.
    const lastSeq = channel.streams.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(channel.streams.length).toBe(lastSeq);
  });

  it("thinking: terminal thinking.stopped fires on success when turn ends with thinking active", async () => {
    // Empty reply + only a tool_use block → assistant_text never lands, so
    // the dispatcher's finally is the only place thinking gets收束.
    const blocks: StreamBlock[] = [
      { raw: { type: "tool" }, kind: "tool_use", seq: 1 },
    ];
    const runtime = new FakeRuntime({ blocks, reply: "", newSessionId: "sid" });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    // [synth thinking.started, tool_use, terminal thinking.stopped]
    const kinds = channel.streams.map((s) => (s.block as StreamBlock).kind);
    expect(kinds).toEqual(["thinking", "tool_use", "thinking"]);
    expect((channel.streams[2].block as StreamBlock).raw as { phase: string }).toMatchObject({
      phase: "stopped",
    });
  });

  it("thinking: post-abort onBlock callbacks are dropped after controller.signal.aborted", async () => {
    // Drive runtime manually so we can fire callbacks AFTER the dispatcher
    // marks the turn aborted (simulating the NDJSON adapter's stdout-flush
    // window between SIGTERM and SIGKILL).
    let captured: RuntimeRunOptions | null = null;
    const runtime: RuntimeAdapter = {
      id: "fake",
      run: async (opts) => {
        captured = opts;
        // Block 1 fires while the turn is still live.
        opts.onBlock?.({ raw: {}, kind: "system", seq: 1 });
        // Wait for caller-side abort. Reject to simulate the runtime exiting.
        return new Promise<RuntimeRunResult>((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    };
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({
      channel,
      runtimeFactory: () => runtime,
      turnTimeoutMs: 30,
    });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    // Timeout has fired by now → controller.signal.aborted=true.
    const beforeLate = channel.streams.length;
    // Simulate adapter flushing one more block AFTER abort.
    captured!.onBlock?.({ raw: { type: "late" }, kind: "tool_use", seq: 99 });
    captured!.onStatus?.({ kind: "thinking", phase: "updated", label: "late" });
    await new Promise((r) => setTimeout(r, 5));
    // Late callbacks are dropped — wire frame count unchanged.
    expect(channel.streams.length).toBe(beforeLate);
  });

  it("typing: cancel-previous within debounce window does NOT double-ping /hub/typing", async () => {
    const runtime = new FakeRuntime({ hang: true });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({
      channel,
      runtimeFactory: () => runtime,
      turnTimeoutMs: 30,
    });

    // First turn pings typing.
    await dispatcher.handle(
      makeEnvelope({
        id: "m1",
        conversation: { id: "rm_oc_dbnc", kind: "direct" },
        trace: { id: "tr1", streamable: true },
      }),
    );
    expect(channel.typings.length).toBe(1);

    // Second turn arrives immediately (cancel-previous superseder); within
    // the 2s debounce, no second hub ping should fire.
    await dispatcher.handle(
      makeEnvelope({
        id: "m2",
        conversation: { id: "rm_oc_dbnc", kind: "direct" },
        trace: { id: "tr2", streamable: true },
      }),
    );
    expect(channel.typings.length).toBe(1);
  });

  it("typing: synchronous throw from channel.typing is logged but does not break turn", async () => {
    const channel = new FakeChannel();
    // Replace typing with a sync-throwing function (non-async).
    (channel as unknown as { typing: (ctx: ChannelTypingContext) => Promise<void> }).typing =
      ((_ctx: ChannelTypingContext) => {
        throw new Error("sync boom");
      }) as unknown as (ctx: ChannelTypingContext) => Promise<void>;
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid" });
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("ok");
  });

  it("thinking: post-assistant_text system/other blocks do NOT re-flicker thinking (sticky guard)", async () => {
    // Mirrors the codex `turn.completed` / claude `result` shapes — both arrive
    // as system/other AFTER the prose. They must NOT re-enter thinking,
    // otherwise the UI flickers right after the final answer.
    const blocks: StreamBlock[] = [
      { raw: { type: "assistant" }, kind: "assistant_text", seq: 1 },
      { raw: { type: "turn.completed" }, kind: "system", seq: 2 },
      { raw: { type: "result" }, kind: "other", seq: 3 },
    ];
    const runtime = new FakeRuntime({ blocks, reply: "ok", newSessionId: "sid" });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    const kinds = channel.streams.map((s) => (s.block as StreamBlock).kind);
    // [assistant_text, system, other] — no thinking flicker after prose.
    expect(kinds).toEqual(["assistant_text", "system", "other"]);
  });

  it("thinking: tool_use AFTER assistant_text still re-enters thinking (multi-step reply)", async () => {
    // Sticky only blocks system/other re-entry. A genuine follow-up tool call
    // SHOULD drive "Thinking…" again so the user knows the agent is working.
    const blocks: StreamBlock[] = [
      { raw: { type: "assistant" }, kind: "assistant_text", seq: 1 },
      { raw: { type: "tool" }, kind: "tool_use", seq: 2 },
    ];
    const runtime = new FakeRuntime({ blocks, reply: "ok", newSessionId: "sid" });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    const kinds = channel.streams.map((s) => (s.block as StreamBlock).kind);
    // [assistant_text, synth thinking.started, tool_use, terminal thinking.stopped]
    expect(kinds).toEqual(["assistant_text", "thinking", "tool_use", "thinking"]);
  });

  it("thinking: runtime onStatus(thinking.stopped) forwards to wire and prevents finally double-emit", async () => {
    // Mirrors hermes/acp-stream's prompt-done path: the runtime explicitly
    // tells us thinking is over BEFORE the dispatcher's finally runs.
    const runtime = new FakeRuntime({
      events: [
        { kind: "block", block: { raw: { type: "tool" }, kind: "tool_use", seq: 1 } },
        { kind: "status", event: { kind: "thinking", phase: "stopped" } },
      ],
      reply: "ok",
      newSessionId: "sid",
    });
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    // [synth thinking.started, tool_use, runtime thinking.stopped]
    // The finalizeThinkingIfActive in finally must NOT re-emit a 4th frame.
    const kinds = channel.streams.map((s) => (s.block as StreamBlock).kind);
    expect(kinds).toEqual(["thinking", "tool_use", "thinking"]);
    const stoppedFrames = channel.streams.filter(
      (s) => (s.block as StreamBlock).kind === "thinking" &&
        ((s.block as StreamBlock).raw as { phase: string }).phase === "stopped",
    );
    expect(stoppedFrames.length).toBe(1);
  });

  it("thinking: cancel-previous superseder skips finalize (prior turn does NOT emit terminal stopped)", async () => {
    // Streamable cancel-previous race: the SUPERSEDED turn's finalize must
    // NOT push a `thinking.stopped` frame, because the new turn is about to
    // start its own typing/thinking lifecycle and an old stopped frame would
    // race the new started frame on the wire.
    let priorObserved: RuntimeRunOptions | null = null;
    const prior = new FakeRuntime({
      hang: true,
      observeRun: (opts) => {
        priorObserved = opts;
      },
    });
    const newer = new FakeRuntime({ reply: "newer", newSessionId: "sid-new" });
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => (++callNo === 1 ? prior : newer);
    const channel = new FakeChannel();
    const { dispatcher } = await scaffold({ channel, runtimeFactory });

    // First turn — fires typing + a system block to prime thinkingActive,
    // then hangs.
    const first = dispatcher.handle(
      makeEnvelope({
        id: "m_prior",
        conversation: { id: "rm_oc_cancel", kind: "direct" },
        trace: { id: "tr_prior", streamable: true },
      }),
    );
    while (!priorObserved) await new Promise((r) => setTimeout(r, 1));
    priorObserved!.onBlock?.({ raw: { type: "system" }, kind: "system", seq: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const beforeSupersede = channel.streams.length;

    // Second turn supersedes prior.
    await dispatcher.handle(
      makeEnvelope({
        id: "m_newer",
        conversation: { id: "rm_oc_cancel", kind: "direct" },
        trace: { id: "tr_newer", streamable: true },
      }),
    );
    await first.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));

    // Frames belonging to prior trace before supersede:
    //   [synth thinking.started, system]
    // After supersede no terminal `thinking.stopped` should be emitted for
    // tr_prior — `finalizeThinkingIfActive` skips on superseded turns.
    const priorFrames = channel.streams
      .slice(0, beforeSupersede)
      .map((s) => (s.block as StreamBlock).kind);
    expect(priorFrames).toEqual(["thinking", "system"]);
    // No frame WITH the prior traceId after the supersede mark either.
    const postSupersedePriorFrames = channel.streams
      .slice(beforeSupersede)
      .filter((s) => s.traceId === "tr_prior");
    expect(postSupersedePriorFrames.length).toBe(0);
  });

  it("typing: second ping within debounce window does not double-fire /hub/typing", async () => {
    // The recentTypingPings map's true-LRU behavior is implemented but not
    // directly observable from this test surface (would require >1024 cold
    // rooms to exercise eviction). What we DO verify here is the user-visible
    // contract: rapid same-room pings within the 2s debounce coalesce to one.
    const channel = new FakeChannel();
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid" });
    const { dispatcher } = await scaffold({ channel, runtimeFactory: () => runtime });

    await dispatcher.handle(
      makeEnvelope({
        id: "hot1",
        conversation: { id: "rm_oc_hot", kind: "direct" },
        trace: { id: "trh1", streamable: true },
      }),
    );
    expect(channel.typings.length).toBe(1);

    await dispatcher.handle(
      makeEnvelope({
        id: "hot2",
        conversation: { id: "rm_oc_hot", kind: "direct" },
        trace: { id: "trh2", streamable: true },
      }),
    );
    expect(channel.typings.length).toBe(1);
  });

  it("transcript: synthesized thinking does NOT pollute outbound.blocks", async () => {
    const blocks: StreamBlock[] = [
      { raw: { type: "system" }, kind: "system", seq: 1 },
      { raw: { type: "tool" }, kind: "tool_use", seq: 2 },
    ];
    const runtime = new FakeRuntime({ blocks, reply: "ok", newSessionId: "sid" });
    const channel = new FakeChannel();
    const records: import("../transcript.js").TranscriptRecord[] = [];
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      transcript: { enabled: true, rootDir: dir, write: (rec) => records.push(rec) },
    });

    await dispatcher.handle(
      makeEnvelope({ trace: { id: "tr", streamable: true } }),
    );
    await new Promise((r) => setTimeout(r, 5));

    const outbound = records.find((r) => r.kind === "outbound");
    expect(outbound).toBeDefined();
    const blockTypes = (outbound as { blocks?: Array<{ type: string }> }).blocks?.map((b) => b.type) ?? [];
    // Only the runtime-emitted blocks land in the transcript; synth thinking is intentionally skipped.
    expect(blockTypes).toEqual(["system", "tool_use"]);
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

  // ─────────────────────────────────────────────────────────────────────
  // Owner-chat reply gating
  // ─────────────────────────────────────────────────────────────────────

  it("non-owner-chat room: discards result.text, agent must use botcord_send", async () => {
    const runtime = new FakeRuntime({ reply: "would-be-reply", newSessionId: "sid-1" });
    const { dispatcher, channel, store } = await scaffold({
      runtimeFactory: () => runtime,
    });

    await dispatcher.handle(
      makeEnvelope({
        id: "msg_1",
        conversation: { id: "rm_g_other", kind: "group" },
      }),
    );

    expect(runtime.calls.length).toBe(1);
    // Session is still persisted — only the channel send is gated.
    expect(store.all().length).toBe(1);
    expect(channel.sends.length).toBe(0);
  });

  it("non-owner-chat room: timeout sends a diagnostic reply", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new FakeRuntime({ hang: true });
      const { dispatcher, channel } = await scaffold({
        runtimeFactory: () => runtime,
        turnTimeoutMs: 500,
      });
      const p = dispatcher.handle(
        makeEnvelope({
          id: "m_to",
          conversation: { id: "rm_g_other", kind: "group" },
        }),
      );
      await vi.advanceTimersByTimeAsync(501);
      await p;
      expect(runtime.calls[0].signal.aborted).toBe(true);
      expect(channel.sends.length).toBe(1);
      expect(channel.sends[0].message.text).toMatch(/Runtime timeout/);
      expect(channel.sends[0].message.conversationId).toBe("rm_g_other");
      expect(channel.sends[0].message.replyTo).toBe("m_to");
    } finally {
      vi.useRealTimers();
    }
  });

  it("non-owner-chat room: runtime error sends a diagnostic reply", async () => {
    const runtime = new FakeRuntime({ throwError: "boom" });
    const { dispatcher, channel } = await scaffold({
      runtimeFactory: () => runtime,
    });
    await dispatcher.handle(
      makeEnvelope({
        id: "m_err",
        conversation: { id: "rm_g_other", kind: "group" },
      }),
    );
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toContain("Runtime error: boom");
    expect(channel.sends[0].message.conversationId).toBe("rm_g_other");
    expect(channel.sends[0].message.replyTo).toBe("m_err");
  });

  // ─────────────────────────────────────────────────────────────────────
  // Serial coalesce-on-drain
  // ─────────────────────────────────────────────────────────────────────

  it("serial coalesce: messages arriving during a slow turn fold into ONE next turn", async () => {
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      const tag = `r${callNo}`;
      return new FakeRuntime({
        id: "claude-code",
        reply: tag,
        delayMs: 30,
        newSessionId: `sid-${callNo}`,
      });
    };
    // Capture composer input so we can inspect what each turn was asked to render.
    const composeCalls: Array<{ id: string; batchSize: number }> = [];
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const dispatcher = new Dispatcher({
      config: baseConfig({
        defaultRoute: { runtime: "claude-code", cwd: "/tmp/d", queueMode: "serial" },
      }),
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: runtimeFactory,
      sessionStore: store,
      log: silentLogger(),
      composeUserTurn: (msg) => {
        const raw = msg.raw as { batch?: unknown[] } | null | undefined;
        const batch = Array.isArray(raw?.batch) ? raw!.batch : null;
        composeCalls.push({ id: msg.id, batchSize: batch ? batch.length : 1 });
        return msg.text ?? "";
      },
    });

    // m1 arrives → triggers immediate turn.
    const p1 = dispatcher.handle(
      makeEnvelope({
        id: "m1",
        text: "hello",
        raw: { hub_msg_id: "m1", text: "hello" },
        conversation: { id: "rm_grp_x", kind: "group" },
      }),
    );
    // Let the worker start runtime.run for m1.
    await Promise.resolve();
    await Promise.resolve();
    // m2 + m3 arrive while m1 is in flight → buffered, must coalesce.
    const p2 = dispatcher.handle(
      makeEnvelope({
        id: "m2",
        text: "second",
        raw: { hub_msg_id: "m2", text: "second" },
        conversation: { id: "rm_grp_x", kind: "group" },
      }),
    );
    const p3 = dispatcher.handle(
      makeEnvelope({
        id: "m3",
        text: "third",
        raw: { hub_msg_id: "m3", text: "third" },
        conversation: { id: "rm_grp_x", kind: "group" },
      }),
    );
    await Promise.all([p1, p2, p3]);

    // Exactly two runtime turns: m1 alone, then a single coalesced turn merging m2+m3.
    expect(callNo).toBe(2);
    expect(composeCalls.length).toBe(2);
    expect(composeCalls[0]).toEqual({ id: "m1", batchSize: 1 });
    // Anchor of merged turn is the latest entry (m3); raw.batch holds both.
    expect(composeCalls[1].id).toBe("m3");
    expect(composeCalls[1].batchSize).toBe(2);
    // Sends gated for non-owner-chat room.
    expect(channel.sends.length).toBe(0);
  });

  it("serial coalesce: mentioned is OR'd across the merged batch", async () => {
    let captured: { mentioned?: boolean } = {};
    const runtimeFactory: RuntimeFactory = () =>
      new FakeRuntime({ reply: "ok", delayMs: 20, newSessionId: "sid" });
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const dispatcher = new Dispatcher({
      config: baseConfig({
        defaultRoute: { runtime: "claude-code", cwd: "/tmp/d", queueMode: "serial" },
      }),
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: runtimeFactory,
      sessionStore: store,
      log: silentLogger(),
      composeUserTurn: (msg) => {
        if (msg.id === "m_b") captured = { mentioned: msg.mentioned };
        return msg.text ?? "";
      },
    });

    const p1 = dispatcher.handle(
      makeEnvelope({
        id: "m_a",
        text: "a",
        mentioned: false,
        conversation: { id: "rm_grp_y", kind: "group" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    // Two new entries arrive during turn 1; one of them is mentioned.
    const p2 = dispatcher.handle(
      makeEnvelope({
        id: "m_a2",
        text: "a2",
        mentioned: true,
        conversation: { id: "rm_grp_y", kind: "group" },
      }),
    );
    const p3 = dispatcher.handle(
      makeEnvelope({
        id: "m_b",
        text: "b",
        mentioned: false,
        conversation: { id: "rm_grp_y", kind: "group" },
      }),
    );
    await Promise.all([p1, p2, p3]);
    expect(captured.mentioned).toBe(true);
  });

  it("serial coalesce: buffer overflow drops oldest entries (>40 backlog)", async () => {
    let firstTurnDone!: () => void;
    const firstTurnGate = new Promise<void>((resolve) => {
      firstTurnDone = resolve;
    });
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      const tag = `r${callNo}`;
      // Turn 1 hangs until firstTurnGate is resolved, so we can pile up the
      // overflowing backlog while it's in flight. Turns 2+ just complete.
      if (callNo === 1) {
        return new FakeRuntime({
          reply: tag,
          newSessionId: `sid-${callNo}`,
          observeRun: () => {
            void firstTurnGate.then(() => undefined);
          },
        });
      }
      return new FakeRuntime({
        reply: tag,
        newSessionId: `sid-${callNo}`,
        delayMs: 0,
      });
    };
    const composedIds: string[][] = [];
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const dispatcher = new Dispatcher({
      config: baseConfig({
        defaultRoute: { runtime: "claude-code", cwd: "/tmp/d", queueMode: "serial" },
      }),
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: runtimeFactory,
      sessionStore: store,
      log: silentLogger(),
      composeUserTurn: (msg) => {
        const raw = msg.raw as { batch?: Array<{ hub_msg_id?: string }> } | null;
        const ids = Array.isArray(raw?.batch)
          ? raw!.batch!.map((b) => b.hub_msg_id ?? "?")
          : [msg.id];
        composedIds.push(ids);
        return msg.text ?? "";
      },
    });
    // Use a slow-runtime trigger that only resolves once we've enqueued
    // enough overflow. Easier path: switch to delayMs and use timers.
    // Simplification: just push 50 messages serially via Promise.all so that
    // arrivals 2-50 buffer while arrival 1 is mid-run.
    const arrivals: Array<Promise<void>> = [];
    arrivals.push(
      dispatcher.handle(
        makeEnvelope({
          id: "m_first",
          text: "first",
          raw: { hub_msg_id: "m_first", text: "first" },
          conversation: { id: "rm_grp_overflow", kind: "group" },
        }),
      ),
    );
    // Yield twice so the worker observes the first entry and starts runtime.
    await Promise.resolve();
    await Promise.resolve();
    // Push 50 more — backlog cap is 40, so the oldest 10 must be dropped.
    for (let i = 0; i < 50; i++) {
      arrivals.push(
        dispatcher.handle(
          makeEnvelope({
            id: `m_${i}`,
            text: `msg-${i}`,
            raw: { hub_msg_id: `m_${i}`, text: `msg-${i}` },
            conversation: { id: "rm_grp_overflow", kind: "group" },
          }),
        ),
      );
    }
    // Release turn 1 so the worker drains the (capped) backlog.
    firstTurnDone();
    await Promise.all(arrivals);

    // Two compose calls: first turn (m_first), second turn (40 surviving
    // backlog entries — m_10 through m_49 if drop-oldest was applied).
    expect(composedIds.length).toBe(2);
    expect(composedIds[0]).toEqual(["m_first"]);
    expect(composedIds[1].length).toBe(40);
    expect(composedIds[1][0]).toBe("m_10");
    expect(composedIds[1][39]).toBe("m_49");
  });

  it("serial coalesce: char-cap drops oldest individual messages from merged batch", async () => {
    let callNo = 0;
    const runtimeFactory: RuntimeFactory = () => {
      callNo += 1;
      const tag = `r${callNo}`;
      return new FakeRuntime({
        reply: tag,
        newSessionId: `sid-${callNo}`,
        // Turn 1 holds until released so turns 2-N pile up.
        delayMs: callNo === 1 ? 50 : 0,
      });
    };
    const composedItemCounts: number[] = [];
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const dispatcher = new Dispatcher({
      config: baseConfig({
        defaultRoute: { runtime: "claude-code", cwd: "/tmp/d", queueMode: "serial" },
      }),
      channels: new Map<string, ChannelAdapter>([[channel.id, channel]]),
      runtime: runtimeFactory,
      sessionStore: store,
      log: silentLogger(),
      composeUserTurn: (msg) => {
        const raw = msg.raw as { batch?: unknown[] } | null;
        const items = Array.isArray(raw?.batch) ? raw!.batch!.length : 1;
        composedItemCounts.push(items);
        return msg.text ?? "";
      },
    });
    // Each pile-up message carries ~2000 chars; 20 messages = ~40000 chars,
    // well over the 16000 cap. The merger must drop oldest until ≤16000.
    const big = "x".repeat(2000);
    const p0 = dispatcher.handle(
      makeEnvelope({
        id: "m_lead",
        text: "lead",
        raw: { hub_msg_id: "m_lead", text: "lead" },
        conversation: { id: "rm_grp_chars", kind: "group" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    const arrivals: Array<Promise<void>> = [p0];
    for (let i = 0; i < 20; i++) {
      arrivals.push(
        dispatcher.handle(
          makeEnvelope({
            id: `mb_${i}`,
            text: big,
            raw: { hub_msg_id: `mb_${i}`, text: big },
            conversation: { id: "rm_grp_chars", kind: "group" },
          }),
        ),
      );
    }
    await Promise.all(arrivals);

    // Two composer calls. The second is the merged drain — it must contain
    // strictly fewer than 20 items because oldest were dropped to fit cap.
    expect(composedItemCounts.length).toBe(2);
    expect(composedItemCounts[0]).toBe(1);
    expect(composedItemCounts[1]).toBeGreaterThan(0);
    expect(composedItemCounts[1]).toBeLessThan(20);
    // Cap is 16000 chars; each item is 2000 → at most 8 items survive.
    expect(composedItemCounts[1]).toBeLessThanOrEqual(8);
  });

  it("attentionGate=false skips the runtime turn but still acks and runs onInbound (PR3)", async () => {
    const runtime = new FakeRuntime();
    const { store, dir } = await makeStore();
    tempDirs.push(dir);
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const accept = vi.fn(async () => {});
    const onInbound = vi.fn();
    const attentionGate = vi.fn(async () => false);
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => runtime,
      sessionStore: store,
      log: silentLogger(),
      onInbound,
      attentionGate,
    });
    await dispatcher.handle(makeEnvelope({ id: "m_gated", text: "hello" }, { accept }));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(attentionGate).toHaveBeenCalledTimes(1);
    expect(runtime.calls.length).toBe(0);
    expect(channel.sends.length).toBe(0);
  });

  it("attentionGate=true wakes the runtime as usual (PR3)", async () => {
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid-1" });
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
      attentionGate: () => true,
    });
    await dispatcher.handle(makeEnvelope({ id: "m_wake" }));
    expect(runtime.calls.length).toBe(1);
    expect(channel.sends.length).toBe(1);
  });

  it("attentionGate throwing fails open and runs the turn (PR3)", async () => {
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid-1" });
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
      attentionGate: () => {
        throw new Error("boom");
      },
    });
    await dispatcher.handle(makeEnvelope({ id: "m_wake_throw" }));
    expect(runtime.calls.length).toBe(1);
  });

  it("owner-chat detection: dashboard_user_chat in non-rm_oc room still sends reply", async () => {
    const runtime = new FakeRuntime({ reply: "ok", newSessionId: "sid-1" });
    const { dispatcher, channel } = await scaffold({
      runtimeFactory: () => runtime,
    });
    await dispatcher.handle(
      makeEnvelope({
        id: "m_dash",
        // Note: room id does NOT start with rm_oc_ but raw.source_type marks
        // this as a dashboard user chat — must be treated as owner-chat by
        // the gating predicate.
        conversation: { id: "rm_dashroom", kind: "direct" },
        raw: { source_type: "dashboard_user_chat" },
      }),
    );
    expect(channel.sends.length).toBe(1);
    expect(channel.sends[0].message.text).toBe("ok");
  });
});
