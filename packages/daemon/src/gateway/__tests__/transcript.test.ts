import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dispatcher, type RuntimeFactory } from "../dispatcher.js";
import { SessionStore } from "../session-store.js";
import {
  createTranscriptWriter,
  cleanupTranscriptFiles,
  resolveTranscriptEnabled,
  TRANSCRIPT_RETENTION_MS,
  TRANSCRIPT_TEXT_LIMIT,
  truncateTextField,
  type TranscriptRecord,
} from "../transcript.js";
import { safePathSegment, transcriptFilePath } from "../transcript-paths.js";
import type {
  ChannelAdapter,
  ChannelSendContext,
  ChannelSendResult,
  GatewayConfig,
  GatewayInboundEnvelope,
  GatewayInboundMessage,
  RuntimeAdapter,
  RuntimeRunOptions,
  RuntimeRunResult,
} from "../types.js";
import type { GatewayLogger } from "../log.js";

function silentLogger(): GatewayLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

class FakeChannel implements ChannelAdapter {
  readonly id = "botcord";
  readonly type = "fake";
  readonly sends: ChannelSendContext[] = [];
  sendImpl?: (ctx: ChannelSendContext) => Promise<ChannelSendResult> | ChannelSendResult;
  async start(): Promise<void> {}
  async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
    this.sends.push(ctx);
    if (this.sendImpl) return this.sendImpl(ctx);
    return {};
  }
}

class FakeTelegramChannel extends FakeChannel {
  override readonly id = "gw_telegram_test";
  override readonly type = "telegram";
}

interface FakeRuntimeOptions {
  reply?: string;
  newSessionId?: string;
  delayMs?: number;
  throwError?: Error | string;
  hang?: boolean;
}

class FakeRuntime implements RuntimeAdapter {
  readonly id = "claude-code";
  constructor(private readonly opts: FakeRuntimeOptions = {}) {}
  async run(options: RuntimeRunOptions): Promise<RuntimeRunResult> {
    if (this.opts.hang) {
      await new Promise<void>((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
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
    return {
      text: this.opts.reply ?? "hello",
      newSessionId: this.opts.newSessionId ?? "sid-1",
    };
  }
}

function makeMessage(p: Partial<GatewayInboundMessage> = {}): GatewayInboundMessage {
  return {
    id: p.id ?? "msg_1",
    channel: p.channel ?? "botcord",
    accountId: p.accountId ?? "ag_me",
    conversation: p.conversation ?? { id: "rm_oc_1", kind: "direct" },
    sender: p.sender ?? { id: "ag_peer", kind: "user", name: "peer" },
    text: p.text ?? "hello",
    raw: p.raw ?? {},
    replyTo: null,
    receivedAt: Date.now(),
    trace: p.trace,
  };
}

function makeEnvelope(p: Partial<GatewayInboundMessage> = {}): GatewayInboundEnvelope {
  return { message: makeMessage(p) };
}

function baseConfig(): GatewayConfig {
  return {
    channels: [{ id: "botcord", type: "botcord", accountId: "ag_me" }],
    defaultRoute: { runtime: "claude-code", cwd: "/tmp/default" },
    routes: [],
  };
}

async function readRecords(file: string): Promise<TranscriptRecord[]> {
  if (!existsSync(file)) return [];
  const data = await readFile(file, "utf8");
  return data
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TranscriptRecord);
}

interface Scaffold {
  dispatcher: Dispatcher;
  channel: FakeChannel;
  store: SessionStore;
  rootDir: string;
  recordsForRoom: (roomId: string, topicId?: string | null) => Promise<TranscriptRecord[]>;
  cleanup: () => Promise<void>;
}

async function scaffold(opts: {
  runtimeFactory?: RuntimeFactory;
  turnTimeoutMs?: number;
  attentionGate?: (msg: GatewayInboundMessage) => boolean | Promise<boolean>;
  composeUserTurn?: (msg: GatewayInboundMessage) => string;
  channel?: FakeChannel;
  agentId?: string;
} = {}): Promise<Scaffold> {
  const tmp = await mkdtemp(path.join(tmpdir(), "transcript-test-"));
  const sessionsPath = path.join(tmp, "sessions.json");
  const store = new SessionStore({ path: sessionsPath });
  await store.load();
  const rootDir = path.join(tmp, "agents");
  const channel = opts.channel ?? new FakeChannel();
  const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
  const transcript = createTranscriptWriter({ rootDir, log: silentLogger(), enabled: true });
  const dispatcher = new Dispatcher({
    config: baseConfig(),
    channels,
    runtime: opts.runtimeFactory ?? (() => new FakeRuntime()),
    sessionStore: store,
    log: silentLogger(),
    turnTimeoutMs: opts.turnTimeoutMs,
    attentionGate: opts.attentionGate,
    composeUserTurn: opts.composeUserTurn,
    transcript,
  });
  return {
    dispatcher,
    channel,
    store,
    rootDir,
    recordsForRoom: async (roomId: string, topicId: string | null = null) => {
      const file = transcriptFilePath(rootDir, opts.agentId ?? "ag_me", roomId, topicId);
      return readRecords(file);
    },
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

describe("safePathSegment", () => {
  it("fast path for plain ids", () => {
    expect(safePathSegment("rm_abc-123")).toBe("rm_abc-123");
    expect(safePathSegment("ag_01HXYZ")).toBe("ag_01HXYZ");
  });

  it("invalid → _invalid_<sha256-8>", () => {
    const dot = safePathSegment("..");
    expect(dot).toMatch(/^_invalid_[0-9a-f]{8}$/);
    expect(safePathSegment(".")).toMatch(/^_invalid_[0-9a-f]{8}$/);
    expect(safePathSegment("")).toMatch(/^_invalid_[0-9a-f]{8}$/);
    // Different inputs hash to different files.
    expect(safePathSegment("..")).not.toBe(safePathSegment("."));
  });

  it("Windows reserved names take precedence over fast path", () => {
    expect(safePathSegment("CON")).toBe("_win_CON");
    expect(safePathSegment("con")).toBe("_win_con");
    expect(safePathSegment("COM1")).toBe("_win_COM1");
    expect(safePathSegment("LPT9")).toBe("_win_LPT9");
  });

  it("escapes path-bearing chars but keeps `%` literal", () => {
    expect(safePathSegment("rm/with/slash")).toBe("rm%2Fwith%2Fslash");
    // `a..b` falls out of fast path (`.` is not whitelisted) so dots get encoded.
    expect(safePathSegment("a..b")).toBe("a%2E%2Eb");
    // `%` itself is preserved literally.
    expect(safePathSegment("100%pure")).toBe("100%pure");
  });

  it("truncates long escaped names without splitting %XX", () => {
    const long = "%".repeat(0) + "a/".repeat(150); // long enough to need truncation after escape
    const s = safePathSegment(long);
    expect(s.length).toBeLessThanOrEqual(200);
    // Ensure the result does not end mid-`%XX` (last 3 chars are either non-`%` block or `_<hash>`).
    expect(s).toMatch(/_[0-9a-f]{8}$/);
  });

  it("different long inputs sharing prefix get different hashes", () => {
    const a = "/".repeat(150) + "tail-A";
    const b = "/".repeat(150) + "tail-B";
    const sa = safePathSegment(a);
    const sb = safePathSegment(b);
    expect(sa).not.toBe(sb);
    expect(sa.length).toBeLessThanOrEqual(200);
    expect(sb.length).toBeLessThanOrEqual(200);
  });
});

describe("resolveTranscriptEnabled", () => {
  it("env=1 forces on", () => {
    expect(resolveTranscriptEnabled("1", false)).toBe(true);
    expect(resolveTranscriptEnabled("1", true)).toBe(true);
  });
  it("env=0 forces off", () => {
    expect(resolveTranscriptEnabled("0", true)).toBe(false);
    expect(resolveTranscriptEnabled("0", false)).toBe(false);
  });
  it("unset / other strings fall through to config", () => {
    expect(resolveTranscriptEnabled(undefined, true)).toBe(true);
    expect(resolveTranscriptEnabled(undefined, false)).toBe(false);
    expect(resolveTranscriptEnabled("yes", true)).toBe(true);
    expect(resolveTranscriptEnabled("yes", false)).toBe(false);
  });
  it("defaults on when env and config are both unset", () => {
    expect(resolveTranscriptEnabled(undefined, undefined)).toBe(true);
    expect(resolveTranscriptEnabled("yes", undefined)).toBe(true);
  });
});

describe("truncateTextField", () => {
  it("passes through short text", () => {
    const r = truncateTextField("hi");
    expect(r.text).toBe("hi");
    expect(r.truncated).toBe(false);
  });
  it("truncates oversize", () => {
    const big = "a".repeat(TRANSCRIPT_TEXT_LIMIT + 100);
    const r = truncateTextField(big);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(TRANSCRIPT_TEXT_LIMIT);
  });
});

describe("Dispatcher transcript integration", () => {
  let cleanups: Array<() => Promise<void>>;
  beforeEach(() => {
    cleanups = [];
  });
  afterEach(async () => {
    for (const c of cleanups) await c();
  });

  function track(s: Scaffold): Scaffold {
    cleanups.push(s.cleanup);
    return s;
  }

  it("happy path: inbound + dispatched + outbound{delivered}, all share turnId", async () => {
    const s = track(await scaffold({ runtimeFactory: () => new FakeRuntime({ reply: "ok" }) }));
    await s.dispatcher.handle(makeEnvelope({ conversation: { id: "rm_oc_1", kind: "direct" } }));
    const recs = await s.recordsForRoom("rm_oc_1");
    expect(recs.map((r) => r.kind)).toEqual(["inbound", "dispatched", "outbound"]);
    expect(new Set(recs.map((r) => r.turnId)).size).toBe(1);
    const out = recs[2] as Extract<TranscriptRecord, { kind: "outbound" }>;
    expect(out.deliveryStatus).toBe("delivered");
    expect(out.finalText).toBe("ok");
  });

  it("non-owner-chat: outbound{gated_non_owner_chat}, channel never sends", async () => {
    const s = track(await scaffold({ runtimeFactory: () => new FakeRuntime({ reply: "ok" }) }));
    await s.dispatcher.handle(
      makeEnvelope({ conversation: { id: "rm_normal", kind: "group" } }),
    );
    const recs = await s.recordsForRoom("rm_normal");
    const out = recs.find((r) => r.kind === "outbound") as Extract<TranscriptRecord, { kind: "outbound" }>;
    expect(out.deliveryStatus).toBe("gated_non_owner_chat");
    expect(s.channel.sends.length).toBe(0);
  });

  it("third-party direct chat: runtime text is delivered", async () => {
    const channel = new FakeTelegramChannel();
    const s = track(await scaffold({
      runtimeFactory: () => new FakeRuntime({ reply: "ok" }),
      channel,
    }));
    await s.dispatcher.handle(
      makeEnvelope({
        channel: "gw_telegram_test",
        conversation: { id: "telegram:user:7904063707", kind: "direct" },
        sender: { id: "telegram:user:7904063707", kind: "user", name: "danny_aaas" },
      }),
    );
    const recs = await s.recordsForRoom("telegram:user:7904063707");
    const out = recs.find((r) => r.kind === "outbound") as Extract<TranscriptRecord, { kind: "outbound" }>;
    expect(out.deliveryStatus).toBe("delivered");
    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0].message.conversationId).toBe("telegram:user:7904063707");
  });

  it("dashboard_user_chat raw.source_type → delivered even outside rm_oc_", async () => {
    const s = track(await scaffold({ runtimeFactory: () => new FakeRuntime({ reply: "yo" }) }));
    await s.dispatcher.handle(
      makeEnvelope({
        conversation: { id: "rm_dash", kind: "direct" },
        raw: { source_type: "dashboard_user_chat" },
      }),
    );
    const recs = await s.recordsForRoom("rm_dash");
    const out = recs.find((r) => r.kind === "outbound") as Extract<TranscriptRecord, { kind: "outbound" }>;
    expect(out.deliveryStatus).toBe("delivered");
  });

  it("empty runtime text → outbound{empty_text}", async () => {
    const s = track(await scaffold({ runtimeFactory: () => new FakeRuntime({ reply: "   " }) }));
    await s.dispatcher.handle(makeEnvelope());
    const recs = await s.recordsForRoom("rm_oc_1");
    const out = recs.find((r) => r.kind === "outbound") as Extract<TranscriptRecord, { kind: "outbound" }>;
    expect(out.deliveryStatus).toBe("empty_text");
    expect(s.channel.sends.length).toBe(0);
  });

  it("channel.send throws → outbound{send_failed} with deliveryReason", async () => {
    const channel = new FakeChannel();
    channel.sendImpl = () => {
      throw new Error("boom");
    };
    const s = track(await scaffold({
      runtimeFactory: () => new FakeRuntime({ reply: "ok" }),
      channel,
    }));
    await s.dispatcher.handle(makeEnvelope());
    const recs = await s.recordsForRoom("rm_oc_1");
    const out = recs.find((r) => r.kind === "outbound") as Extract<TranscriptRecord, { kind: "outbound" }>;
    expect(out.deliveryStatus).toBe("send_failed");
    expect(out.deliveryReason).toBe("boom");
  });

  it("runtime throws → turn_error{phase:runtime}, no outbound", async () => {
    const s = track(await scaffold({
      runtimeFactory: () => new FakeRuntime({ throwError: "kaboom" }),
    }));
    await s.dispatcher.handle(makeEnvelope());
    const recs = await s.recordsForRoom("rm_oc_1");
    const kinds = recs.map((r) => r.kind);
    expect(kinds).toContain("turn_error");
    expect(kinds).not.toContain("outbound");
    const err = recs.find((r) => r.kind === "turn_error") as Extract<TranscriptRecord, { kind: "turn_error" }>;
    expect(err.phase).toBe("runtime");
    expect(err.error).toBe("kaboom");
  });

  it("attention gate false → inbound + attention_skipped only", async () => {
    const s = track(await scaffold({ attentionGate: () => false }));
    await s.dispatcher.handle(makeEnvelope());
    const recs = await s.recordsForRoom("rm_oc_1");
    expect(recs.map((r) => r.kind)).toEqual(["inbound", "attention_skipped"]);
    expect(new Set(recs.map((r) => r.turnId)).size).toBe(1);
  });

  it("compose_failed (cancel-previous mode) emits non-terminal record then proceeds", async () => {
    const s = track(await scaffold({
      composeUserTurn: () => {
        throw new Error("compose boom");
      },
      runtimeFactory: () => new FakeRuntime({ reply: "ok" }),
    }));
    await s.dispatcher.handle(makeEnvelope({ conversation: { id: "rm_oc_1", kind: "direct" } }));
    const recs = await s.recordsForRoom("rm_oc_1");
    expect(recs.map((r) => r.kind)).toEqual([
      "inbound",
      "compose_failed",
      "dispatched",
      "outbound",
    ]);
  });

  it("pre-skip branches do not write any record", async () => {
    const s = track(await scaffold());
    // empty text
    await s.dispatcher.handle(makeEnvelope({ text: "   " }));
    // own-agent echo
    await s.dispatcher.handle(makeEnvelope({ sender: { id: "ag_me", kind: "agent" } }));
    const recs = await s.recordsForRoom("rm_oc_1");
    expect(recs).toEqual([]);
  });

  it("text/finalText truncation marks truncated.<field>", async () => {
    const big = "X".repeat(TRANSCRIPT_TEXT_LIMIT + 50);
    const s = track(await scaffold({
      runtimeFactory: () => new FakeRuntime({ reply: big }),
    }));
    await s.dispatcher.handle(makeEnvelope({ text: big }));
    const recs = await s.recordsForRoom("rm_oc_1");
    const inbound = recs[0] as Extract<TranscriptRecord, { kind: "inbound" }>;
    expect(inbound.truncated?.text).toBe(true);
    expect(inbound.text.length).toBe(TRANSCRIPT_TEXT_LIMIT);
    const outbound = recs[recs.length - 1] as Extract<TranscriptRecord, { kind: "outbound" }>;
    expect(outbound.truncated?.finalText).toBe(true);
  });

  it("sender kind variants serialize correctly", async () => {
    for (const kind of ["user", "agent", "system"] as const) {
      const s = track(await scaffold({
        runtimeFactory: () => new FakeRuntime({ reply: "ok" }),
      }));
      // for kind=agent we need a peer id to avoid own-echo skip
      await s.dispatcher.handle(
        makeEnvelope({ sender: { id: "ag_other", kind, name: "Bob" } }),
      );
      const recs = await s.recordsForRoom("rm_oc_1");
      const inbound = recs[0] as Extract<TranscriptRecord, { kind: "inbound" }>;
      expect(inbound.sender.kind).toBe(kind);
      expect(inbound.sender.name).toBe("Bob");
    }
  });

  it("file rotation when crossing maxFileBytes", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "transcript-rotate-"));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    const writer = createTranscriptWriter({
      rootDir: tmp,
      log: silentLogger(),
      enabled: true,
      maxFileBytes: 200, // tiny
    });
    const base = {
      ts: new Date().toISOString(),
      turnId: "tn_x",
      agentId: "ag_me",
      roomId: "rm_x",
      topicId: null,
    } as const;
    for (let i = 0; i < 10; i++) {
      writer.write({
        ...base,
        kind: "attention_skipped",
        reason: "padding-" + i + "-" + "z".repeat(40),
      });
    }
    const dir = path.join(tmp, "ag_me", "transcripts", "rm_x");
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(dir);
    // Should be at least one rotated (.YYYYMMDD-HHMMSS.jsonl) plus active
    expect(files.length).toBeGreaterThan(1);
    expect(files.some((f) => /_default\.\d{8}-\d{6}\.jsonl$/.test(f))).toBe(true);
    expect(files).toContain("_default.jsonl");
  });

  it("cleans transcript files older than the retention window", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "transcript-clean-"));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    const oldFile = transcriptFilePath(tmp, "ag_me", "rm_old", null);
    const freshFile = transcriptFilePath(tmp, "ag_me", "rm_fresh", null);
    await mkdir(path.dirname(oldFile), { recursive: true });
    await mkdir(path.dirname(freshFile), { recursive: true });
    await writeFile(oldFile, "{}\n", { mode: 0o600 });
    await writeFile(freshFile, "{}\n", { mode: 0o600 });
    const oldDate = new Date(Date.now() - TRANSCRIPT_RETENTION_MS - 60_000);
    utimesSync(oldFile, oldDate, oldDate);

    const removed = cleanupTranscriptFiles(tmp, Date.now() - TRANSCRIPT_RETENTION_MS);

    expect(removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  it("disabled writer does not create files", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "transcript-off-"));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    const writer = createTranscriptWriter({ rootDir: tmp, log: silentLogger(), enabled: false });
    expect(writer.enabled).toBe(false);
    writer.write({
      ts: new Date().toISOString(),
      kind: "attention_skipped",
      turnId: "tn_x",
      agentId: "ag_me",
      roomId: "rm_x",
      topicId: null,
      reason: "test",
    });
    expect(existsSync(path.join(tmp, "ag_me"))).toBe(false);
  });

  it("FsTranscriptWriter absorbs filesystem errors — turn still completes", async () => {
    // Point the writer at a path inside a regular file (mkdir will fail).
    const tmp = await mkdtemp(path.join(tmpdir(), "transcript-fail-"));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    const blocker = path.join(tmp, "blocker");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(blocker, "x");
    // rootDir below `blocker` (a file, not a dir) → mkdir/append fail every time.
    const writer = createTranscriptWriter({
      rootDir: path.join(blocker, "nope"),
      log: silentLogger(),
      enabled: true,
    });
    const sessionsPath = path.join(tmp, "sessions.json");
    const store = new SessionStore({ path: sessionsPath });
    await store.load();
    const channel = new FakeChannel();
    const channels = new Map<string, ChannelAdapter>([[channel.id, channel]]);
    const dispatcher = new Dispatcher({
      config: baseConfig(),
      channels,
      runtime: () => new FakeRuntime({ reply: "ok" }),
      sessionStore: store,
      log: silentLogger(),
      transcript: writer,
    });
    await expect(dispatcher.handle(makeEnvelope())).resolves.not.toThrow();
    expect(channel.sends.length).toBe(1);
  });

  it("CLI path helper resolves to the same file the writer used", async () => {
    const s = track(await scaffold({ runtimeFactory: () => new FakeRuntime({ reply: "ok" }) }));
    await s.dispatcher.handle(
      makeEnvelope({
        conversation: { id: "rm_oc_1", kind: "direct", threadId: "tp_ABC" },
      }),
    );
    const file = transcriptFilePath(s.rootDir, "ag_me", "rm_oc_1", "tp_ABC");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(0);
  });
});
