import { pgTable, uuid, varchar, text, boolean, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users";

export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  description: text("description"),
  isSystem: boolean("is_system").default(false).notNull(),
  priority: integer("priority").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const permissions = pgTable("permissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  resource: varchar("resource", { length: 50 }).notNull(),
  action: varchar("action", { length: 50 }).notNull(),
  scope: varchar("scope", { length: 20 }).default("own").notNull(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("role_permissions_unique").on(table.roleId, table.permissionId),
  ],
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    unique("user_roles_unique").on(table.userId, table.roleId),
  ],
);
