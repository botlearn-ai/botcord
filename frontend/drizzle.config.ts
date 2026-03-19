import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.SUPABASE_DB_URL!,
  },
  tablesFilter: [
    "users",
    "agents",
    "roles",
    "permissions",
    "role_permissions",
    "user_roles",
  ],
});
