/**
 * Cloud-daemon mode runtime entrypoint.
 *
 * Equivalent to {@link startDaemon} for cloud-mode operation: skips local
 * user-auth, skips local on-disk credentials, dials
 * `${HUB_URL}/cloud/daemon/ws` with the env-injected JWT, and reuses the
 * existing provisioner so `provision_agent` / `revoke_agent` frames work
 * the same way they do for local daemons.
 *
 * See ``docs/cloud-agent-technical-design.md`` §4 + §6.
 */
import { CONTROL_FRAME_TYPES, shouldWake, type AttentionPolicy } from "@botcord/protocol-core";
import type { CloudGatewayTypingEmitter } from "./cloud-gateway-runtime.js";
import {
  Gateway,
  resolveTranscriptEnabled,
  type ChannelAdapter,
  type GatewayChannelConfig,
  type GatewayInboundMessage,
  type GatewayLogger,
  type GatewayRuntimeSnapshot,
} from "./gateway/index.js";
import { ActivityTracker } from "./activity-tracker.js";
import type { DaemonConfig } from "./config.js";
import { SESSIONS_PATH, SNAPSHOT_PATH } from "./config.js";
import { ControlChannel } from "./control-channel.js";
import { toGatewayConfig } from "./daemon-config-map.js";
import { log as daemonLog } from "./log.js";
import { createProvisioner } from "./provision.js";
import { createDaemonChannel, pushAgentSkillSnapshot, pushRuntimeSnapshot } from "./daemon.js";
import { SnapshotWriter } from "./snapshot-writer.js";
import { createDaemonSystemContextBuilder } from "./system-context.js";
import { readWorkingMemorySnapshot } from "./working-memory.js";
import { createRoomStaticContextBuilder } from "./room-context.js";
import { createRoomContextFetcher } from "./room-context-fetcher.js";
import { createRecentRoomMessagesRecoveryBuilder } from "./room-recovery-context.js";
import { composeBotCordUserTurn } from "./turn-text.js";
import { PolicyResolver, type DaemonAttentionPolicy } from "./gateway/policy-resolver.js";
import { scanMention } from "./mention-scan.js";
import { createActivityRecorder } from "./daemon.js";
import { CloudAuthManager, asUserAuthManager } from "./cloud-auth.js";
import type { CloudModeConfig } from "./cloud-mode.js";
import { buildCloudRunSettleHook } from "./cloud-settle.js";
import type { InstalledAgentInfo, OnAgentInstalledHook } from "./provision.js";
import type { SkillIndexOptions } from "./skill-index.js";
import {
  createDaemonErrorReporter,
  initializeErrorReporterSafely,
  installProcessErrorReportingHooks,
  type ErrorReporter,
} from "./error-reporting.js";

// Cloud daemons follow the same cadence as local — keeps dashboard
// "runtimes last detected" behavior identical across both kinds.
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5_000;

function resolveSnapshotIntervalMs(): number {
  const raw = process.env.BOTCORD_DAEMON_SNAPSHOT_INTERVAL_MS;
  if (!raw) return DEFAULT_SNAPSHOT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SNAPSHOT_INTERVAL_MS;
  return n;
}

/** Options accepted by {@link startCloudDaemon}. */
export interface CloudDaemonRuntimeOptions {
  /** Resolved env-driven cloud config (see {@link loadCloudModeConfig}). */
  cloudConfig: CloudModeConfig;
  /**
   * Empty/initial DaemonConfig. Cloud daemons start with zero agents and
   * grow exclusively via `provision_agent` frames over the cloud control
   * plane — `agents[]` / `routes[]` arrays are seeded empty.
   */
  config: DaemonConfig;
  configPath: string;
  sessionStorePath?: string;
  snapshotPath?: string;
  snapshotIntervalMs?: number;
  log?: GatewayLogger;
  /** Test hook — override the control-channel cstr. */
  controlChannelFactory?: typeof ControlChannel;
  /** Skip control channel entirely; for tests that exercise the gateway only. */
  disableControlChannel?: boolean;
  /**
   * Test hook — inject a pre-built provisioner. Default uses
   * `createProvisioner({ gateway, policyResolver, onAgentInstalled })`.
   */
  provisionerFactory?: typeof createProvisioner;
  /** Test hook: inject daemon error reporter instead of resolving from env. */
  errorReporter?: ErrorReporter;
}

/** Handle returned by {@link startCloudDaemon}. */
export interface CloudDaemonHandle {
  stop: (reason?: string) => Promise<void>;
  snapshot: () => GatewayRuntimeSnapshot;
}

function buildLogger(opt: GatewayLogger | undefined): GatewayLogger {
  if (opt) return opt;
  return {
    info: (msg, meta) => daemonLog.info(msg, meta),
    warn: (msg, meta) => daemonLog.warn(msg, meta),
    error: (msg, meta) => daemonLog.error(msg, meta),
    debug: (msg, meta) => daemonLog.debug(msg, meta),
  };
}

/**
 * Boot the cloud daemon. The gateway starts with zero channels; every
 * provisioned agent arrives via `provision_agent`, which calls into the
 * shared `provision.ts` flow exactly like a local daemon does. The only
 * difference is the control-channel auth, endpoint path, and the absence
 * of a local user-auth file.
 */
export async function startCloudDaemon(
  opts: CloudDaemonRuntimeOptions,
): Promise<CloudDaemonHandle> {
  const logger = buildLogger(opts.log);
  const cloudCfg = opts.cloudConfig;
  const errorReporter = opts.errorReporter ?? createDaemonErrorReporter({ log: logger });
  await initializeErrorReporterSafely(errorReporter, logger);
  const uninstallProcessErrorHooks = installProcessErrorReportingHooks({
    reporter: errorReporter,
    log: logger,
    hubUrl: cloudCfg.hubUrl,
    daemonInstanceId: cloudCfg.daemonInstanceId,
  });

  logger.info("cloud daemon starting", {
    cloudDaemonInstanceId: cloudCfg.cloudDaemonInstanceId,
    daemonInstanceId: cloudCfg.daemonInstanceId,
    hubUrl: cloudCfg.hubUrl,
  });

  // ActivityTracker / policy resolver / per-agent caches — same as local
  // daemon, but the caches start empty because no agents are bound at
  // boot. `onAgentInstalled` populates them whenever provision_agent
  // lands.
  const activityTracker = new ActivityTracker();
  const credentialPathByAgentId = new Map<string, string>();
  const hubUrlByAgentId = new Map<string, string>();
  const displayNameByAgent = new Map<string, string>();
  const runtimeByAgentId = new Map<string, string>();
  const hermesProfileByAgentId = new Map<string, string>();
  const skillIndexOptionsForAgent = (agentId: string): SkillIndexOptions => {
    const hermesProfile = hermesProfileByAgentId.get(agentId);
    return {
      runtime: runtimeByAgentId.get(agentId) ?? opts.config.defaultRoute.adapter,
      ...(hermesProfile ? { hermesProfile } : {}),
    };
  };
  // Seed each per-agent hub URL with the cloud-mode value so that even
  // before the first credential file is written the room-context fetcher
  // has somewhere sensible to point.
  const fallbackHubUrl = cloudCfg.hubUrl;
  const resolveHubUrl = (accountId: string): string | undefined =>
    hubUrlByAgentId.get(accountId) ?? fallbackHubUrl;

  // Same gateway-config translation as local — empty `agents` produces an
  // empty `channels[]` initially, which is fine.
  const gwConfig = toGatewayConfig(opts.config, { agentIds: [], agentRuntimes: {} });

  const roomContextFetcher = createRoomContextFetcher({
    credentialPathByAgentId,
    hubBaseUrl: cloudCfg.hubUrl,
    log: logger,
  });
  const roomContextBuilder = createRoomStaticContextBuilder({
    fetchRoomInfo: roomContextFetcher,
    log: logger,
  });
  const buildRuntimeRecoveryContext = createRecentRoomMessagesRecoveryBuilder({
    credentialPathByAgentId,
    hubBaseUrl: cloudCfg.hubUrl,
    limit: 20,
    log: logger,
  });

  type PerAgentBuilder = (
    msg: GatewayInboundMessage,
  ) => Promise<string | undefined> | string | undefined;
  const scBuilders = new Map<string, PerAgentBuilder>();
  const buildSystemContext = (
    message: GatewayInboundMessage,
  ): Promise<string | undefined> | string | undefined => {
    const b = scBuilders.get(message.accountId);
    return b ? b(message) : undefined;
  };
  const buildMemoryContext = (message: GatewayInboundMessage) =>
    readWorkingMemorySnapshot(message.accountId);

  const recordActivity = createActivityRecorder({ activityTracker });
  const onInbound = (msg: GatewayInboundMessage): void => {
    recordActivity(msg);
  };

  // Optionally settle ``cloud_run`` envelopes against the Hub usage ledger
  // once the runtime turn finishes. The Hub can disable this per run through
  // payload.cloud_run.settle_usage=false.
  const settleHook = buildCloudRunSettleHook({
    hubUrl: cloudCfg.hubUrl,
    accessToken: cloudCfg.accessToken,
    log: logger,
  });
  const onTurnComplete = async (event: {
    message: GatewayInboundMessage;
    result?: import("./gateway/types.js").RuntimeRunResult;
    wallTimeMs: number;
    error?: unknown;
  }): Promise<void> => {
    const envelope = (event.message.raw as { envelope?: unknown } | undefined)
      ?.envelope as
      | {
          type?: string;
          payload?: {
            cloud_run?: {
              run_id?: unknown;
              settle_usage?: unknown;
            } | null;
          } | null;
        }
      | undefined;
    const cloudRun = envelope?.payload?.cloud_run;
    const runId = cloudRun?.run_id;
    const settleUsage = cloudRun?.settle_usage;
    await settleHook({
      envelopeType: envelope?.type,
      runId: typeof runId === "string" ? runId : undefined,
      settleUsage: typeof settleUsage === "boolean" ? settleUsage : undefined,
      wallTimeMs: event.wallTimeMs,
      tokens: {
        ...(event.result?.inputCacheHitTokens !== undefined
          ? { inputCacheHitTokens: event.result.inputCacheHitTokens }
          : {}),
        ...(event.result?.inputCacheMissTokens !== undefined
          ? { inputCacheMissTokens: event.result.inputCacheMissTokens }
          : {}),
        ...(event.result?.outputTokens !== undefined
          ? { outputTokens: event.result.outputTokens }
          : {}),
      },
      messageId: event.message.id,
    });
  };

  const policyResolver = new PolicyResolver({
    fetchGlobal: async (_agentId: string) => undefined,
  });

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

  const installedAgentIds = new Set<string>();
  let controlChannel: ControlChannel | null = null;
  const pushInstalledAgentSkillSnapshot = (agentId: string, reason: string): void => {
    if (!controlChannel) return;
    const skillIndexOptions = skillIndexOptionsForAgent(agentId);
    const pushed = pushAgentSkillSnapshot(controlChannel, agentId, skillIndexOptions);
    logger.info("cloud control-channel: agent_skill_snapshot pushed", {
      agentId,
      runtime: skillIndexOptions.runtime,
      hermesProfile: skillIndexOptions.hermesProfile ?? null,
      reason,
      ok: pushed,
    });
  };

  const onAgentInstalled: OnAgentInstalledHook = (info: InstalledAgentInfo) => {
    installedAgentIds.add(info.agentId);
    if (info.runtime) runtimeByAgentId.set(info.agentId, info.runtime);
    if (info.hermesProfile) hermesProfileByAgentId.set(info.agentId, info.hermesProfile);
    else if (info.runtime) hermesProfileByAgentId.delete(info.agentId);
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
          skillIndexOptions: () => skillIndexOptionsForAgent(info.agentId),
          // Cloud daemons run isolated — no loop-risk guard wired in PR1;
          // the runtime adapter's wall-time budget enforces the equivalent.
          loopRiskBuilder: () => null,
        }),
      );
    }
    pushInstalledAgentSkillSnapshot(info.agentId, "agent_installed");
  };

  const gateway = new Gateway({
    config: gwConfig,
    sessionStorePath: opts.sessionStorePath ?? SESSIONS_PATH,
    createChannel: (chCfg: GatewayChannelConfig): ChannelAdapter => {
      return createDaemonChannel(chCfg, {
        credentialPathByAgentId,
        hubBaseUrl: cloudCfg.hubUrl,
      });
    },
    log: logger,
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    buildSystemContext,
    buildMemoryContext,
    buildRuntimeRecoveryContext,
    onInbound,
    onTurnComplete,
    errorReporter,
    composeUserTurn: composeBotCordUserTurn,
    attentionGate,
    resolveHubUrl,
    transcriptEnabled: resolveTranscriptEnabled(
      process.env.BOTCORD_TRANSCRIPT,
      opts.config.transcript?.enabled,
    ),
  });

  await gateway.start();
  logger.info("cloud daemon gateway started (zero agents at boot)");

  if (!opts.disableControlChannel) {
    const auth = asUserAuthManager(new CloudAuthManager(cloudCfg));
    const provisionerFactory = opts.provisionerFactory ?? createProvisioner;
    // Forward-declare controlChannel-bound emitter: the provisioner is
    // built before the channel exists, so the closure captures the slot
    // and reads it back lazily once cloud-daemon assigns the instance.
    const cloudGatewayTypingEmitter: CloudGatewayTypingEmitter = (event) => {
      const ch = controlChannel;
      if (!ch) return;
      ch.send({
        id: `cgrs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: CONTROL_FRAME_TYPES.CLOUD_GATEWAY_RUNTIME_STATUS,
        params: {
          eventId: event.eventId,
          turnId: event.turnId,
          gatewayId: event.gatewayId,
          agentId: event.agentId,
          conversationId: event.conversationId,
          kind: "typing",
          phase: event.phase,
          traceId: event.traceId ?? null,
        },
        ts: Date.now(),
      });
    };
    const provisioner = provisionerFactory({
      gateway,
      policyResolver,
      onAgentInstalled,
      cloudGatewayTypingEmitter,
    });
    const ControlChannelCtor = opts.controlChannelFactory ?? ControlChannel;
    controlChannel = new ControlChannelCtor({
      auth,
      // The cloud WS endpoint differs from the local daemon WS — same
      // frame schema, different bearer-token kind on the Hub side.
      path: "/cloud/daemon/ws",
      handle: async (frame) => provisioner(frame),
      label: `cloud:${cloudCfg.cloudDaemonInstanceId}`,
    });
    try {
      await controlChannel.start();
      // Same `runtime_snapshot` push as local — keeps the dashboard's
      // "what's installed" view accurate the moment the daemon comes up.
      const pushed = pushRuntimeSnapshot(controlChannel);
      logger.info("cloud control-channel started; runtime_snapshot pushed", {
        ok: pushed,
      });
      for (const agentId of installedAgentIds) {
        pushInstalledAgentSkillSnapshot(agentId, "control_channel_started");
      }
    } catch (err) {
      logger.warn("cloud control-channel start failed; daemon will retry", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    logger.info("cloud daemon stopping", { reason: reason ?? null });
    snapshotWriter.stop();
    snapshotWriter.writeFinal();
    uninstallProcessErrorHooks();
    const controlStopP = controlChannel
      ? controlChannel.stop().catch(() => undefined)
      : Promise.resolve();
    stopping = Promise.all([controlStopP, gateway.stop(reason)]).then(
      () => undefined,
    ).finally(() => {
      snapshotWriter.remove();
      logger.info("cloud daemon stopped", { reason: reason ?? null });
    });
    return stopping;
  };

  return {
    stop,
    snapshot: () => gateway.snapshot(),
  };
}
