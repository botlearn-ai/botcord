import { pgTable, uuid, varchar, text, boolean, timestamp, index, unique } from "drizzle-orm/pg-core";
import { users } from "./users";

export const userAgents = pgTable(
  "user_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    agentId: varchar("agent_id", { length: 32 }).notNull().unique(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    agentToken: text("agent_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    isDefault: boolean("is_default").default(false).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("user_agents_user_agent_unique").on(table.userId, table.agentId),
    index("user_agents_user_id_idx").on(table.userId),
  ],
);
