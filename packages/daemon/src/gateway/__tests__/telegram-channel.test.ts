import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTelegramChannel } from "../channels/telegram.js";
import type { ChannelStartContext, GatewayInboundEnvelope } from "../types.js";
import type { GatewayLogger } from "../log.js";

const silentLog: GatewayLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const stubConfig = {
  channels: [],
  defaultRoute: { runtime: "claude-code", cwd: "/tmp" },
};

interface FetchCall {
  url: string;
  body: unknown;
}

function makeFetchScript(
  responses: Array<{ ok: boolean; result?: unknown; description?: string }>,
  calls: FetchCall[],
  onAfterUpdates?: () => void,
): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const r = responses[i] ?? { ok: true, result: [] };
    i += 1;
    if (url.includes("/getUpdates") && i === 1 && onAfterUpdates) {
      // Fire the abort callback after returning the seeded updates so the
      // poll loop exits before the next iteration.
      queueMicrotask(onAfterUpdates);
    }
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function makeStartCtx(opts: {
  abort: AbortController;
  emit?: (env: GatewayInboundEnvelope) => Promise<void>;
}): {
  ctx: ChannelStartContext;
  emits: GatewayInboundEnvelope[];
  statuses: Array<Record<string, unknown>>;
} {
  const emits: GatewayInboundEnvelope[] = [];
  const statuses: Array<Record<string, unknown>> = [];
  const ctx: ChannelStartContext = {
    config: stubConfig,
    accountId: "ag_self",
    abortSignal: opts.abort.signal,
    log: silentLog,
    emit:
      opts.emit ??
      (async (env) => {
        emits.push(env);
      }),
    setStatus: (patch) => {
      statuses.push(patch);
    },
  };
  return { ctx, emits, statuses };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "tg-channel-"));
});
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("createTelegramChannel — start()", () => {
  it("marks status error with reason missing_secret when no token is available", async () => {
    const calls: FetchCall[] = [];
    const channel = createTelegramChannel({
      id: "gw_tg_x",
      accountId: "ag_self",
      // No botToken, no allowed* — and a secretFile pointing at a non-existent path.
      secretFile: path.join(tmp, "missing-secret.json"),
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript([], calls),
    });
    const abort = new AbortController();
    const { ctx, statuses } = makeStartCtx({ abort });
    await channel.start(ctx);
    expect(calls).toHaveLength(0);
    const lastErrorPatch = statuses.find((s) => s.lastError === "missing_secret");
    expect(lastErrorPatch).toBeDefined();
  });

  it("normalizes a private text update from an allowed sender/chat", async () => {
    const calls: FetchCall[] = [];
    const update = {
      update_id: 100,
      message: {
        message_id: 7,
        from: { id: 42, username: "alice", first_name: "Alice" },
        chat: { id: 42, type: "private" as const },
        text: "hello world",
      },
    };
    const abort = new AbortController();
    const channel = createTelegramChannel({
      id: "gw_tg_a",
      accountId: "ag_self",
      botToken: "tok",
      allowedSenderIds: ["42"],
      allowedChatIds: ["42"],
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript(
        [{ ok: true, result: [update] }],
        calls,
        () => abort.abort(),
      ),
    });
    const { ctx, emits } = makeStartCtx({ abort });
    await channel.start(ctx);
    expect(emits).toHaveLength(1);
    const msg = emits[0]!.message;
    expect(msg.id).toBe("telegram:42:7");
    expect(msg.conversation.id).toBe("telegram:user:42");
    expect(msg.conversation.kind).toBe("direct");
    expect(msg.sender.id).toBe("telegram:user:42");
    expect(msg.sender.kind).toBe("user");
    expect(msg.text).toBe("hello world");
    expect(msg.accountId).toBe("ag_self");
    expect(msg.channel).toBe("gw_tg_a");
    expect(msg.trace).toEqual({ id: "telegram:42:7", streamable: true });
  });

  it("uses telegram:group:<id> for non-private chats", async () => {
    const calls: FetchCall[] = [];
    const update = {
      update_id: 5,
      message: {
        message_id: 3,
        from: { id: 99, first_name: "Bob" },
        chat: { id: -1001, type: "supergroup" as const, title: "Team" },
        text: "yo",
      },
    };
    const abort = new AbortController();
    const channel = createTelegramChannel({
      id: "gw_tg_g",
      accountId: "ag_self",
      botToken: "tok",
      allowedSenderIds: ["99"],
      allowedChatIds: ["-1001"],
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript(
        [{ ok: true, result: [update] }],
        calls,
        () => abort.abort(),
      ),
    });
    const { ctx, emits } = makeStartCtx({ abort });
    await channel.start(ctx);
    expect(emits).toHaveLength(1);
    expect(emits[0]!.message.conversation.id).toBe("telegram:group:-1001");
    expect(emits[0]!.message.conversation.kind).toBe("group");
  });

  it("default-denies inbound when allowed lists are empty", async () => {
    const calls: FetchCall[] = [];
    const update = {
      update_id: 9,
      message: {
        message_id: 1,
        from: { id: 1 },
        chat: { id: 1, type: "private" as const },
        text: "spam",
      },
    };
    const abort = new AbortController();
    const channel = createTelegramChannel({
      id: "gw_tg_deny",
      accountId: "ag_self",
      botToken: "tok",
      // No allowedSenderIds / allowedChatIds.
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript(
        [{ ok: true, result: [update] }],
        calls,
        () => abort.abort(),
      ),
    });
    const { ctx, emits } = makeStartCtx({ abort });
    await channel.start(ctx);
    expect(emits).toHaveLength(0);
  });

  it("drops a chat that is allowed by sender but not by chat (miss)", async () => {
    const calls: FetchCall[] = [];
    const update = {
      update_id: 9,
      message: {
        message_id: 1,
        from: { id: 1 },
        chat: { id: 2, type: "private" as const },
        text: "hi",
      },
    };
    const abort = new AbortController();
    const channel = createTelegramChannel({
      id: "gw_tg_miss",
      accountId: "ag_self",
      botToken: "tok",
      allowedSenderIds: ["1"],
      allowedChatIds: ["3"], // miss
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript(
        [{ ok: true, result: [update] }],
        calls,
        () => abort.abort(),
      ),
    });
    const { ctx, emits } = makeStartCtx({ abort });
    await channel.start(ctx);
    expect(emits).toHaveLength(0);
  });

  it("persists the next offset to the state file (no replay on restart)", async () => {
    const calls: FetchCall[] = [];
    const stateFile = path.join(tmp, "state.json");
    const update = {
      update_id: 250,
      message: {
        message_id: 7,
        from: { id: 1 },
        chat: { id: 1, type: "private" as const },
        text: "hi",
      },
    };
    const abort = new AbortController();
    const channel = createTelegramChannel({
      id: "gw_tg_state",
      accountId: "ag_self",
      botToken: "tok",
      allowedSenderIds: ["1"],
      allowedChatIds: ["1"],
      stateFile,
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript(
        [{ ok: true, result: [update] }],
        calls,
        () => abort.abort(),
      ),
    });
    const { ctx } = makeStartCtx({ abort });
    await channel.start(ctx);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(persisted.cursor).toBe("251");
  });

  it("calls getUpdates with the persisted offset on a fresh start", async () => {
    const stateFile = path.join(tmp, "state.json");
    // Seed the state file with a cursor.
    {
      const seed = createTelegramChannel({
        id: "gw_tg_seed",
        accountId: "ag_self",
        botToken: "tok",
        allowedSenderIds: ["1"],
        allowedChatIds: ["1"],
        stateFile,
        stateDebounceMs: 0,
        fetchImpl: makeFetchScript([], []),
      });
      // Reach into the stop() to flush — but easier: just use state-store directly.
      void seed; // unused
    }
    // Manually write a state file simulating prior cursor=999.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({ cursor: "999", updatedAt: new Date(0).toISOString() }),
    );

    const calls: FetchCall[] = [];
    const abort = new AbortController();
    const channel = createTelegramChannel({
      id: "gw_tg_restart",
      accountId: "ag_self",
      botToken: "tok",
      allowedSenderIds: ["1"],
      allowedChatIds: ["1"],
      stateFile,
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript(
        [{ ok: true, result: [] }],
        calls,
        () => abort.abort(),
      ),
    });
    const { ctx } = makeStartCtx({ abort });
    await channel.start(ctx);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as Record<string, unknown>).offset).toBe(999);
  });
});

describe("createTelegramChannel — send()", () => {
  it("posts to /sendMessage with the chat_id stripped from conversation.id", async () => {
    const calls: FetchCall[] = [];
    const channel = createTelegramChannel({
      id: "gw_tg_send",
      accountId: "ag_self",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript(
        [{ ok: true, result: { message_id: 17 } }],
        calls,
      ),
    });
    const result = await channel.send({
      message: {
        channel: "gw_tg_send",
        accountId: "ag_self",
        conversationId: "telegram:user:42",
        text: "hi back",
        threadId: null,
        replyTo: null,
        traceId: null,
      },
      log: silentLog,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/sendMessage");
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.chat_id).toBe("42");
    expect(body.text).toBe("hi back");
    expect(body.disable_web_page_preview).toBe(true);
    expect(result.providerMessageId).toBe("telegram:42:17");
  });

  it("splits long text and posts one /sendMessage per chunk", async () => {
    const calls: FetchCall[] = [];
    const channel = createTelegramChannel({
      id: "gw_tg_split",
      accountId: "ag_self",
      botToken: "tok",
      splitAt: 10,
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript(
        [
          { ok: true, result: { message_id: 1 } },
          { ok: true, result: { message_id: 2 } },
          { ok: true, result: { message_id: 3 } },
        ],
        calls,
      ),
    });
    await channel.send({
      message: {
        channel: "gw_tg_split",
        accountId: "ag_self",
        conversationId: "telegram:group:-100",
        text: "abcdefghij\nklmnopqrst\nuvwxyz",
        threadId: null,
        replyTo: null,
        traceId: null,
      },
      log: silentLog,
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      const body = c.body as Record<string, unknown>;
      expect(body.chat_id).toBe("-100");
      expect((body.text as string).length).toBeLessThanOrEqual(10);
    }
  });
});

describe("W1: cursor unchanged when emit throws", () => {
  it("leaves the on-disk cursor untouched when emit() throws on the first batch", { timeout: 5000 }, async () => {
    const stateFile = path.join(tmp, "state.json");
    const update = {
      update_id: 999,
      message: {
        message_id: 1,
        from: { id: 42, username: "alice" },
        chat: { id: 42, type: "private" as const },
        text: "boom",
      },
    };
    const calls: FetchCall[] = [];
    const abort = new AbortController();
    // Custom fetch: deliver the update once, then block on AbortSignal so
    // the poll loop doesn't hot-spin while we wait for the abort to fire.
    let delivered = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (!delivered) {
        delivered = true;
        return new Response(JSON.stringify({ ok: true, result: [update] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Second + later polls: abort and throw immediately so the loop exits.
      abort.abort();
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const channel = createTelegramChannel({
      id: "gw_tg_w1",
      accountId: "ag_self",
      botToken: "tok",
      stateFile,
      stateDebounceMs: 0,
      fetchImpl,
      allowedChatIds: ["42"],
      allowedSenderIds: ["42"],
    });
    let emitCalls = 0;
    const { ctx } = makeStartCtx({
      abort,
      emit: async () => {
        emitCalls += 1;
        throw new Error("emit boom");
      },
    });
    await channel.start(ctx);
    expect(emitCalls).toBeGreaterThanOrEqual(1);
    // No state file written (cursor never advanced) OR if written, cursor
    // must NOT be 1000 — proving the failed batch will retry.
    let cursor: string | undefined;
    try {
      cursor = JSON.parse(readFileSync(stateFile, "utf8")).cursor;
    } catch {
      cursor = undefined;
    }
    expect(cursor).not.toBe("1000");
  });
});

describe("W2: started guard", () => {
  it("calling start() a second time throws 'already started'", async () => {
    const calls: FetchCall[] = [];
    const abort = new AbortController();
    const channel = createTelegramChannel({
      id: "gw_tg_guard",
      accountId: "ag_self",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
      allowedChatIds: ["1"],
      allowedSenderIds: ["1"],
      fetchImpl: makeFetchScript([{ ok: true, result: [] }], calls),
    });
    const { ctx } = makeStartCtx({ abort });
    // First start — runs async; don't await yet.
    const first = channel.start(ctx);
    // Second start while first is in-flight.
    const secondAbort = new AbortController();
    const { ctx: ctx2 } = makeStartCtx({ abort: secondAbort });
    await expect(channel.start(ctx2)).rejects.toThrow("already started");
    abort.abort();
    await first;
  });
});

describe("C3: bot token redacted in error logs", () => {
  it("fetch error that includes the bot token is re-thrown with token replaced by ***", async () => {
    const SECRET_TOKEN = "1234567890:ABCDEFGHIJKLMNabcdefghijklmn";
    let caughtMessage = "";
    const fetchImpl = (async () => {
      const e = new Error(`network error: https://api.telegram.org/bot${SECRET_TOKEN}/getUpdates failed`);
      throw e;
    }) as unknown as typeof fetch;
    const abort = new AbortController();
    const channel = createTelegramChannel({
      id: "gw_tg_c3",
      accountId: "ag_self",
      botToken: SECRET_TOKEN,
      allowedChatIds: ["1"],
      allowedSenderIds: ["1"],
      stateFile: path.join(tmp, "state-c3.json"),
      stateDebounceMs: 0,
      fetchImpl,
    });
    const { ctx } = makeStartCtx({
      abort,
      emit: async () => {},
    });
    // Override log to capture warn/error output as JSON strings for inspection.
    const logged: string[] = [];
    const captureLog = (...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    };
    (ctx.log as Record<string, unknown>).error = captureLog;
    (ctx.log as Record<string, unknown>).warn = captureLog;
    // The poll loop will catch the fetch error and log it, then back-off.
    // Abort after a short time.
    setTimeout(() => abort.abort(), 200);
    await channel.start(ctx);
    // All logged output must NOT contain the raw token.
    for (const line of logged) {
      expect(line).not.toContain(SECRET_TOKEN);
    }
    // At least one log line must reference *** (token redacted).
    expect(logged.some((l) => l.includes("***"))).toBe(true);
  });
});

describe("createTelegramChannel — typing()", () => {
  it("posts to /sendChatAction with action: typing", async () => {
    const calls: FetchCall[] = [];
    const channel = createTelegramChannel({
      id: "gw_tg_typing",
      accountId: "ag_self",
      botToken: "tok",
      stateFile: path.join(tmp, "state.json"),
      stateDebounceMs: 0,
      fetchImpl: makeFetchScript([{ ok: true, result: true }], calls),
    });
    await channel.typing!({
      traceId: "t1",
      accountId: "ag_self",
      conversationId: "telegram:user:42",
      log: silentLog,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/sendChatAction");
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.chat_id).toBe("42");
    expect(body.action).toBe("typing");
  });
});
