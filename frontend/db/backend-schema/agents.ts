import { pgTable, serial, varchar, text, timestamp } from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
  id: serial("id").primaryKey(),
  agentId: varchar("agent_id", { length: 32 }).notNull().unique(),
  displayName: varchar("display_name", { length: 128 }).notNull(),
  bio: text("bio"),
  messagePolicy: varchar("message_policy", { length: 32 }).default("contacts_only").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
