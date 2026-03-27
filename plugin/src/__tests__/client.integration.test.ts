/**
 * Integration tests for BotCordClient against a mock Hub server.
 * Tests real HTTP connections, token lifecycle, retry logic, and all API methods.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BotCordClient } from "../client.js";
import { generateKeypair } from "../crypto.js";
import { createMockHub } from "./mock-hub.js";

const kp = generateKeypair();

let hub: ReturnType<typeof createMockHub>;
let hubUrl: string;

function makeClient(overrides?: Record<string, string>) {
  return new BotCordClient({
    hubUrl,
    agentId: "ag_testclient00",
    keyId: "k_test",
    privateKey: kp.privateKey,
    ...overrides,
  });
}

/** Helper: create a topup and complete it via internal endpoint to seed balance. */
async function seedBalance(client: BotCordClient, amountMinor: string) {
  const topup = await client.createTopup({ amount_minor: amountMinor });
  // Complete via internal mock endpoint
  await fetch(`${hubUrl}/internal/wallet/topups/${topup.topup_id}/complete`, {
    method: "POST",
  });
}

beforeAll(async () => {
  hub = createMockHub();
  hubUrl = await hub.start();
});

afterAll(async () => {
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
  hub.state.idempotencyKeys.clear();
  hub.state.knownAgents.clear();
  hub.state.knownAgents.add("ag_testclient00");
});

// ── Constructor ──────────────────────────────────────────────────

describe("constructor", () => {
  it("throws when required fields are missing", () => {
    expect(() => new BotCordClient({} as any)).toThrow("requires hubUrl");
    expect(() => new BotCordClient({ hubUrl: "x" } as any)).toThrow();
  });

  it("strips trailing slash from hubUrl", () => {
    const client = new BotCordClient({
      hubUrl: `${hubUrl}/`,
      agentId: "ag_x",
      keyId: "k_x",
      privateKey: kp.privateKey,
    });
    expect(client.getHubUrl()).toBe(hubUrl);
  });

  it("rejects non-loopback HTTP hub URLs", () => {
    expect(() => new BotCordClient({
      hubUrl: "http://api.botcord.chat",
      agentId: "ag_x",
      keyId: "k_x",
      privateKey: kp.privateKey,
    })).toThrow("must use https://");
  });

  it("allows loopback HTTP hub URLs for local development", () => {
    const client = new BotCordClient({
      hubUrl: "http://127.0.0.1:8000/",
      agentId: "ag_x",
      keyId: "k_x",
      privateKey: kp.privateKey,
    });
    expect(client.getHubUrl()).toBe("http://127.0.0.1:8000");
  });

  it("exposes agentId and hubUrl via accessors", () => {
    const client = makeClient();
    expect(client.getAgentId()).toBe("ag_testclient00");
    expect(client.getHubUrl()).toBe(hubUrl);
  });
});

// ── Token management ─────────────────────────────────────────────

describe("token management", () => {
  it("fetches token on first API call", async () => {
    const client = makeClient();
    await client.pollInbox();
    expect(hub.state.tokenRefreshCount).toBe(1);
  });

  it("reuses cached token across calls", async () => {
    const client = makeClient();
    await client.pollInbox();
    await client.pollInbox();
    await client.pollInbox();
    // Only 1 refresh, token reused for subsequent calls
    expect(hub.state.tokenRefreshCount).toBe(1);
  });

  it("re-authenticates on 401 response", async () => {
    const client = makeClient();
    // First call: get token and succeed
    await client.pollInbox();
    expect(hub.state.tokenRefreshCount).toBe(1);

    // Set override to return 401 once, then clear it
    let callCount = 0;
    hub.state.overrides.set("/hub/inbox", {
      status: 401,
      body: { error: "unauthorized" },
    });

    // The client should retry after 401 - but our override is persistent
    // so the retry will also get 401 and fail.
    // This tests that at least a token refresh is attempted.
    try {
      await client.pollInbox();
    } catch {
      // expected to fail since the override persists
    }
    // Token was refreshed on the 401
    expect(hub.state.tokenRefreshCount).toBeGreaterThanOrEqual(2);
  });

  it("seeds token from config and skips initial refresh", async () => {
    // Pre-register a token in the mock hub so it's accepted
    const preToken = "pre-seeded-jwt-token";
    hub.state.tokens.set(preToken, "ag_testclient00");

    const client = new BotCordClient({
      hubUrl,
      agentId: "ag_testclient00",
      keyId: "k_test",
      privateKey: kp.privateKey,
      token: preToken,
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await client.pollInbox();
    // No refresh needed — token was seeded from config
    expect(hub.state.tokenRefreshCount).toBe(0);
  });

  it("refreshes when seeded token is expired", async () => {
    const client = new BotCordClient({
      hubUrl,
      agentId: "ag_testclient00",
      keyId: "k_test",
      privateKey: kp.privateKey,
      token: "expired-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) - 100, // already expired
    });
    await client.pollInbox();
    // Expired token triggers a refresh
    expect(hub.state.tokenRefreshCount).toBe(1);
  });

  it("invokes onTokenRefresh callback after refresh", async () => {
    const client = makeClient();
    const calls: Array<{ token: string; expiresAt: number }> = [];
    client.onTokenRefresh = (token, expiresAt) => {
      calls.push({ token, expiresAt });
    };
    await client.pollInbox();
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toMatch(/^mock-jwt-token-/);
    expect(calls[0].expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("does not block request when onTokenRefresh throws", async () => {
    const client = makeClient();
    client.onTokenRefresh = () => {
      throw new Error("persistence failure");
    };
    // Should succeed despite callback throwing
    const result = await client.pollInbox();
    expect(result).toBeDefined();
  });

  it("401 retry uses refreshed token, not the stale one", async () => {
    const client = makeClient();
    // First call: get token #1
    await client.pollInbox();
    expect(hub.state.tokenRefreshCount).toBe(1);

    // Track tokens seen by onTokenRefresh.
    // When the callback fires, the 401 override has already been consumed
    // and we can safely remove it so the retry succeeds.
    const refreshedTokens: string[] = [];
    client.onTokenRefresh = (token) => {
      refreshedTokens.push(token);
      hub.state.overrides.delete("/hub/inbox");
    };

    // Set a persistent 401 override. The onTokenRefresh callback above
    // deletes it after the refresh, so the retry sees no override.
    hub.state.overrides.set("/hub/inbox", {
      status: 401,
      body: { error: "unauthorized" },
    });

    const result = await client.pollInbox();
    expect(result).toBeDefined();
    // Refresh happened and onTokenRefresh was called with new token
    expect(hub.state.tokenRefreshCount).toBe(2);
    expect(refreshedTokens).toHaveLength(1);
    expect(refreshedTokens[0]).toMatch(/^mock-jwt-token-2-/);
  });
});

// ── Messaging ────────────────────────────────────────────────────

describe("sendMessage", () => {
  it("sends a signed envelope to the Hub", async () => {
    const client = makeClient();
    const result = await client.sendMessage("ag_receiver1234", "Hello!");

    expect(result.queued).toBe(true);
    expect(result.hub_msg_id).toBeTruthy();
    expect(hub.state.messages).toHaveLength(1);

    const sent = hub.state.messages[0].envelope;
    expect(sent.from).toBe("ag_testclient00");
    expect(sent.to).toBe("ag_receiver1234");
    expect(sent.type).toBe("message");
    expect(sent.payload.text).toBe("Hello!");
    expect(sent.sig.alg).toBe("ed25519");
  });

  it("includes topic as query param", async () => {
    const client = makeClient();
    await client.sendMessage("ag_receiver1234", "Topic msg", { topic: "general" });

    expect(hub.state.messages).toHaveLength(1);
    expect(hub.state.messages[0].topic).toBe("general");
  });

  it("sends multiple messages sequentially", async () => {
    const client = makeClient();
    await client.sendMessage("ag_a", "first");
    await client.sendMessage("ag_b", "second");
    await client.sendMessage("ag_c", "third");

    expect(hub.state.messages).toHaveLength(3);
    expect(hub.state.messages.map((m) => m.envelope.payload.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("sendEnvelope", () => {
  it("sends a pre-built envelope", async () => {
    const { buildSignedEnvelope } = await import("../crypto.js");
    const client = makeClient();

    const envelope = buildSignedEnvelope({
      from: "ag_testclient00",
      to: "ag_custom",
      type: "ack",
      payload: { status: "received" },
      privateKey: kp.privateKey,
      keyId: "k_test",
    });

    const result = await client.sendEnvelope(envelope, "my-topic");
    expect(result.queued).toBe(true);
    expect(hub.state.messages[0].envelope.type).toBe("ack");
    expect(hub.state.messages[0].topic).toBe("my-topic");
  });
});

// ── Inbox ────────────────────────────────────────────────────────

describe("pollInbox", () => {
  it("returns empty inbox", async () => {
    const client = makeClient();
    const result = await client.pollInbox();
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("returns queued messages", async () => {
    hub.state.inbox.push(
      { hub_msg_id: "h1", envelope: { from: "ag_sender", payload: { text: "hi" } } },
      { hub_msg_id: "h2", envelope: { from: "ag_sender", payload: { text: "hey" } } },
    );

    const client = makeClient();
    const result = await client.pollInbox({ limit: 10 });
    expect(result.messages).toHaveLength(2);
    expect(result.count).toBe(2);
  });

  it("ack removes messages from inbox", async () => {
    hub.state.inbox.push(
      { hub_msg_id: "h1", envelope: { from: "ag_x", payload: { text: "a" } } },
    );

    const client = makeClient();
    await client.pollInbox({ ack: true });
    expect(hub.state.inbox).toHaveLength(0);
  });
});

describe("getHistory", () => {
  it("returns message history", async () => {
    const client = makeClient();
    // Send some messages first
    await client.sendMessage("ag_peer", "msg1");
    await client.sendMessage("ag_peer", "msg2");

    const history = await client.getHistory({ peer: "ag_peer" });
    expect(history.messages).toHaveLength(2);
  });
});

// ── Registry ─────────────────────────────────────────────────────

describe("resolve", () => {
  it("resolves agent info", async () => {
    const client = makeClient();
    const info = await client.resolve("ag_target123456");
    expect(info.agent_id).toBe("ag_target123456");
    expect(info.display_name).toBe("Agent ag_target123456");
  });
});

// ── Contacts ─────────────────────────────────────────────────────

describe("contacts", () => {
  it("lists contacts", async () => {
    hub.state.contacts = [
      { contact_agent_id: "ag_friend", display_name: "Friend", created_at: "2025-01-01T00:00:00Z" },
    ];
    const client = makeClient();
    const contacts = await client.listContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].contact_agent_id).toBe("ag_friend");
  });

  it("lists blocks", async () => {
    const client = makeClient();
    const blocks = await client.listBlocks();
    expect(blocks).toEqual([]);
  });
});

// ── Rooms ────────────────────────────────────────────────────────

describe("rooms", () => {
  it("creates a room and lists it", async () => {
    const client = makeClient();
    const room = await client.createRoom({
      name: "Test Room",
      visibility: "public",
      rule: "Keep it short",
      required_subscription_product_id: "sp_gold",
      max_members: 42,
      default_invite: true,
      slow_mode_seconds: 30,
      member_ids: ["ag_member1", "ag_member2"],
    });

    expect(room.room_id).toMatch(/^rm_/);
    expect(room.name).toBe("Test Room");
    expect(room.rule).toBe("Keep it short");
    expect(room.required_subscription_product_id).toBe("sp_gold");
    expect(room.max_members).toBe(42);
    expect(room.default_invite).toBe(true);
    expect(room.slow_mode_seconds).toBe(30);

    const myRooms = await client.listMyRooms();
    expect(myRooms).toHaveLength(1);
    expect(myRooms[0].name).toBe("Test Room");
    expect(myRooms[0].rule).toBe("Keep it short");
    expect(myRooms[0].required_subscription_product_id).toBe("sp_gold");
  });

  it("gets room info by ID", async () => {
    const client = makeClient();
    const room = await client.createRoom({ name: "Info Room" });
    const info = await client.getRoomInfo(room.room_id);
    expect(info.name).toBe("Info Room");
  });

  it("creates a subscription-gated room when product ID is provided", async () => {
    const client = makeClient();
    const room = await client.createRoom({
      name: "Subscribers",
      required_subscription_product_id: "sp_testproduct",
    });

    expect(room.required_subscription_product_id).toBe("sp_testproduct");
    expect(hub.state.rooms[0].required_subscription_product_id).toBe("sp_testproduct");
  });

  it("updates room rule", async () => {
    const client = makeClient();
    const room = await client.createRoom({ name: "Rule Room", rule: "Initial rule" });

    const updated = await client.updateRoom(room.room_id, {
      rule: "Updated rule",
      required_subscription_product_id: "sp_premium",
      max_members: 100,
      default_invite: true,
      slow_mode_seconds: 10,
    });

    expect(updated.rule).toBe("Updated rule");
    expect(updated.required_subscription_product_id).toBe("sp_premium");
    expect(updated.max_members).toBe(100);
    expect(updated.default_invite).toBe(true);
    expect(updated.slow_mode_seconds).toBe(10);
    expect(hub.state.rooms[0].rule).toBe("Updated rule");
    expect(hub.state.rooms[0].required_subscription_product_id).toBe("sp_premium");
  });

  it("updates room subscription requirement", async () => {
    const client = makeClient();
    const room = await client.createRoom({ name: "Paid Room" });

    const updated = await client.updateRoom(room.room_id, {
      required_subscription_product_id: "sp_updated",
    });

    expect(updated.required_subscription_product_id).toBe("sp_updated");
    expect(hub.state.rooms[0].required_subscription_product_id).toBe("sp_updated");
  });

  it("clears room rule when update sends null", async () => {
    const client = makeClient();
    const room = await client.createRoom({ name: "Clear Rule Room", rule: "Temp rule" });

    const updated = await client.updateRoom(room.room_id, {
      rule: null,
    });

    expect(updated.rule).toBeNull();
    expect(hub.state.rooms[0].rule).toBeNull();
  });

  it("returns 404 for unknown room", async () => {
    const client = makeClient();
    await expect(client.getRoomInfo("rm_nonexistent")).rejects.toThrow("404");
  });
});

// ── Contact requests ─────────────────────────────────────────────

describe("contact requests", () => {
  it("lists received requests", async () => {
    const client = makeClient();
    const requests = await client.listReceivedRequests("pending");
    expect(requests).toEqual([]);
  });

  it("lists sent requests", async () => {
    const client = makeClient();
    const requests = await client.listSentRequests();
    expect(requests).toEqual([]);
  });
});

// ── Wallet ──────────────────────────────────────────────────

describe("wallet", () => {
  it("returns default zero balance", async () => {
    const client = makeClient();
    const wallet = await client.getWallet();
    expect(wallet.agent_id).toBe("ag_testclient00");
    expect(wallet.asset_code).toBe("COIN");
    expect(wallet.available_balance_minor).toBe("0");
    expect(wallet.locked_balance_minor).toBe("0");
    expect(wallet.total_balance_minor).toBe("0");
  });

  it("topup creates pending request without crediting balance", async () => {
    const client = makeClient();
    const result = await client.createTopup({ amount_minor: "10000", channel: "mock" });
    expect(result.status).toBe("pending");
    expect(result.amount_minor).toBe("10000");
    expect(result.topup_id).toMatch(/^tu_/);

    // Balance should NOT increase yet
    const wallet = await client.getWallet();
    expect(wallet.available_balance_minor).toBe("0");
  });

  it("topup idempotency — same key returns same result without duplication", async () => {
    const client = makeClient();
    const key = "idem-topup-1";
    const r1 = await client.createTopup({ amount_minor: "5000", idempotency_key: key });
    const r2 = await client.createTopup({ amount_minor: "5000", idempotency_key: key });
    expect(r1.topup_id).toBe(r2.topup_id);

    // Balance still zero — pending topups don't credit
    const wallet = await client.getWallet();
    expect(wallet.available_balance_minor).toBe("0");
  });

  it("transfer moves coins between agents", async () => {
    const client = makeClient();
    hub.state.knownAgents.add("ag_receiver1234");
    await seedBalance(client, "20000");

    const tx = await client.createTransfer({
      to_agent_id: "ag_receiver1234",
      amount_minor: "8000",
      memo: "test payment",
    });
    expect(tx.type).toBe("transfer");
    expect(tx.status).toBe("completed");
    expect(tx.amount_minor).toBe("8000");
    expect(tx.from_agent_id).toBe("ag_testclient00");
    expect(tx.to_agent_id).toBe("ag_receiver1234");
    // memo is stored in metadata_json, not as top-level field
    expect(tx.metadata_json).toBe(JSON.stringify({ memo: "test payment" }));

    const wallet = await client.getWallet();
    expect(wallet.available_balance_minor).toBe("12000");
  });

  it("transfer rejects insufficient balance", async () => {
    const client = makeClient();
    hub.state.knownAgents.add("ag_other");
    await expect(
      client.createTransfer({ to_agent_id: "ag_other", amount_minor: "999999" }),
    ).rejects.toThrow("400");
  });

  it("transfer rejects unknown recipient", async () => {
    const client = makeClient();
    await seedBalance(client, "5000");
    await expect(
      client.createTransfer({ to_agent_id: "ag_unknown", amount_minor: "100" }),
    ).rejects.toThrow("400");
  });

  it("transfer rejects self-transfer", async () => {
    const client = makeClient();
    await seedBalance(client, "1000");
    await expect(
      client.createTransfer({ to_agent_id: "ag_testclient00", amount_minor: "100" }),
    ).rejects.toThrow("400");
  });

  it("transfer idempotency — same key returns same result", async () => {
    const client = makeClient();
    hub.state.knownAgents.add("ag_receiver1234");
    await seedBalance(client, "10000");

    const key = "idem-transfer-1";
    const r1 = await client.createTransfer({
      to_agent_id: "ag_receiver1234",
      amount_minor: "3000",
      idempotency_key: key,
    });
    const r2 = await client.createTransfer({
      to_agent_id: "ag_receiver1234",
      amount_minor: "3000",
      idempotency_key: key,
    });
    expect(r1.tx_id).toBe(r2.tx_id);

    // Only deducted once
    const wallet = await client.getWallet();
    expect(wallet.available_balance_minor).toBe("7000");
  });

  it("withdrawal locks balance", async () => {
    const client = makeClient();
    await seedBalance(client, "15000");

    const result = await client.createWithdrawal({ amount_minor: "5000" });
    expect(result.status).toBe("pending");
    expect(result.withdrawal_id).toMatch(/^wd_/);

    const wallet = await client.getWallet();
    expect(wallet.available_balance_minor).toBe("10000");
    expect(wallet.locked_balance_minor).toBe("5000");
  });

  it("withdrawal rejects insufficient balance", async () => {
    const client = makeClient();
    await expect(
      client.createWithdrawal({ amount_minor: "999999" }),
    ).rejects.toThrow("400");
  });

  it("ledger returns entries for the agent", async () => {
    const client = makeClient();
    hub.state.knownAgents.add("ag_other");
    await seedBalance(client, "5000");
    await client.createTransfer({ to_agent_id: "ag_other", amount_minor: "2000" });

    const ledger = await client.getWalletLedger();
    // topup credit + transfer debit = 2 entries
    expect(ledger.entries.length).toBeGreaterThanOrEqual(2);
    expect(ledger.entries.every((e: any) => e.agent_id === "ag_testclient00")).toBe(true);
  });

  it("getWalletTransaction returns transaction detail", async () => {
    const client = makeClient();
    hub.state.knownAgents.add("ag_other");
    await seedBalance(client, "1000");
    const transfer = await client.createTransfer({
      to_agent_id: "ag_other",
      amount_minor: "500",
    });

    const tx = await client.getWalletTransaction(transfer.tx_id);
    expect(tx.tx_id).toBe(transfer.tx_id);
    expect(tx.type).toBe("transfer");
  });

  it("getWalletTransaction returns 404 for unknown tx", async () => {
    const client = makeClient();
    await expect(client.getWalletTransaction("tx_nonexistent")).rejects.toThrow("404");
  });
});

// ── Error handling ───────────────────────────────────────────────

describe("error handling", () => {
  it("throws on 500 server error", async () => {
    hub.state.overrides.set("/hub/send", {
      status: 500,
      body: { error: "internal error" },
    });

    const client = makeClient();
    await expect(client.sendMessage("ag_x", "fail")).rejects.toThrow("500");
  });

  it("throws with status property on error", async () => {
    hub.state.overrides.set("/hub/send", {
      status: 403,
      body: { error: "forbidden" },
    });

    const client = makeClient();
    try {
      await client.sendMessage("ag_x", "fail");
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(403);
    }
  });

  it("retries on 429 rate limit", async () => {
    let callCount = 0;
    // We need a dynamic override — use the override to return 429 first time
    hub.state.overrides.set("/hub/rooms/me", {
      status: 429,
      body: { error: "rate limited" },
      headers: { "Retry-After": "0" },
    });

    const client = makeClient();
    // Will retry MAX_RETRIES times then fail
    await expect(client.listMyRooms()).rejects.toThrow();
  });
});
