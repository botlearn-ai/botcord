import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { transcriptFilePath, transcriptRoomDir } from "./transcript-paths.js";

export const RUNTIME_FAILURE_TAIL_LIMIT = 8 * 1024;

const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/(Authorization:\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(^|[\s])(--(?:api-key|api_key|apikey|token|access-token|access_token|refresh-token|refresh_token|password|secret))=([^\s"']+)/gi, "$1$2=[REDACTED]"],
  [/(^|[\s])(--(?:api-key|api_key|apikey|token|access-token|access_token|refresh-token|refresh_token|password|secret))(\s+)([^\s"']+)/gi, "$1$2$3[REDACTED]"],
  [/\b((?:openai|anthropic)[_-]?api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|password|secret|token)(\s*[:=]\s*)[^\s"']+/gi, "$1$2[REDACTED]"],
  [/\b(drt_|dit_|gho_|ghp_|sk-)[A-Za-z0-9_-]+/g, "$1[REDACTED]"],
];

const SECRET_VALUE_FLAGS = new Set([
  "--api-key",
  "--api_key",
  "--apikey",
  "--token",
  "--access-token",
  "--access_token",
  "--refresh-token",
  "--refresh_token",
  "--password",
  "--secret",
]);

export interface RuntimeFailureSummary {
  agent_id: string;
  room_id: string;
  topic_id?: string | null;
  turn_id: string;
  runtime: string;
  cwd?: string | null;
  command?: string[] | null;
  exit_code?: number | null;
  signal?: string | null;
  duration_ms?: number | null;
  stderr_tail?: string | null;
  stdout_tail?: string | null;
  error_name?: string | null;
  error_message?: string | null;
}

export interface RuntimeFailureLookupResult {
  file: string;
  record: {
    ts?: string;
    kind: string;
    turnId?: string;
    errorRef?: string;
    runtime?: string;
    error?: string;
    runtimeFailure?: RuntimeFailureSummary;
  };
}

export function makeRuntimeErrorRef(summary: Partial<RuntimeFailureSummary>): string {
  const material = JSON.stringify({
    turn_id: summary.turn_id,
    runtime: summary.runtime,
    message: summary.error_message,
    exit_code: summary.exit_code,
    nonce: randomBytes(6).toString("hex"),
  });
  return "err_" + createHash("sha256").update(material).digest("hex").slice(0, 12);
}

export function sanitizeRuntimeFailureText(value: string, limit = RUNTIME_FAILURE_TAIL_LIMIT): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return tailText(out, limit) ?? "";
}

export function tailText(value: string | undefined | null, limit = RUNTIME_FAILURE_TAIL_LIMIT): string | null {
  if (!value) return null;
  return value.length > limit ? value.slice(-limit) : value;
}

export function safeCommand(command: string[] | undefined | null): string[] | null {
  if (!command || command.length === 0) return null;
  const out: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const part = command[i]!;
    out.push(sanitizeRuntimeFailureText(part, 512));
    if (SECRET_VALUE_FLAGS.has(part.toLowerCase()) && i + 1 < command.length) {
      out.push("[REDACTED]");
      i++;
    }
  }
  return out;
}

export function errorInfo(err: unknown): { error_name: string | null; error_message: string | null } {
  if (err instanceof Error) {
    return {
      error_name: err.name || "Error",
      error_message: sanitizeRuntimeFailureText(err.message, 2048),
    };
  }
  return {
    error_name: null,
    error_message: sanitizeRuntimeFailureText(String(err), 2048),
  };
}

export function lookupRuntimeFailureTranscript(args: {
  rootDir: string;
  agentId: string;
  roomId: string;
  topicId?: string | null;
  turnId?: string | null;
  errorRef?: string | null;
}): RuntimeFailureLookupResult | null {
  const files = runtimeFailureTranscriptFiles(args.rootDir, args.agentId, args.roomId, args.topicId ?? null);
  for (const file of files) {
    const found = scanRuntimeFailureFile(file, args.turnId ?? null, args.errorRef ?? null);
    if (found) return { file, record: found };
  }
  return null;
}

function runtimeFailureTranscriptFiles(
  rootDir: string,
  agentId: string,
  roomId: string,
  topicId: string | null,
): string[] {
  if (topicId !== null) {
    const file = transcriptFilePath(rootDir, agentId, roomId, topicId);
    return existsSync(file) ? [file] : [];
  }
  const dir = transcriptRoomDir(rootDir, agentId, roomId);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((entry) => path.join(dir, entry))
      .filter((file) => file.endsWith(".jsonl") && isFile(file));
  } catch {
    return [];
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function scanRuntimeFailureFile(
  file: string,
  turnId: string | null,
  errorRef: string | null,
): RuntimeFailureLookupResult["record"] | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const rec = parsed as RuntimeFailureLookupResult["record"];
    if (rec.kind !== "turn_error" && rec.kind !== "runtime_failure") continue;
    if (!rec.errorRef && !rec.runtimeFailure) continue;
    if (turnId && rec.turnId !== turnId) continue;
    if (errorRef && rec.errorRef !== errorRef) continue;
    return rec;
  }
  return null;
}
