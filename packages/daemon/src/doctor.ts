import type { RuntimeProbeEntry } from "./adapters/runtimes.js";
import type { DaemonConfig } from "./config.js";
import { resolveBootAgents } from "./agent-discovery.js";

/** Summary of a single channel's readiness, printable by the doctor command. */
export interface ChannelProbeResult {
  id: string;
  type: string;
  accountId: string;
  credentialsOk: boolean;
  credentialsMessage: string;
  hubUrl: string | null;
  hubOk: boolean;
  hubMessage: string;
}

/** Minimal filesystem surface needed by {@link probeChannel}; injectable for tests. */
export interface DoctorFileReader {
  readFile(path: string): string | null;
}

/** HTTP GET surface needed by {@link probeChannel}; injectable for tests. */
export interface DoctorHttpFetcher {
  (url: string, timeoutMs: number): Promise<DoctorHttpResult>;
}

/** Response shape returned by {@link DoctorHttpFetcher}. */
export interface DoctorHttpResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** One endpoint probe entry, mirrored from `RuntimeEndpointProbe`. */
export interface DoctorRuntimeEndpoint {
  name: string;
  url: string;
  reachable: boolean;
  version?: string;
  error?: string;
  agents?: Array<{
    id: string;
    name?: string;
    workspace?: string;
    model?: { name?: string; provider?: string };
  }>;
  /**
   * Optional warning surfaced by the doctor: e.g. botcord plugin loaded on
   * the gateway (would form a daemon → openclaw → botcord → Hub loop).
   */
  warnings?: string[];
}

/** Augmented runtime entry that may carry endpoint probe results. */
export interface DoctorRuntimeEntry extends RuntimeProbeEntry {
  endpoints?: DoctorRuntimeEndpoint[];
}

/** Input for the rendered doctor output. */
export interface DoctorInput {
  runtimes: DoctorRuntimeEntry[];
  channels: ChannelProbeResult[];
}

/** Per-channel config entry accepted by {@link probeChannel}. */
export interface ChannelProbeConfig {
  id: string;
  type: string;
  accountId: string;
  /**
   * Optional explicit credential file path. When set, wins over the
   * default `~/.botcord/credentials/<accountId>.json` used by
   * `probeChannel`'s fallback. Populated by discovery to surface the
   * exact file that would be loaded at start.
   */
  credentialsFile?: string;
}

/** Top-level options for {@link probeChannels}. */
export interface ProbeChannelsOptions {
  channels: ChannelProbeConfig[];
  credentialsPath: (accountId: string) => string;
  fileReader: DoctorFileReader;
  fetcher: DoctorHttpFetcher;
  timeoutMs?: number;
}

/**
 * Build the implicit channel list for a daemon config. One channel per
 * configured or discovered agent, keyed by agentId (matches
 * `toGatewayConfig`). Mirrors the daemon's boot-agent resolution so
 * `doctor` reports channels even when the config file omits `agents`.
 */
export function channelsFromDaemonConfig(cfg: DaemonConfig): ChannelProbeConfig[] {
  let boot;
  try {
    boot = resolveBootAgents(cfg);
  } catch {
    return [];
  }
  return boot.agents.map((a) => {
    const entry: ChannelProbeConfig = {
      id: a.agentId,
      type: "botcord",
      accountId: a.agentId,
    };
    if (a.credentialsFile) entry.credentialsFile = a.credentialsFile;
    return entry;
  });
}

/**
 * Inspect credentials + Hub reachability for one channel. Pure modulo the
 * injected file reader and fetcher.
 */
export async function probeChannel(
  ch: ChannelProbeConfig,
  opts: {
    credentialsPath: (accountId: string) => string;
    fileReader: DoctorFileReader;
    fetcher: DoctorHttpFetcher;
    timeoutMs: number;
  },
): Promise<ChannelProbeResult> {
  const result: ChannelProbeResult = {
    id: ch.id,
    type: ch.type,
    accountId: ch.accountId,
    credentialsOk: false,
    credentialsMessage: "",
    hubUrl: null,
    hubOk: false,
    hubMessage: "",
  };

  if (ch.type !== "botcord") {
    result.credentialsMessage = `unsupported channel type "${ch.type}" (no credentials check)`;
    result.hubMessage = "skipped";
    return result;
  }

  const credFile = ch.credentialsFile ?? opts.credentialsPath(ch.accountId);
  const raw = opts.fileReader.readFile(credFile);
  if (raw === null) {
    result.credentialsMessage = `missing at ${credFile}`;
  } else {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const token = parsed.token ?? parsed["token"];
      const hubUrlRaw = parsed.hubUrl ?? parsed["hub_url"] ?? parsed["hub"];
      if (typeof token !== "string" || token.length === 0) {
        result.credentialsMessage = "token missing or empty";
      } else if (typeof hubUrlRaw !== "string" || hubUrlRaw.length === 0) {
        result.credentialsMessage = "hubUrl missing";
      } else {
        result.credentialsOk = true;
        result.credentialsMessage = `loaded (${credFile})`;
        result.hubUrl = hubUrlRaw;
      }
    } catch (err) {
      result.credentialsMessage = `invalid JSON: ${(err as Error).message}`;
    }
  }

  if (!result.hubUrl) {
    result.hubMessage = "skipped (no hub URL)";
    return result;
  }

  // Probe `/` — the hub is ASGI and responds 2xx/3xx/404 which is fine for
  // "reachable". We treat any response as reachable; network errors fall
  // through to hubOk=false.
  const probeUrl = `${result.hubUrl.replace(/\/+$/, "")}/`;
  const http = await opts.fetcher(probeUrl, opts.timeoutMs);
  if (http.ok) {
    result.hubOk = true;
    result.hubMessage = `reachable (HTTP ${http.status})`;
  } else if (http.status !== undefined) {
    result.hubMessage = `HTTP ${http.status}`;
  } else {
    result.hubMessage = http.error ?? "unreachable";
  }
  return result;
}

/** Probe a list of channels sequentially. Sequential keeps output stable. */
export async function probeChannels(
  opts: ProbeChannelsOptions,
): Promise<ChannelProbeResult[]> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const out: ChannelProbeResult[] = [];
  for (const ch of opts.channels) {
    out.push(
      await probeChannel(ch, {
        credentialsPath: opts.credentialsPath,
        fileReader: opts.fileReader,
        fetcher: opts.fetcher,
        timeoutMs,
      }),
    );
  }
  return out;
}

/** Default HTTP fetcher using `fetch` + `AbortController` timeout. */
export const defaultHttpFetcher: DoctorHttpFetcher = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    const ok = resp.status >= 200 && resp.status < 400;
    return { ok, status: resp.status };
  } catch (err) {
    const e = err as Error & { name?: string };
    if (e.name === "AbortError") return { ok: false, error: "timeout" };
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
};

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - s.length));
}

/**
 * Render runtime + channel probe output. Pure — all IO happened already.
 * Used by the CLI `doctor` command and by unit tests.
 */
export function renderDoctor(input: DoctorInput): string {
  const lines: string[] = [];

  // Runtimes table (matches existing doctor layout).
  const rows = input.runtimes.map((e) => ({
    runtime: e.id,
    name: e.displayName,
    status: e.result.available ? "ok" : "missing",
    version: e.result.version ?? "—",
    path: e.result.path ?? "—",
  }));
  const widths = {
    runtime: Math.max(7, ...rows.map((r) => r.runtime.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
  };
  lines.push(
    `${pad("RUNTIME", widths.runtime)}  ${pad("NAME", widths.name)}  ${pad("STATUS", widths.status)}  ${pad("VERSION", widths.version)}  PATH`,
  );
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const e = input.runtimes[i];
    lines.push(
      `${pad(r.runtime, widths.runtime)}  ${pad(r.name, widths.name)}  ${pad(r.status, widths.status)}  ${pad(r.version, widths.version)}  ${r.path}`,
    );
    if (e.endpoints && e.endpoints.length > 0) {
      for (const ep of e.endpoints) {
        const mark = ep.reachable ? "✓" : "✗";
        const detail = ep.reachable
          ? ep.version ?? "ok"
          : ep.error ?? "unreachable";
        lines.push(`    gateway ${pad(`"${ep.name}"`, 16)} ${pad(ep.url, 40)} ${mark} ${detail}`);
        if (ep.agents && ep.agents.length > 0) {
          // RFC §3.8.4: list by `id` (stable key); show display name when distinct.
          lines.push(
            `      agents (id): ${ep.agents
              .map((a) => (a.name && a.name !== a.id ? `${a.id} (${a.name})` : a.id))
              .join(", ")}`,
          );
        }
        if (ep.warnings) {
          for (const w of ep.warnings) lines.push(`      WARN: ${w}`);
        }
      }
    }
  }
  const available = input.runtimes.filter((e) => e.result.available).length;
  lines.push(`\n${available}/${input.runtimes.length} runtimes available`);

  lines.push("");
  lines.push("Channels:");
  if (input.channels.length === 0) {
    lines.push("  No channels configured.");
    return lines.join("\n");
  }
  const cw = {
    id: Math.max(2, ...input.channels.map((c) => c.id.length)),
    type: Math.max(4, ...input.channels.map((c) => c.type.length)),
  };
  lines.push(
    `  ${pad("ID", cw.id)}  ${pad("TYPE", cw.type)}  CREDENTIALS        HUB`,
  );
  for (const c of input.channels) {
    const credMark = c.credentialsOk ? "✓" : "✗";
    const hubMark = c.hubOk ? "✓" : "✗";
    lines.push(
      `  ${pad(c.id, cw.id)}  ${pad(c.type, cw.type)}  ${credMark} ${pad(c.credentialsMessage, 16)}  ${hubMark} ${c.hubMessage}`,
    );
  }
  return lines.join("\n");
}

/**
 * Thin orchestrator: runs runtime + channel probes and returns the rendered
 * text. Keeps `index.ts` free of probe wiring.
 */
export async function runDoctor(
  runtimes: RuntimeProbeEntry[],
  channels: ChannelProbeConfig[],
  opts: {
    credentialsPath: (accountId: string) => string;
    fileReader: DoctorFileReader;
    fetcher: DoctorHttpFetcher;
    timeoutMs?: number;
  },
): Promise<DoctorInput> {
  const channelResults = await probeChannels({
    channels,
    credentialsPath: opts.credentialsPath,
    fileReader: opts.fileReader,
    fetcher: opts.fetcher,
    timeoutMs: opts.timeoutMs,
  });
  return { runtimes, channels: channelResults };
}
