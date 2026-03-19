import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BotCordClient } from "../client.js";
import { generateKeypair } from "../crypto.js";
import { createMockHub } from "./mock-hub.js";
import { createPaymentTool } from "../tools/payment.js";
import { setConfigGetter } from "../runtime.js";

const senderKeys = generateKeypair();
const receiverKeys = generateKeypair();

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
  hub.state.knownAgents.add("ag_sender");
  hub.state.knownAgents.add("ag_receiver");
  hub.state.tokens.clear();
  setConfigGetter(() => null);
});

describe("payment tool integration", () => {
  it("verifies recipient and sends transfers with payment metadata", async () => {
    const sender = makeClient("ag_sender", senderKeys.privateKey);
    const tool = createPaymentTool();

    await seedBalance(sender, "25000");
    makeToolConfig("ag_sender", senderKeys.privateKey);

    const recipient = await tool.execute("tool-1", {
      action: "recipient_verify",
      agent_id: "ag_receiver",
    });
    expect(recipient.data.agent_id).toBe("ag_receiver");

    const transfer = await tool.execute("tool-2", {
      action: "transfer",
      to_agent_id: "ag_receiver",
      amount_minor: "7000",
      memo: "invoice settlement",
      reference_type: "invoice",
      reference_id: "inv_123",
      metadata: { order_id: "ord_456" },
      idempotency_key: "pay-1",
    });

    expect(transfer.data.type).toBe("transfer");
    expect(transfer.data.to_agent_id).toBe("ag_receiver");
    expect(transfer.data.reference_type).toBe("invoice");
    expect(transfer.data.reference_id).toBe("inv_123");
    expect(JSON.parse(transfer.data.metadata_json)).toEqual({
      order_id: "ord_456",
      memo: "invoice settlement",
    });

    const txStatus = await tool.execute("tool-3", {
      action: "tx_status",
      tx_id: transfer.data.tx_id,
    });
    expect(txStatus.data.tx_id).toBe(transfer.data.tx_id);

    const ledger = await tool.execute("tool-4", {
      action: "ledger",
      type: "transfer",
    });
    expect(ledger.data.entries).toHaveLength(1);

    const balance = await tool.execute("tool-5", {
      action: "balance",
    });
    expect(balance.data.available_balance_minor).toBe("18000");
  });

  it("creates and cancels withdrawals through the unified payment tool", async () => {
    const sender = makeClient("ag_sender", senderKeys.privateKey);
    const tool = createPaymentTool();

    await seedBalance(sender, "10000");
    makeToolConfig("ag_sender", senderKeys.privateKey);

    const withdrawal = await tool.execute("tool-6", {
      action: "withdraw",
      amount_minor: "3000",
      destination_type: "mock_bank",
      destination: { account: "ending-1234" },
      idempotency_key: "wd-1",
    });
    expect(withdrawal.data.status).toBe("pending");

    const cancelled = await tool.execute("tool-7", {
      action: "cancel_withdrawal",
      withdrawal_id: withdrawal.data.withdrawal_id,
    });
    expect(cancelled.data.status).toBe("cancelled");

    const balance = await tool.execute("tool-8", {
      action: "balance",
    });
    expect(balance.data.available_balance_minor).toBe("10000");
    expect(balance.data.locked_balance_minor).toBe("0");
  });
});
