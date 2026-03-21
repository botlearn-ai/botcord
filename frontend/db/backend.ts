import { drizzle } from "drizzle-orm/postgres-js";
import { getSharedSqlClient, dbConfigError, isDbConfigured } from "./client";
import * as schema from "./schema";

export const backendDbConfigError = dbConfigError;
export const isBackendDbConfigured = isDbConfigured;

export const backendDb = isBackendDbConfigured
  ? drizzle(getSharedSqlClient(), { schema })
  : (new Proxy(
      {},
      {
        get() {
          throw new Error(backendDbConfigError);
        },
      },
    ) as ReturnType<typeof drizzle>);
