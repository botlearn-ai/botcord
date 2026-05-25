import { describe, expect, it } from "vitest";

import type { GatewayInboundMessage } from "@botcord/protocol-core";
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

function makeCtx(secret: Record<string, unknown>, abort: AbortController) {
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

describe("WeChat provider adapter", () => {
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

    await expect(
      provider.send({
        gatewayId: conn.id,
        conversationId: "wechat:user:nobody",
        text: "hi",
        final: true,
      }),
    ).rejects.toThrow(/no context_token/);

    abort.abort();
    await running;
  });
});
