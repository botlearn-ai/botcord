import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BotCordClient } from "../client.js";
import { generateKeypair } from "../crypto.js";
import { createMockHub } from "./mock-hub.js";
import { createSubscriptionTool } from "../tools/subscription.js";
import { setConfigGetter } from "../runtime.js";
import type { Subscription, SubscriptionProduct } from "../types.js";

const ownerKeys = generateKeypair();
const subscriberKeys = generateKeypair();

let hub: ReturnType<typeof createMockHub>;
let hubUrl: string;

function makeClient(agentId: string, privateKey: string, keyId = `k_${agentId}`) {
  return new BotCordClient({
    hubUrl,
    agentId,
    keyId,
    privateKey,
  });
}

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

async function seedBalance(client: BotCordClient, amountMinor: string) {
  const topup = await client.createTopup({ amount_minor: amountMinor, channel: "mock" });
  await fetch(`${hubUrl}/internal/wallet/topups/${topup.topup_id}/complete`, {
    method: "POST",
  });
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

describe("subscription client and tool integration", () => {
  it("creates products, subscribes, cancels, and lists the related resources", async () => {
    const owner = makeClient("ag_owner", ownerKeys.privateKey);
    const subscriber = makeClient("ag_subscriber", subscriberKeys.privateKey);
    const tool = createSubscriptionTool();

    await seedBalance(subscriber, "50000");

    makeToolConfig("ag_owner", ownerKeys.privateKey);
    const created = await tool.execute("tool-1", {
      action: "create_product",
      name: "Pro Access",
      description: "Priority support and premium tooling",
      amount: "120",
      billing_interval: "month",
    });
    const createdProduct = created.data as SubscriptionProduct;
    expect(createdProduct.product_id).toMatch(/^sp_/);

    const ownerProducts = await owner.listMySubscriptionProducts();
    expect(ownerProducts).toHaveLength(1);
    expect(ownerProducts[0].name).toBe("Pro Access");

    const publicProducts = await owner.listSubscriptionProducts();
    expect(publicProducts).toHaveLength(1);

    const toolOwnedProducts = await tool.execute("tool-1b", {
      action: "list_my_products",
    });
    expect(toolOwnedProducts.data as SubscriptionProduct[]).toHaveLength(1);

    makeToolConfig("ag_subscriber", subscriberKeys.privateKey);
    const subscribed = await tool.execute("tool-2", {
      action: "subscribe",
      product_id: createdProduct.product_id,
    });
    const subscribedSubscription = subscribed.data as Subscription;
    expect(subscribedSubscription.subscription_id).toMatch(/^su_/);
    expect(subscribedSubscription.status).toBe("active");

    const subscriberSubscriptions = await subscriber.listMySubscriptions();
    expect(subscriberSubscriptions).toHaveLength(1);
    expect(subscriberSubscriptions[0].status).toBe("active");

    const toolSubscriptions = await tool.execute("tool-2b", {
      action: "list_my_subscriptions",
    });
    expect(toolSubscriptions.data as Subscription[]).toHaveLength(1);

    makeToolConfig("ag_owner", ownerKeys.privateKey);
    const subscribers = await tool.execute("tool-3", {
      action: "list_subscribers",
      product_id: createdProduct.product_id,
    });
    const subscriberList = subscribers.data as Subscription[];
    expect(subscriberList).toHaveLength(1);
    expect(subscriberList[0].subscriber_agent_id).toBe("ag_subscriber");

    makeToolConfig("ag_subscriber", subscriberKeys.privateKey);
    const cancelled = await tool.execute("tool-4", {
      action: "cancel",
      subscription_id: subscribedSubscription.subscription_id,
    });
    expect((cancelled.data as Subscription).status).toBe("cancelled");

    const afterCancel = await subscriber.listMySubscriptions();
    expect(afterCancel[0].status).toBe("cancelled");

    const subscriberWallet = await subscriber.getWallet();
    const ownerWallet = await owner.getWallet();
    expect(subscriberWallet.available_balance_minor).toBe("38000");
    expect(ownerWallet.available_balance_minor).toBe("12000");
  });

  it("archives products and blocks new subscriptions", async () => {
    const owner = makeClient("ag_owner", ownerKeys.privateKey);
    const subscriber = makeClient("ag_subscriber", subscriberKeys.privateKey);

    await seedBalance(subscriber, "20000");

    const product = await owner.createSubscriptionProduct({
      name: "Archive Soon",
      description: "Will be archived",
      amount_minor: "5000",
      billing_interval: "week",
    });
    const archived = await owner.archiveSubscriptionProduct(product.product_id);
    expect(archived.status).toBe("archived");

    await expect(
      subscriber.subscribeToProduct(product.product_id),
    ).rejects.toThrow("400");

    const activeProducts = await subscriber.listSubscriptionProducts();
    expect(activeProducts).toHaveLength(0);
  });

  it("charges renewals, skips duplicate processing, and auto-cancels after repeated failures", async () => {
    const owner = makeClient("ag_owner", ownerKeys.privateKey);
    const subscriber = makeClient("ag_subscriber", subscriberKeys.privateKey);

    await seedBalance(subscriber, "40000");
    const product = await owner.createSubscriptionProduct({
      name: "Weekly Pro",
      description: "Renewable weekly plan",
      amount_minor: "10000",
      billing_interval: "week",
    });
    const subscription = await subscriber.subscribeToProduct(product.product_id);
    const subscriptionId = subscription.subscription_id;
    const dueCycle = hub.state.subscriptions.find((item) => item.subscription_id === subscriptionId)?.next_charge_at;
    expect(dueCycle).toBeTruthy();

    const record = hub.state.subscriptions.find((item) => item.subscription_id === subscriptionId)!;
    record.next_charge_at = "2000-01-01T00:00:00.000Z";

    let resp = await fetch(`${hubUrl}/internal/subscriptions/run-billing`, {
      method: "POST",
    });
    expect(resp.ok).toBe(true);
    const firstRun = await resp.json();
    expect(firstRun.charged).toBe(1);

    let subscriberWallet = await subscriber.getWallet();
    let ownerWallet = await owner.getWallet();
    expect(subscriberWallet.available_balance_minor).toBe("20000");
    expect(ownerWallet.available_balance_minor).toBe("20000");

    record.next_charge_at = dueCycle!;
    resp = await fetch(`${hubUrl}/internal/subscriptions/run-billing`, {
      method: "POST",
    });
    const duplicateRun = await resp.json();
    expect(duplicateRun.processed).toBe(0);

    subscriberWallet = await subscriber.getWallet();
    ownerWallet = await owner.getWallet();
    expect(subscriberWallet.available_balance_minor).toBe("20000");
    expect(ownerWallet.available_balance_minor).toBe("20000");

    record.next_charge_at = "2000-01-01T00:00:00.000Z";

    const failureProduct = await owner.createSubscriptionProduct({
      name: "Failure Plan",
      description: "Used to exercise past due",
      amount_minor: "15000",
      billing_interval: "week",
    });
    const failureSubscription = await subscriber.subscribeToProduct(failureProduct.product_id);
    const failureRecord = hub.state.subscriptions.find(
      (item) => item.subscription_id === failureSubscription.subscription_id,
    )!;
    hub.state.wallets.get("ag_subscriber")!.available_balance_minor = 0;
    failureRecord.next_charge_at = "2000-01-01T00:00:00.000Z";

    let failedRuns = 0;
    for (let i = 0; i < 3; i += 1) {
      const retryDate = new Date(Date.UTC(2000, 0, 1 + i, 0, 0, 0)).toISOString();
      failureRecord.next_charge_at = retryDate;
      resp = await fetch(`${hubUrl}/internal/subscriptions/run-billing`, {
        method: "POST",
      });
      const result = await resp.json();
      failedRuns += result.failed;
    }

    expect(failedRuns).toBeGreaterThanOrEqual(1);
    expect(failureRecord.status).toBe("cancelled");
    expect(failureRecord.consecutive_failed_attempts).toBe(3);
    expect(failureRecord.cancelled_at).toBeTruthy();
  });
});
