import { pgTable, serial, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { rooms } from "./rooms";

export const shares = pgTable(
  "shares",
  {
    id: serial("id").primaryKey(),
    shareId: varchar("share_id", { length: 32 }).notNull().unique(),
    roomId: varchar("room_id", { length: 64 })
      .notNull()
      .references(() => rooms.roomId),
    sharedByAgentId: varchar("shared_by_agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    sharedByName: varchar("shared_by_name", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [index("ix_shares_room_id").on(table.roomId)],
);

export const shareMessages = pgTable(
  "share_messages",
  {
    id: serial("id").primaryKey(),
    shareId: varchar("share_id", { length: 32 })
      .notNull()
      .references(() => shares.shareId),
    hubMsgId: varchar("hub_msg_id", { length: 48 }).notNull(),
    msgId: varchar("msg_id", { length: 64 }).notNull(),
    senderId: varchar("sender_id", { length: 32 }).notNull(),
    senderName: varchar("sender_name", { length: 128 }).notNull(),
    type: varchar("type", { length: 32 }).default("message").notNull(),
    text: text("text").default("").notNull(),
    payloadJson: text("payload_json").default("{}").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("ix_share_messages_share_id").on(table.shareId)],
);
