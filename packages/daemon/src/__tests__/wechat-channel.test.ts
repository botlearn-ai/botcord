import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWechatChannel } from "../gateway/channels/wechat.js";
import type {
  ChannelStartContext,
  GatewayInboundEnvelope,
  GatewayLogger,
} from "../gateway/types.js";
import type { FetchLike } from "../gateway/channels/wechat-http.js";

const SILENT_LOG: GatewayLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

interface StubResponse {
  status?: number;
  body: unknown;
}

/**
 * Build a fetch stub whose responses are matched by URL substring. Each
 * matcher returns either a single response or a queue (for `getupdates`,
 * which is called repeatedly).
 */
function buildFetchStub(
  matchers: Array<{
    match: string;
    respond: (
      callIdx: number,
      body: Record<string, unknown> | null,
    ) => StubResponse | Promise<StubResponse>;
  }>,
  calls: Array<{ url: string; body: Record<string, unknown> | null }>,
): FetchLike {
  const counters = new Map<string, number>();
  return async (url, init) => {
    let parsed: Record<string, unknown> | null = null;
    if (init?.body) {
      try {
        parsed = JSON.parse(init.body as string) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    calls.push({ url, body: parsed });
    for (const m of matchers) {
      if (url.includes(m.match)) {
        const idx = counters.get(m.match) ?? 0;
        counters.set(m.match, idx + 1);
        const resp = await m.respond(idx, parsed);
        const status = resp.status ?? 200;
        const text =
          typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
        return {
          status,
          ok: status >= 200 && status < 300,
          text: async () => text,
        };
      }
    }
    return { status: 404, ok: false, text: async () => "" };
  };
}

interface HarnessResult {
  envelopes: GatewayInboundEnvelope[];
  statusPatches: Array<Record<string, unknown>>;
  pollDone: Promise<void>;
  abort: () => void;
}

function startAdapter(
  adapter: ReturnType<typeof createWechatChannel>,
  opts: { stopAfterEnvelopes?: number; stopAfterMs?: number } = {},
): HarnessResult {
  const ctrl = new AbortController();
  const envelopes: GatewayInboundEnvelope[] = [];
  const statusPatches: Array<Record<string, unknown>> = [];
  const ctx: ChannelStartContext = {
    config: { channels: [], defaultRoute: { runtime: "claude-code", cwd: "/tmp" } },
    accountId: "ag_test",
    abortSignal: ctrl.signal,
    log: SILENT_LOG,
    emit: async (env) => {
      envelopes.push(env);
      if (
        opts.stopAfterEnvelopes !== undefined &&
        envelopes.length >= opts.stopAfterEnvelopes
      ) {
        ctrl.abort();
      }
    },
    setStatus: (patch) => {
      statusPatches.push({ ...patch });
    },
  };
  const pollDone = adapter.start(ctx) as Promise<void>;
  if (opts.stopAfterMs !== undefined) {
    setTimeout(() => ctrl.abort(), opts.stopAfterMs);
  }
  return { envelopes, statusPatches, pollDone, abort: () => ctrl.abort() };
}

describe("wechat channel adapter", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "wechat-ch-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("marks status error with reason missing_secret when bot token is unavailable", async () => {
    const fakeSecret = path.join(tmp, "no-such-secret.json");
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = buildFetchStub(
      [
        {
          match: "getupdates",
          respond: () => ({ body: { ret: 0, get_updates_buf: "buf-1", msgs: [] } }),
        },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_1",
      accountId: "ag_test",
      secretFile: fakeSecret,
      stateFile: path.join(tmp, "state.json"),
      fetchImpl,
      stateDebounceMs: 0,
      allowedSenderIds: ["alice@im.wechat"],
    });
    const h = startAdapter(adapter);
    await h.pollDone;
    expect(h.statusPatches.some((p) => p.lastError === "missing_secret")).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("normalizes a message_type=1 inbound and persists get_updates_buf cursor", async () => {
    const stateFile = path.join(tmp, "state.json");
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = buildFetchStub(
      [
        {
          match: "getupdates",
          respond: (idx) => {
            if (idx === 0) {
              return {
                body: {
                  ret: 0,
                  get_updates_buf: "cursor-after-1",
                  msgs: [
                    {
                      message_type: 1,
                      from_user_id: "alice@im.wechat",
                      context_token: "ctx-aaa",
                      client_id: "wechat-client-1",
                      item_list: [{ type: 1, text_item: { text: "hello world" } }],
                    },
                  ],
                },
              };
            }
            // Subsequent polls: empty so the loop just keeps spinning until abort.
            return { body: { ret: 0, get_updates_buf: "cursor-after-1", msgs: [] } };
          },
        },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_1",
      accountId: "ag_test",
      botToken: "tok-123",
      stateFile,
      fetchImpl,
      stateDebounceMs: 0,
      allowedSenderIds: ["alice@im.wechat"],
    });
    const h = startAdapter(adapter, { stopAfterEnvelopes: 1 });
    await h.pollDone;

    expect(h.envelopes).toHaveLength(1);
    const env = h.envelopes[0]!;
    expect(env.message.id).toBe("wechat-client-1");
    expect(env.message.conversation).toEqual({
      id: "wechat:user:alice@im.wechat",
      kind: "direct",
    });
    expect(env.message.sender).toEqual({
      id: "alice@im.wechat",
      kind: "user",
    });
    expect(env.message.text).toBe("hello world");
    expect(env.message.trace?.id).toMatch(/^wechat:alice@im\.wechat:\d+:/);

    // Cursor on disk reflects the buf returned by the first poll.
    const stateRaw = (await import("node:fs")).readFileSync(stateFile, "utf8");
    expect(JSON.parse(stateRaw).cursor).toBe("cursor-after-1");
  });

  it("drops messages missing context_token", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = buildFetchStub(
      [
        {
          match: "getupdates",
          respond: (idx) => {
            if (idx === 0) {
              return {
                body: {
                  ret: 0,
                  get_updates_buf: "c",
                  msgs: [
                    {
                      message_type: 1,
                      from_user_id: "alice@im.wechat",
                      // no context_token
                      item_list: [{ type: 1, text_item: { text: "hi" } }],
                    },
                  ],
                },
              };
            }
            return { body: { ret: 0, get_updates_buf: "c", msgs: [] } };
          },
        },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_2",
      accountId: "ag_test",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      fetchImpl,
      stateDebounceMs: 0,
      allowedSenderIds: ["alice@im.wechat"],
    });
    const h = startAdapter(adapter, { stopAfterMs: 50 });
    await h.pollDone;
    expect(h.envelopes).toHaveLength(0);
  });

  it("drops messages from senders not in allowedSenderIds (default-deny)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = buildFetchStub(
      [
        {
          match: "getupdates",
          respond: (idx) => {
            if (idx === 0) {
              return {
                body: {
                  ret: 0,
                  get_updates_buf: "c",
                  msgs: [
                    {
                      message_type: 1,
                      from_user_id: "stranger@im.wechat",
                      context_token: "ctx",
                      item_list: [{ type: 1, text_item: { text: "hi" } }],
                    },
                  ],
                },
              };
            }
            return { body: { ret: 0, get_updates_buf: "c", msgs: [] } };
          },
        },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_3",
      accountId: "ag_test",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      fetchImpl,
      stateDebounceMs: 0,
      // empty allowlist -> default deny
      allowedSenderIds: [],
    });
    const h = startAdapter(adapter, { stopAfterMs: 50 });
    await h.pollDone;
    expect(h.envelopes).toHaveLength(0);
  });

  it("send() echoes the inbound context_token bound to the trace id", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = buildFetchStub(
      [
        {
          match: "getupdates",
          respond: (idx) => {
            if (idx === 0) {
              return {
                body: {
                  ret: 0,
                  get_updates_buf: "c",
                  msgs: [
                    {
                      message_type: 1,
                      from_user_id: "alice@im.wechat",
                      context_token: "ctx-XYZ",
                      item_list: [{ type: 1, text_item: { text: "ping" } }],
                    },
                  ],
                },
              };
            }
            return { body: { ret: 0, get_updates_buf: "c", msgs: [] } };
          },
        },
        {
          match: "sendmessage",
          respond: () => ({ body: { ret: 0 } }),
        },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_send",
      accountId: "ag_test",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      fetchImpl,
      stateDebounceMs: 0,
      allowedSenderIds: ["alice@im.wechat"],
    });
    const h = startAdapter(adapter, { stopAfterEnvelopes: 1 });
    await h.pollDone;
    const trace = h.envelopes[0]!.message.trace!;
    const sendResult = await adapter.send({
      log: SILENT_LOG,
      message: {
        channel: "gw_wx_send",
        accountId: "ag_test",
        conversationId: "wechat:user:alice@im.wechat",
        text: "pong",
        traceId: trace.id,
      },
    });
    expect(sendResult.providerMessageId).toMatch(/^botcord-/);
    const sendCall = calls.find((c) => c.url.includes("sendmessage"));
    expect(sendCall).toBeDefined();
    const msg = (sendCall!.body!.msg as Record<string, unknown>) ?? {};
    expect(msg.context_token).toBe("ctx-XYZ");
    expect(msg.to_user_id).toBe("alice@im.wechat");
    expect(msg.message_type).toBe(2);
    const itemList = msg.item_list as Array<Record<string, unknown>>;
    expect((itemList[0]!.text_item as Record<string, unknown>).text).toBe("pong");
    // base_info injected centrally
    expect(sendCall!.body!.base_info).toEqual({ channel_version: "1.0.2" });
  });

  it("send() rejects when traceId is missing or unknown — no conversation-level fallback", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = buildFetchStub(
      [
        {
          match: "sendmessage",
          respond: () => ({ body: { ret: 0 } }),
        },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_send2",
      accountId: "ag_test",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      fetchImpl,
      stateDebounceMs: 0,
      allowedSenderIds: ["alice@im.wechat"],
    });
    await expect(
      adapter.send({
        log: SILENT_LOG,
        message: {
          channel: "gw_wx_send2",
          accountId: "ag_test",
          conversationId: "wechat:user:alice@im.wechat",
          text: "should fail",
          traceId: null,
        },
      }),
    ).rejects.toThrow(/no context_token/);
    await expect(
      adapter.send({
        log: SILENT_LOG,
        message: {
          channel: "gw_wx_send2",
          accountId: "ag_test",
          conversationId: "wechat:user:alice@im.wechat",
          text: "still no",
          traceId: "unknown-trace",
        },
      }),
    ).rejects.toThrow(/no context_token/);
    expect(calls.find((c) => c.url.includes("sendmessage"))).toBeUndefined();
  });

  it("send() splits long replies into chunks <= splitAt, preferring newline boundaries", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = buildFetchStub(
      [
        {
          match: "getupdates",
          respond: (idx) => {
            if (idx === 0) {
              return {
                body: {
                  ret: 0,
                  get_updates_buf: "c",
                  msgs: [
                    {
                      message_type: 1,
                      from_user_id: "alice@im.wechat",
                      context_token: "ctx-1",
                      item_list: [{ type: 1, text_item: { text: "go" } }],
                    },
                  ],
                },
              };
            }
            return { body: { ret: 0, get_updates_buf: "c", msgs: [] } };
          },
        },
        { match: "sendmessage", respond: () => ({ body: { ret: 0 } }) },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_split",
      accountId: "ag_test",
      botToken: "tok",
      splitAt: 50,
      stateFile: path.join(tmp, "state.json"),
      fetchImpl,
      stateDebounceMs: 0,
      allowedSenderIds: ["alice@im.wechat"],
    });
    const h = startAdapter(adapter, { stopAfterEnvelopes: 1 });
    await h.pollDone;
    const traceId = h.envelopes[0]!.message.trace!.id;

    const part1 = "a".repeat(40);
    const part2 = "b".repeat(40);
    const text = `${part1}\n${part2}`;
    await adapter.send({
      log: SILENT_LOG,
      message: {
        channel: "gw_wx_split",
        accountId: "ag_test",
        conversationId: "wechat:user:alice@im.wechat",
        text,
        traceId,
      },
    });
    const sendCalls = calls.filter((c) => c.url.includes("sendmessage"));
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of sendCalls) {
      const m = c.body!.msg as Record<string, unknown>;
      const items = m.item_list as Array<Record<string, unknown>>;
      const t = (items[0]!.text_item as Record<string, unknown>).text as string;
      expect(t.length).toBeLessThanOrEqual(50);
    }
  });

  it("typing() caches the typing_ticket from getconfig and reuses it on the next call", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    let configCalls = 0;
    const fetchImpl = buildFetchStub(
      [
        {
          match: "getupdates",
          respond: (idx) => {
            if (idx === 0) {
              return {
                body: {
                  ret: 0,
                  get_updates_buf: "c",
                  msgs: [
                    {
                      message_type: 1,
                      from_user_id: "alice@im.wechat",
                      context_token: "ctx-1",
                      item_list: [{ type: 1, text_item: { text: "go" } }],
                    },
                  ],
                },
              };
            }
            return { body: { ret: 0, get_updates_buf: "c", msgs: [] } };
          },
        },
        {
          match: "getconfig",
          respond: () => {
            configCalls += 1;
            return { body: { ret: 0, typing_ticket: "ticket-zzz" } };
          },
        },
        { match: "sendtyping", respond: () => ({ body: { ret: 0 } }) },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_typing",
      accountId: "ag_test",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      fetchImpl,
      stateDebounceMs: 0,
      allowedSenderIds: ["alice@im.wechat"],
    });
    const h = startAdapter(adapter, { stopAfterEnvelopes: 1 });
    await h.pollDone;
    const traceId = h.envelopes[0]!.message.trace!.id;

    await adapter.typing!({
      traceId,
      accountId: "ag_test",
      conversationId: "wechat:user:alice@im.wechat",
      log: SILENT_LOG,
    });
    await adapter.typing!({
      traceId,
      accountId: "ag_test",
      conversationId: "wechat:user:alice@im.wechat",
      log: SILENT_LOG,
    });

    expect(configCalls).toBe(1);
    const sendTypingCalls = calls.filter((c) => c.url.includes("sendtyping"));
    expect(sendTypingCalls.length).toBe(2);
    for (const c of sendTypingCalls) {
      expect(c.body!.typing_ticket).toBe("ticket-zzz");
      expect(c.body!.ilink_user_id).toBe("alice@im.wechat");
      expect(c.body!.status).toBe(1);
    }
  });

  it("sets provider=wechat and updates lastPollAt / lastInboundAt / lastSendAt / authorized in status", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = buildFetchStub(
      [
        {
          match: "getupdates",
          respond: (idx) => {
            if (idx === 0) {
              return {
                body: {
                  ret: 0,
                  get_updates_buf: "c",
                  msgs: [
                    {
                      message_type: 1,
                      from_user_id: "alice@im.wechat",
                      context_token: "ctx-1",
                      item_list: [{ type: 1, text_item: { text: "hi" } }],
                    },
                  ],
                },
              };
            }
            return { body: { ret: 0, get_updates_buf: "c", msgs: [] } };
          },
        },
        { match: "sendmessage", respond: () => ({ body: { ret: 0 } }) },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_status",
      accountId: "ag_test",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      fetchImpl,
      stateDebounceMs: 0,
      allowedSenderIds: ["alice@im.wechat"],
    });
    const h = startAdapter(adapter, { stopAfterEnvelopes: 1 });
    await h.pollDone;
    const traceId = h.envelopes[0]!.message.trace!.id;
    await adapter.send({
      log: SILENT_LOG,
      message: {
        channel: "gw_wx_status",
        accountId: "ag_test",
        conversationId: "wechat:user:alice@im.wechat",
        text: "ack",
        traceId,
      },
    });
    const snap = adapter.status!();
    expect(snap.provider).toBe("wechat");
    expect(snap.authorized).toBe(true);
    expect(typeof snap.lastPollAt).toBe("number");
    expect(typeof snap.lastInboundAt).toBe("number");
    expect(typeof snap.lastSendAt).toBe("number");
  });

  it("send() honors a 30-minute trace TTL — expired traces are rejected", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    let nowMs = 1_000_000;
    const fetchImpl = buildFetchStub(
      [
        {
          match: "getupdates",
          respond: (idx) => {
            if (idx === 0) {
              return {
                body: {
                  ret: 0,
                  get_updates_buf: "c",
                  msgs: [
                    {
                      message_type: 1,
                      from_user_id: "alice@im.wechat",
                      context_token: "ctx",
                      item_list: [{ type: 1, text_item: { text: "hi" } }],
                    },
                  ],
                },
              };
            }
            return { body: { ret: 0, get_updates_buf: "c", msgs: [] } };
          },
        },
      ],
      calls,
    );
    const adapter = createWechatChannel({
      id: "gw_wx_ttl",
      accountId: "ag_test",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      fetchImpl,
      stateDebounceMs: 0,
      allowedSenderIds: ["alice@im.wechat"],
      now: () => nowMs,
    });
    const h = startAdapter(adapter, { stopAfterEnvelopes: 1 });
    await h.pollDone;
    const traceId = h.envelopes[0]!.message.trace!.id;
    // Advance well past the 30-minute TTL.
    nowMs += 31 * 60 * 1000;
    await expect(
      adapter.send({
        log: SILENT_LOG,
        message: {
          channel: "gw_wx_ttl",
          accountId: "ag_test",
          conversationId: "wechat:user:alice@im.wechat",
          text: "late",
          traceId,
        },
      }),
    ).rejects.toThrow(/no context_token/);
  });
});

// vi import kept available for future per-test mocking; nothing to do here.
void vi;
