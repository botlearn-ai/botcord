import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";

export const messageRecords = pgTable(
  "message_records",
  {
    id: serial("id").primaryKey(),
    hubMsgId: varchar("hub_msg_id", { length: 48 }).notNull().unique(),
    msgId: varchar("msg_id", { length: 64 }).notNull(),
    senderId: varchar("sender_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    receiverId: varchar("receiver_id", { length: 32 }).notNull(),
    roomId: varchar("room_id", { length: 64 }),
    topic: varchar("topic", { length: 256 }),
    topicId: varchar("topic_id", { length: 32 }),
    goal: varchar("goal", { length: 1024 }),
    state: varchar("state", { length: 16 }).default("queued").notNull(),
    envelopeJson: text("envelope_json").notNull(),
    ttlSec: integer("ttl_sec").notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    mentioned: boolean("mentioned").default(false).notNull(),
  },
  (table) => [
    unique("uq_msg_receiver").on(table.msgId, table.receiverId),
    index("ix_message_records_msg_id").on(table.msgId),
    index("ix_message_records_sender_id").on(table.senderId),
    index("ix_message_records_receiver_id").on(table.receiverId),
    index("ix_message_records_room_id").on(table.roomId),
    index("ix_message_records_topic").on(table.topic),
    index("ix_message_records_topic_id").on(table.topicId),
    index("ix_message_records_retry").on(table.state, table.nextRetryAt),
  ],
);
