/**
 * botcord_payment — Unified payment and transaction tool for BotCord coin flows.
 */
import { withClient } from "./with-client.js";
import { validationError, dryRunResult } from "./tool-result.js";
import { formatCoinAmount } from "./coin-format.js";
import { executeTransfer, isPeerContact, formatFollowUpDeliverySummary } from "./payment-transfer.js";

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

function sanitizeTransaction(tx: any): any {
  const metadata = extractMetadata(tx);
  return {
    tx_id: tx.tx_id,
    type: tx.type,
    status: tx.status,
    asset_code: tx.asset_code,
    amount: formatCoinAmount(tx.amount_minor),
    fee: formatCoinAmount(tx.fee_minor),
    from_agent_id: tx.from_agent_id,
    to_agent_id: tx.to_agent_id,
    reference_type: tx.reference_type,
    reference_id: tx.reference_id,
    idempotency_key: tx.idempotency_key,
    metadata: metadata ?? undefined,
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

function formatLedger(data: any): string {
  const entries = data.entries ?? [];
  if (entries.length === 0) return "No payment ledger entries found.";

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

export function createPaymentTool(opts?: { name?: string; description?: string }) {
  return {
    name: opts?.name || "botcord_payment",
    label: "Manage Payments",
    description:
      opts?.description ||
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
        confirmed: {
          type: "boolean" as const,
          description: "Set to true to confirm a stranger transfer (recipient not in contacts) — for transfer",
        },
        limit: {
          type: "number" as const,
          description: "Max entries to return — for ledger",
        },
        type: {
          type: "string" as const,
          description: "Filter by transaction type — for ledger",
        },
        dry_run: {
          type: "boolean" as const,
          description: "Preview the request without executing. Returns the API call that would be made.",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: any, args: any) => {
      return withClient(async (client) => {
        // Dry-run for write operations
        if (args.dry_run) {
          switch (args.action) {
            case "transfer":
              if (!args.to_agent_id) return validationError("to_agent_id is required");
              if (!args.amount_minor) return validationError("amount_minor is required");
              return dryRunResult("POST", "/wallet/transfers", { to_agent_id: args.to_agent_id, amount_minor: args.amount_minor, memo: args.memo }) as any;
            case "topup":
              if (!args.amount_minor) return validationError("amount_minor is required");
              return dryRunResult("POST", "/wallet/topups", { amount_minor: args.amount_minor, channel: args.channel }) as any;
            case "withdraw":
              if (!args.amount_minor) return validationError("amount_minor is required");
              return dryRunResult("POST", "/wallet/withdrawals", { amount_minor: args.amount_minor, destination_type: args.destination_type }) as any;
            default:
              break;
          }
        }

        switch (args.action) {
          case "recipient_verify": {
            if (!args.agent_id) return validationError("agent_id is required");
            const agent = await client.resolve(args.agent_id);
            return { result: formatRecipient(agent), data: agent } as any;
          }

          case "balance": {
            const summary = await client.getWallet();
            return { result: formatBalance(summary), data: sanitizeBalance(summary) } as any;
          }

          case "ledger": {
            const opts: { cursor?: string; limit?: number; type?: string } = {};
            if (args.cursor) opts.cursor = args.cursor;
            if (args.limit) opts.limit = args.limit;
            if (args.type) opts.type = args.type;
            const ledger = await client.getWalletLedger(opts);
            return { result: formatLedger(ledger), data: sanitizeLedger(ledger) } as any;
          }

          case "transfer": {
            if (!args.to_agent_id) return validationError("to_agent_id is required");
            if (!args.amount_minor) return validationError("amount_minor is required");

            const isContact = await isPeerContact(client, args.to_agent_id);
            if (!isContact && args.confirmed !== true) {
              return {
                result: `\u26a0\ufe0f ${args.to_agent_id} is not in your contacts. This is a stranger transfer of ${formatCoinAmount(args.amount_minor)}. To proceed, call this tool again with confirmed: true. The transfer will create a chat room between you and the recipient.`,
              } as any;
            }

            const transfer = await executeTransfer(client, {
              to_agent_id: args.to_agent_id,
              amount_minor: args.amount_minor,
              memo: args.memo,
              reference_type: args.reference_type,
              reference_id: args.reference_id,
              metadata: args.metadata,
              idempotency_key: args.idempotency_key,
            });
            return {
              result: `${formatTransaction(transfer.tx)}\n${formatFollowUpDeliverySummary(transfer)}`,
              data: sanitizeTransferResult(transfer),
            } as any;
          }

          case "topup": {
            if (!args.amount_minor) return validationError("amount_minor is required");
            const topup = await client.createTopup({
              amount_minor: args.amount_minor,
              channel: args.channel,
              metadata: args.metadata,
              idempotency_key: args.idempotency_key,
            });
            return { result: formatTopup(topup), data: sanitizeTopup(topup) } as any;
          }

          case "withdraw": {
            if (!args.amount_minor) return validationError("amount_minor is required");
            const withdrawal = await client.createWithdrawal({
              amount_minor: args.amount_minor,
              fee_minor: args.fee_minor,
              destination_type: args.destination_type,
              destination: args.destination,
              idempotency_key: args.idempotency_key,
            });
            return { result: formatWithdrawal(withdrawal), data: sanitizeWithdrawal(withdrawal) } as any;
          }

          case "cancel_withdrawal": {
            if (!args.withdrawal_id) return validationError("withdrawal_id is required");
            const withdrawal = await client.cancelWithdrawal(args.withdrawal_id);
            return { result: formatWithdrawal(withdrawal), data: sanitizeWithdrawal(withdrawal) } as any;
          }

          case "tx_status": {
            if (!args.tx_id) return validationError("tx_id is required");
            const tx = await client.getWalletTransaction(args.tx_id);
            return { result: formatTransaction(tx), data: sanitizeTransaction(tx) } as any;
          }

          default:
            return validationError(`Unknown action: ${args.action}`);
        }
      });
    },
  };
}
