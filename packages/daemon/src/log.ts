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

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  ensureDir();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  });
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
