import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { walletTransactions } from "./wallet";

export const subscriptionProducts = pgTable(
  "subscription_products",
  {
    id: serial("id").primaryKey(),
    productId: varchar("product_id", { length: 64 }).notNull().unique(),
    ownerAgentId: varchar("owner_agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    name: varchar("name", { length: 128 }).notNull(),
    description: text("description").default("").notNull(),
    assetCode: varchar("asset_code", { length: 16 }).default("COIN").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    billingInterval: varchar("billing_interval", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_subscription_product_owner_name").on(table.ownerAgentId, table.name),
    index("ix_subscription_products_owner").on(table.ownerAgentId),
  ],
);

export const agentSubscriptions = pgTable(
  "agent_subscriptions",
  {
    id: serial("id").primaryKey(),
    subscriptionId: varchar("subscription_id", { length: 64 }).notNull().unique(),
    productId: varchar("product_id", { length: 64 })
      .notNull()
      .references(() => subscriptionProducts.productId),
    subscriberAgentId: varchar("subscriber_agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    providerAgentId: varchar("provider_agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    assetCode: varchar("asset_code", { length: 16 }).default("COIN").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    billingInterval: varchar("billing_interval", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).default("active").notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    nextChargeAt: timestamp("next_charge_at", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    lastChargedAt: timestamp("last_charged_at", { withTimezone: true }),
    lastChargeTxId: varchar("last_charge_tx_id", { length: 64 }).references(
      () => walletTransactions.txId,
    ),
    consecutiveFailedAttempts: integer("consecutive_failed_attempts").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uq_subscription_product_subscriber").on(table.productId, table.subscriberAgentId),
    index("ix_agent_subscriptions_product").on(table.productId),
    index("ix_agent_subscriptions_subscriber").on(table.subscriberAgentId),
    index("ix_agent_subscriptions_period_end").on(table.currentPeriodEnd),
    index("ix_agent_subscriptions_next_charge").on(table.nextChargeAt),
    check("ck_subscription_amount_positive", sql`${table.amountMinor} > 0`),
    check(
      "ck_subscription_failed_attempts_nonneg",
      sql`${table.consecutiveFailedAttempts} >= 0`,
    ),
  ],
);

export const subscriptionChargeAttempts = pgTable(
  "subscription_charge_attempts",
  {
    id: serial("id").primaryKey(),
    attemptId: varchar("attempt_id", { length: 64 }).notNull().unique(),
    subscriptionId: varchar("subscription_id", { length: 64 })
      .notNull()
      .references(() => agentSubscriptions.subscriptionId),
    billingCycleKey: varchar("billing_cycle_key", { length: 128 }).notNull(),
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    txId: varchar("tx_id", { length: 64 }).references(() => walletTransactions.txId),
    failureReason: text("failure_reason"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uq_subscription_cycle").on(table.subscriptionId, table.billingCycleKey),
    index("ix_charge_attempts_subscription").on(table.subscriptionId),
  ],
);
