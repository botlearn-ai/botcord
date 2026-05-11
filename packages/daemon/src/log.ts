import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LOG_DIR = path.join(homedir(), ".botcord", "logs");
const LOG_FILE = path.join(LOG_DIR, "daemon.log");
const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_ROTATE_KEEP = 20;

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

export interface LogFileEntry {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  active: boolean;
}

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

function rotatedName(file: string, date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `${file}.${stamp}.${process.pid}`;
}

export function listDaemonLogFiles(logFile = LOG_FILE): LogFileEntry[] {
  const dir = path.dirname(logFile);
  const base = path.basename(logFile);
  const entries: LogFileEntry[] = [];

  try {
    const st = statSync(logFile);
    if (st.isFile()) {
      entries.push({
        path: logFile,
        name: base,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        active: true,
      });
    }
  } catch {
    // no active log
  }

  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return entries;
  }

  for (const name of names) {
    if (!name.startsWith(`${base}.`)) continue;
    const file = path.join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      entries.push({
        path: file,
        name,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        active: false,
      });
    } catch {
      // ignore disappearing files
    }
  }

  return entries.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name);
  });
}

export function rotateLogIfNeeded(
  logFile = LOG_FILE,
  nextBytes = 0,
  maxBytes = LOG_ROTATE_MAX_BYTES,
  keep = LOG_ROTATE_KEEP,
): void {
  let currentSize = 0;
  try {
    const st = statSync(logFile);
    if (!st.isFile()) return;
    currentSize = st.size;
  } catch {
    return;
  }
  if (currentSize + nextBytes <= maxBytes) return;

  try {
    renameSync(logFile, rotatedName(logFile));
  } catch {
    return;
  }

  const rotated = listDaemonLogFiles(logFile).filter((entry) => !entry.active);
  for (const entry of rotated.slice(Math.max(0, keep))) {
    try {
      unlinkSync(entry.path);
    } catch {
      // best-effort cleanup
    }
  }
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  ensureDir();
  const line = formatLogLine(level, msg, fields);
  try {
    rotateLogIfNeeded(LOG_FILE, Buffer.byteLength(line) + 1);
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
