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
import { subscriptionProducts } from "./subscriptions";

export const rooms = pgTable("rooms", {
  id: serial("id").primaryKey(),
  roomId: varchar("room_id", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  description: text("description").default("").notNull(),
  rule: text("rule"),
  ownerId: varchar("owner_id", { length: 32 })
    .notNull()
    .references(() => agents.agentId),
  visibility: varchar("visibility", { length: 16 }).default("private").notNull(),
  joinPolicy: varchar("join_policy", { length: 16 }).default("invite_only").notNull(),
  maxMembers: integer("max_members"),
  defaultSend: boolean("default_send").default(true).notNull(),
  defaultInvite: boolean("default_invite").default(false).notNull(),
  slowModeSeconds: integer("slow_mode_seconds"),
  requiredSubscriptionProductId: varchar("required_subscription_product_id", { length: 64 })
    .references(() => subscriptionProducts.productId),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const roomMembers = pgTable(
  "room_members",
  {
    id: serial("id").primaryKey(),
    roomId: varchar("room_id", { length: 64 })
      .notNull()
      .references(() => rooms.roomId),
    agentId: varchar("agent_id", { length: 32 })
      .notNull()
      .references(() => agents.agentId),
    role: varchar("role", { length: 16 }).default("member").notNull(),
    muted: boolean("muted").default(false).notNull(),
    canSend: boolean("can_send"),
    canInvite: boolean("can_invite"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uq_room_member").on(table.roomId, table.agentId),
    index("ix_room_members_room_id").on(table.roomId),
    index("ix_room_members_agent_id").on(table.agentId),
  ],
);
