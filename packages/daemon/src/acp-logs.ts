import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { LogFileEntry } from "./log.js";

const ACP_LOG_DIR = path.join(homedir(), ".botcord", "logs", "acp");
const ACP_LOG_MAX_BYTES = 2 * 1024 * 1024;
const ACP_LOG_KEEP = 20;
const ACP_LOG_DIAGNOSTICS_DEFAULT = 10;
const ACP_LOG_DIAGNOSTICS_ALL = 50;
const RUNTIME_LOG_DEFAULT_PER_ROOT = 5;
const RUNTIME_LOG_ALL_PER_ROOT = 25;
const RUNTIME_LOG_MAX_FILE_BYTES = 2 * 1024 * 1024;

const SECRET_KEY_RE = /token|secret|private.?key|api.?key|authorization|password/i;

export type AcpTraceStream =
  | "child_start"
  | "child_exit"
  | "child_error"
  | "stderr"
  | "stdout_non_json"
  | "turn_context"
  | "rpc_in"
  | "rpc_out";

export interface AcpTraceMeta {
  runtime: string;
  accountId?: string;
  turnId?: string;
  roomId?: string;
  topicId?: string | null;
  gatewayName?: string;
  gatewayUrl?: string;
  hermesProfile?: string;
  sessionId?: string | null;
}

export interface AcpTraceEvent {
  stream: AcpTraceStream;
  turnId?: string;
  messageId?: string;
  roomId?: string;
  topicId?: string | null;
  direction?: "in" | "out";
  pid?: number;
  id?: number | string;
  method?: string;
  status?: "request" | "notification" | "response" | "error";
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  chunk?: string;
  params?: unknown;
  result?: unknown;
}

export interface AcpTraceLogger {
  path: string;
  verbose: boolean;
  write(event: AcpTraceEvent): void;
}

interface RuntimeLogRoot {
  label: string;
  dir: string;
}

interface RuntimeLogFile extends LogFileEntry {
  bundleName: string;
}

export function createAcpTraceLogger(meta: AcpTraceMeta): AcpTraceLogger | null {
  if (process.env.BOTCORD_ACP_LOGS === "0") return null;
  const runtime = safePathSegment(meta.runtime || "acp");
  const key = safePathSegment(
    [
      meta.accountId,
      meta.gatewayName,
      meta.hermesProfile,
      meta.roomId,
    ].filter(Boolean).join("_") || "default",
  );
  const dir = path.join(ACP_LOG_DIR, runtime);
  const file = path.join(dir, `${key}.jsonl`);
  const verbose = process.env.BOTCORD_ACP_TRACE === "verbose";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    path: file,
    verbose,
    write(event) {
      writeAcpTrace(file, meta, event, verbose);
    },
  };
}

export function listAcpTraceLogFiles(includeAll = false): LogFileEntry[] {
  const limit = includeAll ? ACP_LOG_DIAGNOSTICS_ALL : ACP_LOG_DIAGNOSTICS_DEFAULT;
  const out: LogFileEntry[] = [];
  collectFiles(ACP_LOG_DIR, out, (name) => name.endsWith(".jsonl") || name.includes(".jsonl."));
  return out
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .slice(0, limit);
}

export function listRuntimeLogFiles(includeAll = false): RuntimeLogFile[] {
  const limit = includeAll ? RUNTIME_LOG_ALL_PER_ROOT : RUNTIME_LOG_DEFAULT_PER_ROOT;
  const out: RuntimeLogFile[] = [];
  for (const root of runtimeLogRoots()) {
    const files: LogFileEntry[] = [];
    collectFiles(root.dir, files, looksLikeLogFile, 4);
    for (const entry of files
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
      .slice(0, limit)) {
      out.push({
        ...entry,
        bundleName: path.posix.join(
          "runtime-logs",
          root.label,
          relativeBundlePath(root.dir, entry.path),
        ),
      });
    }
  }
  return out;
}

function writeAcpTrace(
  file: string,
  meta: AcpTraceMeta,
  event: AcpTraceEvent,
  verbose: boolean,
): void {
  try {
    rotateIfNeeded(file);
    const record = {
      ts: new Date().toISOString(),
      runtime: meta.runtime,
      accountId: meta.accountId,
      turnId: event.turnId ?? meta.turnId,
      messageId: event.messageId,
      roomId: event.roomId ?? meta.roomId,
      topicId: event.topicId ?? meta.topicId ?? undefined,
      gatewayName: meta.gatewayName,
      gatewayUrl: meta.gatewayUrl,
      hermesProfile: meta.hermesProfile,
      sessionId: event.params && typeof event.params === "object"
        ? pickString(event.params as Record<string, unknown>, "sessionId") ?? meta.sessionId ?? undefined
        : meta.sessionId ?? undefined,
      ...summarizeEvent(event, verbose),
    };
    appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch {
    // ACP trace logging must never affect runtime execution.
  }
}

function summarizeEvent(event: AcpTraceEvent, verbose: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    stream: event.stream,
  };
  if (event.direction) out.direction = event.direction;
  if (event.pid !== undefined) out.pid = event.pid;
  if (event.id !== undefined) out.id = event.id;
  if (event.method) out.method = event.method;
  if (event.status) out.status = event.status;
  if (event.code !== undefined) out.code = event.code;
  if (event.signal !== undefined) out.signal = event.signal;
  if (event.error) out.error = truncate(event.error, 1000);
  if (event.chunk) out.chunk = truncate(redactSecretString(event.chunk), 2000);
  if (event.params !== undefined) out.params = summarizePayload(event.params, verbose);
  if (event.result !== undefined) out.result = summarizePayload(event.result, verbose);
  return out;
}

function summarizePayload(value: unknown, verbose: boolean): unknown {
  const redacted = redactSecrets(value);
  if (verbose) return capPayload(redacted);
  if (Array.isArray(redacted)) return { type: "array", length: redacted.length };
  if (!redacted || typeof redacted !== "object") return redacted;
  const obj = redacted as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (key === "prompt") {
      out.prompt = summarizePrompt(v);
    } else if (key === "cwd" || key === "sessionId") {
      out[key] = v;
    } else if (key === "_meta") {
      out[key] = summarizePayload(v, false);
    } else if (key === "update") {
      out.update = summarizeUpdate(v);
    } else if (key === "toolCall") {
      out.toolCall = summarizeToolCall(v);
    } else if (typeof v === "string") {
      out[key] = stringSummary(v);
    } else if (Array.isArray(v)) {
      out[key] = { type: "array", length: v.length };
    } else if (v && typeof v === "object") {
      out[key] = { type: "object", keys: Object.keys(v as Record<string, unknown>).slice(0, 20) };
    } else {
      out[key] = v;
    }
  }
  return out;
}

function summarizePrompt(value: unknown): unknown {
  if (!Array.isArray(value)) return summarizePayload(value, false);
  return value.map((item) => {
    if (!item || typeof item !== "object") return summarizePayload(item, false);
    const obj = item as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text : "";
    return {
      type: obj.type,
      textBytes: text ? Buffer.byteLength(text, "utf8") : undefined,
      textPreview: text ? truncate(text.replace(/\s+/g, " "), 120) : undefined,
    };
  });
}

function summarizeUpdate(value: unknown): unknown {
  if (!value || typeof value !== "object") return summarizePayload(value, false);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof obj.sessionUpdate === "string") out.sessionUpdate = obj.sessionUpdate;
  if (typeof obj.title === "string") out.title = stringSummary(obj.title);
  if (obj.content !== undefined) out.content = summarizePayload(obj.content, false);
  return Object.keys(out).length > 0 ? out : { type: "object", keys: Object.keys(obj).slice(0, 20) };
}

function summarizeToolCall(value: unknown): unknown {
  if (!value || typeof value !== "object") return summarizePayload(value, false);
  const obj = value as Record<string, unknown>;
  return {
    name: typeof obj.name === "string" ? obj.name : undefined,
    rawInput: obj.rawInput === undefined ? undefined : summarizePayload(obj.rawInput, false),
  };
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSecretString(value) : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactSecrets(v);
  }
  return out;
}

function redactSecretString(value: string): string {
  return value
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(token=)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(drt_|dit_|gho_)[A-Za-z0-9_-]+/g, "$1[REDACTED]");
}

function capPayload(value: unknown): unknown {
  if (typeof value === "string") return truncate(value, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map(capPayload);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    out[key] = capPayload(v);
  }
  return out;
}

function stringSummary(value: string): Record<string, unknown> {
  return {
    bytes: Buffer.byteLength(value, "utf8"),
    preview: truncate(value.replace(/\s+/g, " "), 160),
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rotateIfNeeded(file: string): void {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size <= ACP_LOG_MAX_BYTES) return;
    renameSync(file, `${file}.${new Date().toISOString().replace(/[:.]/g, "-")}.${process.pid}`);
    const dir = path.dirname(file);
    const base = path.basename(file);
    const rotated = readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.`))
      .map((name) => {
        const p = path.join(dir, name);
        const st = statSync(p);
        return { p, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of rotated.slice(ACP_LOG_KEEP)) unlinkSync(entry.p);
  } catch {
    // best-effort
  }
}

function collectFiles(
  dir: string,
  out: LogFileEntry[],
  accept: (name: string, file: string) => boolean,
  maxDepth = 3,
): void {
  if (maxDepth < 0) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = statSync(file);
      if (st.isDirectory()) {
        collectFiles(file, out, accept, maxDepth - 1);
      } else if (st.isFile() && st.size <= RUNTIME_LOG_MAX_FILE_BYTES && accept(name, file)) {
        out.push({
          path: file,
          name: path.relative(ACP_LOG_DIR, file) || name,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          active: true,
        });
      }
    } catch {
      // ignore disappearing files
    }
  }
}

function runtimeLogRoots(): RuntimeLogRoot[] {
  const roots: RuntimeLogRoot[] = [
    { label: "openclaw", dir: path.join(homedir(), ".openclaw", "logs") },
    { label: "qclaw", dir: path.join(homedir(), ".qclaw", "logs") },
    { label: "hermes", dir: path.join(homedir(), ".hermes", "logs") },
  ];
  const hermesProfiles = path.join(homedir(), ".hermes", "profiles");
  try {
    for (const name of readdirSync(hermesProfiles)) {
      roots.push({
        label: path.posix.join("hermes-profiles", safePathSegment(name)),
        dir: path.join(hermesProfiles, name, "logs"),
      });
    }
  } catch {
    // no profiles
  }
  const botcordAgents = path.join(homedir(), ".botcord", "agents");
  try {
    for (const agent of readdirSync(botcordAgents)) {
      roots.push({
        label: path.posix.join("botcord-hermes", safePathSegment(agent)),
        dir: path.join(botcordAgents, agent, "hermes-home", "logs"),
      });
    }
  } catch {
    // no botcord agent homes
  }
  return roots.filter((root) => existsSync(root.dir));
}

function looksLikeLogFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".log") ||
    lower.endsWith(".jsonl") ||
    lower.endsWith(".txt") ||
    lower.includes("log")
  );
}

function relativeBundlePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).map(safePathSegment).join("/");
}

function safePathSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "unknown";
}
