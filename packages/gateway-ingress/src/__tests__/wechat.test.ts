import { describe, expect, it, vi } from "vitest";

import type { GatewayInboundMessage } from "@botcord/protocol-core";
import type { IngressLogger } from "../log.js";
import { noopLogger } from "../log.js";
import { createWechatProvider } from "../providers/wechat.js";
import type { ProviderRuntimeContext } from "../providers/types.js";
import type { GatewayConnection } from "../types.js";

const conn: GatewayConnection = {
  id: "gw_wc_unit",
  agentId: "ag_unit",
  provider: "wechat",
  status: "active",
  enabled: true,
  config: {
    allowedSenderIds: ["alice"],
  },
  createdAt: 1,
  updatedAt: 1,
};

function makeCtx(
  secret: Record<string, unknown>,
  abort: AbortController,
  log: IngressLogger = noopLogger,
) {
  const emits: { msg: GatewayInboundMessage; providerEventId: string }[] = [];
  const cursors: Record<string, unknown>[] = [];
  const activity: {
    lastPollAt?: number;
    lastInboundAt?: number;
    lastError?: string | null;
  }[] = [];
  const ctx: ProviderRuntimeContext = {
    connection: conn,
    secret,
    log,
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

describe("WeChat provider adapter", () => {
  it("records only safe observable details when getupdates fetch rejects", async () => {
    const secretToken = "wechat-secret-token";
    const failure = new TypeError(
      `fetch failed for https://ilinkai.weixin.qq.com/ilink/bot/getupdates?token=${secretToken}`,
    );
    (failure as { cause?: unknown }).cause = {
      code: "ENOTFOUND",
      errno: -3008,
      hostname: "ilinkai.weixin.qq.com",
      url: `https://ilinkai.weixin.qq.com/ilink/bot/getupdates?token=${secretToken}`,
    };
    let pollCount = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/ilink/bot/getupdates")) {
        pollCount += 1;
        if (pollCount === 1) throw failure;
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const logs: { message: string; meta?: Record<string, unknown> }[] = [];
    const log: IngressLogger = {
      ...noopLogger,
      error(message, meta) {
        logs.push({ message, meta });
      },
    };

    const provider = createWechatProvider({
      gatewayId: conn.id,
      fetchImpl,
    });
    const abort = new AbortController();
    const { ctx, activity } = makeCtx({ botToken: secretToken }, abort, log);
    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (
      Date.now() < deadline &&
      !activity.some((patch) => patch.lastError === "TypeError: fetch_failed")
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    abort.abort();
    await running;

    expect(activity.some((patch) => patch.lastError === "TypeError: fetch_failed")).toBe(true);
    expect(logs).toContainEqual({
      message: "wechat poll failed",
      meta: {
        name: "TypeError",
        message: "fetch_failed",
        cause: { code: "ENOTFOUND", errno: -3008 },
      },
    });
    const observable = JSON.stringify({ logs, activity });
    expect(observable).not.toContain("ilinkai.weixin.qq.com");
    expect(observable).not.toContain(secretToken);
    expect(observable).not.toContain("https://");
  });

  it("clears a prior poll error after getupdates succeeds again", async () => {
    vi.useFakeTimers();
    try {
      let pollCount = 0;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        if (url.endsWith("/ilink/bot/getupdates")) {
          pollCount += 1;
          if (pollCount === 1) {
            throw new TypeError("fetch failed");
          }
          if (pollCount === 2) {
            return new Response(
              JSON.stringify({ ret: 0, get_updates_buf: "buf-ok", msgs: [] }),
              { status: 200 },
            );
          }
          return new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener(
              "abort",
              () => rej(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const provider = createWechatProvider({
        gatewayId: conn.id,
        fetchImpl,
      });
      const abort = new AbortController();
      const { ctx, activity } = makeCtx({ botToken: "secret-token" }, abort);
      const running = provider.start(ctx);

      await vi.waitFor(() => {
        expect(activity.some((patch) => patch.lastError === "TypeError: fetch_failed")).toBe(true);
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => {
        expect(activity.some((patch) => patch.lastError === null)).toBe(true);
      });

      abort.abort();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls getupdates, normalizes text, advances cursor only after emit", async () => {
    let pollCount = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/ilink/bot/getupdates")) {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_type: 1,
                  from_user_id: "alice",
                  context_token: "ctx-tok-1",
                  client_id: "wc_client_1",
                  item_list: [{ type: 1, text_item: { text: "hello wechat" } }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        // After the first batch, hold open until aborted.
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createWechatProvider({
      gatewayId: conn.id,
      fetchImpl,
    });
    const abort = new AbortController();
    const { ctx, emits, cursors } = makeCtx({ botToken: "tok" }, abort);

    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && emits.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    abort.abort();
    await running;

    expect(emits).toHaveLength(1);
    expect(emits[0]!.msg.text).toBe("hello wechat");
    expect(emits[0]!.msg.conversation.id).toBe("wechat:user:alice");
    expect(emits[0]!.msg.sender.id).toBe("wechat:user:alice");
    expect(emits[0]!.providerEventId).toBe("wechat:gw_wc_unit:wc_client_1");
    expect(cursors[0]).toEqual({ buf: "buf-1" });
  });

  it("rejects senders not in allowedSenderIds", async () => {
    let pollCount = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/ilink/bot/getupdates")) {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-2",
              msgs: [
                {
                  message_type: 1,
                  from_user_id: "eve",
                  context_token: "ctx-tok-2",
                  client_id: "wc_client_2",
                  item_list: [{ type: 1, text_item: { text: "blocked" } }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createWechatProvider({
      gatewayId: conn.id,
      fetchImpl,
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
    // Cursor still advances — the orchestrator's dedupe / allowlist filter
    // dropped the message, but iLink saw it delivered.
    expect(cursors[0]).toEqual({ buf: "buf-2" });
  });

  it("send() reuses cached context_token and posts to sendmessage", async () => {
    let pollCount = 0;
    const sendBodies: unknown[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/ilink/bot/getupdates")) {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-3",
              msgs: [
                {
                  message_type: 1,
                  from_user_id: "alice",
                  context_token: "ctx-tok-3",
                  client_id: "wc_client_3",
                  item_list: [{ type: 1, text_item: { text: "ping" } }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (url.endsWith("/ilink/bot/sendmessage")) {
        sendBodies.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createWechatProvider({
      gatewayId: conn.id,
      fetchImpl,
    });
    const abort = new AbortController();
    const { ctx, emits } = makeCtx({ botToken: "tok" }, abort);
    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && emits.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const result = await provider.send({
      gatewayId: conn.id,
      conversationId: "wechat:user:alice",
      text: "pong",
      final: true,
    });

    abort.abort();
    await running;

    expect(result.providerMessageId).not.toBeNull();
    expect(sendBodies).toHaveLength(1);
    const body = sendBodies[0] as { msg: Record<string, unknown> };
    expect(body.msg).toMatchObject({
      to_user_id: "alice",
      context_token: "ctx-tok-3",
      message_type: 2,
      message_state: 2,
    });
    expect(body.msg.item_list).toEqual([
      { type: 1, text_item: { text: "pong" } },
    ]);
  });

  it("throws only safe observable error details when sendmessage fetch rejects", async () => {
    const secretToken = "wechat-secret-token";
    const failure = new TypeError(
      `fetch failed for https://ilinkai.weixin.qq.com/ilink/bot/sendmessage?access_token=${secretToken}`,
    );
    (failure as { cause?: unknown }).cause = {
      code: "ECONNRESET",
      errno: "ECONNRESET",
      hostname: "ilinkai.weixin.qq.com",
      url: `https://ilinkai.weixin.qq.com/ilink/bot/sendmessage?access_token=${secretToken}`,
    };
    let pollCount = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/ilink/bot/getupdates")) {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-3",
              msgs: [
                {
                  message_type: 1,
                  from_user_id: "alice",
                  context_token: "ctx-tok-3",
                  client_id: "wc_client_3",
                  item_list: [{ type: 1, text_item: { text: "ping" } }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (url.endsWith("/ilink/bot/sendmessage")) throw failure;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createWechatProvider({
      gatewayId: conn.id,
      fetchImpl,
    });
    const abort = new AbortController();
    const { ctx, emits, activity } = makeCtx({ botToken: secretToken }, abort);
    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && emits.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    let thrown: unknown;
    try {
      await provider.send({
        gatewayId: conn.id,
        conversationId: "wechat:user:alice",
        text: "pong",
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
    expect(observable).not.toContain("ilinkai.weixin.qq.com");
    expect(observable).not.toContain(secretToken);
    expect(observable).not.toContain("https://");
  });

  it("typing() fetches typing_ticket via getconfig and posts sendtyping", async () => {
    let pollCount = 0;
    const getConfigBodies: unknown[] = [];
    const sendTypingBodies: unknown[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/ilink/bot/getupdates")) {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-typing",
              msgs: [
                {
                  message_type: 1,
                  from_user_id: "alice",
                  context_token: "ctx-tok-typing",
                  client_id: "wc_client_typing",
                  item_list: [{ type: 1, text_item: { text: "hi" } }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (url.endsWith("/ilink/bot/getconfig")) {
        getConfigBodies.push(JSON.parse(init?.body as string));
        return new Response(
          JSON.stringify({ ret: 0, typing_ticket: "ticket-xyz" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/ilink/bot/sendtyping")) {
        sendTypingBodies.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createWechatProvider({
      gatewayId: conn.id,
      fetchImpl,
    });
    const abort = new AbortController();
    const { ctx, emits } = makeCtx({ botToken: "tok" }, abort);
    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && emits.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // First typing call hits getconfig + sendtyping.
    await provider.typing!({
      gatewayId: conn.id,
      conversationId: "wechat:user:alice",
      turnId: "turn_t1",
      phase: "started",
    });
    // Second call reuses the cached typing_ticket — only one getconfig.
    await provider.typing!({
      gatewayId: conn.id,
      conversationId: "wechat:user:alice",
      turnId: "turn_t2",
      phase: "started",
    });

    abort.abort();
    await running;

    expect(getConfigBodies).toHaveLength(1);
    expect((getConfigBodies[0] as { ilink_user_id: string }).ilink_user_id).toBe("alice");
    expect(sendTypingBodies).toHaveLength(2);
    for (const body of sendTypingBodies) {
      expect(body).toMatchObject({
        ilink_user_id: "alice",
        typing_ticket: "ticket-xyz",
        status: 1,
      });
    }
  });

  it("typing() is a no-op when no trace exists for the conversation", async () => {
    let sendTypingCalls = 0;
    let getConfigCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/ilink/bot/getupdates")) {
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (url.endsWith("/ilink/bot/getconfig")) getConfigCalls += 1;
      if (url.endsWith("/ilink/bot/sendtyping")) sendTypingCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createWechatProvider({
      gatewayId: conn.id,
      fetchImpl,
    });
    const abort = new AbortController();
    const { ctx } = makeCtx({ botToken: "tok" }, abort);
    const running = provider.start(ctx);
    await new Promise((r) => setTimeout(r, 30));

    await provider.typing!({
      gatewayId: conn.id,
      conversationId: "wechat:user:nobody",
      turnId: "turn_x",
      phase: "started",
    });

    abort.abort();
    await running;
    expect(getConfigCalls).toBe(0);
    expect(sendTypingCalls).toBe(0);
  });

  it("send() throws when no trace is cached for the conversation", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      // Hold the poll open so loop survives until abort.
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener(
          "abort",
          () => rej(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const provider = createWechatProvider({
      gatewayId: conn.id,
      fetchImpl,
    });
    const abort = new AbortController();
    const { ctx } = makeCtx({ botToken: "tok" }, abort);
    const running = provider.start(ctx);
    // Let start() install config + open poll.
    await new Promise((r) => setTimeout(r, 30));

    let thrown: unknown;
    try {
      await provider.send({
        gatewayId: conn.id,
        conversationId: "wechat:user:nobody",
        text: "hi",
        final: true,
      });
    } catch (err) {
      thrown = err;
    }

    expect(String(thrown)).toBe("Error: wechat send: no_context_token");
    expect(String(thrown)).not.toContain("nobody");

    abort.abort();
    await running;
  });
});
