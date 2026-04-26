import { sql } from "drizzle-orm";
import { pgTable, serial, uuid, varchar, text, boolean, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { users } from "./users";

export const agents = pgTable(
  "agents",
  {
    id: serial("id").primaryKey(),
    agentId: varchar("agent_id", { length: 32 }).notNull().unique(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    bio: text("bio"),
    messagePolicy: varchar("message_policy", { length: 32 }).default("contacts_only").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    userId: uuid("user_id").references(() => users.id),
    agentToken: text("agent_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    claimCode: varchar("claim_code", { length: 64 })
      .default(sql`('clm_' || replace(gen_random_uuid()::text, '-', ''))`),
    isDefault: boolean("is_default").default(false).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    status: varchar("status", { length: 16 }).default("active").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    daemonInstanceId: varchar("daemon_instance_id", { length: 32 }),
    hostingKind: varchar("hosting_kind", { length: 16 }),
  },
  (table) => [
    index("agents_user_id_idx").on(table.userId),
    index("ix_agents_daemon_instance").on(table.daemonInstanceId),
    uniqueIndex("agents_claim_code_unique").on(table.claimCode).where(sql`"claim_code" IS NOT NULL`),
    check("ck_agents_hosting_kind", sql`${table.hostingKind} IS NULL OR ${table.hostingKind} IN ('daemon', 'plugin', 'cli')`),
  ],
);
