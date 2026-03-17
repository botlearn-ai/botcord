/**
 * botcord_wallet — Manage the agent's coin wallet: balance, ledger, transfers, topups, withdrawals.
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

function extractMemo(tx: any): string | null {
  if (!tx.metadata_json) return null;
  try {
    const meta = typeof tx.metadata_json === "string"
      ? JSON.parse(tx.metadata_json)
      : tx.metadata_json;
    return meta?.memo ?? null;
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
  const memo = extractMemo(tx);
  if (memo) lines.push(`Memo: ${memo}`);
  lines.push(`Created: ${tx.created_at}`);
  if (tx.completed_at) lines.push(`Completed: ${tx.completed_at}`);
  return lines.join("\n");
}

function formatLedger(data: any): string {
  const entries = data.entries ?? [];
  if (entries.length === 0) return "No ledger entries found.";

  const lines = entries.map((e: any) => {
    const dir = e.direction === "credit" ? "+" : "-";
    return `${e.created_at} | ${dir}${e.amount_minor} | bal=${e.balance_after_minor} | tx=${e.tx_id}`;
  });

  if (data.has_more) {
    lines.push(`\n(More entries available — use cursor: "${data.next_cursor}")`);
  }
  return lines.join("\n");
}

export function createWalletTool() {
  return {
    name: "botcord_wallet",
    description:
      "Manage your BotCord coin wallet: check balance, view ledger, transfer coins, request topup/withdrawal, check transaction status.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["balance", "ledger", "transfer", "topup", "withdraw", "tx_status"],
          description: "Wallet action to perform",
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
          description: "Optional memo — for transfer",
        },
        idempotency_key: {
          type: "string" as const,
          description: "Optional idempotency key (UUID) — for transfer, withdraw",
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
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
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
              idempotency_key: args.idempotency_key,
            });
            return { result: formatTransaction(tx), data: tx };
          }

          case "topup": {
            if (!args.amount_minor) return { error: "amount_minor is required" };
            const topup = await client.createTopup({
              amount_minor: args.amount_minor,
              channel: args.channel,
              idempotency_key: args.idempotency_key,
            });
            return { result: `Topup request created: ${JSON.stringify(topup)}`, data: topup };
          }

          case "withdraw": {
            if (!args.amount_minor) return { error: "amount_minor is required" };
            const withdrawal = await client.createWithdrawal({
              amount_minor: args.amount_minor,
              destination_type: args.destination_type,
              destination: args.destination,
              idempotency_key: args.idempotency_key,
            });
            return {
              result: `Withdrawal request created: ${JSON.stringify(withdrawal)}`,
              data: withdrawal,
            };
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
        return { error: `Wallet action failed: ${err.message}` };
      }
    },
  };
}
