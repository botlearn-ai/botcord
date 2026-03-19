import { backendDb } from "@/../db/backend";
import {
  walletAccounts,
  walletTransactions,
  walletEntries,
  topupRequests,
  withdrawalRequests,
} from "@/../db/backend-schema";
import { eq, and, sql, desc, lt, inArray } from "drizzle-orm";
import {
  generateTxId,
  generateWalletEntryId,
  generateTopupId,
  generateWithdrawalId,
} from "@/lib/id-generators";

const ASSET_CODE = "COIN";

// ---------------------------------------------------------------------------
// getOrCreateWallet
// ---------------------------------------------------------------------------
export async function getOrCreateWallet(agentId: string) {
  const [existing] = await backendDb
    .select()
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.agentId, agentId),
        eq(walletAccounts.assetCode, ASSET_CODE),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const [created] = await backendDb
    .insert(walletAccounts)
    .values({ agentId, assetCode: ASSET_CODE })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  // Race condition: another request created it first
  const [raced] = await backendDb
    .select()
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.agentId, agentId),
        eq(walletAccounts.assetCode, ASSET_CODE),
      ),
    )
    .limit(1);

  return raced!;
}

// ---------------------------------------------------------------------------
// getWalletSummary
// ---------------------------------------------------------------------------
export async function getWalletSummary(agentId: string) {
  const wallet = await getOrCreateWallet(agentId);
  return {
    agent_id: wallet.agentId,
    asset_code: wallet.assetCode,
    available_balance_minor: wallet.availableBalanceMinor,
    locked_balance_minor: wallet.lockedBalanceMinor,
    total_balance_minor:
      wallet.availableBalanceMinor + wallet.lockedBalanceMinor,
    version: wallet.version,
  };
}

// ---------------------------------------------------------------------------
// listWalletLedger
// ---------------------------------------------------------------------------
export async function listWalletLedger(
  agentId: string,
  opts: { cursor?: number; limit?: number; type?: string } = {},
) {
  const limit = Math.min(opts.limit ?? 50, 100);

  let query = backendDb
    .select()
    .from(walletEntries)
    .where(
      opts.cursor
        ? and(
            eq(walletEntries.agentId, agentId),
            lt(walletEntries.id, opts.cursor),
          )
        : eq(walletEntries.agentId, agentId),
    )
    .orderBy(desc(walletEntries.id))
    .limit(limit + 1);

  const rows = await query;

  // If filtering by type, join with transactions
  let entries = rows;
  if (opts.type) {
    const txIds = rows.map((r) => r.txId);
    if (txIds.length > 0) {
      const txRows = await backendDb
        .select()
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.type, opts.type),
            inArray(walletTransactions.txId, txIds),
          ),
        );
      const validTxIds = new Set(txRows.map((t) => t.txId));
      entries = rows.filter((r) => validTxIds.has(r.txId));
    }
  }

  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return {
    entries: page.map((e) => ({
      entry_id: e.entryId,
      tx_id: e.txId,
      agent_id: e.agentId,
      asset_code: e.assetCode,
      direction: e.direction,
      amount_minor: e.amountMinor,
      balance_after_minor: e.balanceAfterMinor,
      created_at: e.createdAt.toISOString(),
    })),
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

// ---------------------------------------------------------------------------
// getTransaction
// ---------------------------------------------------------------------------
export async function getTransaction(txId: string) {
  const [tx] = await backendDb
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.txId, txId))
    .limit(1);

  if (!tx) return null;

  return {
    tx_id: tx.txId,
    type: tx.type,
    status: tx.status,
    asset_code: tx.assetCode,
    amount_minor: tx.amountMinor,
    fee_minor: tx.feeMinor,
    from_agent_id: tx.fromAgentId,
    to_agent_id: tx.toAgentId,
    initiator_agent_id: tx.initiatorAgentId,
    reference_type: tx.referenceType,
    reference_id: tx.referenceId,
    idempotency_key: tx.idempotencyKey,
    metadata: tx.metadataJson ? JSON.parse(tx.metadataJson) : null,
    created_at: tx.createdAt.toISOString(),
    updated_at: tx.updatedAt.toISOString(),
    completed_at: tx.completedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// createTransfer
// ---------------------------------------------------------------------------
export async function createTransfer(
  fromAgentId: string,
  toAgentId: string,
  amountMinor: number,
  opts: {
    memo?: string;
    referenceType?: string;
    referenceId?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
  } = {},
) {
  if (amountMinor <= 0) {
    throw new TransferError("amount_minor must be positive", 400);
  }

  if (fromAgentId === toAgentId) {
    throw new TransferError("Cannot transfer to self", 400);
  }

  return await backendDb.transaction(async (tx) => {
    // Check idempotency
    if (opts.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.type, "transfer"),
            eq(walletTransactions.initiatorAgentId, fromAgentId),
            eq(walletTransactions.idempotencyKey, opts.idempotencyKey),
          ),
        )
        .limit(1);

      if (existing) {
        return { tx_id: existing.txId, idempotent_replay: true };
      }
    }

    // Lock wallets (order by agentId to avoid deadlocks)
    const [first, second] =
      fromAgentId < toAgentId
        ? [fromAgentId, toAgentId]
        : [toAgentId, fromAgentId];

    // Ensure both wallets exist
    for (const aid of [fromAgentId, toAgentId]) {
      await tx
        .insert(walletAccounts)
        .values({ agentId: aid, assetCode: ASSET_CODE })
        .onConflictDoNothing();
    }

    // Lock wallets in deterministic order
    const [wallet1] = await tx
      .select()
      .from(walletAccounts)
      .where(
        and(
          eq(walletAccounts.agentId, first),
          eq(walletAccounts.assetCode, ASSET_CODE),
        ),
      )
      .for("update");

    const [wallet2] = await tx
      .select()
      .from(walletAccounts)
      .where(
        and(
          eq(walletAccounts.agentId, second),
          eq(walletAccounts.assetCode, ASSET_CODE),
        ),
      )
      .for("update");

    const senderWallet =
      first === fromAgentId ? wallet1! : wallet2!;
    const receiverWallet =
      first === toAgentId ? wallet1! : wallet2!;

    if (senderWallet.availableBalanceMinor < amountMinor) {
      throw new TransferError("Insufficient balance", 400);
    }

    const txId = generateTxId();
    const now = new Date();

    // Create transaction
    await tx.insert(walletTransactions).values({
      txId,
      type: "transfer",
      status: "completed",
      assetCode: ASSET_CODE,
      amountMinor,
      feeMinor: 0,
      fromAgentId,
      toAgentId,
      initiatorAgentId: fromAgentId,
      referenceType: opts.referenceType ?? null,
      referenceId: opts.referenceId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
      metadataJson: opts.metadata ? JSON.stringify(opts.metadata) : null,
      completedAt: now,
    });

    const newSenderBalance = senderWallet.availableBalanceMinor - amountMinor;
    const newReceiverBalance =
      receiverWallet.availableBalanceMinor + amountMinor;

    // Debit entry
    await tx.insert(walletEntries).values({
      entryId: generateWalletEntryId(),
      txId,
      agentId: fromAgentId,
      assetCode: ASSET_CODE,
      direction: "debit",
      amountMinor,
      balanceAfterMinor: newSenderBalance,
    });

    // Credit entry
    await tx.insert(walletEntries).values({
      entryId: generateWalletEntryId(),
      txId,
      agentId: toAgentId,
      assetCode: ASSET_CODE,
      direction: "credit",
      amountMinor,
      balanceAfterMinor: newReceiverBalance,
    });

    // Update sender balance
    await tx
      .update(walletAccounts)
      .set({
        availableBalanceMinor: newSenderBalance,
        version: sql`${walletAccounts.version} + 1`,
        updatedAt: now,
      })
      .where(eq(walletAccounts.id, senderWallet.id));

    // Update receiver balance
    await tx
      .update(walletAccounts)
      .set({
        availableBalanceMinor: newReceiverBalance,
        version: sql`${walletAccounts.version} + 1`,
        updatedAt: now,
      })
      .where(eq(walletAccounts.id, receiverWallet.id));

    return { tx_id: txId, idempotent_replay: false };
  });
}

// ---------------------------------------------------------------------------
// createTopupRequest
// ---------------------------------------------------------------------------
export async function createTopupRequest(
  agentId: string,
  amountMinor: number,
  opts: {
    channel?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
    externalRef?: string;
  } = {},
) {
  if (amountMinor <= 0) {
    throw new TransferError("amount_minor must be positive", 400);
  }

  await getOrCreateWallet(agentId);

  const topupId = generateTopupId();

  const [row] = await backendDb
    .insert(topupRequests)
    .values({
      topupId,
      agentId,
      assetCode: ASSET_CODE,
      amountMinor,
      status: "pending",
      channel: opts.channel ?? "mock",
      externalRef: opts.externalRef ?? null,
      metadataJson: opts.metadata ? JSON.stringify(opts.metadata) : null,
    })
    .returning();

  return {
    topup_id: row!.topupId,
    agent_id: row!.agentId,
    amount_minor: row!.amountMinor,
    status: row!.status,
    channel: row!.channel,
    created_at: row!.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// createWithdrawalRequest
// ---------------------------------------------------------------------------
export async function createWithdrawalRequest(
  agentId: string,
  amountMinor: number,
  opts: {
    feeMinor?: number;
    destinationType?: string;
    destination?: Record<string, unknown>;
    idempotencyKey?: string;
  } = {},
) {
  if (amountMinor <= 0) {
    throw new TransferError("amount_minor must be positive", 400);
  }

  const feeMinor = opts.feeMinor ?? 0;
  const totalLock = amountMinor + feeMinor;

  return await backendDb.transaction(async (tx) => {
    const [wallet] = await tx
      .select()
      .from(walletAccounts)
      .where(
        and(
          eq(walletAccounts.agentId, agentId),
          eq(walletAccounts.assetCode, ASSET_CODE),
        ),
      )
      .for("update");

    if (!wallet) {
      throw new TransferError("Wallet not found", 404);
    }

    if (wallet.availableBalanceMinor < totalLock) {
      throw new TransferError("Insufficient balance", 400);
    }

    const withdrawalId = generateWithdrawalId();

    // Lock the balance
    await tx
      .update(walletAccounts)
      .set({
        availableBalanceMinor: wallet.availableBalanceMinor - totalLock,
        lockedBalanceMinor: wallet.lockedBalanceMinor + totalLock,
        version: sql`${walletAccounts.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(walletAccounts.id, wallet.id));

    const [row] = await tx
      .insert(withdrawalRequests)
      .values({
        withdrawalId,
        agentId,
        assetCode: ASSET_CODE,
        amountMinor,
        feeMinor,
        status: "pending",
        destinationType: opts.destinationType ?? null,
        destinationJson: opts.destination
          ? JSON.stringify(opts.destination)
          : null,
      })
      .returning();

    return {
      withdrawal_id: row!.withdrawalId,
      tx_id: row!.txId,
      agent_id: row!.agentId,
      asset_code: row!.assetCode,
      amount_minor: String(row!.amountMinor),
      fee_minor: String(row!.feeMinor),
      status: row!.status,
      destination_type: row!.destinationType,
      review_note: row!.reviewNote,
      created_at: row!.createdAt.toISOString(),
      reviewed_at: row!.reviewedAt?.toISOString() ?? null,
      completed_at: row!.completedAt?.toISOString() ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// listWithdrawalRequests
// ---------------------------------------------------------------------------
export async function listWithdrawalRequests(agentId: string, limit = 10) {
  const rows = await backendDb
    .select()
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.agentId, agentId))
    .orderBy(desc(withdrawalRequests.createdAt))
    .limit(Math.min(limit, 50));

  return {
    withdrawals: rows.map((row) => ({
      withdrawal_id: row.withdrawalId,
      tx_id: row.txId,
      agent_id: row.agentId,
      asset_code: row.assetCode,
      amount_minor: String(row.amountMinor),
      fee_minor: String(row.feeMinor),
      status: row.status,
      destination_type: row.destinationType,
      review_note: row.reviewNote,
      created_at: row.createdAt.toISOString(),
      reviewed_at: row.reviewedAt?.toISOString() ?? null,
      completed_at: row.completedAt?.toISOString() ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// cancelWithdrawalRequest
// ---------------------------------------------------------------------------
export async function cancelWithdrawalRequest(
  withdrawalId: string,
  agentId: string,
) {
  return await backendDb.transaction(async (tx) => {
    const [withdrawal] = await tx
      .select()
      .from(withdrawalRequests)
      .where(
        and(
          eq(withdrawalRequests.withdrawalId, withdrawalId),
          eq(withdrawalRequests.agentId, agentId),
        ),
      )
      .limit(1);

    if (!withdrawal) {
      throw new TransferError("Withdrawal not found", 404);
    }

    if (withdrawal.status !== "pending") {
      throw new TransferError(
        `Cannot cancel withdrawal in status: ${withdrawal.status}`,
        400,
      );
    }

    const totalLock = withdrawal.amountMinor + withdrawal.feeMinor;

    // Lock wallet
    const [wallet] = await tx
      .select()
      .from(walletAccounts)
      .where(
        and(
          eq(walletAccounts.agentId, agentId),
          eq(walletAccounts.assetCode, ASSET_CODE),
        ),
      )
      .for("update");

    if (!wallet) {
      throw new TransferError("Wallet not found", 404);
    }

    // Unlock balance
    await tx
      .update(walletAccounts)
      .set({
        availableBalanceMinor: wallet.availableBalanceMinor + totalLock,
        lockedBalanceMinor: wallet.lockedBalanceMinor - totalLock,
        version: sql`${walletAccounts.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(walletAccounts.id, wallet.id));

    // Update withdrawal status
    await tx
      .update(withdrawalRequests)
      .set({ status: "cancelled" })
      .where(eq(withdrawalRequests.withdrawalId, withdrawalId));

    return { withdrawal_id: withdrawalId, status: "cancelled" };
  });
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------
export class TransferError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TransferError";
    this.status = status;
  }
}
