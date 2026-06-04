#!/usr/bin/env node
// Codex session token-usage report for BotCord daemon hosts.
//
// Scans local Codex rollout transcripts under
//   <root>/agents/<agentId>/codex-home/sessions/**/*.jsonl
// and reports token usage per agent / room / session, joining the daemon's
// session map (<root>/daemon/sessions.json) to attach the BotCord room each
// session belongs to. Built to answer "which session/room/agent is burning
// tokens" and to alert (non-zero exit) when a session crosses a threshold.
//
// Each Codex `token_count` event carries `info.total_token_usage` (cumulative
// for the session so far) and `info.last_token_usage` (the most recent model
// call). We take the LAST token_count event for a session's cumulative total
// and track the PEAK `last_token_usage.input_tokens` — the latter is the same
// signal the daemon's proactive rotation watches, so this surfaces sessions
// that should have rotated.
//
// Usage:
//   node session-usage-report.mjs [--since=24h] [--top=20] [--by-room]
//     [--alert-last-input=160000] [--alert-total=5000000] [--root=~/.botcord]
//     [--json]
//
// Exit codes: 0 = ok, 2 = at least one session tripped an alert threshold.

import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    since: "24h",
    top: 20,
    byRoom: false,
    alertLastInput: 160_000,
    alertTotal: 5_000_000,
    root: path.join(os.homedir(), ".botcord"),
    json: false,
  };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, key, val] = m;
    switch (key) {
      case "since": out.since = val ?? out.since; break;
      case "top": out.top = Number(val) || out.top; break;
      case "by-room": out.byRoom = true; break;
      case "alert-last-input": out.alertLastInput = Number(val) || 0; break;
      case "alert-total": out.alertTotal = Number(val) || 0; break;
      case "root": out.root = val ? expandHome(val) : out.root; break;
      case "json": out.json = true; break;
      default: break;
    }
  }
  return out;
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Parse a `--since` value (`24h`, `7d`, `90m`, or an ISO date) to an epoch ms cutoff. */
function sinceCutoff(since) {
  const rel = /^(\d+)([mhd])$/.exec(since);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]];
    return Date.now() - n * unit;
  }
  const t = Date.parse(since);
  return Number.isFinite(t) ? t : Date.now() - 86_400_000;
}

/** Recursively collect *.jsonl files under dir. */
async function findJsonl(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...(await findJsonl(full)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) found.push(full);
  }
  return found;
}

/** Load <root>/daemon/sessions.json into a runtimeSessionId -> entry map. */
async function loadSessionMap(root) {
  const map = new Map();
  try {
    const raw = await readFile(path.join(root, "daemon", "sessions.json"), "utf8");
    const parsed = JSON.parse(raw);
    for (const entry of Object.values(parsed.entries ?? {})) {
      if (entry?.runtimeSessionId) map.set(entry.runtimeSessionId, entry);
    }
  } catch {
    // No map (or unreadable) — sessions just report room=unknown.
  }
  return map;
}

const EMPTY = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };

/**
 * Stream one rollout file, extracting the session id, the final cumulative
 * usage, the peak single-turn input, the last activity timestamp, and the
 * subagent flag. Streams line-by-line so multi-MB transcripts stay cheap.
 */
async function scanFile(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let sessionId = null;
  let subagent = false;
  let cwd = null;
  let total = { ...EMPTY };
  let peakLastInput = 0;
  let contextWindow = null;
  let lastTs = null;
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) lastTs = o.timestamp;
    if (o.type === "session_meta") {
      sessionId = o.payload?.id ?? sessionId;
      cwd = o.payload?.cwd ?? cwd;
      subagent = o.payload?.thread_source === "subagent";
      continue;
    }
    if (o.type === "event_msg" && o.payload?.type === "token_count") {
      const info = o.payload.info ?? {};
      if (info.total_token_usage) total = info.total_token_usage;
      const li = info.last_token_usage?.input_tokens ?? 0;
      if (li > peakLastInput) peakLastInput = li;
      if (info.model_context_window) contextWindow = info.model_context_window;
    }
  }
  return {
    file,
    sessionId,
    subagent,
    cwd,
    total,
    peakLastInput,
    contextWindow,
    lastTs: lastTs ? Date.parse(lastTs) : null,
  };
}

/** Extract the agent id from a sessions path: .../agents/<agentId>/codex-home/... */
function agentIdFromPath(file) {
  const m = /\/agents\/([^/]+)\/codex-home\//.exec(file);
  return m ? m[1] : "unknown";
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Fixed-width cell: truncate over-long values (with an ellipsis) so columns align. */
function clip(s, w) {
  s = String(s);
  if (s.length > w - 1) s = `${s.slice(0, w - 2)}… `;
  return pad(s, w);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cutoff = sinceCutoff(opts.since);
  const agentsDir = path.join(opts.root, "agents");
  const sessionMap = await loadSessionMap(opts.root);

  const files = await findJsonl(agentsDir);
  const scanned = [];
  for (const file of files) {
    // Cheap pre-filter on mtime so we don't stream ancient transcripts.
    let mtime = 0;
    try { mtime = (await stat(file)).mtimeMs; } catch { /* ignore */ }
    if (mtime && mtime < cutoff) continue;
    const r = await scanFile(file);
    const ts = r.lastTs ?? mtime;
    if (ts && ts < cutoff) continue;
    const entry = r.sessionId ? sessionMap.get(r.sessionId) : undefined;
    scanned.push({
      ...r,
      ts,
      agentId: agentIdFromPath(file),
      roomId: entry?.conversationId ?? (r.subagent ? "(subagent)" : "(rotated/unknown)"),
      turnCount: entry?.turnCount ?? null,
    });
  }

  scanned.sort((a, b) => (b.total.total_tokens ?? 0) - (a.total.total_tokens ?? 0));

  // Aggregate per agent and (optionally) per room.
  const byAgent = new Map();
  const byRoom = new Map();
  for (const s of scanned) {
    const a = byAgent.get(s.agentId) ?? { sessions: 0, total: 0, output: 0, peakInput: 0 };
    a.sessions += 1;
    a.total += s.total.total_tokens ?? 0;
    a.output += s.total.output_tokens ?? 0;
    a.peakInput = Math.max(a.peakInput, s.peakLastInput);
    byAgent.set(s.agentId, a);

    const rk = `${s.agentId}::${s.roomId}`;
    const r = byRoom.get(rk) ?? { agentId: s.agentId, roomId: s.roomId, sessions: 0, total: 0, peakInput: 0 };
    r.sessions += 1;
    r.total += s.total.total_tokens ?? 0;
    r.peakInput = Math.max(r.peakInput, s.peakLastInput);
    byRoom.set(rk, r);
  }

  const alerts = scanned.filter(
    (s) =>
      (opts.alertTotal > 0 && (s.total.total_tokens ?? 0) >= opts.alertTotal) ||
      (opts.alertLastInput > 0 && s.peakLastInput >= opts.alertLastInput),
  );

  if (opts.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      since: opts.since,
      thresholds: { alertTotal: opts.alertTotal, alertLastInput: opts.alertLastInput },
      sessionsScanned: scanned.length,
      byAgent: [...byAgent.entries()].map(([agentId, v]) => ({ agentId, ...v })),
      byRoom: [...byRoom.values()],
      topSessions: scanned.slice(0, opts.top).map((s) => ({
        agentId: s.agentId,
        roomId: s.roomId,
        sessionId: s.sessionId,
        subagent: s.subagent,
        turnCount: s.turnCount,
        totalTokens: s.total.total_tokens ?? 0,
        cachedInputTokens: s.total.cached_input_tokens ?? 0,
        outputTokens: s.total.output_tokens ?? 0,
        peakLastInputTokens: s.peakLastInput,
        contextWindow: s.contextWindow,
        lastActivity: s.ts ? new Date(s.ts).toISOString() : null,
      })),
      alerts: alerts.map((s) => ({
        agentId: s.agentId,
        roomId: s.roomId,
        sessionId: s.sessionId,
        totalTokens: s.total.total_tokens ?? 0,
        peakLastInputTokens: s.peakLastInput,
      })),
    }, null, 2));
    process.exit(alerts.length ? 2 : 0);
  }

  console.log(`BotCord Codex session usage — since ${opts.since} (${scanned.length} sessions)\n`);

  console.log("Per agent (by total tokens):");
  console.log(`  ${pad("agent", 18)}${pad("sessions", 10)}${pad("total", 10)}${pad("output", 10)}peak-1turn-input`);
  for (const [agentId, v] of [...byAgent.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${pad(agentId, 18)}${pad(v.sessions, 10)}${pad(fmt(v.total), 10)}${pad(fmt(v.output), 10)}${fmt(v.peakInput)}`);
  }

  if (opts.byRoom) {
    console.log("\nPer room (by total tokens):");
    console.log(`  ${pad("agent", 18)}${pad("room", 24)}${pad("sessions", 10)}${pad("total", 10)}peak-1turn-input`);
    for (const r of [...byRoom.values()].sort((a, b) => b.total - a.total)) {
      console.log(`  ${pad(r.agentId, 18)}${clip(r.roomId, 24)}${pad(r.sessions, 10)}${pad(fmt(r.total), 10)}${fmt(r.peakInput)}`);
    }
  }

  console.log(`\nTop ${opts.top} sessions:`);
  console.log(`  ${pad("agent", 18)}${pad("room", 22)}${pad("turns", 7)}${pad("total", 9)}${pad("peak-in", 9)}${pad("ctx%", 6)}session`);
  for (const s of scanned.slice(0, opts.top)) {
    const ctxPct = s.contextWindow ? `${Math.round((s.peakLastInput / s.contextWindow) * 100)}%` : "-";
    const flag = (opts.alertTotal > 0 && (s.total.total_tokens ?? 0) >= opts.alertTotal)
      || (opts.alertLastInput > 0 && s.peakLastInput >= opts.alertLastInput) ? " ⚠" : "";
    console.log(`  ${pad(s.agentId, 18)}${clip(s.roomId, 22)}${pad(s.turnCount ?? "-", 7)}${pad(fmt(s.total.total_tokens ?? 0), 9)}${pad(fmt(s.peakLastInput), 9)}${pad(ctxPct, 6)}${s.sessionId ?? "?"}${flag}`);
  }

  if (alerts.length) {
    console.log(`\n⚠ ${alerts.length} session(s) over threshold (total>=${fmt(opts.alertTotal)} or peak-input>=${fmt(opts.alertLastInput)}):`);
    for (const s of alerts) {
      console.log(`  ${s.agentId} ${s.roomId} ${s.sessionId} total=${fmt(s.total.total_tokens ?? 0)} peak-input=${fmt(s.peakLastInput)}`);
    }
  }

  process.exit(alerts.length ? 2 : 0);
}

main().catch((err) => {
  console.error("session-usage-report failed:", err);
  process.exit(1);
});
