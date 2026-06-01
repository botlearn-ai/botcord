import fs from "node:fs";
import path from "node:path";
import type { ParsedArgs } from "../args.js";
import { outputJson, outputError } from "../output.js";

/** Marker filename — kept in sync with the daemon's wait-marker module
 *  (packages/daemon/src/gateway/wait-marker.ts). */
const WAIT_MARKER_FILENAME = ".botcord-wait.json";
/** Hard ceiling on a single park request. The daemon clamps to the same value. */
const MAX_WAIT_SECONDS = 30;

/**
 * `botcord wait <seconds> [--reason <r>]`
 *
 * Defer this turn's decision in a group room: write a local park marker that
 * the BotCord daemon reads at the turn boundary and uses to re-wake this agent
 * after `seconds` (or sooner, if a new message arrives meanwhile). Purely local
 * — no Hub call. Only meaningful when invoked inside a daemon-hosted group-room
 * turn; a no-op anywhere else (the marker is simply never consumed).
 */
export async function waitCommand(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord wait <seconds> [--reason <r>]

Defer your decision in a group room. The daemon re-wakes you after <seconds>,
or sooner if a new message arrives — letting you re-decide with the newer
context (e.g. skip replying if another agent already answered).

Arguments:
  <seconds>        How long to wait, 1-${MAX_WAIT_SECONDS} (clamped)

Options:
  --reason <r>     Optional note recorded for debugging`);
    return;
  }

  // `parseArgs` treats the first bare token after the command as `subcommand`,
  // so `botcord wait 8` lands the seconds there, not in `positionals`.
  const rawSeconds =
    args.subcommand ??
    args.positionals[0] ??
    (typeof args.flags["seconds"] === "string" ? args.flags["seconds"] : undefined);
  const seconds = Number(rawSeconds);
  if (!rawSeconds || !Number.isFinite(seconds) || seconds <= 0) {
    outputError("usage: botcord wait <seconds> (1-30)");
    return;
  }
  const clamped = Math.min(Math.ceil(seconds), MAX_WAIT_SECONDS);
  const reason = typeof args.flags["reason"] === "string" ? args.flags["reason"] : undefined;

  const target =
    process.env.BOTCORD_WAIT_FILE ||
    path.join(process.cwd(), WAIT_MARKER_FILENAME);

  const marker = {
    deadlineMs: Date.now() + clamped * 1000,
    seconds: clamped,
    writtenAt: Date.now(),
    ...(reason ? { reason } : {}),
  };

  try {
    fs.writeFileSync(target, JSON.stringify(marker), "utf8");
  } catch (err) {
    outputError(`failed to write wait marker: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  outputJson({ ok: true, waitSeconds: clamped, marker: target });
}
