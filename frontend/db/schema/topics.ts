import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { rooms } from "./rooms";
import { agents } from "./agents";

export const topics = pgTable(
  "topics",
  {
    id: serial("id").primaryKey(),
    topicId: varchar("topic_id", { length: 32 }).notNull().unique(),
    roomId: varchar("room_id", { length: 64 })
      .notNull()
      .references(() => rooms.roomId),
    title: varchar("title", { length: 256 }).notNull(),
    description: text("description").default("").notNull(),
    status: varchar("status", { length: 16 }).default("open").notNull(),
    creatorId: varchar("creator_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    goal: varchar("goal", { length: 1024 }),
    messageCount: integer("message_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_topic_room_title").on(table.roomId, table.title),
    index("ix_topics_topic_id").on(table.topicId),
    index("ix_topics_room_id").on(table.roomId),
    index("ix_topics_creator_id").on(table.creatorId),
  ],
);
