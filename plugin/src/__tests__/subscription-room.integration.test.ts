import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeypair } from "../crypto.js";
import { createMockHub } from "./mock-hub.js";
import { createSubscriptionTool } from "../tools/subscription.js";
import { setConfigGetter } from "../runtime.js";

const ownerKeys = generateKeypair();

let hub: ReturnType<typeof createMockHub>;
let hubUrl: string;

function makeToolConfig(agentId: string, privateKey: string, keyId = `k_${agentId}`) {
  setConfigGetter(() => ({
    channels: {
      botcord: {
        hubUrl,
        agentId,
        keyId,
        privateKey,
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
  setConfigGetter(() => null);
});

describe("subscription room tool integration", () => {
  it("creates a subscription-gated room bound to a product", async () => {
    const tool = createSubscriptionTool();
    makeToolConfig("ag_owner", ownerKeys.privateKey);

    const createdProduct = await tool.execute("tool-1", {
      action: "create_product",
      name: "Premium",
      amount_minor: "9000",
      billing_interval: "month",
    });

    const productId = (createdProduct as any).data.product_id;
    const createdRoom = await tool.execute("tool-2", {
      action: "create_subscription_room",
      product_id: productId,
      name: "Premium Room",
      description: "Members only",
      rule: "No leaks",
      max_members: 20,
      default_send: true,
      default_invite: false,
      slow_mode_seconds: 15,
    });

    const room = (createdRoom as any).data;
    expect(room.name).toBe("Premium Room");
    expect(room.visibility).toBe("private");
    expect(room.join_policy).toBe("invite_only");
    expect(room.required_subscription_product_id).toBe(productId);
    expect(room.max_members).toBe(20);
    expect(room.slow_mode_seconds).toBe(15);
  });

  it("binds an existing room to a subscription product", async () => {
    const tool = createSubscriptionTool();
    makeToolConfig("ag_owner", ownerKeys.privateKey);

    const createdProduct = await tool.execute("tool-1", {
      action: "create_product",
      name: "Gold",
      amount_minor: "7000",
      billing_interval: "week",
    });
    const productId = (createdProduct as any).data.product_id;

    hub.state.rooms.push({
      room_id: "rm_existing",
      name: "Existing Room",
      description: "",
      rule: null,
      visibility: "public",
      join_policy: "open",
      required_subscription_product_id: null,
      max_members: null,
      default_send: true,
      default_invite: false,
      slow_mode_seconds: null,
      member_count: 1,
      created_at: new Date().toISOString(),
    });

    const bound = await tool.execute("tool-2", {
      action: "bind_room_to_product",
      room_id: "rm_existing",
      product_id: productId,
      rule: "Bound rule",
      default_invite: true,
    });

    const room = (bound as any).data;
    expect(room.room_id).toBe("rm_existing");
    expect(room.visibility).toBe("private");
    expect(room.join_policy).toBe("invite_only");
    expect(room.required_subscription_product_id).toBe(productId);
    expect(room.rule).toBe("Bound rule");
    expect(room.default_invite).toBe(true);
  });
});
