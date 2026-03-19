import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.SUPABASE_DB_URL;
export const dbConfigError =
  "SUPABASE_DB_URL is not set. Add it to .env.local for Drizzle ORM to connect to Supabase PostgreSQL.";
export const isDbConfigured = Boolean(connectionString);

export const db = isDbConfigured
  ? drizzle(postgres(connectionString as string), { schema })
  : (new Proxy(
      {},
      {
        get() {
          throw new Error(dbConfigError);
        },
      },
    ) as ReturnType<typeof drizzle>);
