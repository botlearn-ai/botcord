import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LOG_DIR = path.join(homedir(), ".botcord", "logs");
const LOG_FILE = path.join(LOG_DIR, "daemon.log");

let inited = false;
function ensureDir(): void {
  if (inited) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort
  }
  inited = true;
}

type Level = "info" | "warn" | "error" | "debug";

function formatValue(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.stack ?? value.message);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

export function formatLogLine(
  level: Level,
  msg: string,
  fields: Record<string, unknown> | undefined,
  date = new Date(),
): string {
  const detail = Object.entries(fields ?? {})
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  const prefix = `[${level.toUpperCase()}] ${msg}`;
  const suffix = `ts=${date.toISOString()}`;
  return detail ? `${prefix} ${detail} ${suffix}` : `${prefix} ${suffix}`;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  ensureDir();
  const line = formatLogLine(level, msg, fields);
  try {
    appendFileSync(LOG_FILE, line + "\n", { mode: 0o600 });
  } catch {
    // ignore log write errors
  }
  // Mirror to stderr so `--foreground` and `logs -f` both see it.
  process.stderr.write(line + "\n");
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.BOTCORD_DAEMON_DEBUG) write("debug", msg, fields);
  },
};

export const LOG_FILE_PATH = LOG_FILE;
