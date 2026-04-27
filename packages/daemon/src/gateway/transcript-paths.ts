import { createHash } from "node:crypto";
import path from "node:path";

const FAST_PATH_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WIN_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
const MAX_LEN = 200;
const TRUNCATE_PREFIX = 191;

function sha256_8(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

function isControlOrNul(ch: number): boolean {
  return ch === 0 || ch < 0x20 || ch === 0x7f;
}

function isAllControl(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (!isControlOrNul(raw.charCodeAt(i))) return false;
  }
  return true;
}

function percentEncodeByte(byte: number): string {
  return "%" + byte.toString(16).toUpperCase().padStart(2, "0");
}

function isWhitelistByte(byte: number): boolean {
  // [A-Za-z0-9_-%] retained as literal
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x5f || // _
    byte === 0x2d || // -
    byte === 0x25    // %  (kept literal — design §3.1)
  );
}

function escapeRaw(raw: string): string {
  const bytes = Buffer.from(raw, "utf8");
  let out = "";
  for (const b of bytes) {
    out += isWhitelistByte(b) ? String.fromCharCode(b) : percentEncodeByte(b);
  }
  return out;
}

/**
 * Truncate an escaped string to exactly MAX_LEN chars without splitting a `%XX`
 * sequence. Keep first TRUNCATE_PREFIX chars (rolled back if mid-`%XX`), then
 * `_` + sha256-8(raw) so the total is always ≤ MAX_LEN.
 */
function truncateEscaped(escaped: string, raw: string): string {
  let cut = TRUNCATE_PREFIX;
  // Roll back if cut sits inside a `%XX` sequence.
  // A '%' at position cut-1 or cut-2 means the next 1 or 2 chars belong to it.
  if (cut >= 1 && escaped[cut - 1] === "%") cut -= 1;
  else if (cut >= 2 && escaped[cut - 2] === "%") cut -= 2;
  const hash = sha256_8(raw);
  return escaped.slice(0, cut) + "_" + hash;
}

/**
 * Convert a raw ID into a filesystem-safe path segment.
 *
 * Order (must not be reordered — see design §3.1):
 *   1. obviously invalid (empty / `.` / `..` / all control/NUL)
 *      → `_invalid_<sha256-8>`
 *   2. Windows reserved name (CON/PRN/AUX/NUL/COM1-9/LPT1-9, case-insensitive)
 *      → `_win_<raw>`
 *   3. fast path (`^[A-Za-z0-9_-]{1,128}$`) → return raw
 *   4. percent-encode non-whitelist bytes; truncate at 200 chars without
 *      splitting a `%XX` (191 prefix + `_` + sha256-8)
 *
 * The original ID is always written into the transcript record itself; this
 * helper only sanitizes the on-disk filename.
 */
export function safePathSegment(raw: string): string {
  // 1. obviously invalid
  if (raw === "" || raw === "." || raw === ".." || isAllControl(raw)) {
    return "_invalid_" + sha256_8(raw);
  }

  // 2. Windows reserved names — must run BEFORE fast path so `CON` is not
  //    leaked unchanged on case-insensitive filesystems.
  if (WIN_RESERVED.has(raw.toUpperCase())) {
    return "_win_" + raw;
  }

  // 3. fast path
  if (FAST_PATH_RE.test(raw)) return raw;

  // 4. escape + maybe truncate
  const escaped = escapeRaw(raw);
  if (escaped.length <= MAX_LEN) return escaped;
  return truncateEscaped(escaped, raw);
}

/**
 * Resolve the on-disk transcript file for a given (agent, room, topic). Used
 * by the writer AND the CLI subcommands so both look at the same file.
 *
 * Layout (design §3.1):
 *   <rootDir>/<agentId>/transcripts/<roomId>/<topicId|_default>.jsonl
 *
 * Where <rootDir> is typically `~/.botcord/agents`.
 */
export function transcriptFilePath(
  rootDir: string,
  agentId: string,
  roomId: string,
  topicId: string | null,
): string {
  return path.join(
    rootDir,
    safePathSegment(agentId),
    "transcripts",
    safePathSegment(roomId),
    (topicId === null ? "_default" : safePathSegment(topicId)) + ".jsonl",
  );
}

/** Directory holding a (agent, room) pair's transcript files. */
export function transcriptRoomDir(
  rootDir: string,
  agentId: string,
  roomId: string,
): string {
  return path.join(
    rootDir,
    safePathSegment(agentId),
    "transcripts",
    safePathSegment(roomId),
  );
}

/** Directory holding all transcript rooms for a single agent. */
export function transcriptAgentRoot(rootDir: string, agentId: string): string {
  return path.join(rootDir, safePathSegment(agentId), "transcripts");
}
