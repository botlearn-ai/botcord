import {
  CONTROL_FRAME_TYPES,
  shouldWake,
  type AttentionPolicy,
} from "@botcord/protocol-core";
import {
  Gateway,
  createBotCordChannel,
  createTelegramChannel,
  createWechatChannel,
  resolveTranscriptEnabled,
  sanitizeUntrustedContent,
  type ChannelAdapter,
  type GatewayChannelConfig,
  type GatewayInboundMessage,
  type GatewayOutboundMessage,
  type GatewayLogger,
  type GatewayRuntimeSnapshot,
} from "./gateway/index.js";
import { ActivityTracker } from "./activity-tracker.js";
import type { DaemonConfig } from "./config.js";
import { SESSIONS_PATH, SNAPSHOT_PATH } from "./config.js";
import { resolveBootAgents, type BootAgentsResult } from "./agent-discovery.js";
import { ensureAgentWorkspace } from "./agent-workspace.js";
import { ControlChannel } from "./control-channel.js";
import { toGatewayConfig } from "./daemon-config-map.js";
import { log as daemonLog } from "./log.js";
import {
  adoptDiscoveredOpenclawAgents,
  collectRuntimeSnapshot,
  createProvisioner,
  type OnAgentInstalledHook,
} from "./provision.js";
import { openclawAutoProvisionEnabled } from "./openclaw-discovery.js";
import { SnapshotWriter } from "./snapshot-writer.js";
import { createDaemonSystemContextBuilder } from "./system-context.js";
import { createRoomStaticContextBuilder } from "./room-context.js";
import { createRoomContextFetcher } from "./room-context-fetcher.js";
import {
  buildLoopRiskPrompt,
  loopRiskSessionKey,
  recordInboundText as recordLoopRiskInbound,
  recordOutboundText as recordLoopRiskOutbound,
} from "./loop-risk.js";
import { composeBotCordUserTurn } from "./turn-text.js";
import { UserAuthManager } from "./user-auth.js";
import { PolicyResolver, type DaemonAttentionPolicy } from "./gateway/policy-resolver.js";
import { scanMention } from "./mention-scan.js";
import { createDiagnosticBundle, uploadDiagnosticBundle } from "./diagnostics.js";

/**
 * Default hard cap for a single runtime turn. Long-running coding/research
 * tasks routinely exceed 10 minutes, so daemon-hosted agents get a larger
 * window before the dispatcher aborts the runtime.
 */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

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

// Sender classification lives in `./sender-classify.ts` so it can be shared
// with the user-turn composer without a daemon.ts ↔ turn-text.ts cycle.
import { classifyActivitySender } from "./sender-classify.js";
export { classifyActivitySender };

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

/** Per-call dependencies for {@link createDaemonChannel}. */
export interface CreateDaemonChannelDeps {
  credentialPathByAgentId: Map<string, string>;
  defaultCredentialsPath?: string;
  hubBaseUrl?: string;
}

/**
 * Dispatch a `GatewayChannelConfig` to the right adapter constructor based on
 * `chCfg.type`. Phase A wires up the BotCord adapter and stub constructors
 * for telegram/wechat (which throw "not implemented"); Phase B will fill the
 * latter in. Unknown types throw so misconfigured channels fail loudly at
 * boot rather than silently dropping inbound traffic.
 */
export function createDaemonChannel(
  chCfg: GatewayChannelConfig,
  deps: CreateDaemonChannelDeps,
): ChannelAdapter {
  switch (chCfg.type) {
    case "botcord": {
      const agentId =
        typeof chCfg.agentId === "string" ? chCfg.agentId : chCfg.accountId;
      return createBotCordChannel({
        id: chCfg.id,
        accountId: chCfg.accountId,
        agentId,
        credentialsPath:
          deps.credentialPathByAgentId.get(agentId) ?? deps.defaultCredentialsPath,
        hubBaseUrl: deps.hubBaseUrl,
      });
    }
    case "telegram":
      return createTelegramChannel({
        id: chCfg.id,
        accountId: chCfg.accountId,
        ...(typeof chCfg.baseUrl === "string" ? { baseUrl: chCfg.baseUrl } : {}),
        ...(Array.isArray(chCfg.allowedSenderIds)
          ? { allowedSenderIds: chCfg.allowedSenderIds as string[] }
          : {}),
        ...(Array.isArray(chCfg.allowedChatIds)
          ? { allowedChatIds: chCfg.allowedChatIds as string[] }
          : {}),
        ...(typeof chCfg.splitAt === "number" ? { splitAt: chCfg.splitAt } : {}),
        ...(typeof chCfg.secretFile === "string" ? { secretFile: chCfg.secretFile } : {}),
        ...(typeof chCfg.stateFile === "string" ? { stateFile: chCfg.stateFile } : {}),
      });
    case "wechat":
      return createWechatChannel({
        id: chCfg.id,
        accountId: chCfg.accountId,
        ...(typeof chCfg.baseUrl === "string" ? { baseUrl: chCfg.baseUrl } : {}),
        ...(Array.isArray(chCfg.allowedSenderIds)
          ? { allowedSenderIds: chCfg.allowedSenderIds as string[] }
          : {}),
        ...(typeof chCfg.splitAt === "number" ? { splitAt: chCfg.splitAt } : {}),
        ...(typeof chCfg.secretFile === "string" ? { secretFile: chCfg.secretFile } : {}),
        ...(typeof chCfg.stateFile === "string" ? { stateFile: chCfg.stateFile } : {}),
      });
    default:
      throw new Error(`unknown channel type "${chCfg.type}"`);
  }
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
  const userAuth =
    opts.userAuth === undefined
      ? tryLoadUserAuth(logger)
      : opts.userAuth;
  const expectedHubUrl = opts.hubBaseUrl ?? userAuth?.current?.hubUrl;

  // Resolve boot agents: explicit `agents` config wins; otherwise scan the
  // credentials directory. A zero-agent result is valid in P1 — the daemon
  // still starts with zero channels so operators can drop credentials in
  // and restart without re-running `init`.
  const boot = opts.bootAgents ?? resolveBootAgents(opts.config, { expectedHubUrl });
  for (const w of boot.warnings) {
    logger.warn("daemon.discovery.warning", { message: w });
  }
  const agentIds = boot.agents.map((a) => a.agentId);
  const { credentialPathByAgentId, agentRuntimes } = backfillBootAgents(
    boot.agents,
    { logger },
  );

  const gwConfig = toGatewayConfig(opts.config, { agentIds, agentRuntimes });

  // Per-agent hub URL — read from each credential file at boot. Used to
  // populate `BOTCORD_HUB` for runtime CLI subprocesses so the bundled
  // `botcord` CLI talks to the same hub the agent is registered against,
  // even when a single daemon hosts agents from different hubs.
  const hubUrlByAgentId = new Map<string, string>();
  for (const a of boot.agents) {
    if (a.hubUrl) hubUrlByAgentId.set(a.agentId, a.hubUrl);
  }
  const fallbackHubUrl = opts.hubBaseUrl;
  const resolveHubUrl = (accountId: string): string | undefined =>
    hubUrlByAgentId.get(accountId) ?? fallbackHubUrl;

  // ActivityTracker lives at the daemon layer (not the gateway core). We
  // expose it to the gateway via (a) the `buildSystemContext` hook so the
  // cross-room digest reflects current activity, and (b) the `onInbound`
  // observer so incoming messages get recorded before the turn runs —
  // mirroring the pre-P0.5 dispatcher's "record-before-adapter-run" ordering.
  const activityTracker = new ActivityTracker();

  // Shared room-context fetcher — one BotCordClient per accountId, created
  // lazily and reused across turns so JWT refreshes amortize. The builder
  // wrapping it adds a TTL cache on top so group rooms don't hit Hub every
  // turn.
  const roomContextFetcher = createRoomContextFetcher({
    credentialPathByAgentId,
    ...(opts.credentialsPath ? { defaultCredentialsPath: opts.credentialsPath } : {}),
    ...(opts.hubBaseUrl ? { hubBaseUrl: opts.hubBaseUrl } : {}),
    log: logger,
  });
  const roomContextBuilder = createRoomStaticContextBuilder({
    fetchRoomInfo: roomContextFetcher,
    log: logger,
  });

  // Cache one system-context builder per configured agentId. The gateway
  // calls this with each inbound message and we pick the right builder by
  // `message.accountId` — so per-agent working memory + activity digests
  // stay scoped when a single daemon hosts multiple agents.
  type PerAgentBuilder = (
    msg: GatewayInboundMessage,
  ) => Promise<string | undefined> | string | undefined;
  const scBuilders = new Map<string, PerAgentBuilder>();
  const loopRiskBuilder = (msg: GatewayInboundMessage): string | null =>
    buildLoopRiskPrompt({
      sessionKey: loopRiskSessionKey({
        accountId: msg.accountId,
        conversationId: msg.conversation.id,
        threadId: msg.conversation.threadId ?? null,
      }),
    });
  for (const aid of agentIds) {
    scBuilders.set(
      aid,
      createDaemonSystemContextBuilder({
        agentId: aid,
        activityTracker,
        roomContextBuilder,
        loopRiskBuilder,
      }),
    );
  }
  const buildSystemContext = (
    message: GatewayInboundMessage,
  ): Promise<string | undefined> | string | undefined => {
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
  const recordActivity = createActivityRecorder({
    activityTracker,
    ...(agentIds[0] ? { fallbackAgentId: agentIds[0] } : {}),
  });
  const onInbound = (msg: GatewayInboundMessage): void => {
    recordActivity(msg);
    // Feed the loop-risk tracker with the sanitized inbound text so
    // detectShortAckTail + detectHighTurnRate have a timeline.
    recordLoopRiskInbound({
      sessionKey: loopRiskSessionKey({
        accountId: msg.accountId,
        conversationId: msg.conversation.id,
        threadId: msg.conversation.threadId ?? null,
      }),
      text: msg.text,
      timestamp: msg.receivedAt,
    });
  };
  const onOutbound = (out: GatewayOutboundMessage): void => {
    recordLoopRiskOutbound({
      sessionKey: loopRiskSessionKey({
        accountId: out.accountId,
        conversationId: out.conversationId,
        threadId: out.threadId ?? null,
      }),
      text: out.text,
    });
  };

  // Per-agent attention policy cache (PR3, design §4.2 / §5). Seeded from
  // the optional `defaultAttention` / `attentionKeywords` carried by
  // `provision_agent`, refreshed in-place by the `policy_updated` control
  // frame. PR2 will plug per-room overrides into `fetchEffective`; PR3
  // leaves it absent so the resolver collapses to per-agent state.
  const policyResolver = new PolicyResolver({
    fetchGlobal: async (_agentId: string) => undefined,
  });

  // Display-name lookup for the mention text-fallback. Populated from boot
  // credentials; multi-agent daemons can reuse the same map via accountId.
  const displayNameByAgent = new Map<string, string>();
  for (const a of boot.agents) {
    if (a.displayName) displayNameByAgent.set(a.agentId, a.displayName);
  }

  // Attention gate: compose `messages.mentioned` (sender-supplied — distrust)
  // with a local `@<display_name>` / `@<agent_id>` text scan, resolve the
  // effective policy, then defer to the protocol-core `shouldWake` decision.
  const attentionGate = async (msg: GatewayInboundMessage): Promise<boolean> => {
    const policy: DaemonAttentionPolicy = await policyResolver.resolve(
      msg.accountId,
      msg.conversation.id,
    );
    if (policy.mode === "allowed_senders") {
      return (policy.allowedSenderIds ?? []).includes(msg.sender.id);
    }
    const localMention = scanMention(msg.text, {
      agentId: msg.accountId,
      displayName: displayNameByAgent.get(msg.accountId),
    });
    return shouldWake(policy as AttentionPolicy, {
      mentioned: msg.mentioned === true || localMention,
      text: msg.text,
    });
  };

  // Boot-seeded per-agent caches (`credentialPathByAgentId`,
  // `hubUrlByAgentId`, `displayNameByAgent`, `scBuilders`) are scoped to
  // the agents present at startup. Without this hook, agents added later
  // via `provision_agent` or openclaw-adoption stay missing from those
  // caches until the next daemon restart — `room-context-fetcher` then
  // logs `daemon.room-context.no-credentials` on every turn for the new
  // agent and the system context loses its `[BotCord Room]` block (member
  // names, rule, role).
  const onAgentInstalled: OnAgentInstalledHook = (info) => {
    // Re-provision (e.g. credential rotation) overwrites in place so the
    // next room-context fetch re-loads the BotCordClient against the new
    // credential file.
    credentialPathByAgentId.set(info.agentId, info.credentialsFile);
    if (info.hubUrl) hubUrlByAgentId.set(info.agentId, info.hubUrl);
    if (info.displayName) displayNameByAgent.set(info.agentId, info.displayName);
    if (!scBuilders.has(info.agentId)) {
      scBuilders.set(
        info.agentId,
        createDaemonSystemContextBuilder({
          agentId: info.agentId,
          activityTracker,
          roomContextBuilder,
          loopRiskBuilder,
        }),
      );
    }
  };

  const gateway = new Gateway({
    config: gwConfig,
    sessionStorePath: opts.sessionStorePath ?? SESSIONS_PATH,
    createChannel: (chCfg: GatewayChannelConfig): ChannelAdapter =>
      createDaemonChannel(chCfg, {
        credentialPathByAgentId,
        defaultCredentialsPath: opts.credentialsPath,
        hubBaseUrl: opts.hubBaseUrl,
      }),
    log: logger,
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    buildSystemContext,
    onInbound,
    onOutbound,
    composeUserTurn: composeBotCordUserTurn,
    attentionGate,
    resolveHubUrl,
    transcriptEnabled: resolveTranscriptEnabled(
      process.env.BOTCORD_TRANSCRIPT,
      opts.config.transcript?.enabled === true,
    ),
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
      hint: "drop a credentials JSON in the discovery dir and restart, or run `botcord-daemon start --agent <ag_xxx>` (only seeds config on first run)",
    });
  }

  await gateway.start();
  logger.info("daemon started", { agents: agentIds });

  if (openclawAutoProvisionEnabled(opts.config)) {
    try {
      const adopted = await adoptDiscoveredOpenclawAgents({
        gateway,
        cfg: opts.config,
        onAgentInstalled,
      });
      if (
        adopted.adopted.length > 0 ||
        adopted.failed.length > 0 ||
        adopted.skipped.length > 0
      ) {
        logger.info("openclaw auto-provision completed", {
          adopted: adopted.adopted,
          skipped: adopted.skipped,
          failed: adopted.failed,
        });
      }
    } catch (err) {
      logger.warn("openclaw auto-provision failed; continuing", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Control channel is optional — daemon still runs (data-plane only)
  // when user-auth hasn't been set up yet. Operators can `login` later
  // without restarting, but for P0 we require a restart to pick it up.
  let controlChannel: ControlChannel | null = null;
  if (userAuth?.current && !opts.disableControlChannel) {
    logger.info("control-channel: enabling", {
      userId: userAuth.current.userId,
      hubUrl: userAuth.current.hubUrl,
    });
    const provisioner = createProvisioner({ gateway, policyResolver, onAgentInstalled });
    controlChannel = new ControlChannel({
      auth: userAuth,
      handle: async (frame) => {
        if (frame.type === "collect_diagnostics") {
          logger.info("diagnostics: collect requested", { frameId: frame.id });
          const bundle = await createDiagnosticBundle();
          const upload = await uploadDiagnosticBundle({ auth: userAuth, bundle });
          logger.info("diagnostics: uploaded", {
            frameId: frame.id,
            bundleId: upload.bundleId,
            sizeBytes: upload.sizeBytes,
            localPath: bundle.path,
          });
          return {
            ok: true,
            result: {
              bundle_id: upload.bundleId,
              filename: upload.filename,
              size_bytes: upload.sizeBytes,
              expires_at: upload.expiresAt ?? null,
              local_path: bundle.path,
            },
          };
        }
        return provisioner(frame);
      },
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
 * Result of {@link backfillBootAgents}: the maps the boot flow needs to
 * plumb into `toGatewayConfig` + the channel factory.
 */
export interface BootBackfillResult {
  credentialPathByAgentId: Map<string, string>;
  agentRuntimes: Record<string, { runtime?: string; cwd?: string; openclawGateway?: string; openclawAgent?: string; hermesProfile?: string }>;
}

/**
 * Walk the boot-agent list and (a) populate the credential-path + runtime
 * caches used downstream, and (b) idempotently create each agent's on-disk
 * workspace tree (plan §9). One agent's failing workspace must not block
 * the others — errors are warned and swallowed per agent. Exported for
 * unit tests; `startDaemon` calls this inline.
 */
export function backfillBootAgents(
  agents: BootAgentsResult["agents"],
  opts: {
    logger: GatewayLogger;
    ensure?: typeof ensureAgentWorkspace;
  },
): BootBackfillResult {
  const ensure = opts.ensure ?? ensureAgentWorkspace;
  const credentialPathByAgentId = new Map<string, string>();
  const agentRuntimes: Record<string, { runtime?: string; cwd?: string }> = {};
  const failed: string[] = [];
  for (const a of agents) {
    if (a.credentialsFile) credentialPathByAgentId.set(a.agentId, a.credentialsFile);
    if (a.runtime || a.cwd || a.openclawGateway || a.openclawAgent || a.hermesProfile) {
      agentRuntimes[a.agentId] = {
        ...(a.runtime ? { runtime: a.runtime } : {}),
        ...(a.cwd ? { cwd: a.cwd } : {}),
        ...(a.openclawGateway ? { openclawGateway: a.openclawGateway } : {}),
        ...(a.openclawAgent ? { openclawAgent: a.openclawAgent } : {}),
        ...(a.hermesProfile ? { hermesProfile: a.hermesProfile } : {}),
      };
    }
    // Seed files are written only when missing (see `ensureAgentWorkspace`),
    // so a legacy agent whose workspace dir doesn't exist yet gets one on
    // the next boot — with zero risk of overwriting the user's edits.
    try {
      ensure(a.agentId, {
        ...(a.displayName ? { displayName: a.displayName } : {}),
        ...(a.runtime ? { runtime: a.runtime } : {}),
        ...(a.keyId ? { keyId: a.keyId } : {}),
        ...(a.savedAt ? { savedAt: a.savedAt } : {}),
        // `bio` is not surfaced on BootAgent — identity.md renders a
        // placeholder the user can fill in.
      });
    } catch (err) {
      failed.push(a.agentId);
      opts.logger.warn("ensureAgentWorkspace failed at boot; continuing", {
        agentId: a.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failed.length > 0) {
    opts.logger.warn("ensureAgentWorkspace: boot backfill incomplete", {
      count: failed.length,
      agentIds: failed,
    });
  }
  return { credentialPathByAgentId, agentRuntimes };
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
