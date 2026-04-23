import { CONTROL_FRAME_TYPES } from "@botcord/protocol-core";
import {
  Gateway,
  createBotCordChannel,
  sanitizeUntrustedContent,
  type ChannelAdapter,
  type GatewayChannelConfig,
  type GatewayInboundMessage,
  type GatewayLogger,
  type GatewayRuntimeSnapshot,
} from "./gateway/index.js";
import { ActivityTracker } from "./activity-tracker.js";
import type { DaemonConfig } from "./config.js";
import { SESSIONS_PATH, SNAPSHOT_PATH } from "./config.js";
import { resolveBootAgents, type BootAgentsResult } from "./agent-discovery.js";
import { ControlChannel } from "./control-channel.js";
import { toGatewayConfig } from "./daemon-config-map.js";
import { log as daemonLog } from "./log.js";
import { collectRuntimeSnapshot, createProvisioner } from "./provision.js";
import { SnapshotWriter } from "./snapshot-writer.js";
import { createDaemonSystemContextBuilder } from "./system-context.js";
import { UserAuthManager } from "./user-auth.js";

/**
 * Matches the 10-minute turn timeout the legacy daemon dispatcher used, so
 * long-running CLI turns behave the same way under the gateway core.
 */
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Default cadence for writing `gateway.snapshot()` to disk. Override via
 * `BOTCORD_DAEMON_SNAPSHOT_INTERVAL_MS`.
 */
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5_000;

function resolveSnapshotIntervalMs(): number {
  const raw = process.env.BOTCORD_DAEMON_SNAPSHOT_INTERVAL_MS;
  if (!raw) return DEFAULT_SNAPSHOT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SNAPSHOT_INTERVAL_MS;
  return n;
}

/**
 * BotCord owner-chat room prefix. Rooms with this prefix are direct-message
 * rooms between an operator and their own agent; turns here are treated as
 * owner-trust by the daemon's trust classifier. Re-declared here (also lives
 * in the legacy daemon dispatcher) so we can label activity entries the same
 * way without cross-importing the deprecated module.
 */
const OWNER_CHAT_PREFIX = "rm_oc_";

/** Map a gateway inbound message to the activity tracker's sender labels.
 *
 * The gateway BotCord channel collapses two distinct owner-trust cases
 * (`rm_oc_` rooms AND `source_type === "dashboard_user_chat"`) into a single
 * `sender.kind === "user"` marker — which also covers `dashboard_human_room`
 * humans. We need them separated for the cross-room digest wording
 * ("owner" vs "human Alice"), so we peek at the upstream `raw.source_type`
 * and replicate the channel's `isOwnerTrust` logic. Falling back to just the
 * `rm_oc_` prefix when `raw` is an unexpected shape keeps the classifier
 * working even if a non-BotCord channel is later plugged in.
 *
 * Exported for unit tests — the function has no side effects.
 */
export function classifyActivitySender(
  msg: GatewayInboundMessage,
): { kind: "agent" | "human" | "owner"; label: string } {
  const sourceType =
    msg.raw && typeof msg.raw === "object" && "source_type" in msg.raw
      ? (msg.raw as { source_type?: unknown }).source_type
      : undefined;
  const isOwner =
    msg.conversation.id.startsWith(OWNER_CHAT_PREFIX) ||
    sourceType === "dashboard_user_chat";
  if (isOwner) {
    return { kind: "owner", label: msg.sender.name || msg.sender.id || "owner" };
  }
  if (msg.sender.kind === "user") {
    return { kind: "human", label: msg.sender.name || msg.sender.id || "user" };
  }
  return { kind: "agent", label: msg.sender.id || "unknown" };
}

/** Minimal activity-tracker surface the inbound observer uses. */
interface ActivityRecorderTarget {
  record: (entry: {
    agentId: string;
    roomId: string;
    roomName?: string;
    topic: string | null;
    lastInboundPreview: string;
    lastSenderKind: "agent" | "human" | "owner";
    lastSender: string;
  }) => void;
}

/**
 * Build the `onInbound` observer wired to the given activity tracker.
 * Exported for tests.
 *
 * The recorded `agentId` is taken from the inbound message's `accountId`
 * — so a multi-agent daemon files activity under whichever configured
 * agent actually received the message. An optional `fallbackAgentId`
 * covers pathological inputs where `accountId` is empty (should never
 * happen from the gateway, but defensive).
 */
export function createActivityRecorder(opts: {
  activityTracker: ActivityRecorderTarget;
  fallbackAgentId?: string;
}): (msg: GatewayInboundMessage) => void {
  return (msg: GatewayInboundMessage): void => {
    const { kind, label } = classifyActivitySender(msg);
    const rawText = typeof msg.text === "string" ? msg.text : "";
    // Owner text passes through verbatim; everything else gets the same
    // sanitization the legacy dispatcher applied before recording a preview.
    const preview = kind === "owner" ? rawText : sanitizeUntrustedContent(rawText);
    const agentId = msg.accountId || opts.fallbackAgentId || "";
    opts.activityTracker.record({
      agentId,
      roomId: msg.conversation.id,
      roomName: msg.conversation.title,
      topic: msg.conversation.threadId ?? null,
      lastInboundPreview: preview,
      lastSenderKind: kind,
      lastSender: label,
    });
  };
}

/**
 * Minimal send-capable surface used by {@link pushRuntimeSnapshot}.
 * Exists so the helper is trivially mockable from unit tests without needing
 * a full `ControlChannel` + user-auth harness.
 */
export interface RuntimeSnapshotSink {
  send: (frame: {
    id: string;
    type: string;
    params?: Record<string, unknown>;
    ts?: number;
  }) => boolean;
}

/**
 * Emit one `runtime_snapshot` event frame on the control channel. Plan §8.5
 * P0: first-connect push only — reconnect-push and diffing are P1. A send
 * failure is non-fatal (the Hub will re-query via `list_runtimes` on demand
 * or wait for the next daemon restart). Exported for unit tests.
 */
export function pushRuntimeSnapshot(sink: RuntimeSnapshotSink): boolean {
  const snap = collectRuntimeSnapshot();
  const ok = sink.send({
    id: `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: CONTROL_FRAME_TYPES.RUNTIME_SNAPSHOT,
    params: snap as unknown as Record<string, unknown>,
    ts: Date.now(),
  });
  if (!ok) {
    daemonLog.warn("runtime-snapshot: control-channel send returned false", {
      runtimes: snap.runtimes.length,
    });
  }
  return ok;
}

/** Options accepted by {@link startDaemon} — the P0.5 compatibility shim. */
export interface DaemonRuntimeOptions {
  config: DaemonConfig;
  /** Informational only; surfaced in startup logs. */
  configPath: string;
  /** Override the JSON session store location; defaults to `~/.botcord/daemon/sessions.json`. */
  sessionStorePath?: string;
  /** Override the snapshot file path; defaults to `~/.botcord/daemon/snapshot.json`. */
  snapshotPath?: string;
  /** Override snapshot write cadence in ms; defaults to 5s or `BOTCORD_DAEMON_SNAPSHOT_INTERVAL_MS`. */
  snapshotIntervalMs?: number;
  log?: GatewayLogger;
  /** Override Hub base URL; defaults to the one stored in credentials. */
  hubBaseUrl?: string;
  /** Override credentials JSON path; defaults to `~/.botcord/credentials/<agentId>.json`. */
  credentialsPath?: string;
  /**
   * Inject a pre-resolved boot-agent list (e.g. from tests). When omitted,
   * `startDaemon` resolves boot agents from `config.agents`/`config.agentId`
   * or falls back to credential discovery.
   */
  bootAgents?: BootAgentsResult;
  /**
   * Inject a pre-built user-auth manager. Typically only set by tests; in
   * production the daemon calls `UserAuthManager.load()` internally, and
   * only starts the control channel when a user-auth record exists.
   */
  userAuth?: UserAuthManager | null;
  /** Skip the control channel even when user-auth is available. Test hook. */
  disableControlChannel?: boolean;
}

/** Handle returned by {@link startDaemon}. */
export interface DaemonHandle {
  /** Graceful shutdown — idempotent. */
  stop: (reason?: string) => Promise<void>;
  /** Channel + turn status snapshot, straight from `Gateway.snapshot()`. */
  snapshot: () => GatewayRuntimeSnapshot;
}

/**
 * Adapt daemon's file-based `log` module into the gateway logger contract.
 * Writes go to `~/.botcord/logs/daemon.log` + stderr, preserving the format
 * existing `logs -f` watchers rely on. Debug lines stay gated by
 * `BOTCORD_DAEMON_DEBUG`, mirroring pre-migration behavior.
 */
function buildDaemonLogger(): GatewayLogger {
  return {
    info: (msg, meta) => daemonLog.info(msg, meta),
    warn: (msg, meta) => daemonLog.warn(msg, meta),
    error: (msg, meta) => daemonLog.error(msg, meta),
    debug: (msg, meta) => daemonLog.debug(msg, meta),
  };
}

/**
 * Boot the gateway using a daemon-shaped config. This is the P0.5 compat
 * entry point: the on-disk config at `~/.botcord/daemon/config.json` keeps
 * its existing shape, and `Gateway` handles channels/dispatch/sessions
 * under the hood.
 *
 * Only the BotCord channel is supported today; `channels[]` in the
 * translated gateway config has exactly one entry (`botcord-main`).
 */
export async function startDaemon(opts: DaemonRuntimeOptions): Promise<DaemonHandle> {
  const logger = opts.log ?? buildDaemonLogger();

  // Resolve boot agents: explicit `agents` config wins; otherwise scan the
  // credentials directory. A zero-agent result is valid in P1 — the daemon
  // still starts with zero channels so operators can drop credentials in
  // and restart without re-running `init`.
  const boot = opts.bootAgents ?? resolveBootAgents(opts.config);
  for (const w of boot.warnings) {
    logger.warn("daemon.discovery.warning", { message: w });
  }
  const agentIds = boot.agents.map((a) => a.agentId);
  const credentialPathByAgentId = new Map<string, string>();
  const agentRuntimes: Record<string, { runtime?: string; cwd?: string }> = {};
  for (const a of boot.agents) {
    if (a.credentialsFile) credentialPathByAgentId.set(a.agentId, a.credentialsFile);
    if (a.runtime || a.cwd) {
      agentRuntimes[a.agentId] = {
        ...(a.runtime ? { runtime: a.runtime } : {}),
        ...(a.cwd ? { cwd: a.cwd } : {}),
      };
    }
  }

  const gwConfig = toGatewayConfig(opts.config, { agentIds, agentRuntimes });

  // ActivityTracker lives at the daemon layer (not the gateway core). We
  // expose it to the gateway via (a) the `buildSystemContext` hook so the
  // cross-room digest reflects current activity, and (b) the `onInbound`
  // observer so incoming messages get recorded before the turn runs —
  // mirroring the pre-P0.5 dispatcher's "record-before-adapter-run" ordering.
  const activityTracker = new ActivityTracker();

  // Cache one system-context builder per configured agentId. The gateway
  // calls this with each inbound message and we pick the right builder by
  // `message.accountId` — so per-agent working memory + activity digests
  // stay scoped when a single daemon hosts multiple agents.
  const scBuilders = new Map<string, (msg: GatewayInboundMessage) => string | undefined>();
  for (const aid of agentIds) {
    scBuilders.set(
      aid,
      createDaemonSystemContextBuilder({ agentId: aid, activityTracker }),
    );
  }
  const buildSystemContext = (message: GatewayInboundMessage): string | undefined => {
    const b = scBuilders.get(message.accountId);
    if (b) return b(message);
    // Unknown accountId (shouldn't happen in practice): fall back to the
    // first configured agent so we still emit *something* rather than
    // silently dropping the context block. When no agents are bound the
    // daemon has no context to surface — return undefined.
    const first = agentIds[0];
    if (!first) return undefined;
    const fallback = scBuilders.get(first);
    return fallback ? fallback(message) : undefined;
  };

  // Observer runs after ack + before runtime.run. Keeping the side effect
  // outside the system-context builder (option A) means the builder stays
  // pure — a cleaner contract the gateway can also expose to non-daemon
  // callers in the future.
  const onInbound = createActivityRecorder({
    activityTracker,
    ...(agentIds[0] ? { fallbackAgentId: agentIds[0] } : {}),
  });

  const gateway = new Gateway({
    config: gwConfig,
    sessionStorePath: opts.sessionStorePath ?? SESSIONS_PATH,
    createChannel: (chCfg: GatewayChannelConfig): ChannelAdapter => {
      const agentId =
        typeof chCfg.agentId === "string" ? chCfg.agentId : chCfg.accountId;
      return createBotCordChannel({
        id: chCfg.id,
        accountId: chCfg.accountId,
        agentId,
        credentialsPath:
          credentialPathByAgentId.get(agentId) ?? opts.credentialsPath,
        hubBaseUrl: opts.hubBaseUrl,
      });
    },
    log: logger,
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    buildSystemContext,
    onInbound,
  });

  logger.info("daemon starting", {
    agents: agentIds,
    source: boot.source,
    credentialsDir: boot.credentialsDir,
    configPath: opts.configPath,
    sessionsPath: opts.sessionStorePath ?? SESSIONS_PATH,
    channels: gwConfig.channels.map((c) => c.id),
    routeCount: gwConfig.routes?.length ?? 0,
  });

  if (agentIds.length === 0) {
    logger.warn("daemon starting with no channels", {
      source: boot.source,
      credentialsDir: boot.credentialsDir,
      hint: "drop a credentials JSON in the discovery dir and restart, or run `botcord-daemon init --agent <ag_xxx>`",
    });
  }

  await gateway.start();
  logger.info("daemon started", { agents: agentIds });

  // Control channel is optional — daemon still runs (data-plane only)
  // when user-auth hasn't been set up yet. Operators can `login` later
  // without restarting, but for P0 we require a restart to pick it up.
  let controlChannel: ControlChannel | null = null;
  const userAuth =
    opts.userAuth === undefined
      ? tryLoadUserAuth(logger)
      : opts.userAuth;
  if (userAuth?.current && !opts.disableControlChannel) {
    logger.info("control-channel: enabling", {
      userId: userAuth.current.userId,
      hubUrl: userAuth.current.hubUrl,
    });
    const provisioner = createProvisioner({ gateway });
    controlChannel = new ControlChannel({
      auth: userAuth,
      handle: provisioner,
    });
    try {
      await controlChannel.start();
      // Plan §8.5 P0 — push one runtime snapshot immediately after connect
      // so Hub's `daemon_instances.runtimes_json` is populated for the
      // dashboard even before any user action. No periodic refresh in P0.
      const pushed = pushRuntimeSnapshot(controlChannel);
      logger.info("control-channel: initial runtime_snapshot push", {
        ok: pushed,
      });
    } catch (err) {
      logger.warn("control-channel failed to start; continuing without it", {
        error: err instanceof Error ? err.message : String(err),
      });
      // start() schedules its own reconnect; we swallow the initial
      // failure so the daemon boots either way.
    }
  } else if (!userAuth?.current) {
    logger.info("control-channel skipped: no user-auth record", {
      hint: "run `botcord-daemon start` to enable Hub control plane (device-code login)",
    });
  }

  const snapshotWriter = new SnapshotWriter({
    path: opts.snapshotPath ?? SNAPSHOT_PATH,
    intervalMs: opts.snapshotIntervalMs ?? resolveSnapshotIntervalMs(),
    snapshot: () => gateway.snapshot(),
    log: logger,
  });
  snapshotWriter.start();

  let stopping: Promise<void> | null = null;
  const stop = (reason?: string): Promise<void> => {
    if (stopping) return stopping;
    logger.info("daemon stopping", { reason: reason ?? null });
    snapshotWriter.stop();
    // Write one final snapshot so `status` doesn't briefly see stale data,
    // then delete the file on the way out.
    snapshotWriter.writeFinal();
    const controlStopP = controlChannel
      ? controlChannel.stop().catch(() => undefined)
      : Promise.resolve();
    stopping = Promise.all([controlStopP, gateway.stop(reason)]).then(
      () => undefined,
    ).finally(() => {
      snapshotWriter.remove();
      logger.info("daemon stopped", { reason: reason ?? null });
    });
    return stopping;
  };

  return {
    stop,
    snapshot: () => gateway.snapshot(),
  };
}

/**
 * Load the user-auth record if present, swallowing "file missing" as the
 * expected not-logged-in state. A parse / permission error is logged and
 * treated as "no record" so a broken user-auth.json can't block the
 * data-plane from coming up.
 */
function tryLoadUserAuth(logger: GatewayLogger): UserAuthManager | null {
  try {
    return UserAuthManager.load();
  } catch (err) {
    logger.warn("failed to load user-auth", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
