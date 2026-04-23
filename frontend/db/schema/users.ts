import { pgTable, uuid, varchar, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  displayName: varchar("display_name", { length: 128 }).notNull(),
  email: varchar("email", { length: 255 }).unique(),
  avatarUrl: text("avatar_url"),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  supabaseUserId: uuid("supabase_user_id").notNull().unique(),
  maxAgents: integer("max_agents").default(10).notNull(),
  bannedAt: timestamp("banned_at", { withTimezone: true }),
  banReason: text("ban_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  betaAccess: boolean("beta_access").default(false).notNull(),
  betaAdmin: boolean("beta_admin").default(false).notNull(),
  humanId: varchar("human_id", { length: 32 }).notNull().unique(),
});
