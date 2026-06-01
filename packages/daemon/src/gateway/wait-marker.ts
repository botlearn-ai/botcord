/**
 * Workspace park-marker transport for the agent-driven `botcord wait` defer.
 *
 * In non-owner BotCord group rooms the dispatcher discards the runtime's final
 * text (the agent replies out-of-band via the `botcord send` CLI → Hub), so a
 * "please re-wake me later" signal cannot ride back on the turn result. Instead
 * the bundled `botcord wait <seconds>` CLI drops a tiny JSON marker into the
 * agent's workspace; the dispatcher reads it at the turn boundary and schedules
 * a re-wake. This keeps the *decision* to wait in the agent (it judges
 * relevance/urgency) while the *timer* lives cheaply in the daemon — no runtime
 * session is held open during the wait.
 *
 * The marker path is scoped per **queue** (channel:agent:room:thread): the
 * dispatcher serializes turns within a queue but NOT across queues that share
 * one agent workspace (`route.cwd`), so two concurrent group-room turns for the
 * same agent would otherwise clobber each other's marker. The dispatcher passes
 * the resolved path to the CLI subprocess via `BOTCORD_WAIT_FILE`.
 *
 * Local daemon-hosted agents only: the marker rides the shared filesystem of
 * `route.cwd`. Cloud (sandboxed) agents need a networked transport — out of
 * scope here.
 */
import fs from "node:fs";
import path from "node:path";

/** Filename stem for park markers. */
export const WAIT_MARKER_PREFIX = ".botcord-wait";
/** Legacy unscoped marker name — the CLI's fallback when `BOTCORD_WAIT_FILE`
 *  is unset. Never consumed by the dispatcher (which always scopes per queue),
 *  so an unscoped write is a harmless no-op. */
export const WAIT_MARKER_FILENAME = `${WAIT_MARKER_PREFIX}.json`;

/** Hard ceiling on a single park request (mirrors the CLI clamp). Also used by
 *  the dispatcher as the total accumulated-park budget across consecutive
 *  re-wakes on one queue. */
export const MAX_WAIT_MS = 30_000;

export interface WaitMarker {
  /** Absolute unix millis the agent wants to be re-woken by (already clamped). */
  deadlineMs: number;
  reason?: string;
}

/** Legacy unscoped path under `cwd` (CLI fallback / tests). */
export function waitMarkerPath(cwd: string): string {
  return path.join(cwd, WAIT_MARKER_FILENAME);
}

/** Per-queue marker path under the agent workspace. */
export function resolveWaitMarkerPath(cwd: string, queueKey: string): string {
  const safe = queueKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(cwd, `${WAIT_MARKER_PREFIX}.${safe}.json`);
}

/** Best-effort delete of any pre-existing marker at `markerPath`. Called before
 *  a turn runs so that whatever `botcord wait` writes during this turn is
 *  unambiguously from this turn. */
export function clearWaitMarker(markerPath: string): void {
  try {
    fs.rmSync(markerPath, { force: true });
  } catch {
    // A leftover marker only costs one wasted park-check next turn — never
    // let cleanup failure abort the dispatch path.
  }
}

/**
 * Read + delete the marker a turn may have written via `botcord wait`, and
 * return the validated request (or null). Always removes the file so the next
 * turn starts clean. `now` is injectable for tests.
 *
 * A deadline in the past — or beyond {@link MAX_WAIT_MS} — is clamped; a
 * non-positive remaining wait yields null (treated as "no wait").
 */
export function consumeWaitMarker(markerPath: string, now: number = Date.now()): WaitMarker | null {
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch {
    return null; // no marker (ENOENT) or unreadable
  }
  try {
    fs.rmSync(markerPath, { force: true });
  } catch {
    // ignore — the pre-turn clear will catch it next time
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const deadlineMs = typeof obj.deadlineMs === "number" ? obj.deadlineMs : NaN;
  if (!Number.isFinite(deadlineMs)) return null;
  const clamped = Math.min(deadlineMs, now + MAX_WAIT_MS);
  if (clamped <= now) return null;
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;
  return reason !== undefined ? { deadlineMs: clamped, reason } : { deadlineMs: clamped };
}
