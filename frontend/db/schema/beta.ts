import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const betaCodeStatusEnum = pgEnum("betacodestatus", ["active", "revoked"]);
export const betaWaitlistStatusEnum = pgEnum("betawaitliststatus", ["pending", "approved", "rejected"]);

export const betaInviteCodes = pgTable("beta_invite_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 128 }).notNull().default(""),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  createdBy: varchar("created_by", { length: 256 }).notNull().default(""),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: betaCodeStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const betaCodeRedemptions = pgTable(
  "beta_code_redemptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeId: uuid("code_id")
      .notNull()
      .references(() => betaInviteCodes.id),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const betaWaitlistEntries = pgTable("beta_waitlist_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  email: varchar("email", { length: 256 }).notNull(),
  note: text("note"),
  status: betaWaitlistStatusEnum("status").notNull().default("pending"),
  appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  sentCodeId: uuid("sent_code_id").references(() => betaInviteCodes.id),
});
