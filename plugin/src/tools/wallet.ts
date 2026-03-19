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
import { formatCoinAmount } from "./coin-format.js";
import { executeContactOnlyTransfer, formatFollowUpDeliverySummary } from "./payment-transfer.js";

function sanitizeBalance(summary: any): any {
  return {
    agent_id: summary.agent_id,
    asset_code: summary.asset_code,
    available_balance: formatCoinAmount(summary.available_balance_minor),
    locked_balance: formatCoinAmount(summary.locked_balance_minor),
    total_balance: formatCoinAmount(summary.total_balance_minor),
    updated_at: summary.updated_at,
  };
}

function formatBalance(summary: any): string {
  const available = summary.available_balance_minor ?? "0";
  const locked = summary.locked_balance_minor ?? "0";
  const total = summary.total_balance_minor ?? "0";
  return [
    `Asset: ${summary.asset_code}`,
    `Available: ${formatCoinAmount(available)}`,
    `Locked:    ${formatCoinAmount(locked)}`,
    `Total:     ${formatCoinAmount(total)}`,
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

function sanitizeTransaction(tx: any): any {
  return {
    tx_id: tx.tx_id,
    type: tx.type,
    status: tx.status,
    asset_code: tx.asset_code,
    amount: formatCoinAmount(tx.amount_minor),
    fee: formatCoinAmount(tx.fee_minor),
    from_agent_id: tx.from_agent_id,
    to_agent_id: tx.to_agent_id,
    memo: extractMemo(tx) ?? undefined,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
    completed_at: tx.completed_at,
  };
}

function sanitizeTransferResult(transfer: any): any {
  return {
    tx: sanitizeTransaction(transfer.tx),
    transfer_record_message: transfer.transfer_record_message,
    notifications: transfer.notifications,
  };
}

function formatTransaction(tx: any): string {
  const lines = [
    `Transaction: ${tx.tx_id}`,
    `Type:   ${tx.type}`,
    `Status: ${tx.status}`,
    `Amount: ${formatCoinAmount(tx.amount_minor)}`,
    `Fee:    ${formatCoinAmount(tx.fee_minor)}`,
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
    return `${e.created_at} | ${dir}${formatCoinAmount(e.amount_minor)} | bal=${formatCoinAmount(e.balance_after_minor)} | tx=${e.tx_id}`;
  });

  if (data.has_more) {
    lines.push(`\n(More entries available — use cursor: "${data.next_cursor}")`);
  }
  return lines.join("\n");
}

function sanitizeLedger(data: any): any {
  const entries = (data.entries ?? []).map((entry: any) => ({
    entry_id: entry.entry_id,
    tx_id: entry.tx_id,
    direction: entry.direction,
    amount: formatCoinAmount(entry.amount_minor),
    balance_after: formatCoinAmount(entry.balance_after_minor),
    created_at: entry.created_at,
  }));

  return {
    entries,
    next_cursor: data.next_cursor,
    has_more: data.has_more,
  };
}

function formatTopup(topup: any): string {
  return [
    `Topup: ${topup.topup_id}`,
    `Status: ${topup.status}`,
    `Amount: ${formatCoinAmount(topup.amount_minor)}`,
    `Channel: ${topup.channel}`,
    `Created: ${topup.created_at}`,
    topup.completed_at ? `Completed: ${topup.completed_at}` : null,
  ].filter(Boolean).join("\n");
}

function sanitizeTopup(topup: any): any {
  return {
    topup_id: topup.topup_id,
    status: topup.status,
    asset_code: topup.asset_code,
    amount: formatCoinAmount(topup.amount_minor),
    channel: topup.channel,
    idempotency_key: topup.idempotency_key,
    created_at: topup.created_at,
    updated_at: topup.updated_at,
    completed_at: topup.completed_at,
  };
}

function formatWithdrawal(withdrawal: any): string {
  return [
    `Withdrawal: ${withdrawal.withdrawal_id}`,
    `Status: ${withdrawal.status}`,
    `Amount: ${formatCoinAmount(withdrawal.amount_minor)}`,
    `Fee: ${formatCoinAmount(withdrawal.fee_minor)}`,
    withdrawal.destination_type ? `Destination type: ${withdrawal.destination_type}` : null,
    `Created: ${withdrawal.created_at}`,
    withdrawal.reviewed_at ? `Reviewed: ${withdrawal.reviewed_at}` : null,
    withdrawal.completed_at ? `Completed: ${withdrawal.completed_at}` : null,
  ].filter(Boolean).join("\n");
}

function sanitizeWithdrawal(withdrawal: any): any {
  return {
    withdrawal_id: withdrawal.withdrawal_id,
    status: withdrawal.status,
    asset_code: withdrawal.asset_code,
    amount: formatCoinAmount(withdrawal.amount_minor),
    fee: formatCoinAmount(withdrawal.fee_minor),
    destination_type: withdrawal.destination_type,
    destination: withdrawal.destination,
    idempotency_key: withdrawal.idempotency_key,
    created_at: withdrawal.created_at,
    updated_at: withdrawal.updated_at,
    reviewed_at: withdrawal.reviewed_at,
    completed_at: withdrawal.completed_at,
  };
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
            return { result: formatBalance(summary), data: sanitizeBalance(summary) };
          }

          case "ledger": {
            const opts: { cursor?: string; limit?: number; type?: string } = {};
            if (args.cursor) opts.cursor = args.cursor;
            if (args.limit) opts.limit = args.limit;
            if (args.type) opts.type = args.type;
            const ledger = await client.getWalletLedger(opts);
            return { result: formatLedger(ledger), data: sanitizeLedger(ledger) };
          }

          case "transfer": {
            if (!args.to_agent_id) return { error: "to_agent_id is required" };
            if (!args.amount_minor) return { error: "amount_minor is required" };
            const transfer = await executeContactOnlyTransfer(client, {
              to_agent_id: args.to_agent_id,
              amount_minor: args.amount_minor,
              memo: args.memo,
              idempotency_key: args.idempotency_key,
            });
            return {
              result: `${formatTransaction(transfer.tx)}\n${formatFollowUpDeliverySummary(transfer)}`,
              data: sanitizeTransferResult(transfer),
            };
          }

          case "topup": {
            if (!args.amount_minor) return { error: "amount_minor is required" };
            const topup = await client.createTopup({
              amount_minor: args.amount_minor,
              channel: args.channel,
              idempotency_key: args.idempotency_key,
            });
            return { result: formatTopup(topup), data: sanitizeTopup(topup) };
          }

          case "withdraw": {
            if (!args.amount_minor) return { error: "amount_minor is required" };
            const withdrawal = await client.createWithdrawal({
              amount_minor: args.amount_minor,
              destination_type: args.destination_type,
              destination: args.destination,
              idempotency_key: args.idempotency_key,
            });
            return { result: formatWithdrawal(withdrawal), data: sanitizeWithdrawal(withdrawal) };
          }

          case "tx_status": {
            if (!args.tx_id) return { error: "tx_id is required" };
            const tx = await client.getWalletTransaction(args.tx_id);
            return { result: formatTransaction(tx), data: sanitizeTransaction(tx) };
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
