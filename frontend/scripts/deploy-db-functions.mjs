#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import postgres from "postgres";

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) return null;

  const key = trimmed.slice(0, eqIndex).trim();
  let value = trimmed.slice(eqIndex + 1).trim();
  if (!key) return null;

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

async function loadEnvFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function main() {
  const cwd = process.cwd();
  await loadEnvFile(path.resolve(cwd, ".env.local"));
  await loadEnvFile(path.resolve(cwd, ".env"));

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error("SUPABASE_DB_URL is not set. Checked process env, .env.local, and .env.");
    process.exit(1);
  }

  const functionsDir = path.resolve(cwd, "db/functions");
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
