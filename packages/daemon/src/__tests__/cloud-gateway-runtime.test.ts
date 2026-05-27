import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_FRAME_TYPES, type GatewayInboundFrame } from "@botcord/protocol-core";

import {
  handleCloudGatewayRuntimeInbound,
  type CloudGatewayTypingEvent,
} from "../cloud-gateway-runtime.js";
import { Gateway, type ChannelAdapter } from "../gateway/index.js";

describe("cloud gateway runtime inbound", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cloud-gateway-runtime-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects a gateway_inbound frame and captures the runtime reply", async () => {
    const gateway = new Gateway({
      config: {
        channels: [],
        defaultRoute: { runtime: "fake", cwd: tmpDir },
      },
      sessionStorePath: path.join(tmpDir, "sessions.json"),
      createChannel: (cfg) => stubChannel(cfg.id, cfg.type, cfg.accountId),
      createRuntime: () => ({
        id: "fake",
        async run() {
          return { text: "hello from runtime", newSessionId: "sess_1" };
        },
      }),
      transcriptEnabled: false,
    });
    await gateway.start();

    const frame: GatewayInboundFrame = {
      type: RUNTIME_FRAME_TYPES.GATEWAY_INBOUND,
      event_id: "evt_1",
      gateway_id: "gw_tg_1",
      agent_id: "ag_1",
      provider: "telegram",
      message: {
        id: "telegram:1:2",
        channel: "gw_tg_1",
        accountId: "ag_1",
        conversation: { id: "telegram:user:1", kind: "direct" },
        sender: { id: "telegram:user:1", kind: "user" },
        text: "hi",
        replyTo: null,
        mentioned: true,
        receivedAt: Date.now(),
        trace: { id: "telegram:1:2", streamable: false },
      },
    };

    const result = await handleCloudGatewayRuntimeInbound(gateway, frame);
    await gateway.stop("test");

    expect(result.accepted).toBe(true);
    expect(result.eventId).toBe("evt_1");
    expect(result.gatewayId).toBe("gw_tg_1");
    expect(result.conversationId).toBe("telegram:user:1");
    expect(result.outbound?.finalText).toBe("hello from runtime");
  });

  it("invokes the typing emitter when the dispatcher fires typing.started", async () => {
    const typingEvents: CloudGatewayTypingEvent[] = [];
    const gateway = new Gateway({
      config: {
        channels: [],
        defaultRoute: { runtime: "fake", cwd: tmpDir },
      },
      sessionStorePath: path.join(tmpDir, "sessions.json"),
      createChannel: (cfg) => stubChannel(cfg.id, cfg.type, cfg.accountId),
      createRuntime: () => ({
        id: "fake",
        async run() {
          return { text: "ok", newSessionId: "sess_typing" };
        },
      }),
      transcriptEnabled: false,
    });
    await gateway.start();

    const frame: GatewayInboundFrame = {
      type: RUNTIME_FRAME_TYPES.GATEWAY_INBOUND,
      event_id: "evt_typing",
      gateway_id: "gw_wc_1",
      agent_id: "ag_typing",
      provider: "wechat",
      message: {
        id: "wechat:alice:t1",
        channel: "gw_wc_1",
        accountId: "ag_typing",
        conversation: { id: "wechat:user:alice", kind: "direct" },
        sender: { id: "wechat:user:alice", kind: "user" },
        text: "ping",
        replyTo: null,
        mentioned: true,
        receivedAt: Date.now(),
        trace: { id: "wechat:alice:t1", streamable: false },
      },
    };

    const result = await handleCloudGatewayRuntimeInbound(
      gateway,
      frame,
      undefined,
      (event) => typingEvents.push(event),
    );
    await gateway.stop("test");

    expect(result.accepted).toBe(true);
    expect(typingEvents.length).toBeGreaterThanOrEqual(1);
    const first = typingEvents[0]!;
    expect(first.eventId).toBe("evt_typing");
    expect(first.gatewayId).toBe("gw_wc_1");
    expect(first.agentId).toBe("ag_typing");
    expect(first.conversationId).toBe("wechat:user:alice");
    expect(first.phase).toBe("started");
    expect(first.traceId).toBe("wechat:alice:t1");
  });

  it("rejects frames outside the token scope", async () => {
    const gateway = new Gateway({
      config: {
        channels: [],
        defaultRoute: { runtime: "fake", cwd: tmpDir },
      },
      sessionStorePath: path.join(tmpDir, "sessions.json"),
      createChannel: (cfg) => stubChannel(cfg.id, cfg.type, cfg.accountId),
      createRuntime: () => ({
        id: "fake",
        async run() {
          return { text: "unused", newSessionId: "sess_1" };
        },
      }),
      transcriptEnabled: false,
    });

    const result = await handleCloudGatewayRuntimeInbound(gateway, {
      type: RUNTIME_FRAME_TYPES.GATEWAY_INBOUND,
      event_id: "evt_bad",
      gateway_id: "gw_tg_1",
      agent_id: "ag_1",
      provider: "telegram",
      message: {
        id: "telegram:1:2",
        channel: "gw_other",
        accountId: "ag_1",
        conversation: { id: "telegram:user:1", kind: "direct" },
        sender: { id: "telegram:user:1", kind: "user" },
        text: "hi",
        replyTo: null,
        mentioned: true,
        receivedAt: Date.now(),
      },
    });

    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("channel_mismatch");
  });
});

function stubChannel(id: string, type: string, accountId: string): ChannelAdapter {
  return {
    id,
    type,
    async start() {
      return undefined;
    },
    async stop() {
      return undefined;
    },
    async send() {
      return {};
    },
    status() {
      return { channel: id, accountId, running: true };
    },
  };
}
