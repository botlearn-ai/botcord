/**
 * botcord_payment — Unified payment and transaction tool for BotCord coin flows.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { getConfig as getAppConfig } from "../runtime.js";

function formatBalance(summary: any): string {
  const available = summary.available_balance_minor ?? "0";
  const locked = summary.locked_balance_minor ?? "0";
  const total = summary.total_balance_minor ?? "0";
  return [
    `Asset: ${summary.asset_code}`,
    `Available: ${available} minor units`,
    `Locked:    ${locked} minor units`,
    `Total:     ${total} minor units`,
    `Updated:   ${summary.updated_at}`,
  ].join("\n");
}

function formatRecipient(agent: any): string {
  return [
    `Agent: ${agent.agent_id}`,
    `Name: ${agent.display_name || "(none)"}`,
    `Policy: ${agent.message_policy || "(unknown)"}`,
    `Endpoints: ${Array.isArray(agent.endpoints) ? agent.endpoints.length : 0}`,
  ].join("\n");
}

function extractMetadata(tx: any): Record<string, unknown> | null {
  if (!tx?.metadata_json) return null;
  try {
    return typeof tx.metadata_json === "string"
      ? JSON.parse(tx.metadata_json)
      : tx.metadata_json;
  } catch {
    return null;
  }
}

function formatTransaction(tx: any): string {
  const lines = [
    `Transaction: ${tx.tx_id}`,
    `Type:   ${tx.type}`,
    `Status: ${tx.status}`,
    `Amount: ${tx.amount_minor} minor units`,
    `Fee:    ${tx.fee_minor} minor units`,
  ];
  if (tx.from_agent_id) lines.push(`From: ${tx.from_agent_id}`);
  if (tx.to_agent_id) lines.push(`To:   ${tx.to_agent_id}`);
  if (tx.reference_type) lines.push(`Reference type: ${tx.reference_type}`);
  if (tx.reference_id) lines.push(`Reference id:   ${tx.reference_id}`);
  const metadata = extractMetadata(tx);
  if (metadata?.memo) lines.push(`Memo: ${String(metadata.memo)}`);
  if (tx.idempotency_key) lines.push(`Idempotency: ${tx.idempotency_key}`);
  lines.push(`Created: ${tx.created_at}`);
  if (tx.completed_at) lines.push(`Completed: ${tx.completed_at}`);
  return lines.join("\n");
}

function formatTopup(topup: any): string {
  return [
    `Topup: ${topup.topup_id}`,
    `Status: ${topup.status}`,
    `Amount: ${topup.amount_minor} minor units`,
    `Channel: ${topup.channel}`,
    `Created: ${topup.created_at}`,
    topup.completed_at ? `Completed: ${topup.completed_at}` : null,
  ].filter(Boolean).join("\n");
}

function formatWithdrawal(withdrawal: any): string {
  return [
    `Withdrawal: ${withdrawal.withdrawal_id}`,
    `Status: ${withdrawal.status}`,
    `Amount: ${withdrawal.amount_minor} minor units`,
    `Fee: ${withdrawal.fee_minor ?? "0"} minor units`,
    withdrawal.destination_type ? `Destination type: ${withdrawal.destination_type}` : null,
    `Created: ${withdrawal.created_at}`,
    withdrawal.reviewed_at ? `Reviewed: ${withdrawal.reviewed_at}` : null,
    withdrawal.completed_at ? `Completed: ${withdrawal.completed_at}` : null,
  ].filter(Boolean).join("\n");
}

function formatLedger(data: any): string {
  const entries = data.entries ?? [];
  if (entries.length === 0) return "No payment ledger entries found.";

  const lines = entries.map((e: any) => {
    const dir = e.direction === "credit" ? "+" : "-";
    return `${e.created_at} | ${dir}${e.amount_minor} | bal=${e.balance_after_minor} | tx=${e.tx_id}`;
  });

  if (data.has_more) {
    lines.push(`\n(More entries available — use cursor: "${data.next_cursor}")`);
  }
  return lines.join("\n");
}

export function createPaymentTool() {
  return {
    name: "botcord_payment",
    description:
      "Manage BotCord coin payments and transactions: verify recipients, check balance, view ledger, transfer coins, create topups and withdrawals, cancel withdrawals, and query transaction status.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: [
            "recipient_verify",
            "balance",
            "ledger",
            "transfer",
            "topup",
            "withdraw",
            "cancel_withdrawal",
            "tx_status",
          ],
          description: "Payment action to perform",
        },
        agent_id: {
          type: "string" as const,
          description: "Agent ID (ag_...) — for recipient_verify",
        },
        to_agent_id: {
          type: "string" as const,
          description: "Recipient agent ID (ag_...) — for transfer",
        },
        amount_minor: {
          type: "string" as const,
          description: "Amount in minor units (string) — for transfer, topup, withdraw",
        },
        memo: {
          type: "string" as const,
          description: "Optional payment memo — for transfer",
        },
        reference_type: {
          type: "string" as const,
          description: "Optional business reference type — for transfer",
        },
        reference_id: {
          type: "string" as const,
          description: "Optional business reference ID — for transfer",
        },
        metadata: {
          type: "object" as const,
          description: "Optional metadata object — for transfer or topup",
        },
        idempotency_key: {
          type: "string" as const,
          description: "Optional idempotency key — for transfer, topup, withdraw",
        },
        channel: {
          type: "string" as const,
          description: "Topup channel (e.g. 'mock') — for topup",
        },
        destination_type: {
          type: "string" as const,
          description: "Withdrawal destination type — for withdraw",
        },
        destination: {
          type: "object" as const,
          description: "Withdrawal destination details — for withdraw",
        },
        fee_minor: {
          type: "string" as const,
          description: "Optional withdrawal fee in minor units — for withdraw",
        },
        withdrawal_id: {
          type: "string" as const,
          description: "Withdrawal ID — for cancel_withdrawal",
        },
        tx_id: {
          type: "string" as const,
          description: "Transaction ID — for tx_status",
        },
        cursor: {
          type: "string" as const,
          description: "Pagination cursor — for ledger",
        },
        limit: {
          type: "number" as const,
          description: "Max entries to return — for ledger",
        },
        type: {
          type: "string" as const,
          description: "Filter by transaction type — for ledger",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: any, args: any) => {
      const cfg = getAppConfig();
      if (!cfg) return { error: "No configuration available" };
      const singleAccountError = getSingleAccountModeError(cfg);
      if (singleAccountError) return { error: singleAccountError };

      const acct = resolveAccountConfig(cfg);
      if (!isAccountConfigured(acct)) {
        return { error: "BotCord is not configured." };
      }

      const client = new BotCordClient(acct);

      try {
        switch (args.action) {
          case "recipient_verify": {
            if (!args.agent_id) return { error: "agent_id is required" };
            const agent = await client.resolve(args.agent_id);
            return { result: formatRecipient(agent), data: agent };
          }

          case "balance": {
            const summary = await client.getWallet();
            return { result: formatBalance(summary), data: summary };
          }

          case "ledger": {
            const opts: { cursor?: string; limit?: number; type?: string } = {};
            if (args.cursor) opts.cursor = args.cursor;
            if (args.limit) opts.limit = args.limit;
            if (args.type) opts.type = args.type;
            const ledger = await client.getWalletLedger(opts);
            return { result: formatLedger(ledger), data: ledger };
          }

          case "transfer": {
            if (!args.to_agent_id) return { error: "to_agent_id is required" };
            if (!args.amount_minor) return { error: "amount_minor is required" };
            const tx = await client.createTransfer({
              to_agent_id: args.to_agent_id,
              amount_minor: args.amount_minor,
              memo: args.memo,
              reference_type: args.reference_type,
              reference_id: args.reference_id,
              metadata: args.metadata,
              idempotency_key: args.idempotency_key,
            });
            return { result: formatTransaction(tx), data: tx };
          }

          case "topup": {
            if (!args.amount_minor) return { error: "amount_minor is required" };
            const topup = await client.createTopup({
              amount_minor: args.amount_minor,
              channel: args.channel,
              metadata: args.metadata,
              idempotency_key: args.idempotency_key,
            });
            return { result: formatTopup(topup), data: topup };
          }

          case "withdraw": {
            if (!args.amount_minor) return { error: "amount_minor is required" };
            const withdrawal = await client.createWithdrawal({
              amount_minor: args.amount_minor,
              fee_minor: args.fee_minor,
              destination_type: args.destination_type,
              destination: args.destination,
              idempotency_key: args.idempotency_key,
            });
            return { result: formatWithdrawal(withdrawal), data: withdrawal };
          }

          case "cancel_withdrawal": {
            if (!args.withdrawal_id) return { error: "withdrawal_id is required" };
            const withdrawal = await client.cancelWithdrawal(args.withdrawal_id);
            return { result: formatWithdrawal(withdrawal), data: withdrawal };
          }

          case "tx_status": {
            if (!args.tx_id) return { error: "tx_id is required" };
            const tx = await client.getWalletTransaction(args.tx_id);
            return { result: formatTransaction(tx), data: tx };
          }

          default:
            return { error: `Unknown action: ${args.action}` };
        }
      } catch (err: any) {
        return { error: `Payment action failed: ${err.message}` };
      }
    },
  };
}
