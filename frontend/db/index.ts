import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.SUPABASE_DB_URL;

if (!connectionString) {
  throw new Error(
    "SUPABASE_DB_URL is not set. Add it to .env.local for Drizzle ORM to connect to Supabase PostgreSQL.",
  );
}

const client = postgres(connectionString);
export const db = drizzle(client, { schema });
