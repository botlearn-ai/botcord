import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { GatewayLogger } from "./log.js";
import { transcriptFilePath } from "./transcript-paths.js";

/**
 * Soft cap on a single textual field (`text` / `composedText` / `finalText`).
 * Anything longer is truncated and `truncated.<field>` set to `true`.
 */
export const TRANSCRIPT_TEXT_LIMIT = 32 * 1024;

/** Soft cap on a single transcript file before rotation. */
export const TRANSCRIPT_FILE_LIMIT = 8 * 1024 * 1024;

/** Default retention window for transcript JSONL files. */
export const TRANSCRIPT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** Minimum interval between background transcript retention sweeps. */
export const TRANSCRIPT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Default root directory for per-agent transcript trees. */
export function defaultTranscriptRoot(): string {
  return path.join(homedir(), ".botcord", "agents");
}

// ---------------------------------------------------------------------------
// Record types — see design §3.2
// ---------------------------------------------------------------------------

export type TranscriptRecordKind =
  | "inbound"
  | "dispatched"
  | "block"
  | "compose_failed"
  | "outbound"
  | "turn_error"
  | "attention_skipped"
  | "dropped";

export interface TranscriptRecordBase {
  ts: string;
  kind: TranscriptRecordKind;
  turnId: string;
  agentId: string;
  roomId: string;
  topicId: string | null;
}

export interface TranscriptSenderInfo {
  id: string;
  kind: "user" | "agent" | "system";
  name?: string;
}

export interface InboundTranscriptRecord extends TranscriptRecordBase {
  kind: "inbound";
  messageId: string;
  sender: TranscriptSenderInfo;
  text: string;
  rawBatchEntries?: number;
  trace?: { id: string; streamable?: boolean };
  truncated?: { text?: true };
}

export interface DispatchedTranscriptRecord extends TranscriptRecordBase {
  kind: "dispatched";
  composedText: string;
  mergedFromTurnIds?: string[];
  runtime: string;
  truncated?: { composedText?: true };
}

export interface BlockTranscriptRecord extends TranscriptRecordBase {
  kind: "block";
  runtime: string;
  seq: number;
  blockType: string;
  summary: TranscriptBlockSummary;
  raw?: unknown;
}

export interface ComposeFailedTranscriptRecord extends TranscriptRecordBase {
  kind: "compose_failed";
  error: string;
  fallback: "raw_text";
}

export type DeliveryStatus =
  | "delivered"
  | "gated_non_owner_chat"
  | "empty_text"
  | "send_failed";

export interface TranscriptBlockSummary {
  type: string;
  chars?: number;
  name?: string;
}

export interface OutboundTranscriptRecord extends TranscriptRecordBase {
  kind: "outbound";
  runtime: string;
  runtimeSessionId?: string | null;
  durationMs: number;
  costUsd?: number;
  finalText: string;
  deliveryStatus: DeliveryStatus;
  deliveryReason?: string | null;
  blocks?: TranscriptBlockSummary[];
  truncated?: { finalText?: true };
}

export interface TurnErrorTranscriptRecord extends TranscriptRecordBase {
  kind: "turn_error";
  phase: "runtime" | "timeout";
  error: string;
  durationMs: number;
}

export interface AttentionSkippedTranscriptRecord extends TranscriptRecordBase {
  kind: "attention_skipped";
  reason: string;
}

export type DroppedReason =
  | "batch_merged"
  | "queue_cancel_previous"
  | "queue_overflow";

export interface DroppedTranscriptRecord extends TranscriptRecordBase {
  kind: "dropped";
  reason: DroppedReason;
  supersededBy?: string | null;
}

export type TranscriptRecord =
  | InboundTranscriptRecord
  | DispatchedTranscriptRecord
  | BlockTranscriptRecord
  | ComposeFailedTranscriptRecord
  | OutboundTranscriptRecord
  | TurnErrorTranscriptRecord
  | AttentionSkippedTranscriptRecord
  | DroppedTranscriptRecord;

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

/**
 * Truncate `value` to TRANSCRIPT_TEXT_LIMIT chars. Returns the (possibly
 * truncated) text and whether truncation occurred. Surrogate-pair aware: if
 * the cut would split a pair, step back one char.
 */
export function truncateTextField(value: string): { text: string; truncated: boolean } {
  if (value.length <= TRANSCRIPT_TEXT_LIMIT) return { text: value, truncated: false };
  let cut = TRANSCRIPT_TEXT_LIMIT;
  const code = value.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // mid-surrogate
  return { text: value.slice(0, cut), truncated: true };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface TranscriptWriter {
  /** Append a record. Failures are logged and swallowed. */
  write(rec: TranscriptRecord): void;
  /** Whether persistence is on. CLI / tests may read this. */
  readonly enabled: boolean;
  /** Root directory used for path resolution. */
  readonly rootDir: string;
}

export interface CreateTranscriptWriterOptions {
  /** Defaults to `~/.botcord/agents`. */
  rootDir?: string;
  log: GatewayLogger;
  /** Defaults to `true`; pass `false` to disable persistence. */
  enabled?: boolean;
  /** Override file rotation threshold (bytes). Defaults to TRANSCRIPT_FILE_LIMIT. */
  maxFileBytes?: number;
  /** Delete transcript JSONL files older than this. Defaults to 3 days. */
  retentionMs?: number;
  /** Minimum interval between retention sweeps. Defaults to 6 hours. */
  cleanupIntervalMs?: number;
}

interface FileMeta {
  size: number;
}

class NoopTranscriptWriter implements TranscriptWriter {
  readonly enabled = false;
  readonly rootDir: string;
  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }
  write(_rec: TranscriptRecord): void {
    // intentionally empty
  }
}

class FsTranscriptWriter implements TranscriptWriter {
  readonly enabled = true;
  readonly rootDir: string;
  private readonly log: GatewayLogger;
  private readonly maxFileBytes: number;
  private readonly retentionMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly fileMeta = new Map<string, FileMeta>();
  private firstWriteAnnounced = false;
  private lastCleanupAt = 0;

  constructor(
    rootDir: string,
    log: GatewayLogger,
    maxFileBytes: number,
    retentionMs: number,
    cleanupIntervalMs: number,
  ) {
    this.rootDir = rootDir;
    this.log = log;
    this.maxFileBytes = maxFileBytes;
    this.retentionMs = retentionMs;
    this.cleanupIntervalMs = cleanupIntervalMs;
  }

  write(rec: TranscriptRecord): void {
    try {
      this.cleanupOldFiles();
      const file = transcriptFilePath(this.rootDir, rec.agentId, rec.roomId, rec.topicId);
      const dir = path.dirname(file);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {
        // best-effort — appendFileSync below will surface a real error
      }

      const line = JSON.stringify(rec) + "\n";
      const bytes = Buffer.byteLength(line, "utf8");

      // Rotate before appending if the existing file would exceed the cap.
      const meta = this.statFile(file);
      if (meta.size > 0 && meta.size + bytes > this.maxFileBytes) {
        this.rotate(file);
        this.fileMeta.delete(file);
      }

      appendFileSync(file, line, { mode: 0o600 });
      const cur = this.fileMeta.get(file) ?? { size: meta.size };
      cur.size = (cur.size || 0) + bytes;
      this.fileMeta.set(file, cur);

      if (!this.firstWriteAnnounced) {
        this.firstWriteAnnounced = true;
        this.log.info("transcript enabled", { dir: this.rootDir });
      }
    } catch (err) {
      this.log.warn("transcript: write failed", {
        kind: rec.kind,
        turnId: rec.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private statFile(file: string): FileMeta {
    const cached = this.fileMeta.get(file);
    if (cached) return cached;
    try {
      const st = statSync(file);
      const meta = { size: st.size };
      this.fileMeta.set(file, meta);
      return meta;
    } catch {
      const meta = { size: 0 };
      this.fileMeta.set(file, meta);
      return meta;
    }
  }

  private rotate(file: string): void {
    const stamp = formatStamp(new Date());
    const ext = ".jsonl";
    const base = file.endsWith(ext) ? file.slice(0, -ext.length) : file;
    const rotated = `${base}.${stamp}${ext}`;
    try {
      renameSync(file, rotated);
    } catch (err) {
      this.log.warn("transcript: rotate failed", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private cleanupOldFiles(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) return;
    this.lastCleanupAt = now;
    const cutoff = now - this.retentionMs;
    const removed = cleanupTranscriptFiles(this.rootDir, cutoff);
    if (removed > 0) {
      this.log.info("transcript cleanup removed old files", {
        dir: this.rootDir,
        removed,
        retentionMs: this.retentionMs,
      });
    }
  }
}

export function createTranscriptWriter(
  opts: CreateTranscriptWriterOptions,
): TranscriptWriter {
  const rootDir = opts.rootDir ?? defaultTranscriptRoot();
  const enabled = opts.enabled ?? true;
  if (!enabled) return new NoopTranscriptWriter(rootDir);
  const maxBytes = opts.maxFileBytes ?? TRANSCRIPT_FILE_LIMIT;
  return new FsTranscriptWriter(
    rootDir,
    opts.log,
    maxBytes,
    opts.retentionMs ?? TRANSCRIPT_RETENTION_MS,
    opts.cleanupIntervalMs ?? TRANSCRIPT_CLEANUP_INTERVAL_MS,
  );
}

/**
 * Resolve the tri-state enable flag (env wins; otherwise config). See design §5.
 *  - env === "1" → true (force on)
 *  - env === "0" → false (force off)
 *  - any other / unset → fall back to `configEnabled`
 */
export function resolveTranscriptEnabled(
  envVal: string | undefined,
  configEnabled: boolean | undefined,
): boolean {
  if (envVal === "1") return true;
  if (envVal === "0") return false;
  return configEnabled ?? true;
}

export function cleanupTranscriptFiles(rootDir: string, cutoffMs: number): number {
  let removed = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth < 0) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry);
      try {
        const st = statSync(file);
        if (st.isDirectory()) {
          visit(file, depth - 1);
          continue;
        }
        if (
          st.isFile() &&
          entry.endsWith(".jsonl") &&
          file.includes(`${path.sep}transcripts${path.sep}`) &&
          st.mtimeMs < cutoffMs
        ) {
          rmSync(file, { force: true });
          removed += 1;
        }
      } catch {
        // ignore disappearing files and permission errors
      }
    }
  };
  visit(rootDir, 6);
  return removed;
}

function formatStamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}
