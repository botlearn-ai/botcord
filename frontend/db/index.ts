import { drizzle } from "drizzle-orm/postgres-js";
import { getSharedSqlClient, dbConfigError, isDbConfigured } from "./client";
import * as schema from "./schema";

export const db = isDbConfigured
  ? drizzle(getSharedSqlClient(), { schema })
  : (new Proxy(
      {},
      {
        get() {
          throw new Error(dbConfigError);
        },
      },
    ) as ReturnType<typeof drizzle>);
