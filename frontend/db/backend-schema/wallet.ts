import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  bigint,
  timestamp,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";

export const walletAccounts = pgTable(
  "wallet_accounts",
  {
    id: serial("id").primaryKey(),
    agentId: varchar("agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    assetCode: varchar("asset_code", { length: 16 }).default("COIN").notNull(),
    availableBalanceMinor: bigint("available_balance_minor", { mode: "number" }).default(0).notNull(),
    lockedBalanceMinor: bigint("locked_balance_minor", { mode: "number" }).default(0).notNull(),
    version: integer("version").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uq_wallet_agent_asset").on(table.agentId, table.assetCode),
    index("ix_wallet_accounts_agent_id").on(table.agentId),
    check("ck_wallet_available_nonneg", sql`${table.availableBalanceMinor} >= 0`),
    check("ck_wallet_locked_nonneg", sql`${table.lockedBalanceMinor} >= 0`),
  ],
);

export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: serial("id").primaryKey(),
    txId: varchar("tx_id", { length: 64 }).notNull().unique(),
    type: varchar("type", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    assetCode: varchar("asset_code", { length: 16 }).default("COIN").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    feeMinor: bigint("fee_minor", { mode: "number" }).default(0).notNull(),
    fromAgentId: varchar("from_agent_id", { length: 32 }),
    toAgentId: varchar("to_agent_id", { length: 32 }),
    initiatorAgentId: varchar("initiator_agent_id", { length: 32 }),
    referenceType: varchar("reference_type", { length: 32 }),
    referenceId: varchar("reference_id", { length: 64 }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_tx_idem").on(table.type, table.initiatorAgentId, table.idempotencyKey),
    index("ix_wallet_tx_from").on(table.fromAgentId),
    index("ix_wallet_tx_to").on(table.toAgentId),
    index("ix_wallet_tx_initiator").on(table.initiatorAgentId),
    index("ix_wallet_tx_idempotency").on(table.idempotencyKey),
  ],
);

export const walletEntries = pgTable(
  "wallet_entries",
  {
    id: serial("id").primaryKey(),
    entryId: varchar("entry_id", { length: 64 }).notNull().unique(),
    txId: varchar("tx_id", { length: 64 })
      .notNull()
      .references(() => walletTransactions.txId),
    agentId: varchar("agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    assetCode: varchar("asset_code", { length: 16 }).default("COIN").notNull(),
    direction: varchar("direction", { length: 8 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    balanceAfterMinor: bigint("balance_after_minor", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ix_wallet_entries_tx_id").on(table.txId),
    index("ix_wallet_entries_agent_id").on(table.agentId),
  ],
);

export const topupRequests = pgTable(
  "topup_requests",
  {
    id: serial("id").primaryKey(),
    topupId: varchar("topup_id", { length: 64 }).notNull().unique(),
    agentId: varchar("agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    assetCode: varchar("asset_code", { length: 16 }).default("COIN").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    channel: varchar("channel", { length: 32 }).default("mock").notNull(),
    externalRef: varchar("external_ref", { length: 256 }),
    metadataJson: text("metadata_json"),
    txId: varchar("tx_id", { length: 64 }).references(() => walletTransactions.txId),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("ix_topup_requests_agent_id").on(table.agentId)],
);

export const withdrawalRequests = pgTable(
  "withdrawal_requests",
  {
    id: serial("id").primaryKey(),
    withdrawalId: varchar("withdrawal_id", { length: 64 }).notNull().unique(),
    agentId: varchar("agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    assetCode: varchar("asset_code", { length: 16 }).default("COIN").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    feeMinor: bigint("fee_minor", { mode: "number" }).default(0).notNull(),
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    destinationType: varchar("destination_type", { length: 64 }),
    destinationJson: text("destination_json"),
    reviewNote: text("review_note"),
    txId: varchar("tx_id", { length: 64 }).references(() => walletTransactions.txId),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("ix_withdrawal_requests_agent_id").on(table.agentId)],
);
