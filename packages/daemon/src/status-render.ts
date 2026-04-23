import type { GatewayRuntimeSnapshot } from "./gateway/index.js";

/** Threshold after which a snapshot is flagged `⚠ stale` in rendered output. */
export const STALE_THRESHOLD_MS = 30_000;

/** Input bundle for {@link renderStatus}. */
export interface StatusRenderInput {
  pid: number | null;
  alive: boolean;
  /**
   * Effective list of agent ids the daemon is bound to. Single-agent installs
   * show one entry; multi-agent configs show all. `agentId` (scalar) is kept
   * for backward-compat callers and, when provided alone, rendered the same
   * way.
   */
  agents?: string[] | null;
  /** @deprecated prefer `agents`. */
  agentId?: string | null;
  /** "config" — explicit list; "credentials" — auto-discovered. */
  agentsSource?: "config" | "credentials" | null;
  configPath?: string | null;
  snapshot?: GatewayRuntimeSnapshot | null;
  /** `writtenAt` age in ms. Undefined when no snapshot is available. */
  snapshotAgeMs?: number | null;
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - s.length));
}

function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function renderChannels(snap: GatewayRuntimeSnapshot): string[] {
  const entries = Object.values(snap.channels);
  if (entries.length === 0) return ["Channels:", "  (none)"];
  const idW = Math.max(2, ...entries.map((c) => c.channel.length));
  const accW = Math.max(7, ...entries.map((c) => c.accountId.length));
  const out: string[] = ["Channels:"];
  out.push(
    `  ${pad("ID", idW)}  ${pad("ACCOUNT", accW)}  RUNNING  CONNECTED  RETRIES  RESTART  LAST ERROR`,
  );
  for (const c of entries) {
    const running = c.running ? "yes" : "no";
    const connected =
      c.connected === undefined ? "—" : c.connected ? "yes" : "no";
    const retries =
      c.reconnectAttempts === undefined ? "—" : String(c.reconnectAttempts);
    const restart = c.restartPending ? "yes" : "no";
    const err = c.lastError ?? "—";
    out.push(
      `  ${pad(c.channel, idW)}  ${pad(c.accountId, accW)}  ${pad(running, 7)}  ${pad(connected, 9)}  ${pad(retries, 7)}  ${pad(restart, 7)}  ${err}`,
    );
  }
  return out;
}

function renderTurns(
  snap: GatewayRuntimeSnapshot,
  now: number,
): string[] {
  const entries = Object.values(snap.turns);
  if (entries.length === 0) return ["In-flight turns:", "  (none)"];
  const out: string[] = ["In-flight turns:"];
  const keyW = Math.max(3, ...entries.map((t) => t.key.length));
  const chW = Math.max(7, ...entries.map((t) => t.channel.length));
  const convW = Math.max(14, ...entries.map((t) => t.conversationId.length));
  const rtW = Math.max(7, ...entries.map((t) => t.runtime.length));
  out.push(
    `  ${pad("KEY", keyW)}  ${pad("CHANNEL", chW)}  ${pad("CONVERSATION", convW)}  ${pad("RUNTIME", rtW)}  STARTED          CWD`,
  );
  for (const t of entries) {
    const started = relTime(now - t.startedAt);
    out.push(
      `  ${pad(t.key, keyW)}  ${pad(t.channel, chW)}  ${pad(t.conversationId, convW)}  ${pad(t.runtime, rtW)}  ${pad(started, 16)}  ${t.cwd}`,
    );
  }
  return out;
}

/**
 * Format a human-readable status block. Kept pure so it can be unit-tested
 * without touching disk or spawning a daemon.
 */
export function renderStatus(input: StatusRenderInput, now: number = Date.now()): string {
  const lines: string[] = [];
  if (input.pid === null) {
    lines.push("daemon: stopped");
    return lines.join("\n");
  }
  lines.push(`daemon: pid ${input.pid} (${input.alive ? "alive" : "not alive"})`);
  const agents =
    input.agents && input.agents.length > 0
      ? input.agents
      : input.agentId
        ? [input.agentId]
        : [];
  const sourceTag =
    input.agentsSource === "credentials"
      ? " (discovered)"
      : input.agentsSource === "config"
        ? ""
        : "";
  if (agents.length === 1) {
    lines.push(`agent:  ${agents[0]}${sourceTag}`);
  } else if (agents.length > 1) {
    lines.push(`agents: ${agents.join(", ")}${sourceTag}`);
  } else if (input.agentsSource === "credentials") {
    lines.push(`agents: (none discovered; drop credentials in ~/.botcord/credentials)`);
  }
  if (input.configPath) lines.push(`config: ${input.configPath}`);

  if (input.snapshot) {
    const age = input.snapshotAgeMs ?? 0;
    const stale = age > STALE_THRESHOLD_MS ? " ⚠ stale" : "";
    lines.push(`snapshot: ${relTime(age)}${stale}`);
    lines.push("");
    lines.push(...renderChannels(input.snapshot));
    lines.push("");
    lines.push(...renderTurns(input.snapshot, now));
  } else if (input.alive) {
    lines.push("snapshot: unavailable (daemon running but no snapshot file found)");
  }
  return lines.join("\n");
}
