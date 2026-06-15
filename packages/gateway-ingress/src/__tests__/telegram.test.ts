import { afterEach, describe, expect, it, vi } from "vitest";

import type { IngressLogger } from "../log.js";
import { noopLogger } from "../log.js";
import { createTelegramProvider } from "../providers/telegram.js";
import type { ProviderRuntimeContext } from "../providers/types.js";
import type { GatewayInboundMessage } from "@botcord/protocol-core";
import type { GatewayConnection } from "../types.js";

const conn: GatewayConnection = {
  id: "gw_tg_unit",
  agentId: "ag_unit",
  provider: "telegram",
  status: "active",
  enabled: true,
  config: {
    allowedSenderIds: ["100"],
    allowedChatIds: ["42"],
  },
  createdAt: 1,
  updatedAt: 1,
};

function makeCtx(secret: Record<string, unknown>, abort: AbortController): {
  ctx: ProviderRuntimeContext;
  emits: { msg: GatewayInboundMessage; providerEventId: string }[];
  cursors: Record<string, unknown>[];
  activity: { lastPollAt?: number; lastInboundAt?: number; lastError?: string | null }[];
} {
  const emits: { msg: GatewayInboundMessage; providerEventId: string }[] = [];
  const cursors: Record<string, unknown>[] = [];
  const activity: { lastPollAt?: number; lastInboundAt?: number; lastError?: string | null }[] = [];
  const ctx: ProviderRuntimeContext = {
    connection: conn,
    secret,
    log: noopLogger,
    abortSignal: abort.signal,
    async emit(msg, id) {
      emits.push({ msg, providerEventId: id });
      return true;
    },
    persistCursor(cursor) {
      cursors.push(cursor);
    },
    loadCursor() {
      return {};
    },
    markActivity(patch) {
      activity.push(patch);
    },
  };
  return { ctx, emits, cursors, activity };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram provider adapter", () => {
  it("polls getUpdates, normalizes a message, advances cursor only after emit", async () => {
    const responses: Array<{ ok: boolean; result?: unknown; description?: string }> = [
      {
        ok: true,
        result: [
          {
            update_id: 5,
            message: {
              message_id: 1,
              from: { id: 100, username: "alice" },
              chat: { id: 42, type: "private" },
              text: "hello",
            },
          },
        ],
      },
    ];

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const r = responses.shift();
      if (!r) {
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return new Response(JSON.stringify(r), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createTelegramProvider({
      gatewayId: conn.id,
      fetchImpl,
      pollTimeoutSeconds: 0,
    });
    const abort = new AbortController();
    const { ctx, emits, cursors } = makeCtx({ botToken: "secret-token" }, abort);

    const running = provider.start(ctx);
    // Wait until either we observe an emit or 1 s passes.
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && emits.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    abort.abort();
    await running;

    expect(emits).toHaveLength(1);
    expect(emits[0]!.msg.text).toBe("hello");
    expect(emits[0]!.providerEventId).toBe("tg:gw_tg_unit:5");
    expect(cursors[0]).toEqual({ offset: 6 });
  });

  it("send() POSTs to sendMessage and returns provider message id", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      if (url.endsWith("/getUpdates")) {
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 999 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = createTelegramProvider({
      gatewayId: conn.id,
      fetchImpl,
      pollTimeoutSeconds: 0,
    });
    const abort = new AbortController();
    const { ctx } = makeCtx({ botToken: "tok" }, abort);
    const running = provider.start(ctx);
    // Let start() install the token + config.
    await new Promise((r) => setTimeout(r, 20));

    const result = await provider.send({
      gatewayId: conn.id,
      conversationId: "telegram:user:42",
      text: "ack",
      final: true,
    });
    abort.abort();
    await running;
    expect(result.providerMessageId).toBe("telegram:42:999");
    const sendCalls = calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.body).toMatchObject({ chat_id: "42", text: "ack" });
  });

  it("throws only safe observable error details when sendMessage fetch rejects", async () => {
    const secretToken = "secret-token";
    const failure = new TypeError(
      `fetch failed for https://api.telegram.org/bot${secretToken}/sendMessage`,
    );
    (failure as { cause?: unknown }).cause = {
      code: "ENOTFOUND",
      errno: -3008,
      hostname: "api.telegram.org",
      url: `https://api.telegram.org/bot${secretToken}/sendMessage`,
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/getUpdates")) {
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      throw failure;
    }) as unknown as typeof fetch;

    const provider = createTelegramProvider({
      gatewayId: conn.id,
      fetchImpl,
      pollTimeoutSeconds: 0,
    });
    const abort = new AbortController();
    const { ctx, activity } = makeCtx({ botToken: secretToken }, abort);
    const running = provider.start(ctx);
    // Let start() install the token + config.
    await new Promise((r) => setTimeout(r, 20));

    let thrown: unknown;
    try {
      await provider.send({
        gatewayId: conn.id,
        conversationId: "telegram:user:42",
        text: "ack",
        final: true,
      });
    } catch (err) {
      thrown = err;
    }
    abort.abort();
    await running;

    expect(String(thrown)).toBe("TypeError: fetch_failed");
    const observable = JSON.stringify({
      persistedDeliveryLastError: String(thrown),
      persistedEventLastError: `provider_send_failed: ${String(thrown)}`,
      activity,
    });
    expect(observable).not.toContain("api.telegram.org");
    expect(observable).not.toContain(secretToken);
    expect(observable).not.toContain("https://");
  });

  it("rejects messages from disallowed sender or chat", async () => {
    const responses = [
      {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 1,
              from: { id: 999 },  // not in allowedSenderIds
              chat: { id: 42, type: "private" },
              text: "blocked",
            },
          },
        ],
      },
    ];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const r = responses.shift();
      if (!r) {
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return new Response(JSON.stringify(r), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createTelegramProvider({
      gatewayId: conn.id,
      fetchImpl,
      pollTimeoutSeconds: 0,
    });
    const abort = new AbortController();
    const { ctx, emits, cursors } = makeCtx({ botToken: "tok" }, abort);
    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && cursors.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    abort.abort();
    await running;
    expect(emits).toHaveLength(0);
    expect(cursors[0]).toEqual({ offset: 2 });
  });

  it("records and logs safe metadata when getUpdates fetch rejects", async () => {
    vi.useFakeTimers();

    const errors: { message: string; meta?: Record<string, unknown> }[] = [];
    const logger: IngressLogger = {
      ...noopLogger,
      error(message, meta) {
        errors.push({ message, meta });
      },
    };
    const abort = new AbortController();
    const calls: string[] = [];
    const failure = new TypeError(
      "fetch failed for https://api.telegram.org/botsecret-token/getUpdates",
    );
    (failure as { cause?: unknown }).cause = {
      code: "ENOTFOUND",
      errno: -3008,
      hostname: "api.telegram.org",
      url: "https://api.telegram.org/botsecret-token/getUpdates",
    };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (calls.length === 1) throw failure;
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener(
          "abort",
          () => rej(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const provider = createTelegramProvider({
      gatewayId: conn.id,
      fetchImpl,
      pollTimeoutSeconds: 25,
    });
    const { ctx, activity } = makeCtx({ botToken: "secret-token" }, abort);
    ctx.log = logger;

    const running = provider.start(ctx);
    await vi.waitFor(() => {
      expect(activity.some((patch) => patch.lastError === "TypeError: fetch_failed")).toBe(true);
    });
    expect(errors).toEqual([
      {
        message: "telegram poll failed",
        meta: {
          name: "TypeError",
          message: "fetch_failed",
          cause: { code: "ENOTFOUND", errno: -3008 },
        },
      },
    ]);
    const observable = JSON.stringify({ errors, activity });
    expect(observable).not.toContain("api.telegram.org");
    expect(observable).not.toContain("secret-token");
    expect(observable).not.toContain("https://");

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    abort.abort();
    await running;
  });
});
