import postgres from "postgres";

const connectionString = process.env.SUPABASE_DB_URL;
const poolMaxRaw = process.env.SUPABASE_DB_POOL_MAX;
const parsedPoolMax = poolMaxRaw ? Number.parseInt(poolMaxRaw, 10) : Number.NaN;
const poolMax = Number.isFinite(parsedPoolMax) && parsedPoolMax > 0 ? parsedPoolMax : 1;
const prepareRaw = process.env.SUPABASE_DB_PREPARE?.toLowerCase();
const usePreparedStatements = prepareRaw === "true";

declare global {
  // eslint-disable-next-line no-var
  var __botcordSharedSqlClient: ReturnType<typeof postgres> | undefined;
}

export const isDbConfigured = Boolean(connectionString);
export const dbConfigError =
  "SUPABASE_DB_URL is not set. Add it to .env.local (prefer Supabase Session Pooler URL) for Drizzle ORM.";

export function getSharedSqlClient(): ReturnType<typeof postgres> {
  if (!isDbConfigured) {
    throw new Error(dbConfigError);
  }

  if (!globalThis.__botcordSharedSqlClient) {
    globalThis.__botcordSharedSqlClient = postgres(connectionString as string, {
      max: poolMax,
      prepare: usePreparedStatements,
    });
  }

  return globalThis.__botcordSharedSqlClient;
}
