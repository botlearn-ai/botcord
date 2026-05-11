/**
 * OpenClaw host control-plane WebSocket client.
 *
 * Bootstraps from `~/.botcord/openclaw/host.json` (written by the install
 * script) and runs the long-lived control channel to the Hub:
 *
 *   1. Open `wss://<hub>/openclaw/control` with `Authorization: Bearer <host JWT>`.
 *   2. Verify Hub-signed control frames (Ed25519 over JCS-canonicalised
 *      `{id,type,params,ts}`) — same scheme as the daemon control channel.
 *   3. On `provision_agent`: generate a fresh agent keypair locally, sign
 *      the provision nonce, POST `/openclaw/host/provision-claim` with the
 *      host bearer JWT, write the resulting credentials to
 *      `~/.botcord/credentials/{agentId}.json`, then ack the original
 *      frame with `{agent_id}`.
 *   4. Refresh the host access token via `/openclaw/auth/refresh` shortly
 *      before expiry; persist the rotated tokens back to `host.json`.
 *
 * The host control loop is idempotent — on plugin reload it re-reads
 * `host.json` and reconnects. New agents land as files on disk; the
 * plugin picks them up on next config reload (per-agent hot-attach is
 * a follow-up; see TODO at bottom of the file).
 */
import WebSocket from "ws";
import { writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import {
  generateKeypair,
  jcsCanonicalize,
  signChallenge,
} from "@botcord/protocol-core";
import { getConfig } from "./runtime.js";
import { resolveAccounts } from "./config.js";
import { dispatchInbound } from "./inbound.js";

// Inline minimal types + helpers — the published `@botcord/protocol-core`
// (v0.1.x) doesn't yet ship the control-frame schemas; this duplicates
// just what host-control needs so the plugin can build standalone.

interface ControlFrame {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  sig?: string;
  ts?: number;
}

interface ControlAck {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** Hub control-plane Ed25519 public key (raw 32-byte, base64). */
const DEFAULT_HUB_CONTROL_PUBLIC_KEY = "H8lKtrtJclp+M69dh0n0avdia/kN8fy1tYUSrQFpDxY=";

function resolveHubControlPublicKey(): string {
  const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
  const override = env?.BOTCORD_HUB_CONTROL_PUBLIC_KEY;
  return override && override.length > 0 ? override : DEFAULT_HUB_CONTROL_PUBLIC_KEY;
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyEd25519(pubkeyB64: string, message: string, sigB64: string): boolean {
  try {
    const pkRaw = Buffer.from(pubkeyB64, "base64");
    if (pkRaw.length !== 32) return false;
    const spki = Buffer.concat([SPKI_PREFIX, pkRaw]);
    const pk = createPublicKey({ key: spki, format: "der", type: "spki" });
    return nodeVerify(null, Buffer.from(message), pk, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

// ── Disk layout ─────────────────────────────────────────────────────────────

function botcordHome(): string {
  // Re-resolve each call so tests can monkey-patch `HOME`.
  return process.env.HOME ?? homedir();
}
function hostDir(): string {
  return join(botcordHome(), ".botcord", "openclaw");
}
function hostFile(): string {
  return join(hostDir(), "host.json");
}
function credDir(): string {
  return join(botcordHome(), ".botcord", "credentials");
}

interface HostFile {
  version: 1;
  hubUrl: string;
  hostInstanceId: string;
  privateKey: string;
  publicKey: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  accessExpiresAt: number;
  /** Unix seconds. */
  refreshExpiresAt: number;
  /** `wss://<hub>/openclaw/control` */
  controlWsUrl: string;
  savedAt?: string;
}

export function readHostFile(path: string = hostFile()): HostFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as HostFile;
  } catch {
    return null;
  }
}

function writeHostFile(host: HostFile, path: string = hostFile()): void {
  mkdirSync(hostDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(host, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function writeAgentCredentials(args: {
  agentId: string;
  keyId: string;
  privateKey: string;
  publicKey: string;
  hubUrl: string;
  displayName?: string | null;
  bio?: string | null;
  token?: string;
  tokenExpiresAt?: number;
  openclawHostId: string;
}): string {
  const dir = credDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${args.agentId}.json`);
  const body = {
    version: 1,
    hubUrl: args.hubUrl,
    agentId: args.agentId,
    keyId: args.keyId,
    privateKey: args.privateKey,
    publicKey: args.publicKey,
    displayName: args.displayName || args.agentId,
    bio: args.bio || null,
    savedAt: new Date().toISOString(),
    token: args.token,
    tokenExpiresAt: args.tokenExpiresAt,
    openclawHostId: args.openclawHostId,
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Possible outcomes of :func:`patchOpenclawConfigForAgent`. ``applied`` is
 * the only one that means the new agent will be picked up on next plugin
 * load — the rest require the user (or the dashboard) to take a follow-up
 * action.
 */
export type ConfigPatchResult =
  /** Patch landed; account is registered under channels.botcord.accounts. */
  | { applied: true; reason: "fresh" | "rewired_existing" }
  /** Account already references this exact credentials file — no-op. */
  | { applied: false; reason: "already_present" }
  /**
   * Skipped because patching would push BotCord above one configured
   * account, which the per-tool ``with-client`` guard currently refuses
   * to handle (`SINGLE_ACCOUNT_ONLY_MESSAGE`). Without this skip, adding
   * a second agent on a host would *break* botcord_send et al for the
   * existing agent. Tracked as a follow-up — once the tool layer is
   * session-aware (session→accountId resolution), drop this guard.
   */
  | { applied: false; reason: "multi_account_guard"; existingAccountIds: string[] }
  /** File-system / write failure. */
  | { applied: false; reason: "io_error"; error: string };

/**
 * Patch ``~/.openclaw/openclaw.json`` to register a freshly-provisioned
 * agent under ``channels.botcord.accounts.{agentId}``. Mirrors the
 * single-account → multi-account upgrade path used by
 * ``backend/static/openclaw/install.sh``, but refuses to push the
 * configuration over one active account because the BotCord tool layer
 * still hard-fails on multi-account configs.
 */
export function patchOpenclawConfigForAgent(args: {
  agentId: string;
  credentialsFile: string;
  configPath?: string;
}): ConfigPatchResult {
  const path =
    args.configPath ??
    process.env.OPENCLAW_CONFIG_PATH ??
    join(botcordHome(), ".openclaw", "openclaw.json");

  let cfg: Record<string, any> = {};
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Missing/empty file — start fresh.
  }

  if (typeof cfg !== "object" || cfg === null) cfg = {};
  if (!cfg.channels || typeof cfg.channels !== "object") cfg.channels = {};
  const channels = cfg.channels as Record<string, any>;
  if (!channels.botcord || typeof channels.botcord !== "object") channels.botcord = {};
  const botcord = channels.botcord as Record<string, any>;

  // Discover existing accounts (legacy flat shape counts as one).
  const accountsObj =
    botcord.accounts && typeof botcord.accounts === "object"
      ? (botcord.accounts as Record<string, any>)
      : {};
  const existingMultiIds = Object.keys(accountsObj);
  const hasLegacySingle =
    typeof botcord.credentialsFile === "string" &&
    botcord.credentialsFile.length > 0 &&
    existingMultiIds.length === 0;
  const existingIds = hasLegacySingle ? ["default"] : existingMultiIds;

  // Idempotent re-patch of the same agent → no-op.
  const existingForAgent = accountsObj[args.agentId];
  if (
    existingForAgent &&
    existingForAgent.credentialsFile === args.credentialsFile &&
    existingForAgent.enabled !== false
  ) {
    return { applied: false, reason: "already_present" };
  }

  // Multi-account guard: refuse to push above one configured account.
  // Re-attaching the same agentId, or rewiring a legacy single-account
  // entry that happens to point at this agent's credentials file, is
  // still allowed because the resulting config stays single-account.
  const wouldBeIds = new Set(existingIds);
  wouldBeIds.add(args.agentId);
  if (hasLegacySingle && botcord.credentialsFile === args.credentialsFile) {
    // legacy single → keep as single (will overwrite below)
  } else if (wouldBeIds.size > 1) {
    return {
      applied: false,
      reason: "multi_account_guard",
      existingAccountIds: existingIds,
    };
  }

  // Apply the patch. Two shapes depending on whether we're staying
  // single-account or migrating from legacy → multi (only possible when
  // the legacy entry already points at this same credentialsFile, see
  // above; otherwise we'd have bailed with multi_account_guard).
  let reason: "fresh" | "rewired_existing";
  if (existingIds.length === 0) {
    reason = "fresh";
  } else {
    reason = "rewired_existing";
  }

  if (hasLegacySingle) {
    // Stay in legacy flat shape — overwrite to point at the new agent.
    botcord.credentialsFile = args.credentialsFile;
    if (botcord.enabled === undefined) botcord.enabled = true;
    if (!botcord.deliveryMode) botcord.deliveryMode = "websocket";
  } else {
    if (!botcord.accounts || typeof botcord.accounts !== "object") {
      botcord.accounts = {};
    }
    const accounts = botcord.accounts as Record<string, any>;
    accounts[args.agentId] = {
      ...(accounts[args.agentId] || {}),
      enabled: true,
      credentialsFile: args.credentialsFile,
      deliveryMode: accounts[args.agentId]?.deliveryMode || "websocket",
    };
    if (botcord.enabled === undefined) botcord.enabled = true;
  }

  try {
    mkdirSync(join(botcordHome(), ".openclaw"), { recursive: true });
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8" });
    return { applied: true, reason };
  } catch (err) {
    return {
      applied: false,
      reason: "io_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Frame signature verification ────────────────────────────────────────────

function controlSigningInput(frame: ControlFrame): string {
  return (
    jcsCanonicalize({
      id: frame.id,
      type: frame.type,
      params: (frame.params ?? {}) as Record<string, unknown>,
      ts: typeof frame.ts === "number" ? frame.ts : 0,
    }) ?? "{}"
  );
}

function frameSignatureValid(frame: ControlFrame, hubPublicKey: string | null): boolean {
  if (!hubPublicKey) return false;
  if (typeof frame.sig !== "string" || frame.sig.length === 0) return false;
  return verifyEd25519(hubPublicKey, controlSigningInput(frame), frame.sig);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function refreshHostToken(host: HostFile): Promise<HostFile> {
  const url = `${host.hubUrl.replace(/\/+$/, "")}/openclaw/auth/refresh`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: host.refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(`openclaw refresh failed: ${resp.status} ${await resp.text()}`);
  }
  const body = (await resp.json()) as {
    host_instance_id: string;
    access_token: string;
    refresh_token: string;
    access_expires_at: number;
    refresh_expires_at: number;
  };
  const next: HostFile = {
    ...host,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessExpiresAt: body.access_expires_at,
    refreshExpiresAt: body.refresh_expires_at,
    savedAt: new Date().toISOString(),
  };
  writeHostFile(next);
  return next;
}

interface ProvisionClaimResult {
  agent_id: string;
  key_id: string;
  token: string;
  token_expires_at: number;
  display_name: string;
  bio: string | null;
}

export async function provisionAgentLocal(args: {
  host: HostFile;
  provisionId: string;
  nonce: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  result: ProvisionClaimResult;
  privateKey: string;
  publicKey: string;
  credentialsFile: string;
  config: ConfigPatchResult;
}> {
  const fetchFn = args.fetchImpl ?? fetch;
  const kp = generateKeypair();
  const sig = signChallenge(kp.privateKey, args.nonce);
  const url = `${args.host.hubUrl.replace(/\/+$/, "")}/openclaw/host/provision-claim`;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.host.accessToken}`,
    },
    body: JSON.stringify({
      provision_id: args.provisionId,
      nonce: args.nonce,
      agent: {
        pubkey: kp.pubkeyFormatted,
        proof: { nonce: args.nonce, sig },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    throw new Error(
      `provision-claim failed: ${resp.status} ${await resp.text().catch(() => "")}`,
    );
  }
  const result = (await resp.json()) as ProvisionClaimResult;
  const credPath = writeAgentCredentials({
    agentId: result.agent_id,
    keyId: result.key_id,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    hubUrl: args.host.hubUrl,
    displayName: result.display_name,
    bio: result.bio,
    token: result.token,
    tokenExpiresAt: result.token_expires_at,
    openclawHostId: args.host.hostInstanceId,
  });
  // Register the new agent in OpenClaw's config so it actually gets loaded
  // (next plugin reload). Without this the credentials file is on disk but
  // unreferenced and OpenClaw never spawns a channel for it. The patch is
  // best-effort: when it can't be applied (e.g. multi-account guard, IO
  // error), the structured `config` result is propagated up to the
  // provision-claim ack so the dashboard can warn the user.
  const config = patchOpenclawConfigForAgent({
    agentId: result.agent_id,
    credentialsFile: credPath,
  });
  return {
    result,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    credentialsFile: credPath,
    config,
  };
}

// ── Frame handler ───────────────────────────────────────────────────────────

interface FrameHandlerCtx {
  host: HostFile;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  /** Hook fired after a new agent's credentials have been written. */
  onAgentProvisioned?: (info: {
    agentId: string;
    credentialsFile: string;
  }) => void | Promise<void>;
}

export async function handleControlFrame(
  frame: ControlFrame,
  ctx: FrameHandlerCtx,
): Promise<Omit<ControlAck, "id"> | void> {
  switch (frame.type) {
    case "hello":
      return { ok: true };
    case "ping":
      return { ok: true, result: { pong: true } };
    case "provision_agent": {
      const params = (frame.params ?? {}) as {
        provision_id?: string;
        nonce?: string;
        owner_user_id?: string;
      };
      if (!params.provision_id || !params.nonce) {
        return {
          ok: false,
          error: { code: "bad_params", message: "provision_id and nonce required" },
        };
      }
      try {
        const { result, credentialsFile, config } = await provisionAgentLocal({
          host: ctx.host,
          provisionId: params.provision_id,
          nonce: params.nonce,
        });
        ctx.log("info", `provisioned agent ${result.agent_id} → ${credentialsFile}`);
        if (!config.applied) {
          ctx.log(
            "warn",
            `openclaw config not patched (${config.reason}); agent ${result.agent_id} will not auto-load`,
          );
        }
        if (ctx.onAgentProvisioned) {
          await ctx.onAgentProvisioned({
            agentId: result.agent_id,
            credentialsFile,
          });
        }
        return {
          ok: true,
          result: {
            agent_id: result.agent_id,
            config_patched: config.applied,
            config_skip_reason: config.applied ? undefined : config.reason,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log("warn", `provision_agent failed: ${message}`);
        return { ok: false, error: { code: "provision_failed", message } };
      }
    }
    case "revoke_agent": {
      // Best-effort: agent credentials cleanup is left to the user /
      // dashboard for now; the host just acks so Hub doesn't retry.
      return { ok: true };
    }
    case "wake_agent": {
      const params = (frame.params ?? {}) as {
        agent_id?: string;
        message?: string;
        run_id?: string;
        schedule_id?: string;
      };
      if (!params.agent_id || !params.message) {
        return {
          ok: false,
          error: { code: "bad_params", message: "agent_id and message required" },
        };
      }
      try {
        const cfg = getConfig();
        const accounts = resolveAccounts((cfg?.channels?.botcord ?? {}) as any);
        const entry = Object.entries(accounts).find(([, account]) => account.agentId === params.agent_id)
          ?? Object.entries(accounts).find(([accountId]) => accountId === params.agent_id);
        if (!cfg || !entry) {
          return {
            ok: false,
            error: { code: "agent_not_loaded", message: "BotCord account is not loaded in OpenClaw config" },
          };
        }
        const [accountId] = entry;
        await dispatchInbound({
          cfg,
          accountId,
          senderName: "BotCord Scheduler",
          senderId: "hub",
          senderKind: "agent",
          content: params.message,
          messageId: params.run_id || `schedule-${Date.now()}`,
          messageType: "message" as any,
          chatType: "direct",
          replyTarget: "hub",
          roomId: `rm_schedule_${params.agent_id}`,
          topic: params.schedule_id,
          mentioned: true,
        });
        return { ok: true, result: { agent_id: params.agent_id } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log("warn", `wake_agent failed: ${message}`);
        return { ok: false, error: { code: "wake_failed", message } };
      }
    }
    case "set_route":
      return { ok: true };
    default:
      return {
        ok: false,
        error: { code: "unknown_type", message: `unknown frame type: ${frame.type}` },
      };
  }
}

// ── Long-lived WS loop ──────────────────────────────────────────────────────

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const REFRESH_LEEWAY_SECONDS = 5 * 60; // refresh ~5 min before expiry
const KEEPALIVE_INTERVAL_MS = 25_000;

export interface HostControlOptions {
  /** Override the host file (default: `~/.botcord/openclaw/host.json`). */
  hostFilePath?: string;
  /** Override the embedded Hub control public key. */
  hubPublicKey?: string | null;
  /** Test hook — inject a WebSocket constructor. */
  webSocketCtor?: typeof WebSocket;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  onAgentProvisioned?: FrameHandlerCtx["onAgentProvisioned"];
}

export interface HostControlHandle {
  stop: () => void;
  isConnected: () => boolean;
}

export function startOpenclawHostControl(
  opts: HostControlOptions = {},
): HostControlHandle | null {
  const hostFilePath = opts.hostFilePath ?? hostFile();
  let host = readHostFile(hostFilePath);
  if (!host) return null; // not onboarded as an OpenClaw host

  const log =
    opts.log ??
    ((level, msg) => {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`[botcord:openclaw-host] ${msg}`);
    });

  const hubPublicKey = opts.hubPublicKey ?? resolveHubControlPublicKey();
  const WSCtor = opts.webSocketCtor ?? WebSocket;

  let stopped = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let connected = false;

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function scheduleRefresh() {
    if (!host) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    const nowSec = Math.floor(Date.now() / 1000);
    const fireInMs = Math.max(
      30_000,
      (host.accessExpiresAt - nowSec - REFRESH_LEEWAY_SECONDS) * 1000,
    );
    refreshTimer = setTimeout(async () => {
      if (stopped || !host) return;
      try {
        host = await refreshHostToken(host);
        log("info", "refreshed host access token");
        scheduleRefresh();
      } catch (err) {
        log("warn", `host token refresh failed: ${(err as Error).message}`);
        // Reschedule a near-term retry; if refresh keeps failing the
        // WS will eventually 401 and force reconnect with the stale
        // token (caller-visible failure).
        refreshTimer = setTimeout(scheduleRefresh, 60_000);
      }
    }, fireInMs);
  }

  function connect() {
    if (stopped || !host) return;
    const url = host.controlWsUrl;
    log("info", `connecting ${url}`);
    const sock = new WSCtor(url, {
      headers: { Authorization: `Bearer ${host.accessToken}` },
    });
    ws = sock;

    sock.on("open", () => {
      connected = true;
      attempt = 0;
      log("info", "connected");
      scheduleRefresh();
      keepaliveTimer = setInterval(() => {
        try {
          sock.ping();
        } catch {
          /* ignore */
        }
      }, KEEPALIVE_INTERVAL_MS);
    });

    sock.on("message", async (raw) => {
      let frame: ControlFrame;
      try {
        frame = JSON.parse(raw.toString()) as ControlFrame;
      } catch {
        return;
      }

      // Acks of host-initiated frames go nowhere today (we don't push).
      if ("ok" in frame && typeof frame.id === "string" && !frame.type) return;

      if (typeof frame.id !== "string" || typeof frame.type !== "string") return;

      // Hub-signed frames must verify. Hello/heartbeat use the same scheme.
      if (!frameSignatureValid(frame, hubPublicKey)) {
        log("warn", `dropping unsigned/invalid frame type=${frame.type}`);
        try {
          sock.send(
            JSON.stringify({
              id: frame.id,
              ok: false,
              error: { code: "bad_signature", message: "hub signature did not verify" },
            }),
          );
        } catch {
          /* ignore */
        }
        return;
      }

      const ack = await handleControlFrame(frame, {
        host: host!,
        log,
        onAgentProvisioned: opts.onAgentProvisioned,
      });
      if (!ack) return;
      try {
        sock.send(JSON.stringify({ id: frame.id, ...ack }));
      } catch (err) {
        log("warn", `ack send failed: ${(err as Error).message}`);
      }
    });

    sock.on("close", (code, reason) => {
      connected = false;
      clearTimers();
      log(
        "warn",
        `closed code=${code} reason=${reason?.toString() || ""} — reconnecting`,
      );
      if (stopped) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    });

    sock.on("error", (err) => {
      log("warn", `ws error: ${(err as Error).message}`);
    });
  }

  connect();

  return {
    stop: () => {
      stopped = true;
      clearTimers();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
    isConnected: () => connected,
  };
}

// NOTE: provisionAgentLocal patches `~/.openclaw/openclaw.json` to register
// the new agent under `channels.botcord.accounts.<agentId>`, mirroring the
// install.sh flow. The OpenClaw plugin SDK currently exposes no in-process
// reload hook, so the new account becomes active on the *next* plugin load.
// True hot-attach (zero-downtime add of a running channel) would need an
// SDK-side `runtime.reloadChannel(...)` API or a SIGHUP-style protocol —
// tracked separately.
