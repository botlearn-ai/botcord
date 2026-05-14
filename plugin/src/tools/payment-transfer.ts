import type { BotCordClient } from "../client.js";
import type { WalletTransaction } from "../types.js";
import { formatCoinAmount } from "./coin-format.js";

type FollowUpDeliveryResult = {
  attempted: true;
  sent: boolean;
  target_id?: string;
  hub_msg_id?: string;
  error?: string;
};

export type TransferResult = {
  tx: WalletTransaction;
  transfer_record_message: FollowUpDeliveryResult;
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

export function formatFollowUpDeliverySummary(result: TransferResult): string {
  return `Transfer record message: ${result.transfer_record_message.sent ? "sent" : "failed"}${
    result.transfer_record_message.error ? ` (${result.transfer_record_message.error})` : ""
  }`;
}

async function sendRecordMessage(
  client: BotCordClient,
  tx: WalletTransaction,
  targetId?: string,
): Promise<FollowUpDeliveryResult> {
  const messageTarget = targetId || tx.to_agent_id || "";
  try {
    const response = await client.sendMessage(messageTarget, buildTransferRecordMessage(tx));
    return { attempted: true, sent: true, target_id: messageTarget, hub_msg_id: response.hub_msg_id };
  } catch (err: any) {
    return { attempted: true, sent: false, target_id: messageTarget, error: err?.message ?? String(err) };
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
    record_message_target_id?: string;
  },
): Promise<TransferResult> {
  const { record_message_target_id: recordMessageTargetId, ...transferParams } = params;
  const tx = await client.createTransfer(transferParams);
  const recordMessage = await sendRecordMessage(client, tx, recordMessageTargetId);

  return {
    tx,
    transfer_record_message: recordMessage,
  };
}
