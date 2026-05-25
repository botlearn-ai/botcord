import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noopLogger } from "../log.js";
import { IngressOrchestrator } from "../orchestrator.js";
import { RuntimeSessionManager } from "../runtime/session.js";
import { FileSystemIngressStore } from "../storage/store.js";
import type { GatewayInboundMessage } from "@botcord/protocol-core";
import type { GatewayConnection } from "../types.js";
import { FakeHubClient, FakeRuntimeSocket, FakeSocketFactory } from "./fixtures.js";

import type {
  GatewayInboundFrame,
  RuntimeOutboundFrame,
} from "@botcord/protocol-core";
import { RUNTIME_FRAME_TYPES } from "@botcord/protocol-core";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "botcord-orch-"));
}

const CONN: GatewayConnection = {
  id: "gw_tg_alpha",
  agentId: "ag_alpha",
  provider: "telegram",
  status: "active",
  enabled: true,
  config: {},
  createdAt: 1,
  updatedAt: 1,
};

const NORMALIZED: GatewayInboundMessage = {
  id: "telegram:42:1",
  channel: CONN.id,
  accountId: CONN.agentId,
  conversation: { id: "telegram:user:42", kind: "direct" },
  sender: { id: "telegram:user:42", name: "alice", kind: "user" },
  text: "hi runtime",
  replyTo: null,
  mentioned: false,
  receivedAt: 1700000000000,
};

interface Harness {
  dir: string;
  store: FileSystemIngressStore;
  hub: FakeHubClient;
  socketFactory: FakeSocketFactory;
  runtime: RuntimeSessionManager;
  orchestrator: IngressOrchestrator;
  providerSends: { gatewayId: string; text: string; turnId?: string }[];
}

function makeHarness(): Harness {
  const dir = tmp();
  const store = new FileSystemIngressStore(dir);
  store.upsertConnection(CONN);
  const hub = new FakeHubClient();
  const socketFactory = new FakeSocketFactory();
  let orchestrator!: IngressOrchestrator;
  const runtime = new RuntimeSessionManager({
    socketFactory: socketFactory.factory,
    log: noopLogger,
    hooks: {
      onFrame: (agentId: string, frame: RuntimeOutboundFrame) =>
        orchestrator.onRuntimeFrame(agentId, frame),
      onClose: (agentId: string, reason: string) =>
        orchestrator.onRuntimeClose(agentId, reason),
    },
  });
  orchestrator = new IngressOrchestrator({
    store,
    hub,
    runtime,
    log: noopLogger,
  });
  const providerSends: Harness["providerSends"] = [];
  orchestrator.registerProvider({
    gatewayId: CONN.id,
    provider: "telegram",
    async start() {},
    async stop() {},
    async send(request: {
      gatewayId: string;
      conversationId: string;
      text: string;
      turnId?: string;
      final?: boolean;
    }) {
      providerSends.push({
        gatewayId: request.gatewayId,
        text: request.text,
        ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
      });
      return { providerMessageId: `telegram:42:${providerSends.length + 100}` };
    },
  });
  return { dir, store, hub, socketFactory, runtime, orchestrator, providerSends };
}

describe("IngressOrchestrator", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("ingest persists, calls ensure-running, opens runtime WS, sends inbound frame", async () => {
    const accepted = await h.orchestrator.ingest(CONN.id, NORMALIZED, "tg:gw:1");
    expect(accepted).toBe(true);
    // Give the background dispatch a tick.
    await waitFor(() => h.socketFactory.sockets.length === 1);
    const sock = h.socketFactory.sockets[0]!;
    await waitFor(() => sock.sent.length === 1);
    const frame = JSON.parse(sock.sent[0]!) as GatewayInboundFrame;
    expect(frame.type).toBe(RUNTIME_FRAME_TYPES.GATEWAY_INBOUND);
    expect(frame.gateway_id).toBe(CONN.id);
    expect(frame.agent_id).toBe(CONN.agentId);
    expect(frame.message.text).toBe("hi runtime");
    expect(frame.event_id.startsWith("evt_")).toBe(true);

    expect(h.hub.ensureRunningCalls).toHaveLength(1);
    expect(h.hub.ensureRunningCalls[0]!.body.reason).toBe("third_party_inbound");

    const events = h.store.listEventsByStatus("delivering");
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("delivering");
  });

  it("dedupes by providerEventId", async () => {
    await h.orchestrator.ingest(CONN.id, NORMALIZED, "tg:gw:dup");
    const second = await h.orchestrator.ingest(CONN.id, NORMALIZED, "tg:gw:dup");
    expect(second).toBe(false);
  });

  it("requeues event when ensure-running reports not-ready", async () => {
    h.hub.ensureResponse = () => ({
      agent_id: CONN.agentId,
      status: "provisioning",
      cloud_daemon_instance_id: "cloud_dm_fake",
    });
    await h.orchestrator.ingest(CONN.id, NORMALIZED, "tg:gw:slow");
    await waitFor(() => h.store.listEventsByStatus("queued").length === 1);
    const e = h.store.listEventsByStatus("queued")[0]!;
    expect(e.attemptCount).toBe(1);
    expect(e.lastError).toContain("hub_status_provisioning");
  });

  it("e2e: ack → outbound complete → provider sent → delivered", async () => {
    await h.orchestrator.ingest(CONN.id, NORMALIZED, "tg:gw:final");
    await waitFor(() => h.socketFactory.sockets.length === 1);
    const sock = h.socketFactory.sockets[0]!;
    await waitFor(() => sock.sent.length === 1);
    const inboundFrame = JSON.parse(sock.sent[0]!) as GatewayInboundFrame;

    // Daemon acks the inbound, then streams a complete frame back.
    sock.incoming({
      type: RUNTIME_FRAME_TYPES.GATEWAY_INBOUND_ACK,
      event_id: inboundFrame.event_id,
      accepted: true,
      runtime_session_id: "rt_xxx",
    });
    sock.incoming({
      type: RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_COMPLETE,
      event_id: inboundFrame.event_id,
      turn_id: "turn_1",
      gateway_id: CONN.id,
      agent_id: CONN.agentId,
      conversation_id: NORMALIZED.conversation.id,
      final_text: "thanks!",
    });

    await waitFor(() => h.providerSends.length === 1);
    expect(h.providerSends[0]).toMatchObject({
      gatewayId: CONN.id,
      text: "thanks!",
      turnId: "turn_1",
    });

    await waitFor(() => h.store.listEventsByStatus("delivered").length === 1);
    const delivery = h.store.getDeliveryByEvent(inboundFrame.event_id)!;
    expect(delivery.status).toBe("sent");
    expect(delivery.providerMessageId).toMatch(/^telegram:42:/);

    // Touch was called after the outbound send.
    expect(h.hub.touchCalls).toHaveLength(1);
    expect(h.hub.touchCalls[0]!.body.gateway_id).toBe(CONN.id);
  });

  it("requeues delivering events on runtime close", async () => {
    await h.orchestrator.ingest(CONN.id, NORMALIZED, "tg:gw:reset");
    await waitFor(() => h.store.listEventsByStatus("delivering").length === 1);
    const sock = h.socketFactory.sockets[0]!;
    sock.close(1011, "boom");
    await waitFor(() => h.store.listEventsByStatus("queued").length === 1);
    const e = h.store.listEventsByStatus("queued")[0]!;
    expect(e.lastError).toContain("runtime_closed");
  });

  it("outbound error frame marks event failed", async () => {
    await h.orchestrator.ingest(CONN.id, NORMALIZED, "tg:gw:err");
    await waitFor(() => h.socketFactory.sockets.length === 1);
    const sock = h.socketFactory.sockets[0]!;
    await waitFor(() => sock.sent.length === 1);
    const inboundFrame = JSON.parse(sock.sent[0]!) as GatewayInboundFrame;
    sock.incoming({
      type: RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_ERROR,
      event_id: inboundFrame.event_id,
      turn_id: "turn_x",
      gateway_id: CONN.id,
      agent_id: CONN.agentId,
      conversation_id: NORMALIZED.conversation.id,
      code: "runtime_failed",
      message: "boom",
    });
    await waitFor(() => h.store.listEventsByStatus("failed").length === 1);
    const e = h.store.listEventsByStatus("failed")[0]!;
    expect(e.lastError).toContain("runtime_failed");
  });

  it("hub failure surfaces as failed event", async () => {
    h.hub.ensureResponse = () => ({
      agent_id: CONN.agentId,
      status: "failed",
      error: { code: "provider_create_failed", message: "boom" },
    });
    await h.orchestrator.ingest(CONN.id, NORMALIZED, "tg:gw:hub-fail");
    await waitFor(() => h.store.listEventsByStatus("failed").length === 1);
    const e = h.store.listEventsByStatus("failed")[0]!;
    expect(e.lastError).toContain("hub_status_failed");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((res) => setTimeout(res, 5));
  }
}
