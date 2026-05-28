import { describe, expect, it } from "vitest";

import type { GatewayInboundMessage } from "@botcord/protocol-core";
import { noopLogger } from "../log.js";
import { createFeishuProvider } from "../providers/feishu.js";
import type { ProviderRuntimeContext } from "../providers/types.js";
import type { GatewayConnection } from "../types.js";

const conn: GatewayConnection = {
  id: "gw_fs_unit",
  agentId: "ag_unit",
  provider: "feishu",
  status: "active",
  enabled: true,
  config: {
    appId: "cli_test",
    domain: "feishu",
    allowedSenderIds: ["ou_alice"],
    allowedChatIds: ["oc_chat"],
  },
  createdAt: 1,
  updatedAt: 1,
};

function makeCtx(
  secret: Record<string, unknown>,
  abort: AbortController,
  connection: GatewayConnection = conn,
) {
  const emits: { msg: GatewayInboundMessage; providerEventId: string }[] = [];
  const cursors: Record<string, unknown>[] = [];
  const activity: {
    lastPollAt?: number;
    lastInboundAt?: number;
    lastError?: string | null;
  }[] = [];
  const ctx: ProviderRuntimeContext = {
    connection,
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

interface FakeRequest {
  method: string;
  url: string;
  data?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

function makeSdkOverride(opts: {
  probeBotId?: string;
  /** Called when send POSTs to /open-apis/im/v1/messages. */
  onSend?: (req: FakeRequest) => { messageId?: string };
}) {
  const requests: FakeRequest[] = [];
  let registeredHandlers: Record<string, (data: unknown) => unknown> | null = null;
  const wsStarted: unknown[] = [];

  const sdkOverride = {
    createClient(_args: Record<string, unknown>) {
      return {
        async request(args: unknown): Promise<unknown> {
          const r = args as FakeRequest;
          requests.push(r);
          if (r.url.endsWith("/openclaw_bot/ping")) {
            return {
              code: 0,
              data: { pingBotInfo: { botID: opts.probeBotId ?? "ou_bot" } },
            };
          }
          if (r.url.endsWith("/im/v1/messages")) {
            const out = opts.onSend?.(r) ?? {};
            return {
              code: 0,
              data: { message_id: out.messageId ?? "om_sent" },
            };
          }
          return { code: 0, data: {} };
        },
      };
    },
    createWsClient(_args: Record<string, unknown>) {
      return {
        start(startOpts: unknown): unknown {
          wsStarted.push(startOpts);
          return Promise.resolve();
        },
        close(_opts?: unknown): unknown {
          return Promise.resolve();
        },
      };
    },
    createDispatcher() {
      return {
        register(handlers: Record<string, (data: unknown) => unknown>): void {
          registeredHandlers = handlers;
        },
      };
    },
  };

  return {
    sdkOverride,
    requests,
    wsStarted,
    fireMessageEvent(data: unknown): unknown {
      const h = registeredHandlers?.["im.message.receive_v1"];
      if (!h) throw new Error("dispatcher not registered yet");
      return h(data);
    },
  };
}

describe("Feishu provider adapter", () => {
  it("loads appId from the secret store when setup-owned config omits it", async () => {
    const finalizedConn: GatewayConnection = {
      ...conn,
      config: {
        domain: "feishu",
        allowedSenderIds: ["ou_alice"],
        allowedChatIds: ["oc_chat"],
      },
    };
    let clientArgs: Record<string, unknown> | null = null;
    let wsArgs: Record<string, unknown> | null = null;
    const harness = makeSdkOverride({ probeBotId: "ou_bot" });
    const sdkOverride = {
      ...harness.sdkOverride,
      createClient(args: Record<string, unknown>) {
        clientArgs = args;
        return harness.sdkOverride.createClient(args);
      },
      createWsClient(args: Record<string, unknown>) {
        wsArgs = args;
        return harness.sdkOverride.createWsClient(args);
      },
    };
    const provider = createFeishuProvider({
      gatewayId: finalizedConn.id,
      sdkOverride,
    });
    const abort = new AbortController();
    const { ctx, activity } = makeCtx(
      { appId: "cli_from_secret", appSecret: "shh" },
      abort,
      finalizedConn,
    );

    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && harness.wsStarted.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    abort.abort();
    await running;

    expect(clientArgs).toMatchObject({ appId: "cli_from_secret", appSecret: "shh" });
    expect(wsArgs).toMatchObject({ appId: "cli_from_secret", appSecret: "shh" });
    expect(activity.some((a) => a.lastError === "missing_credential")).toBe(false);
  });

  it("probes botOpenId on start and normalizes a p2p message", async () => {
    const harness = makeSdkOverride({ probeBotId: "ou_bot" });
    const provider = createFeishuProvider({
      gatewayId: conn.id,
      sdkOverride: harness.sdkOverride,
    });
    const abort = new AbortController();
    const { ctx, emits, activity } = makeCtx({ appSecret: "shh" }, abort);

    const running = provider.start(ctx);

    // Wait until probe + dispatcher registration have happened.
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && harness.wsStarted.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    await harness.fireMessageEvent({
      sender: {
        sender_id: { open_id: "ou_alice" },
        sender_type: "user",
      },
      message: {
        message_id: "om_abc",
        chat_id: "oc_chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hi feishu" }),
        create_time: "1700000000000",
        mentions: [{ id: { open_id: "ou_alice" }, name: "Alice" }],
      },
    });

    abort.abort();
    await running;

    expect(emits).toHaveLength(1);
    expect(emits[0]!.msg.text).toBe("hi feishu");
    expect(emits[0]!.msg.conversation.id).toBe("feishu:user:oc_chat");
    expect(emits[0]!.msg.conversation.kind).toBe("direct");
    expect(emits[0]!.msg.sender.id).toBe("feishu:user:ou_alice");
    expect(emits[0]!.msg.sender.name).toBe("Alice");
    expect(emits[0]!.providerEventId).toBe("feishu:om_abc");
    expect(activity.some((a) => a.lastInboundAt !== undefined)).toBe(true);
  });

  it("skips messages from the bot itself", async () => {
    const harness = makeSdkOverride({ probeBotId: "ou_bot" });
    const provider = createFeishuProvider({
      gatewayId: conn.id,
      sdkOverride: harness.sdkOverride,
    });
    const abort = new AbortController();
    const { ctx, emits } = makeCtx({ appSecret: "shh" }, abort);

    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && harness.wsStarted.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    await harness.fireMessageEvent({
      sender: {
        sender_id: { open_id: "ou_bot" }, // bot's own id
      },
      message: {
        message_id: "om_echo",
        chat_id: "oc_chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "should be ignored" }),
      },
    });

    abort.abort();
    await running;
    expect(emits).toHaveLength(0);
  });

  it("rejects senders outside allowedSenderIds", async () => {
    const harness = makeSdkOverride({ probeBotId: "ou_bot" });
    const provider = createFeishuProvider({
      gatewayId: conn.id,
      sdkOverride: harness.sdkOverride,
    });
    const abort = new AbortController();
    const { ctx, emits } = makeCtx({ appSecret: "shh" }, abort);

    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && harness.wsStarted.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    await harness.fireMessageEvent({
      sender: { sender_id: { open_id: "ou_eve" } }, // not in allowedSenderIds
      message: {
        message_id: "om_blocked",
        chat_id: "oc_chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "blocked" }),
      },
    });

    abort.abort();
    await running;
    expect(emits).toHaveLength(0);
  });

  it("send() posts text and returns the provider message id", async () => {
    const harness = makeSdkOverride({
      probeBotId: "ou_bot",
      onSend: () => ({ messageId: "om_reply" }),
    });
    const provider = createFeishuProvider({
      gatewayId: conn.id,
      sdkOverride: harness.sdkOverride,
    });
    const abort = new AbortController();
    const { ctx } = makeCtx({ appSecret: "shh" }, abort);

    const running = provider.start(ctx);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && harness.wsStarted.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const result = await provider.send({
      gatewayId: conn.id,
      conversationId: "feishu:user:oc_chat",
      text: "reply text",
      final: true,
    });

    abort.abort();
    await running;

    expect(result.providerMessageId).toBe("feishu:om_reply");
    const sendCalls = harness.requests.filter((r) => r.url.endsWith("/im/v1/messages"));
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.data).toMatchObject({
      receive_id: "oc_chat",
      msg_type: "text",
    });
  });
});
