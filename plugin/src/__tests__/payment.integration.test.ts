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
    hub.state.contacts = [
      { contact_agent_id: "ag_receiver", display_name: "Receiver", created_at: new Date().toISOString() },
    ];
    makeToolConfig("ag_sender", senderKeys.privateKey);

    const recipient: any = await tool.execute("tool-1", {
      action: "recipient_verify",
      agent_id: "ag_receiver",
    });
    expect(recipient.data.agent_id).toBe("ag_receiver");

    const transfer: any = await tool.execute("tool-2", {
      action: "transfer",
      to_agent_id: "ag_receiver",
      amount: "70",
      memo: "invoice settlement",
      reference_type: "invoice",
      reference_id: "inv_123",
      metadata: { order_id: "ord_456" },
      idempotency_key: "pay-1",
    });

    expect(transfer.data.tx.type).toBe("transfer");
    expect(transfer.data.tx.to_agent_id).toBe("ag_receiver");
    expect(transfer.data.tx.reference_type).toBe("invoice");
    expect(transfer.data.tx.reference_id).toBe("inv_123");
    expect(transfer.data.tx.metadata_json).toBeUndefined();
    expect(transfer.data.tx.metadata).toEqual({
      order_id: "ord_456",
      memo: "invoice settlement",
    });
    expect(transfer.data.transfer_record_message.sent).toBe(true);
    expect(transfer.result).toContain("Transfer record message: sent");
    expect(hub.state.messages).toHaveLength(1);

    const envelopes = hub.state.messages.map((entry) => entry.envelope);
    const recordMessage = envelopes.find((envelope) =>
      envelope.type === "message" &&
      envelope.to === "ag_receiver" &&
      typeof envelope.payload?.text === "string" &&
      envelope.payload.text.includes("[BotCord Transfer]"),
    );

    expect(recordMessage).toBeTruthy();
    if (!recordMessage) {
      throw new Error("expected transfer record message to be present");
    }
    expect(recordMessage.payload.text).toContain(transfer.data.tx.tx_id);

    const txStatus: any = await tool.execute("tool-3", {
      action: "tx_status",
      tx_id: transfer.data.tx.tx_id,
    });
    expect(txStatus.data.tx_id).toBe(transfer.data.tx.tx_id);
    expect(txStatus.data.amount_minor).toBeUndefined();
    expect(txStatus.data.amount).toBe("70.00 COIN");
    expect(txStatus.result).toContain("Amount: 70.00 COIN");

    const ledger: any = await tool.execute("tool-4", {
      action: "ledger",
      type: "transfer",
    });
    expect(ledger.data.entries).toHaveLength(1);
    expect(ledger.data.entries[0].amount_minor).toBeUndefined();
    expect(ledger.data.entries[0].amount).toBe("70.00 COIN");
    expect(ledger.result).toContain("-70.00 COIN");

    const balance: any = await tool.execute("tool-5", {
      action: "balance",
    });
    expect(balance.data.available_balance_minor).toBeUndefined();
    expect(balance.data.available_balance).toBe("180.00 COIN");
    expect(balance.result).toContain("Available: 180.00 COIN");
  });

  it("transfers to contacts without requiring confirmation", async () => {
    const sender = makeClient("ag_sender", senderKeys.privateKey);
    const tool = createPaymentTool();

    await seedBalance(sender, "25000");
    hub.state.contacts = [
      { contact_agent_id: "ag_receiver", display_name: "Receiver", created_at: new Date().toISOString() },
    ];
    makeToolConfig("ag_sender", senderKeys.privateKey);

    // No confirmed param needed — recipient is a contact
    const transfer: any = await tool.execute("tool-contact-transfer", {
      action: "transfer",
      to_agent_id: "ag_receiver",
      amount: "50",
    });

    expect(transfer.data.tx.type).toBe("transfer");
    expect(transfer.data.tx.to_agent_id).toBe("ag_receiver");
    expect(transfer.result).not.toContain("is not in your contacts");
    expect(transfer.data.transfer_record_message.sent).toBe(true);
    expect(hub.state.messages).toHaveLength(1);
  });

  it("requires confirmation for stranger transfers", async () => {
    const sender = makeClient("ag_sender", senderKeys.privateKey);
    const tool = createPaymentTool();

    await seedBalance(sender, "25000");
    makeToolConfig("ag_sender", senderKeys.privateKey);

    // First call without confirmed — should return a warning, no transfer executed
    const warning: any = await tool.execute("tool-non-contact", {
      action: "transfer",
      to_agent_id: "ag_receiver",
      amount: "70",
    });

    expect(warning.result).toContain("is not in your contacts");
    expect(warning.result).toContain("stranger transfer");
    expect(warning.result).toContain("confirmed: true");
    expect(warning.data).toBeUndefined();
    expect(hub.state.walletTransactions).toHaveLength(1); // only the topup
    expect(hub.state.messages).toHaveLength(0);

    // Second call with confirmed: true — should proceed
    const transfer: any = await tool.execute("tool-non-contact-confirm", {
      action: "transfer",
      to_agent_id: "ag_receiver",
      amount: "70",
      confirmed: true,
    });

    expect(transfer.data.tx.type).toBe("transfer");
    expect(transfer.data.tx.to_agent_id).toBe("ag_receiver");
    expect(hub.state.messages).toHaveLength(1);
  });

  it("keeps transfer successful when follow-up messages fail", async () => {
    const sender = makeClient("ag_sender", senderKeys.privateKey);
    const tool = createPaymentTool();

    await seedBalance(sender, "25000");
    hub.state.contacts = [
      { contact_agent_id: "ag_receiver", display_name: "Receiver", created_at: new Date().toISOString() },
    ];
    hub.state.overrides.set("/hub/send", {
      status: 500,
      body: { error: "send failed" },
    });
    makeToolConfig("ag_sender", senderKeys.privateKey);

    const transfer: any = await tool.execute("tool-followup-fail", {
      action: "transfer",
      to_agent_id: "ag_receiver",
      amount: "70",
    });

    expect(transfer.data.tx.type).toBe("transfer");
    expect(transfer.data.transfer_record_message.sent).toBe(false);
    expect(transfer.result).toContain("Transfer record message: failed");

    const balance: any = await tool.execute("tool-followup-fail-balance", {
      action: "balance",
    });
    expect(balance.data.available_balance_minor).toBeUndefined();
    expect(balance.data.available_balance).toBe("180.00 COIN");
  });

  it("creates and cancels withdrawals through the unified payment tool", async () => {
    const sender = makeClient("ag_sender", senderKeys.privateKey);
    const tool = createPaymentTool();

    await seedBalance(sender, "10000");
    makeToolConfig("ag_sender", senderKeys.privateKey);

    const withdrawal: any = await tool.execute("tool-6", {
      action: "withdraw",
      amount: "30",
      destination_type: "mock_bank",
      destination: { account: "ending-1234" },
      idempotency_key: "wd-1",
    });
    expect(withdrawal.data.status).toBe("pending");
    expect(withdrawal.data.amount_minor).toBeUndefined();
    expect(withdrawal.data.amount).toBe("30.00 COIN");
    expect(withdrawal.result).toContain("Amount: 30.00 COIN");

    const cancelled: any = await tool.execute("tool-7", {
      action: "cancel_withdrawal",
      withdrawal_id: withdrawal.data.withdrawal_id,
    });
    expect(cancelled.data.status).toBe("cancelled");
    expect(cancelled.data.amount_minor).toBeUndefined();
    expect(cancelled.result).toContain("Amount: 30.00 COIN");

    const balance: any = await tool.execute("tool-8", {
      action: "balance",
    });
    expect(balance.data.available_balance_minor).toBeUndefined();
    expect(balance.data.locked_balance_minor).toBeUndefined();
    expect(balance.data.available_balance).toBe("100.00 COIN");
    expect(balance.data.locked_balance).toBe("0.00 COIN");
    expect(balance.result).toContain("Available: 100.00 COIN");
  });
});
