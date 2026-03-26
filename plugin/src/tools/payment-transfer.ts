import type { BotCordClient } from "../client.js";
import type { WalletTransaction } from "../types.js";
import { formatCoinAmount } from "./coin-format.js";

type FollowUpDeliveryResult = {
  attempted: true;
  sent: boolean;
  hub_msg_id?: string;
  error?: string;
};

export type TransferResult = {
  tx: WalletTransaction;
  transfer_record_message: FollowUpDeliveryResult;
  notifications: {
    payer: FollowUpDeliveryResult;
    payee: FollowUpDeliveryResult;
  };
};


function extractTransferMetadata(tx: WalletTransaction): Record<string, unknown> | null {
  if (!tx.metadata_json) return null;
  try {
    return typeof tx.metadata_json === "string"
      ? JSON.parse(tx.metadata_json)
      : tx.metadata_json;
  } catch {
    return null;
  }
}

function formatOptionalLine(label: string, value: string | null | undefined): string | null {
  return value ? `${label}: ${value}` : null;
}

export async function isPeerContact(client: BotCordClient, toAgentId: string): Promise<boolean> {
  const contacts = await client.listContacts();
  return contacts.some((contact) => contact.contact_agent_id === toAgentId);
}


export function buildTransferRecordMessage(tx: WalletTransaction): string {
  const metadata = extractTransferMetadata(tx);
  return [
    "[BotCord Transfer]",
    `Status: ${tx.status}`,
    `Transaction: ${tx.tx_id}`,
    `Amount: ${formatCoinAmount(tx.amount_minor)}`,
    `Asset: ${tx.asset_code}`,
    formatOptionalLine("From", tx.from_agent_id),
    formatOptionalLine("To", tx.to_agent_id),
    formatOptionalLine("Memo", typeof metadata?.memo === "string" ? metadata.memo : undefined),
    formatOptionalLine("Reference type", tx.reference_type),
    formatOptionalLine("Reference id", tx.reference_id),
    `Created: ${tx.created_at}`,
  ].filter(Boolean).join("\n");
}

export function buildTransferNotificationMessage(
  tx: WalletTransaction,
  role: "payer" | "payee",
): string {
  if (role === "payer") {
    return `[BotCord Notice] Transfer sent: ${formatCoinAmount(tx.amount_minor)} to ${tx.to_agent_id} (tx: ${tx.tx_id})`;
  }
  return `[BotCord Notice] Payment received: ${formatCoinAmount(tx.amount_minor)} from ${tx.from_agent_id} (tx: ${tx.tx_id})`;
}

export function formatFollowUpDeliverySummary(result: TransferResult): string {
  const lines = [
    `Transfer record message: ${result.transfer_record_message.sent ? "sent" : "failed"}`,
    `Payer notification: ${result.notifications.payer.sent ? "sent" : "failed"}`,
    `Payee notification: ${result.notifications.payee.sent ? "sent" : "failed"}`,
  ];
  const failures = [
    result.transfer_record_message.error,
    result.notifications.payer.error,
    result.notifications.payee.error,
  ].filter(Boolean);
  if (failures.length > 0) {
    lines.push("Warning: some follow-up messages failed to send.");
  }
  return lines.join("\n");
}

async function sendRecordMessage(
  client: BotCordClient,
  tx: WalletTransaction,
): Promise<FollowUpDeliveryResult> {
  try {
    const response = await client.sendMessage(tx.to_agent_id || "", buildTransferRecordMessage(tx));
    return { attempted: true, sent: true, hub_msg_id: response.hub_msg_id };
  } catch (err: any) {
    return { attempted: true, sent: false, error: err?.message ?? String(err) };
  }
}

async function sendNotification(
  client: BotCordClient,
  to: string,
  tx: WalletTransaction,
  role: "payer" | "payee",
): Promise<FollowUpDeliveryResult> {
  try {
    const response = await client.sendSystemMessage(to, buildTransferNotificationMessage(tx, role), {
      event: "wallet_transfer_notice",
      role,
      tx_id: tx.tx_id,
      amount_minor: tx.amount_minor,
      asset_code: tx.asset_code,
      from_agent_id: tx.from_agent_id,
      to_agent_id: tx.to_agent_id,
      reference_type: tx.reference_type,
      reference_id: tx.reference_id,
    });
    return { attempted: true, sent: true, hub_msg_id: response.hub_msg_id };
  } catch (err: any) {
    return { attempted: true, sent: false, error: err?.message ?? String(err) };
  }
}

export async function executeTransfer(
  client: BotCordClient,
  params: {
    to_agent_id: string;
    amount_minor: string;
    memo?: string;
    reference_type?: string;
    reference_id?: string;
    metadata?: Record<string, unknown>;
    idempotency_key?: string;
  },
): Promise<TransferResult> {
  const tx = await client.createTransfer(params);
  const [recordMessage, payerNotification, payeeNotification] = await Promise.all([
    sendRecordMessage(client, tx),
    sendNotification(client, client.getAgentId(), tx, "payer"),
    sendNotification(client, params.to_agent_id, tx, "payee"),
  ]);

  return {
    tx,
    transfer_record_message: recordMessage,
    notifications: {
      payer: payerNotification,
      payee: payeeNotification,
    },
  };
}
