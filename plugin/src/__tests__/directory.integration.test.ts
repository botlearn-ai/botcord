import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDirectoryTool } from "../tools/directory.js";
import { createMockHub } from "./mock-hub.js";
import { generateKeypair } from "../crypto.js";
import { setConfigGetter } from "../runtime.js";

const keys = generateKeypair();

let hub: ReturnType<typeof createMockHub>;
let hubUrl: string;

function makeToolConfig(agentId = "ag_directory") {
  setConfigGetter(() => ({
    channels: {
      botcord: {
        hubUrl,
        agentId,
        keyId: `k_${agentId}`,
        privateKey: keys.privateKey,
      },
    },
  }));
}

beforeAll(async () => {
  hub = createMockHub();
  hubUrl = await hub.start();
});

afterAll(async () => {
  setConfigGetter(() => null);
  await hub.stop();
});

beforeEach(() => {
  hub.state.messages = [];
  hub.state.inbox = [];
  hub.state.endpoints = [];
  hub.state.rooms = [];
  hub.state.contacts = [];
  hub.state.tokenRefreshCount = 0;
  hub.state.overrides.clear();
  hub.state.wallets.clear();
  hub.state.walletTransactions = [];
  hub.state.walletEntries = [];
  hub.state.subscriptionProducts = [];
  hub.state.subscriptions = [];
  hub.state.subscriptionChargeAttempts.clear();
  hub.state.idempotencyKeys.clear();
  hub.state.knownAgents.clear();
  hub.state.knownAgents.add("ag_testclient00");
  hub.state.tokens.clear();
  hub.state.lastHistoryQuery = undefined;
  setConfigGetter(() => null);
});

describe("directory tool integration", () => {
  it("forwards full history query parameters", async () => {
    const tool = createDirectoryTool();
    makeToolConfig();

    const result = await tool.execute("tool-1", {
      action: "history",
      peer: "ag_peer",
      room_id: "rm_room",
      topic: "planning",
      topic_id: "tp_123",
      before: "hub_before",
      after: "hub_after",
      limit: 15,
    });

    expect((result as any).messages).toEqual([]);
    expect(hub.state.lastHistoryQuery).toEqual({
      peer: "ag_peer",
      room_id: "rm_room",
      topic: "planning",
      topic_id: "tp_123",
      before: "hub_before",
      after: "hub_after",
      limit: "15",
    });
  });
});
