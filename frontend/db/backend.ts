import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as backendSchema from "./backend-schema";

const connectionString = process.env.SUPABASE_DB_URL;
export const backendDbConfigError =
  "SUPABASE_DB_URL is not set. Add it to .env.local for Drizzle ORM to connect to PostgreSQL.";
export const isBackendDbConfigured = Boolean(connectionString);

export const backendDb = isBackendDbConfigured
  ? drizzle(postgres(connectionString as string), { schema: backendSchema })
  : (new Proxy(
      {},
      {
        get() {
          throw new Error(backendDbConfigError);
        },
      },
    ) as ReturnType<typeof drizzle>);
