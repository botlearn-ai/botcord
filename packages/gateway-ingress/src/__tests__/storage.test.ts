import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GatewayInboundMessage } from "@botcord/protocol-core";
import { FileSystemIngressStore } from "../storage/store.js";
import type {
  GatewayConnection,
  InboundEvent,
  OutboundDelivery,
} from "../types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "botcord-ingress-"));
}

const NORMALIZED: GatewayInboundMessage = {
  id: "telegram:42:1",
  channel: "gw_tg_test",
  accountId: "ag_test",
  conversation: { id: "telegram:user:42", kind: "direct" },
  sender: { id: "telegram:user:42", kind: "user" },
  text: "hi",
  replyTo: null,
  mentioned: false,
  receivedAt: 1700000000000,
};

const conn: GatewayConnection = {
  id: "gw_tg_test",
  agentId: "ag_test",
  provider: "telegram",
  status: "active",
  enabled: true,
  config: {},
  createdAt: 1,
  updatedAt: 1,
};

describe("FileSystemIngressStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the data directory structure on construction", () => {
    new FileSystemIngressStore(dir);
    for (const sub of ["connections", "state", "events", "deliveries"]) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
  });

  it("round-trips a connection", () => {
    const s = new FileSystemIngressStore(dir);
    s.upsertConnection(conn);
    expect(s.getConnection(conn.id)).toEqual(conn);
    expect(s.listConnections()).toEqual([conn]);
    s.deleteConnection(conn.id);
    expect(s.getConnection(conn.id)).toBeNull();
  });

  it("persists provider cursor and dedupe ring buffer", () => {
    const s = new FileSystemIngressStore(dir);
    s.upsertConnection(conn);
    expect(s.appendDedupe(conn.id, "p1")).toBe(true);
    expect(s.appendDedupe(conn.id, "p1")).toBe(false);
    expect(s.appendDedupe(conn.id, "p2")).toBe(true);
    const state = s.getState(conn.id);
    expect(state?.dedupe).toEqual(["p1", "p2"]);
    expect(s.hasProviderEventId(conn.id, "p1")).toBe(true);
    expect(s.hasProviderEventId(conn.id, "p3")).toBe(false);

    s.updateState(conn.id, { cursor: { offset: 42 } });
    expect(s.getState(conn.id)?.cursor).toEqual({ offset: 42 });
    // Ring buffer is preserved across cursor updates.
    expect(s.getState(conn.id)?.dedupe).toEqual(["p1", "p2"]);
  });

  it("survives a reload (durable inbound queue)", () => {
    const s1 = new FileSystemIngressStore(dir);
    s1.upsertConnection(conn);
    const event: InboundEvent = {
      eventId: "evt_x",
      gatewayId: conn.id,
      agentId: conn.agentId,
      provider: conn.provider,
      providerEventId: "tg:gw:1",
      conversationId: NORMALIZED.conversation.id,
      senderId: NORMALIZED.sender.id,
      normalizedMessage: NORMALIZED,
      status: "queued",
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    s1.insertEvent(event);

    const s2 = new FileSystemIngressStore(dir);
    expect(s2.listEventsByStatus("queued")).toHaveLength(1);
    expect(s2.getEvent("evt_x")?.providerEventId).toBe("tg:gw:1");
    expect(s2.hasProviderEventId(conn.id, "tg:gw:1")).toBe(true);
  });

  it("dedupe ring buffer caps at capacity", () => {
    const s = new FileSystemIngressStore(dir);
    s.upsertConnection(conn);
    for (let i = 0; i < 8; i++) s.appendDedupe(conn.id, `p${i}`, 4);
    expect(s.getState(conn.id)?.dedupe).toEqual(["p4", "p5", "p6", "p7"]);
  });

  it("insertDelivery + getDeliveryByEvent", () => {
    const s = new FileSystemIngressStore(dir);
    const row: OutboundDelivery = {
      deliveryId: "del_abc",
      eventId: "evt_x",
      gatewayId: conn.id,
      conversationId: "telegram:user:42",
      status: "streaming",
      createdAt: 1,
      updatedAt: 1,
    };
    s.insertDelivery(row);
    expect(s.getDeliveryByEvent("evt_x")?.deliveryId).toBe("del_abc");
    s.updateDelivery("del_abc", { status: "sent", providerMessageId: "telegram:1:1" });
    expect(s.getDeliveryByEvent("evt_x")?.status).toBe("sent");
  });
});
