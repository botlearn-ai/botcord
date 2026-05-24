import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfigFromEnv } from "../config.js";
import { noopLogger } from "../log.js";
import { buildIngressService, type IngressService } from "../service.js";
import { MemorySecretStore } from "../storage/secrets.js";
import { FileSystemIngressStore } from "../storage/store.js";
import type { GatewayConnection } from "../types.js";
import { FakeHubClient, FakeSocketFactory } from "./fixtures.js";

import {
  RUNTIME_FRAME_TYPES,
  type GatewayInboundFrame,
} from "@botcord/protocol-core";

const TOKEN = "tg-bot-token";

describe("buildIngressService — Telegram MVP end-to-end", () => {
  let dir: string;
  let service: IngressService;
  let hub: FakeHubClient;
  let sockets: FakeSocketFactory;
  let secrets: MemorySecretStore;

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
    dir = mkdtempSync(join(tmpdir(), "ingress-svc-"));
    hub = new FakeHubClient();
    sockets = new FakeSocketFactory();
    secrets = new MemorySecretStore();
    secrets.write(conn.secretRef!, { botToken: TOKEN });
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
        telegram: makeStubProviderFactory((accepted) => {
          stubSends.push(accepted);
          return { providerMessageId: "tg:42:999" };
        }),
      },
    });
  });

  const stubSends: unknown[] = [];

  afterEach(async () => {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs end-to-end: inbound → orchestrator → runtime ack → outbound complete → provider send", async () => {
    await service.runner.startAll();

    // Drive a synthetic inbound via the orchestrator (stub provider has no
    // poll loop) — that exercises the same path the runner would.
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

    // Simulate the daemon roundtrip.
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
    expect(stubSends).toHaveLength(1);
    expect(hub.touchCalls).toHaveLength(1);
  });
});

function makeStubProviderFactory(send: (text: string) => { providerMessageId: string }) {
  return (gatewayId: string) => ({
    gatewayId,
    provider: "telegram" as const,
    async start() {
      // stub: do nothing — orchestrator drives ingest directly
    },
    async stop() {},
    async send(req: { gatewayId: string; conversationId: string; text: string; turnId?: string; final?: boolean }) {
      return send(req.text);
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
