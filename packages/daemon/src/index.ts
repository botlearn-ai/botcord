#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import {
  loadConfig,
  saveConfig,
  initDefaultConfig,
  resolveConfiguredAgentIds,
  PID_PATH,
  SNAPSHOT_PATH,
  CONFIG_FILE_PATH,
  CONFIG_MISSING,
  type DaemonConfig,
  type RouteRule,
  type RouteRuleMatch,
} from "./config.js";
import { resolveBootAgents } from "./agent-discovery.js";
import {
  defaultTranscriptRoot,
  resolveTranscriptEnabled,
  transcriptAgentRoot,
  transcriptFilePath,
} from "./gateway/index.js";
import { startDaemon } from "./daemon.js";
import { log, LOG_FILE_PATH } from "./log.js";
import { detectRuntimes, getAdapterModule, listAdapterIds } from "./adapters/runtimes.js";
import {
  pollDeviceToken,
  requestDeviceCode,
  type DeviceCodeResponse,
} from "@botcord/protocol-core";
import {
  AUTH_EXPIRED_FLAG_PATH,
  clearAuthExpiredFlag,
  isTokenNearExpiry,
  loadUserAuth,
  saveUserAuth,
  userAuthFromTokenResponse,
  type UserAuthRecord,
} from "./user-auth.js";
import { renderStatus, type StatusRenderInput } from "./status-render.js";
import { appendNextParam } from "./url-utils.js";
import {
  channelsFromDaemonConfig,
  defaultHttpFetcher,
  renderDoctor,
  runDoctor,
  type DoctorFileReader,
} from "./doctor.js";
import type { SnapshotFile } from "./snapshot-writer.js";
import {
  clearWorkingMemory,
  readWorkingMemory,
  resolveMemoryDir,
  updateWorkingMemory,
  DEFAULT_SECTION,
} from "./working-memory.js";
import { resolveStartAuthAction } from "./start-auth.js";
import {
  discoverLocalOpenclawGateways,
  mergeOpenclawGateways,
  openclawDiscoveryConfigEnabled,
} from "./openclaw-discovery.js";

const ADAPTER_LIST = listAdapterIds().join("|");

const DEFAULT_HUB = "https://api.botcord.chat";

/**
 * Fallback label when the operator doesn't pass `--label` at login.
 * macOS hostnames often carry a `.local` mDNS suffix that's just noise in
 * the dashboard — strip it. A null/empty hostname falls back to "daemon".
 */
function defaultLoginLabel(): string {
  const raw = (hostname() || "").trim().replace(/\.local$/i, "");
  return raw.length > 0 ? raw : "daemon";
}

const HELP = `botcord-daemon — BotCord local daemon

Usage: botcord-daemon <command> [options]

Commands:
  start [--background|-d] [--relogin] [--hub <url>] [--label <name>]
        [--install-token <dit_xxx>] [--agent <ag_xxx> ...] [--cwd <path>]
                                          Start the daemon in the foreground by
                                          default. Pass --background (alias -d)
                                          to detach and return to the shell.
                                          Without credentials and on a TTY, runs
                                          the interactive device-code login
                                          first. --hub defaults to ${DEFAULT_HUB}
                                          (or the URL stored in a previous
                                          login). --relogin forces re-login.
                                          --install-token redeems a dashboard
                                          issued one-time install ticket for
                                          non-interactive first start.
                                          --label is sent to the Hub on connect
                                          for the dashboard device list
                                          (defaults to hostname). Non-TTY
                                          environments must mount a pre-existing
                                          user-auth.json (plan §6.4).
                                          On first run, auto-creates
                                          ~/.botcord/daemon/config.json with a
                                          default route (claude-code, $HOME) and
                                          credential auto-discovery. Pass
                                          --agent/--cwd to seed the file
                                          (ignored once config exists).
  stop                                    Stop the running daemon (SIGTERM)
  status                                  Print daemon status (pid, agent)
  logs [-f]                               Print log tail (use -f to follow)
  transcript enable|disable|status        Toggle persistent transcript logging
  transcript list --agent <ag_xxx>        List rooms with transcripts for an agent
  transcript tail --agent <ag_xxx> --room <rm_xxx> [--topic <tp>] [-n 50] [-f]
                                          Tail recent transcript records (NDJSON)
  transcript dump --agent <ag_xxx> --room <rm_xxx> [--topic <tp>]
                                          Print full transcript file to stdout
  transcript prune --agent <ag_xxx> [--older-than 30d] [--all]
                                          Remove rotated transcript files (or all
                                          for the agent with --all --yes)
  route add [match flags] --adapter <${ADAPTER_LIST}> --cwd <path>
      match flags (first match wins; at least one conversation/sender selector required):
        --conversation-id <rm_xxx>        (alias: --room <rm_xxx>)
        --conversation-prefix <rm_oc_>    (alias: --prefix <rm_oc_>)
        --conversation-kind <direct|group>
        --channel <channel_type>          (default: botcord)
        --account-id <ag_xxx>
        --sender-id <ag_xxx>
        --mentioned / --no-mentioned
  route list
  route remove --room <rm_xxx>|--prefix <rm_xxx>
  config                                  Print resolved config
  doctor [--json]                         Scan local runtimes (${ADAPTER_LIST})
  memory get [--agent <ag_xxx>] [--json]  Show current working memory
  memory set [--agent <ag_xxx>] --goal <text>
                                          Pin/update the agent's work goal
  memory set [--agent <ag_xxx>] --section <name> --content <text>
                                          Upsert a section (empty --content deletes it)
  memory delete [--agent <ag_xxx>] --section <name>
                                          Remove a section
  memory clear [--agent <ag_xxx>]         Wipe all working memory
                                          (--agent required if the daemon runs
                                           more than one; optional otherwise)

Env:
  BOTCORD_<RUNTIME>_BIN   Override CLI path per runtime (e.g. BOTCORD_CODEX_BIN)
  BOTCORD_DAEMON_DEBUG    Enable debug logging
`;

interface ParsedArgs {
  cmd: string;
  sub?: string;
  flags: Record<string, string | boolean>;
  /** Repeated-value flags — currently only `--agent`. */
  lists: Record<string, string[]>;
}

/** Known boolean flags — never consume the following token as a value. */
const BOOLEAN_FLAGS = new Set([
  "foreground",
  "background",
  "d",
  "f",
  "follow",
  "json",
  "help",
  "h",
  "mentioned",
  "relogin",
]);

/** Flags that may be repeated on the command line; all values are collected. */
const LIST_FLAGS = new Set(["agent"]);

function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, maybeSub, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const lists: Record<string, string[]> = {};
  const positional: string[] = [];
  let sub: string | undefined;
  if (maybeSub && !maybeSub.startsWith("-")) {
    sub = maybeSub;
  } else if (maybeSub) {
    positional.unshift(maybeSub);
  }
  const args = [...positional, ...rest];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--") && !a.startsWith("-")) continue;
    const key = a.replace(/^-+/, "");
    // `--no-<bool>` → explicit false for a known boolean flag.
    if (key.startsWith("no-")) {
      const base = key.slice(3);
      if (BOOLEAN_FLAGS.has(base)) {
        flags[base] = false;
        continue;
      }
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("-")) {
      if (LIST_FLAGS.has(key)) {
        (lists[key] ||= []).push(next);
      }
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { cmd: cmd ?? "", sub, flags, lists };
}

function readPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const raw = readFileSync(PID_PATH, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the daemon config, auto-creating `~/.botcord/daemon/config.json`
 * with sensible defaults on first run. `--agent` (repeated) pins explicit
 * agent ids; `--cwd` overrides the defaultRoute working directory. Both
 * are seed-only — they are ignored once a config already exists, since
 * `route` and direct edits to `config.json` are the canonical way to
 * change a configured daemon.
 */
function loadOrInitConfig(args: ParsedArgs): DaemonConfig {
  try {
    return loadConfig();
  } catch (err) {
    const missing = err instanceof Error && (err as { code?: string }).code === CONFIG_MISSING;
    if (!missing) throw err;
    const agents = args.lists.agent ?? [];
    const cwd =
      typeof args.flags.cwd === "string" ? path.resolve(args.flags.cwd) : homedir();
    const cfg = initDefaultConfig(agents, cwd);
    saveConfig(cfg);
    log.info("auto-initialized daemon config", { agents, cwd, path: CONFIG_FILE_PATH });
    console.log(`wrote default config to ${CONFIG_FILE_PATH}`);
    if (agents.length === 0) {
      console.log(
        "no --agent provided; daemon will auto-discover identities from ~/.botcord/credentials",
      );
    }
    return cfg;
  }
}

/**
 * Read the current user-auth record without throwing on parse / permission
 * errors — those are returned as `null` so the caller treats them like a
 * missing file (and the device-code flow re-runs).
 */
function safeLoadUserAuth(): UserAuthRecord | null {
  try {
    return loadUserAuth();
  } catch {
    return null;
  }
}

/** Sleep helper used by the device-code poll loop. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface DaemonTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
  daemonInstanceId: string;
  hubUrl: string;
}

function parseDaemonTokenResponse(raw: unknown, fallbackHubUrl: string): DaemonTokenResponse {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown => obj[camel] ?? obj[snake];
  const accessToken = pick("accessToken", "access_token");
  const refreshToken = pick("refreshToken", "refresh_token");
  const expiresIn = pick("expiresIn", "expires_in");
  const userId = pick("userId", "user_id");
  const daemonInstanceId = pick("daemonInstanceId", "daemon_instance_id");
  const hubUrl = pick("hubUrl", "hub_url");
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("daemon auth response missing accessToken");
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error("daemon auth response missing refreshToken");
  }
  if (typeof userId !== "string" || !userId) {
    throw new Error("daemon auth response missing userId");
  }
  if (typeof daemonInstanceId !== "string" || !daemonInstanceId) {
    throw new Error("daemon auth response missing daemonInstanceId");
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600,
    userId,
    daemonInstanceId,
    hubUrl: typeof hubUrl === "string" && hubUrl.length > 0 ? hubUrl : fallbackHubUrl,
  };
}

async function redeemInstallToken(opts: {
  hubUrl: string;
  installToken: string;
  label?: string;
}): Promise<DaemonTokenResponse> {
  const body: Record<string, unknown> = { install_token: opts.installToken };
  if (opts.label) body.label = opts.label;
  const resp = await fetch(`${opts.hubUrl.replace(/\/+$/, "")}/daemon/auth/install-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`daemon install-token redeem failed: ${resp.status} ${text}`);
  }
  return parseDaemonTokenResponse(await resp.json(), opts.hubUrl);
}

/**
 * Run the device-code login flow against the given Hub. Polls every
 * `interval` seconds (the Hub may bump this) until the user authorizes
 * from the dashboard, the device_code expires, or SIGINT is received.
 * Persists the token envelope to `user-auth.json` and returns the record.
 *
 * Plan §6.1.
 */
async function runDeviceCodeFlow(opts: {
  hubUrl: string;
  label?: string;
}): Promise<UserAuthRecord> {
  log.info("device-code flow: requesting code", {
    hubUrl: opts.hubUrl,
    label: opts.label ?? null,
  });
  const dc: DeviceCodeResponse = await requestDeviceCode(
    opts.hubUrl,
    opts.label ? { label: opts.label } : undefined,
  );
  const base = dc.verificationUriComplete ?? dc.verificationUri;
  const display = appendNextParam(base, "/settings/daemons");
  console.log("");
  console.log("Open this URL in a browser where you're signed in to BotCord");
  console.log("(typically your laptop, NOT this machine):");
  console.log("");
  console.log(`  ${display}`);
  console.log("");
  console.log(`Or enter this code at ${dc.verificationUri}: ${dc.userCode}`);
  console.log("Waiting for authorization (Ctrl-C to abort)...");

  const expiresAt = Date.now() + dc.expiresIn * 1000;
  let intervalSec = dc.interval;
  while (Date.now() < expiresAt) {
    await delay(intervalSec * 1000);
    let res;
    try {
      res = await pollDeviceToken(
        opts.hubUrl,
        dc.deviceCode,
        opts.label ? { label: opts.label } : undefined,
      );
    } catch (err) {
      // Network blips shouldn't kill the loop — surface, then retry on
      // the next tick. A persistent failure still ends at expiry.
      console.error(
        `device-code poll error: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (res.status === "pending") continue;
    if (res.status === "slow_down") {
      intervalSec = Math.max(intervalSec, res.interval);
      continue;
    }
    // Issued — persist and return.
    const record = userAuthFromTokenResponse(res, opts.label ? { label: opts.label } : undefined);
    saveUserAuth(record);
    clearAuthExpiredFlag();
    log.info("device-code flow: authorized", {
      userId: record.userId,
      hubUrl: record.hubUrl,
      label: opts.label ?? null,
    });
    console.log(`Logged in as ${record.userId}`);
    return record;
  }
  log.warn("device-code flow: expired without authorization", {
    hubUrl: opts.hubUrl,
  });
  throw new Error("device-code expired without authorization");
}

/**
 * Resolve / acquire a valid user-auth record before the daemon process
 * forks. Returns `null` when the daemon should proceed without a control
 * plane (legacy P0 behavior — caller may still log a warning).
 *
 * Decision tree (plan §4.4 + §6.4):
 * 1. Have existing creds and no `--relogin` → return existing record, even
 *    when a dashboard `--install-token` is present. The token is one-time and
 *    the generated install command should be safe to re-run after first login.
 * 2. No existing creds + `--install-token` → redeem the one-time dashboard ticket.
 * 3. `--relogin` → device-code login.
 * 4. No creds + TTY → device-code login.
 * 5. No creds + no TTY → exit 1 with the §6.4 hint.
 */
async function ensureUserAuthForStart(args: ParsedArgs): Promise<UserAuthRecord | null> {
  const hubFlag = typeof args.flags.hub === "string" ? args.flags.hub : undefined;
  const labelFlag = typeof args.flags.label === "string" ? args.flags.label : undefined;
  const installToken =
    typeof args.flags["install-token"] === "string" ? args.flags["install-token"] : undefined;
  const relogin = args.flags.relogin === true;

  const existing = safeLoadUserAuth();
  const authAction = resolveStartAuthAction({ existing, relogin, installToken });

  if (authAction === "reuse-existing" && existing) {
    // A previously-set auth-expired flag is stale by definition once the
    // operator runs `start` again — if creds genuinely don't work, the
    // control channel will re-write the flag on the next 4401/4403.
    // Clearing here keeps `status` from indefinitely warning about a
    // recovery the daemon already made.
    clearAuthExpiredFlag();
    // Idempotent restart: if creds already exist, keep the stored label as
    // the source of truth — operators wanting to rename must go through
    // `--relogin`. Stale access tokens will be refreshed by
    // UserAuthManager on first WS connect; nothing else to do here.
    if (labelFlag && existing.label !== labelFlag) {
      console.error(
        `note: --label "${labelFlag}" ignored (already logged in as "${existing.label ?? "<unset>"}"); pass --relogin to change it`,
      );
    }
    if (installToken) {
      console.error("note: --install-token ignored because daemon is already logged in; pass --relogin to re-bind");
    }
    return existing;
  }

  // Need a fresh login. Resolve hubUrl: explicit --hub > existing record > DEFAULT_HUB.
  const hubUrl = hubFlag ?? existing?.hubUrl ?? DEFAULT_HUB;
  const label = labelFlag ?? defaultLoginLabel();

  if (authAction === "install-token" && installToken) {
    const tok = await redeemInstallToken({ hubUrl, installToken, label });
    const record = userAuthFromTokenResponse(tok, { label });
    saveUserAuth(record);
    clearAuthExpiredFlag();
    log.info("install-token flow: authorized", {
      userId: record.userId,
      daemonInstanceId: record.daemonInstanceId,
      hubUrl: record.hubUrl,
      label,
    });
    console.log(`Logged in as ${record.userId}`);
    return record;
  }

  if (!process.stdin.isTTY) {
    // Plan §6.4 — non-interactive environment. Fail fast with actionable
    // remediation; never block waiting for input that will never arrive.
    console.error("error: not logged in and no TTY available");
    console.error(
      "hint:  run `botcord-daemon start` once interactively to establish credentials,",
    );
    console.error(
      "       or mount a valid `~/.botcord/daemon/user-auth.json`",
    );
    process.exit(1);
  }

  return runDeviceCodeFlow({ hubUrl, label });
}

async function cmdStart(args: ParsedArgs): Promise<void> {
  let cfg = loadOrInitConfig(args);
  if (openclawDiscoveryConfigEnabled(cfg)) {
    try {
      const found = await discoverLocalOpenclawGateways({
        searchPaths: cfg.openclawDiscovery?.searchPaths,
        defaultPorts: cfg.openclawDiscovery?.defaultPorts,
        timeoutMs: 500,
      });
      const merged = mergeOpenclawGateways(cfg, found);
      if (merged.changed) {
        cfg = merged.cfg;
        saveConfig(cfg);
        log.info("openclaw discovery: gateways merged", {
          added: merged.added.map((g) => ({ name: g.name, url: g.url })),
        });
      }
    } catch (err) {
      log.warn("openclaw discovery failed; continuing", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Foreground is now the default. --background (alias -d) detaches.
  // --foreground is still accepted (no-op) for backwards compatibility and
  // is also what the detached child re-execs itself with.
  const background =
    args.flags.background === true || args.flags.d === true;
  log.info("cmd start", {
    background,
    relogin: args.flags.relogin === true,
    child: process.env.BOTCORD_DAEMON_CHILD === "1",
  });

  const existing = readPid();
  if (existing && pidAlive(existing)) {
    console.error(`daemon already running (pid ${existing})`);
    process.exit(1);
  }

  // Login MUST happen before fork — once detached, stdio is gone and the
  // user can't see the device code. We also run it for explicit
  // --foreground so an interactive user can log in without the fork dance.
  // The auto-spawned child (foreground re-exec) carries the marker env
  // var so we don't try to re-prompt for credentials it already has.
  if (process.env.BOTCORD_DAEMON_CHILD !== "1") {
    await ensureUserAuthForStart(args);
  }

  if (background) {
    // Detached child re-exec in foreground mode. The child writes the PID
    // file once it's up; the parent only polls to confirm startup so the
    // two never race on the same file.
    const child = spawn(process.execPath, [process.argv[1], "start", "--foreground"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, BOTCORD_DAEMON_CHILD: "1" },
    });
    child.unref();
    const deadline = Date.now() + 500;
    let observed: number | null = null;
    while (Date.now() < deadline) {
      const p = readPid();
      if (p && pidAlive(p)) {
        observed = p;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!observed) {
      console.error(`daemon did not record pid within 500ms (expected child pid ${child.pid})`);
      process.exit(1);
    }
    console.log(`daemon started (pid ${observed})`);
    return;
  }

  // Foreground: we ARE the daemon.
  writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
  const handle = await startDaemon({ config: cfg, configPath: CONFIG_FILE_PATH });

  const shutdown = async (sig: string) => {
    log.info("signal received", { sig });
    await handle.stop(sig);
    try {
      unlinkSync(PID_PATH);
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Gateway.start() resolves after channels are started. Keep the process
  // alive until a signal arrives; the channel manager owns its own loops.
  await new Promise<void>(() => {
    // Deliberately never resolves; `shutdown()` calls process.exit(0).
  });
}

async function cmdStop(): Promise<void> {
  const pid = readPid();
  log.info("cmd stop", { pid });
  if (!pid) {
    console.error("no pid file found");
    process.exit(1);
  }
  if (!pidAlive(pid)) {
    console.error(`pid ${pid} not alive; removing stale pid file`);
    try {
      unlinkSync(PID_PATH);
    } catch {
      // ignore
    }
    process.exit(1);
  }
  process.kill(pid, "SIGTERM");
  console.log(`sent SIGTERM to ${pid}`);
}

function readSnapshotFile(): SnapshotFile | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    const raw = readFileSync(SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === 1 &&
      typeof (parsed as { writtenAt?: unknown }).writtenAt === "number" &&
      (parsed as { snapshot?: unknown }).snapshot
    ) {
      return parsed as SnapshotFile;
    }
    return null;
  } catch {
    return null;
  }
}

async function cmdStatus(args: ParsedArgs): Promise<void> {
  const pid = readPid();
  const alive = pid ? pidAlive(pid) : false;
  let agents: string[] = [];
  let agentsSource: "config" | "credentials" | null = null;
  let configPath: string | null = null;
  try {
    const cfg = loadConfig();
    const boot = resolveBootAgents(cfg);
    agents = boot.agents.map((a) => a.agentId);
    agentsSource = boot.source;
    configPath = CONFIG_FILE_PATH;
  } catch {
    // config may not exist pre-init — that's fine
  }

  let userAuth: UserAuthRecord | null = null;
  try {
    userAuth = loadUserAuth();
  } catch {
    // a broken user-auth shouldn't fail status; leave as null
  }
  const authExpired = existsSync(AUTH_EXPIRED_FLAG_PATH);

  const file = readSnapshotFile();
  const now = Date.now();
  const snapshotAgeMs = file ? now - file.writtenAt : null;

  if (args.flags.json === true) {
    const payload = {
      pid,
      alive,
      agents,
      agentsSource,
      // Preserve the legacy scalar field in JSON output when exactly one
      // agent is bound, so consumers pinned to `agentId` keep working.
      agentId: agents.length === 1 ? agents[0] : null,
      config: configPath,
      userAuth: userAuth
        ? {
            userId: userAuth.userId,
            daemonInstanceId: userAuth.daemonInstanceId,
            hubUrl: userAuth.hubUrl,
            expiresAt: userAuth.expiresAt,
            label: userAuth.label ?? null,
          }
        : null,
      authExpired,
      snapshot: file?.snapshot ?? null,
      snapshotWrittenAt: file?.writtenAt ?? null,
      snapshotAgeMs,
      snapshotPath: SNAPSHOT_PATH,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const input: StatusRenderInput = {
    pid,
    alive,
    agents,
    agentsSource,
    configPath,
    snapshot: file?.snapshot ?? null,
    snapshotAgeMs,
  };
  console.log(renderStatus(input, now));
  if (userAuth) {
    console.log(
      `logged in as ${userAuth.userId}${userAuth.label ? ` (${userAuth.label})` : ""}`,
    );
  } else {
    console.log("not logged in (control plane disabled)");
  }
  if (authExpired) {
    console.log("⚠  credentials revoked — run `botcord-daemon start --relogin` to re-authorize");
  }
}

async function cmdLogs(args: ParsedArgs): Promise<void> {
  const follow = args.flags.f === true || args.flags.follow === true;
  if (!existsSync(LOG_FILE_PATH)) {
    console.error(`no log file at ${LOG_FILE_PATH}`);
    process.exit(1);
  }
  if (follow) {
    // `tail -f` is simpler and more robust than watching fs events ourselves.
    const child = spawn("tail", ["-n", "100", "-f", LOG_FILE_PATH], { stdio: "inherit" });
    process.on("SIGINT", () => child.kill("SIGINT"));
    await new Promise((resolve) => child.on("close", resolve));
    return;
  }
  const data = readFileSync(LOG_FILE_PATH, "utf8");
  const lines = data.split("\n");
  console.log(lines.slice(-100).join("\n"));
}

// ---------------------------------------------------------------------------
// transcript subcommands (design §5)
// ---------------------------------------------------------------------------

function transcriptStringFlag(args: ParsedArgs, name: string): string | null {
  const v = args.flags[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseDurationToMs(s: string): number | null {
  const m = /^(\d+)\s*([smhd])?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "d";
  const mult: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * mult[unit];
}

async function cmdTranscript(args: ParsedArgs): Promise<void> {
  switch (args.sub) {
    case "enable":
      return cmdTranscriptToggle(true);
    case "disable":
      return cmdTranscriptToggle(false);
    case "status":
      return cmdTranscriptStatus();
    case "list":
      return cmdTranscriptList(args);
    case "tail":
      return cmdTranscriptTail(args);
    case "dump":
      return cmdTranscriptDump(args);
    case "prune":
      return cmdTranscriptPrune(args);
    default:
      console.error("usage: botcord-daemon transcript <enable|disable|status|list|tail|dump|prune>");
      process.exit(1);
  }
}

function cmdTranscriptToggle(enable: boolean): void {
  let cfg: DaemonConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === CONFIG_MISSING) {
      console.error(
        `daemon config not found — run \`botcord-daemon start\` once to initialize, then retry`,
      );
      process.exit(1);
    }
    throw err;
  }
  cfg.transcript = { ...(cfg.transcript ?? {}), enabled: enable };
  saveConfig(cfg);
  console.log(
    `transcript persistence ${enable ? "enabled" : "disabled"} (next daemon start)`,
  );
}

function cmdTranscriptStatus(): void {
  let cfg: DaemonConfig | null = null;
  try {
    cfg = loadConfig();
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code !== CONFIG_MISSING) throw err;
  }
  const configEnabled = cfg?.transcript?.enabled === true;
  const env = process.env.BOTCORD_TRANSCRIPT;
  const effective = resolveTranscriptEnabled(env, configEnabled);
  let source: string;
  if (env === "1" || env === "0") source = `env BOTCORD_TRANSCRIPT=${env}`;
  else if (configEnabled) source = "config (transcript.enabled=true)";
  else source = "default-off";
  console.log(`enabled: ${effective}`);
  console.log(`source: ${source}`);
  console.log(`root: ${defaultTranscriptRoot()}`);
}

function cmdTranscriptList(args: ParsedArgs): void {
  const agent = transcriptStringFlag(args, "agent");
  if (!agent) {
    console.error("transcript list requires --agent <ag_xxx>");
    process.exit(1);
  }
  const root = transcriptAgentRoot(defaultTranscriptRoot(), agent);
  if (!existsSync(root)) {
    return; // no rooms → empty output
  }
  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    console.log(entry);
  }
}

function cmdTranscriptTail(args: ParsedArgs): Promise<void> | void {
  const agent = transcriptStringFlag(args, "agent");
  const room = transcriptStringFlag(args, "room");
  if (!agent || !room) {
    console.error("transcript tail requires --agent <ag_xxx> --room <rm_xxx>");
    process.exit(1);
  }
  const topic = transcriptStringFlag(args, "topic");
  const file = transcriptFilePath(defaultTranscriptRoot(), agent, room, topic);
  if (!existsSync(file)) {
    console.error(`no transcript at ${file}`);
    process.exit(1);
  }
  const follow = args.flags.f === true || args.flags.follow === true;
  const nFlag = transcriptStringFlag(args, "n");
  const n = nFlag && /^\d+$/.test(nFlag) ? Number(nFlag) : 50;
  if (follow) {
    const child = spawn("tail", ["-n", String(n), "-f", file], { stdio: "inherit" });
    process.on("SIGINT", () => child.kill("SIGINT"));
    return new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });
  }
  const data = readFileSync(file, "utf8");
  const lines = data.split("\n").filter((l) => l.length > 0);
  console.log(lines.slice(-n).join("\n"));
}

function cmdTranscriptDump(args: ParsedArgs): void {
  const agent = transcriptStringFlag(args, "agent");
  const room = transcriptStringFlag(args, "room");
  if (!agent || !room) {
    console.error("transcript dump requires --agent <ag_xxx> --room <rm_xxx>");
    process.exit(1);
  }
  const topic = transcriptStringFlag(args, "topic");
  const file = transcriptFilePath(defaultTranscriptRoot(), agent, room, topic);
  if (!existsSync(file)) {
    console.error(`no transcript at ${file}`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(file, "utf8"));
}

function cmdTranscriptPrune(args: ParsedArgs): void {
  const agent = transcriptStringFlag(args, "agent");
  if (!agent) {
    console.error("transcript prune requires --agent <ag_xxx>");
    process.exit(1);
  }
  const all = args.flags.all === true;
  const olderThanFlag = transcriptStringFlag(args, "older-than");
  const yes = args.flags.yes === true;
  const root = transcriptAgentRoot(defaultTranscriptRoot(), agent);
  if (!existsSync(root)) return;

  if (all) {
    if (!yes) {
      console.error(
        `transcript prune --all will delete every transcript under ${root}; rerun with --yes to confirm`,
      );
      process.exit(1);
    }
    rmSync(root, { recursive: true, force: true });
    console.log(`removed ${root}`);
    return;
  }

  // Default and --older-than: prune rotated files only (the "{topic}.STAMP.jsonl" form).
  // Active files (`{topic}.jsonl` / `_default.jsonl`) are never touched.
  const cutoffMs = olderThanFlag ? parseDurationToMs(olderThanFlag) : null;
  if (olderThanFlag && cutoffMs === null) {
    console.error(`transcript prune --older-than: invalid duration "${olderThanFlag}" (use 30d / 12h / 30m / 60s)`);
    process.exit(1);
  }
  const cutoff = cutoffMs !== null ? Date.now() - cutoffMs : null;

  let removed = 0;
  for (const roomEntry of readdirSync(root)) {
    const dir = path.join(root, roomEntry);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      // rotated files: <topic>.<YYYYMMDD-HHMMSS>.jsonl — must contain a stamp segment
      if (!/^.+\.\d{8}-\d{6}\.jsonl$/.test(f)) continue;
      const full = path.join(dir, f);
      if (cutoff !== null) {
        try {
          const fst = statSync(full);
          if (fst.mtimeMs >= cutoff) continue;
        } catch {
          continue;
        }
      }
      try {
        unlinkSync(full);
        removed += 1;
      } catch (err) {
        console.error(`failed to remove ${full}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log(`removed ${removed} rotated transcript file(s)`);
}

function formatRouteMatch(m: RouteRuleMatch): string {
  const parts: string[] = [];
  if (m.channel) parts.push(`channel=${m.channel}`);
  if (m.accountId) parts.push(`accountId=${m.accountId}`);
  const convId = m.conversationId ?? m.roomId;
  if (convId) parts.push(`conversationId=${convId}`);
  const convPrefix = m.conversationPrefix ?? m.roomPrefix;
  if (convPrefix) parts.push(`conversationPrefix=${convPrefix}`);
  if (m.conversationKind) parts.push(`conversationKind=${m.conversationKind}`);
  if (m.senderId) parts.push(`senderId=${m.senderId}`);
  if (typeof m.mentioned === "boolean") parts.push(`mentioned=${m.mentioned}`);
  return parts.length > 0 ? parts.join(", ") : "(any)";
}

async function cmdRoute(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const sub = args.sub;
  if (sub === "list") {
    if (args.flags.json === true) {
      console.log(JSON.stringify({ default: cfg.defaultRoute, routes: cfg.routes }, null, 2));
      return;
    }
    const d = cfg.defaultRoute;
    console.log(`default: runtime=${d.adapter} cwd=${d.cwd}${d.extraArgs?.length ? ` extraArgs=${JSON.stringify(d.extraArgs)}` : ""}`);
    if (cfg.routes.length === 0) {
      console.log("routes: (none)");
      return;
    }
    console.log("routes:");
    cfg.routes.forEach((r, i) => {
      const tail = r.extraArgs?.length ? ` extraArgs=${JSON.stringify(r.extraArgs)}` : "";
      console.log(`  [${i}] runtime=${r.adapter} cwd=${r.cwd}${tail}`);
      console.log(`      match: ${formatRouteMatch(r.match)}`);
    });
    return;
  }
  if (sub === "add") {
    // Legacy aliases: --room → --conversation-id, --prefix → --conversation-prefix.
    // Prefer the canonical field if both are provided.
    const roomFlag = typeof args.flags.room === "string" ? args.flags.room : undefined;
    const convIdFlag =
      typeof args.flags["conversation-id"] === "string"
        ? (args.flags["conversation-id"] as string)
        : undefined;
    const conversationId = convIdFlag ?? roomFlag;

    const prefixFlag = typeof args.flags.prefix === "string" ? args.flags.prefix : undefined;
    const convPrefixFlag =
      typeof args.flags["conversation-prefix"] === "string"
        ? (args.flags["conversation-prefix"] as string)
        : undefined;
    const conversationPrefix = convPrefixFlag ?? prefixFlag;

    const channel =
      typeof args.flags.channel === "string" ? (args.flags.channel as string) : undefined;
    const accountId =
      typeof args.flags["account-id"] === "string"
        ? (args.flags["account-id"] as string)
        : undefined;
    const senderId =
      typeof args.flags["sender-id"] === "string"
        ? (args.flags["sender-id"] as string)
        : undefined;
    const kindRaw =
      typeof args.flags["conversation-kind"] === "string"
        ? (args.flags["conversation-kind"] as string)
        : undefined;
    if (kindRaw !== undefined && kindRaw !== "direct" && kindRaw !== "group") {
      console.error(`invalid --conversation-kind "${kindRaw}" (must be "direct" or "group")`);
      process.exit(1);
    }
    const conversationKind = kindRaw as "direct" | "group" | undefined;

    const mentioned =
      typeof args.flags.mentioned === "boolean"
        ? (args.flags.mentioned as boolean)
        : undefined;

    const adapter = (typeof args.flags.adapter === "string" ? args.flags.adapter : "claude-code") as RouteRule["adapter"];
    const cwd = typeof args.flags.cwd === "string" ? path.resolve(args.flags.cwd) : "";

    const hasAnyMatch =
      !!conversationId ||
      !!conversationPrefix ||
      !!channel ||
      !!accountId ||
      !!senderId ||
      !!conversationKind ||
      mentioned !== undefined;
    if (!hasAnyMatch) {
      console.error(
        "at least one match flag required (--conversation-id/--room, --conversation-prefix/--prefix, --channel, --account-id, --sender-id, --conversation-kind, --mentioned)",
      );
      process.exit(1);
    }
    if (!cwd) {
      console.error("--cwd required");
      process.exit(1);
    }
    if (!getAdapterModule(adapter)) {
      console.error(`unknown --adapter "${adapter}". Registered: ${ADAPTER_LIST}`);
      process.exit(1);
    }

    // Persist the canonical fields (conversationId/conversationPrefix) even
    // when the user passed the legacy aliases, to avoid config drift.
    const match: RouteRuleMatch = {};
    if (channel) match.channel = channel;
    if (accountId) match.accountId = accountId;
    if (conversationId) match.conversationId = conversationId;
    if (conversationPrefix) match.conversationPrefix = conversationPrefix;
    if (conversationKind) match.conversationKind = conversationKind;
    if (senderId) match.senderId = senderId;
    if (mentioned !== undefined) match.mentioned = mentioned;

    cfg.routes.push({ match, adapter, cwd });
    saveConfig(cfg);
    console.log("route added");
    return;
  }
  if (sub === "remove") {
    const roomFlag = typeof args.flags.room === "string" ? args.flags.room : undefined;
    const convIdFlag =
      typeof args.flags["conversation-id"] === "string"
        ? (args.flags["conversation-id"] as string)
        : undefined;
    const roomId = convIdFlag ?? roomFlag;

    const prefixFlag = typeof args.flags.prefix === "string" ? args.flags.prefix : undefined;
    const convPrefixFlag =
      typeof args.flags["conversation-prefix"] === "string"
        ? (args.flags["conversation-prefix"] as string)
        : undefined;
    const prefix = convPrefixFlag ?? prefixFlag;

    const before = cfg.routes.length;
    cfg.routes = cfg.routes.filter((r) => {
      const rConv = r.match.conversationId ?? r.match.roomId;
      const rPrefix = r.match.conversationPrefix ?? r.match.roomPrefix;
      if (roomId && rConv === roomId) return false;
      if (prefix && rPrefix === prefix) return false;
      return true;
    });
    saveConfig(cfg);
    console.log(`removed ${before - cfg.routes.length} route(s)`);
    return;
  }
  console.error(HELP);
  process.exit(1);
}

async function cmdConfig(): Promise<void> {
  const cfg: DaemonConfig = loadConfig();
  // Surface the effective boot-agent list alongside the raw on-disk config
  // so operators running `config` can tell which identities the daemon will
  // actually bind — explicit list vs discovered credentials.
  const explicit = resolveConfiguredAgentIds(cfg);
  let boot: ReturnType<typeof resolveBootAgents> | null = null;
  try {
    boot = resolveBootAgents(cfg);
  } catch {
    boot = null;
  }
  const payload = {
    config: cfg,
    effective: boot
      ? {
          agents: boot.agents.map((a) => ({
            agentId: a.agentId,
            credentialsFile: a.credentialsFile,
            ...(a.displayName ? { displayName: a.displayName } : {}),
          })),
          source: explicit ? "config" : "credentials",
          credentialsDir: boot.credentialsDir,
          warnings: boot.warnings,
        }
      : null,
  };
  console.log(JSON.stringify(payload, null, 2));
}

/**
 * Select which agent a `memory` subcommand targets.
 *
 * - `--agent <ag_xxx>` explicitly chooses an agent; it must be one listed
 *   in the resolved config.
 * - If the daemon is bound to exactly one agent, `--agent` is optional and
 *   defaults to that agent.
 * - If multiple agents are configured and no `--agent` is passed, we bail
 *   with an explicit message listing the options — too easy to footgun a
 *   memory write against the wrong agent otherwise.
 */
function resolveMemoryTargetAgent(args: ParsedArgs, cfg: DaemonConfig): string {
  const boot = resolveBootAgents(cfg);
  const agents = boot.agents.map((a) => a.agentId);
  if (agents.length === 0) {
    console.error(
      "memory: no agents configured or discovered (add `--agent` to `init` or drop a credentials JSON in the discovery dir)",
    );
    process.exit(1);
  }
  const flagAgent = typeof args.flags.agent === "string" ? args.flags.agent : undefined;
  if (flagAgent) {
    if (!agents.includes(flagAgent)) {
      console.error(
        `--agent "${flagAgent}" is not configured. Configured agents: ${agents.join(", ")}`,
      );
      process.exit(1);
    }
    return flagAgent;
  }
  if (agents.length === 1) return agents[0];
  console.error(
    `memory: --agent <ag_xxx> is required when the daemon is bound to multiple agents. Configured: ${agents.join(", ")}`,
  );
  process.exit(1);
}

async function cmdMemory(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const agentId = resolveMemoryTargetAgent(args, cfg);
  const sub = args.sub;

  if (!sub || sub === "get") {
    const memory = readWorkingMemory(agentId);
    if (args.flags.json === true) {
      console.log(JSON.stringify({ agentId, memory, dir: resolveMemoryDir(agentId) }, null, 2));
      return;
    }
    if (!memory) {
      console.log(`(empty — no working memory for ${agentId})`);
      console.log(`path: ${resolveMemoryDir(agentId)}/working-memory.json`);
      return;
    }
    if (memory.goal) console.log(`goal: ${memory.goal}`);
    const entries = Object.entries(memory.sections);
    if (entries.length === 0) {
      console.log("(no sections)");
    } else {
      for (const [name, content] of entries) {
        console.log(`\n[section: ${name}]`);
        console.log(content);
      }
    }
    console.log(`\nupdatedAt: ${memory.updatedAt}`);
    return;
  }

  if (sub === "set") {
    const goal = typeof args.flags.goal === "string" ? args.flags.goal : undefined;
    const section = typeof args.flags.section === "string" ? args.flags.section : undefined;
    const content = typeof args.flags.content === "string" ? args.flags.content : undefined;
    if (goal === undefined && content === undefined) {
      console.error("memory set: provide --goal or --content");
      process.exit(1);
    }
    try {
      const res = updateWorkingMemory(agentId, { goal, section, content });
      const status: Record<string, unknown> = { ok: true, totalChars: res.totalChars };
      if (goal !== undefined) status.goal = goal === "" ? null : goal;
      if (content !== undefined) {
        status.section = section ?? DEFAULT_SECTION;
        status.sectionPresent = res.sectionPresent;
      }
      console.log(JSON.stringify(status, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  if (sub === "delete") {
    const section = typeof args.flags.section === "string" ? args.flags.section : undefined;
    if (!section) {
      console.error("memory delete: --section required");
      process.exit(1);
    }
    try {
      updateWorkingMemory(agentId, { section, content: "" });
      console.log(`section "${section}" removed`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  if (sub === "clear") {
    clearWorkingMemory(agentId);
    console.log(`cleared working memory for ${agentId}`);
    return;
  }

  console.error(HELP);
  process.exit(1);
}

const fsFileReader: DoctorFileReader = {
  readFile(p: string): string | null {
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
};

async function cmdDoctor(args: ParsedArgs): Promise<void> {
  const entries: import("./doctor.js").DoctorRuntimeEntry[] = detectRuntimes();
  // Doctor should not hard-fail when no config exists yet; channel probes
  // simply produce an empty list in that case.
  let channels: ReturnType<typeof channelsFromDaemonConfig> = [];
  let cfgForEndpoints: import("./config.js").DaemonConfig | null = null;
  try {
    const cfg = loadConfig();
    cfgForEndpoints = cfg;
    channels = channelsFromDaemonConfig(cfg);
  } catch {
    channels = [];
  }
  if (cfgForEndpoints?.openclawGateways && cfgForEndpoints.openclawGateways.length > 0) {
    const { collectRuntimeSnapshotAsync } = await import("./provision.js");
    const snap = await collectRuntimeSnapshotAsync({ cfg: cfgForEndpoints });
    const byId = new Map(snap.runtimes.map((r) => [r.id, r]));
    for (const e of entries) {
      const r = byId.get(e.id);
      if (r?.endpoints) e.endpoints = r.endpoints;
    }
  }

  const credentialsPath = (accountId: string) =>
    path.join(homedir(), ".botcord", "credentials", `${accountId}.json`);

  const input = await runDoctor(entries, channels, {
    credentialsPath,
    fileReader: fsFileReader,
    fetcher: defaultHttpFetcher,
    timeoutMs: 5_000,
  });

  if (args.flags.json === true) {
    console.log(JSON.stringify(input, null, 2));
    return;
  }
  console.log(renderDoctor(input));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || args.flags.help === true || args.flags.h === true) {
    console.log(HELP);
    process.exit(args.cmd ? 0 : 1);
  }
  try {
    switch (args.cmd) {
      case "start":
        await cmdStart(args);
        break;
      case "stop":
        await cmdStop();
        break;
      case "status":
        await cmdStatus(args);
        break;
      case "logs":
        await cmdLogs(args);
        break;
      case "transcript":
        await cmdTranscript(args);
        break;
      case "route":
        await cmdRoute(args);
        break;
      case "config":
        await cmdConfig();
        break;
      case "doctor":
        await cmdDoctor(args);
        break;
      case "memory":
        await cmdMemory(args);
        break;
      default:
        console.error(`unknown command: ${args.cmd}`);
        console.error(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
