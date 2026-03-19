#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import postgres from "postgres";

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error("SUPABASE_DB_URL is not set.");
    process.exit(1);
  }

  const functionsDir = path.resolve(process.cwd(), "db/functions");
  const entries = await fs.readdir(functionsDir, { withFileTypes: true });
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  if (sqlFiles.length === 0) {
    console.log("No SQL function files found in db/functions.");
    return;
  }

  const sql = postgres(connectionString, { max: 1 });
  try {
    for (const fileName of sqlFiles) {
      const filePath = path.join(functionsDir, fileName);
      const script = await fs.readFile(filePath, "utf8");
      if (!script.trim()) continue;
      console.log(`Deploying ${fileName}...`);
      await sql.unsafe(script);
    }
    console.log(`Deployed ${sqlFiles.length} SQL function file(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("Failed to deploy db/functions:", error);
  process.exit(1);
});
