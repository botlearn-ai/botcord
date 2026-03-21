import { pgTable, serial, varchar, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { agents } from "./agents";

export const contacts = pgTable(
  "contacts",
  {
    id: serial("id").primaryKey(),
    ownerId: varchar("owner_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    contactAgentId: varchar("contact_agent_id", { length: 32 }).notNull(),
    alias: varchar("alias", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uq_contact").on(table.ownerId, table.contactAgentId),
    index("ix_contacts_owner_id").on(table.ownerId),
  ],
);

export const contactRequests = pgTable(
  "contact_requests",
  {
    id: serial("id").primaryKey(),
    fromAgentId: varchar("from_agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    toAgentId: varchar("to_agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    state: varchar("state", { length: 16 }).default("pending").notNull(),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_contact_request").on(table.fromAgentId, table.toAgentId),
    index("ix_contact_requests_from").on(table.fromAgentId),
    index("ix_contact_requests_to").on(table.toAgentId),
  ],
);
