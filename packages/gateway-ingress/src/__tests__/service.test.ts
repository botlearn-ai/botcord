import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfigFromEnv } from "../config.js";
import { noopLogger } from "../log.js";
import { createFeishuProvider } from "../providers/feishu.js";
import { createWechatProvider } from "../providers/wechat.js";
import { buildIngressService, type IngressService } from "../service.js";
import { MemorySecretStore } from "../storage/secrets.js";
import { FileSystemIngressStore } from "../storage/store.js";
import type { GatewayConnection } from "../types.js";
import { FakeHubClient, FakeSocketFactory } from "./fixtures.js";

import {
  RUNTIME_FRAME_TYPES,
  type GatewayInboundFrame,
} from "@botcord/protocol-core";

// ---------------------------------------------------------------------------
// Telegram MVP — stub provider, the original integration scenario.
// ---------------------------------------------------------------------------

describe("buildIngressService — Telegram MVP end-to-end", () => {
  let dir: string;
  let service: IngressService;
  let hub: FakeHubClient;
  let sockets: FakeSocketFactory;
  let secrets: MemorySecretStore;
  const stubSends: string[] = [];

  const conn: GatewayConnection = {
    id: "gw_tg_main",
    agentId: "ag_main",
    provider: "telegram",
    status: "active",
    enabled: true,
    config: {
      allowedSenderIds: ["100"],
      allowedChatIds: ["42"],
    },
    secretRef: "gw_tg_main",
    createdAt: 1,
    updatedAt: 1,
  };

  beforeEach(async () => {
    stubSends.length = 0;
    dir = mkdtempSync(join(tmpdir(), "ingress-svc-tg-"));
    hub = new FakeHubClient();
    sockets = new FakeSocketFactory();
    secrets = new MemorySecretStore();
    secrets.write(conn.secretRef!, { botToken: "tg-bot-token" });
    const store = new FileSystemIngressStore(dir);
    store.upsertConnection(conn);
    const config = loadConfigFromEnv({
      BOTCORD_INGRESS_HUB_URL: "http://test",
      BOTCORD_INGRESS_SECRET: "s",
      BOTCORD_INGRESS_DATA_DIR: dir,
      BOTCORD_INGRESS_SECRET_DIR: join(dir, "secrets"),
      BOTCORD_INGRESS_HEALTH_PORT: "0",
    });
    service = await buildIngressService({
      config,
      log: noopLogger,
      store,
      secrets,
      hub,
      socketFactory: sockets.factory,
      factories: {
        telegram: (gatewayId) => ({
          gatewayId,
          provider: "telegram" as const,
          async start() {
            // stub: orchestrator drives ingest directly
          },
          async stop() {},
          async send(req) {
            stubSends.push(req.text);
            return { providerMessageId: "tg:42:999" };
          },
        }),
      },
    });
  });

  afterEach(async () => {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs end-to-end: inbound → orchestrator → runtime ack → outbound complete → provider send", async () => {
    await service.runner.startAll();

    const accepted = await service.orchestrator.ingest(conn.id, {
      id: "telegram:42:1",
      channel: conn.id,
      accountId: conn.agentId,
      conversation: { id: "telegram:user:42", kind: "direct" },
      sender: { id: "telegram:user:100", kind: "user", name: "alice" },
      text: "hello cloud agent",
      replyTo: null,
      mentioned: false,
      receivedAt: 1700000000000,
    }, "tg:run:1");
    expect(accepted).toBe(true);

    await waitFor(() => sockets.sockets.length === 1);
    const sock = sockets.sockets[0]!;
    await waitFor(() => sock.sent.length === 1);
    const frame = JSON.parse(sock.sent[0]!) as GatewayInboundFrame;
    expect(frame.message.text).toBe("hello cloud agent");

    sock.incoming({
      type: RUNTIME_FRAME_TYPES.GATEWAY_INBOUND_ACK,
      event_id: frame.event_id,
      accepted: true,
    });
    sock.incoming({
      type: RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_COMPLETE,
      event_id: frame.event_id,
      turn_id: "turn_1",
      gateway_id: conn.id,
      agent_id: conn.agentId,
      conversation_id: "telegram:user:42",
      final_text: "hi user!",
    });

    await waitFor(() =>
      service.store.listEventsByStatus("delivered").length === 1,
    );
    expect(stubSends).toEqual(["hi user!"]);
    expect(hub.touchCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Feishu MVP — real provider with stubbed lark SDK transport.
// ---------------------------------------------------------------------------

describe("buildIngressService — Feishu MVP end-to-end", () => {
  let dir: string;
  let service: IngressService;
  let hub: FakeHubClient;
  let sockets: FakeSocketFactory;
  let secrets: MemorySecretStore;

  const conn: GatewayConnection = {
    id: "gw_fs_main",
    agentId: "ag_fs_main",
    provider: "feishu",
    status: "active",
    enabled: true,
    config: {
      appId: "cli_e2e",
      domain: "feishu",
      allowedSenderIds: ["ou_alice"],
      allowedChatIds: ["oc_chat"],
    },
    secretRef: "gw_fs_main",
    createdAt: 1,
    updatedAt: 1,
  };

  // Captured during start() so we can fire a synthetic event.
  let fireEvent: ((data: unknown) => unknown) | null = null;
  const sentMessages: { url: string; data?: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    fireEvent = null;
    sentMessages.length = 0;
    dir = mkdtempSync(join(tmpdir(), "ingress-svc-fs-"));
    hub = new FakeHubClient();
    sockets = new FakeSocketFactory();
    secrets = new MemorySecretStore();
    secrets.write(conn.secretRef!, { appSecret: "shh-secret" });
    const store = new FileSystemIngressStore(dir);
    store.upsertConnection(conn);
    const config = loadConfigFromEnv({
      BOTCORD_INGRESS_HUB_URL: "http://test",
      BOTCORD_INGRESS_SECRET: "s",
      BOTCORD_INGRESS_DATA_DIR: dir,
      BOTCORD_INGRESS_SECRET_DIR: join(dir, "secrets"),
      BOTCORD_INGRESS_HEALTH_PORT: "0",
    });
    let registeredHandlers: Record<string, (data: unknown) => unknown> | null = null;
    const sdkOverride = {
      createClient(_args: Record<string, unknown>) {
        return {
          async request(args: unknown): Promise<unknown> {
            const r = args as { method: string; url: string; data?: Record<string, unknown> };
            if (r.url.endsWith("/openclaw_bot/ping")) {
              return { code: 0, data: { pingBotInfo: { botID: "ou_bot" } } };
            }
            if (r.url.endsWith("/im/v1/messages")) {
              sentMessages.push({ url: r.url, data: r.data });
              return { code: 0, data: { message_id: "om_reply_e2e" } };
            }
            return { code: 0 };
          },
        };
      },
      createWsClient(_args: Record<string, unknown>) {
        return {
          start(_opts: unknown): unknown {
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
            fireEvent = (data) => handlers["im.message.receive_v1"]!(data);
          },
        };
      },
    };
    service = await buildIngressService({
      config,
      log: noopLogger,
      store,
      secrets,
      hub,
      socketFactory: sockets.factory,
      factories: {
        feishu: (gatewayId) => createFeishuProvider({ gatewayId, sdkOverride }),
      },
    });
    // Touch registeredHandlers so the var is recognized as used by the linter
    // (it's the closure inside sdkOverride that actually mutates it).
    void registeredHandlers;
  });

  afterEach(async () => {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("real feishu provider: WS event → orchestrator → ack → outbound → send", async () => {
    await service.runner.startAll();

    // Wait for the provider's start() to complete its probe + dispatcher register.
    await waitFor(() => fireEvent !== null);
    await fireEvent!({
      sender: {
        sender_id: { open_id: "ou_alice" },
        sender_type: "user",
      },
      message: {
        message_id: "om_inbound_1",
        chat_id: "oc_chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello from feishu" }),
        create_time: "1700000000000",
        mentions: [{ id: { open_id: "ou_alice" }, name: "Alice" }],
      },
    });

    await waitFor(() => sockets.sockets.length === 1);
    const sock = sockets.sockets[0]!;
    await waitFor(() => sock.sent.length === 1);
    const frame = JSON.parse(sock.sent[0]!) as GatewayInboundFrame;
    expect(frame.provider).toBe("feishu");
    expect(frame.message.text).toBe("hello from feishu");
    expect(frame.message.conversation.id).toBe("feishu:user:oc_chat");

    sock.incoming({
      type: RUNTIME_FRAME_TYPES.GATEWAY_INBOUND_ACK,
      event_id: frame.event_id,
      accepted: true,
    });
    sock.incoming({
      type: RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_COMPLETE,
      event_id: frame.event_id,
      turn_id: "turn_fs_1",
      gateway_id: conn.id,
      agent_id: conn.agentId,
      conversation_id: "feishu:user:oc_chat",
      final_text: "hi from cloud agent",
    });

    await waitFor(() =>
      service.store.listEventsByStatus("delivered").length === 1,
    );
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.data).toMatchObject({
      receive_id: "oc_chat",
      msg_type: "text",
    });
    expect(hub.touchCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// WeChat MVP — real provider with stubbed iLink HTTP transport.
// ---------------------------------------------------------------------------

describe("buildIngressService — WeChat MVP end-to-end", () => {
  let dir: string;
  let service: IngressService;
  let hub: FakeHubClient;
  let sockets: FakeSocketFactory;
  let secrets: MemorySecretStore;

  const conn: GatewayConnection = {
    id: "gw_wc_main",
    agentId: "ag_wc_main",
    provider: "wechat",
    status: "active",
    enabled: true,
    config: {
      allowedSenderIds: ["alice"],
    },
    secretRef: "gw_wc_main",
    createdAt: 1,
    updatedAt: 1,
  };

  const sentBodies: unknown[] = [];

  beforeEach(async () => {
    sentBodies.length = 0;
    dir = mkdtempSync(join(tmpdir(), "ingress-svc-wc-"));
    hub = new FakeHubClient();
    sockets = new FakeSocketFactory();
    secrets = new MemorySecretStore();
    secrets.write(conn.secretRef!, { botToken: "wc-bot-token" });
    const store = new FileSystemIngressStore(dir);
    store.upsertConnection(conn);
    const config = loadConfigFromEnv({
      BOTCORD_INGRESS_HUB_URL: "http://test",
      BOTCORD_INGRESS_SECRET: "s",
      BOTCORD_INGRESS_DATA_DIR: dir,
      BOTCORD_INGRESS_SECRET_DIR: join(dir, "secrets"),
      BOTCORD_INGRESS_HEALTH_PORT: "0",
    });
    let pollCount = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/ilink/bot/getupdates")) {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-e2e",
              msgs: [
                {
                  message_type: 1,
                  from_user_id: "alice",
                  context_token: "ctx-e2e",
                  client_id: "wc_e2e_in_1",
                  item_list: [{ type: 1, text_item: { text: "hello from wechat" } }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        // Hold open until the test aborts via service.shutdown().
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener(
            "abort",
            () => rej(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (url.endsWith("/ilink/bot/sendmessage")) {
        sentBodies.push(JSON.parse(init?.body as string));
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    service = await buildIngressService({
      config,
      log: noopLogger,
      store,
      secrets,
      hub,
      socketFactory: sockets.factory,
      factories: {
        wechat: (gatewayId) => createWechatProvider({ gatewayId, fetchImpl }),
      },
    });
  });

  afterEach(async () => {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("real wechat provider: poll → orchestrator → ack → outbound → send via cached trace", async () => {
    await service.runner.startAll();

    await waitFor(() => sockets.sockets.length === 1);
    const sock = sockets.sockets[0]!;
    await waitFor(() => sock.sent.length === 1);
    const frame = JSON.parse(sock.sent[0]!) as GatewayInboundFrame;
    expect(frame.provider).toBe("wechat");
    expect(frame.message.text).toBe("hello from wechat");
    expect(frame.message.conversation.id).toBe("wechat:user:alice");

    sock.incoming({
      type: RUNTIME_FRAME_TYPES.GATEWAY_INBOUND_ACK,
      event_id: frame.event_id,
      accepted: true,
    });
    sock.incoming({
      type: RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_COMPLETE,
      event_id: frame.event_id,
      turn_id: "turn_wc_1",
      gateway_id: conn.id,
      agent_id: conn.agentId,
      conversation_id: "wechat:user:alice",
      final_text: "hi from cloud agent",
    });

    await waitFor(() =>
      service.store.listEventsByStatus("delivered").length === 1,
    );
    expect(sentBodies).toHaveLength(1);
    const body = sentBodies[0] as { msg: Record<string, unknown> };
    expect(body.msg).toMatchObject({
      to_user_id: "alice",
      context_token: "ctx-e2e",
      message_type: 2,
      message_state: 2,
    });
    expect(body.msg.item_list).toEqual([
      { type: 1, text_item: { text: "hi from cloud agent" } },
    ]);
    expect(hub.touchCalls).toHaveLength(1);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
