import { basename } from "node:path";
import WebSocket from "ws";
import {
  BotCordClient,
  buildHubWebSocketUrl,
  defaultCredentialsFile,
  loadStoredCredentials,
  updateCredentialsToken,
  type InboxMessage,
  type MessageAttachment,
} from "@botcord/protocol-core";
import type {
  ChannelAdapter,
  ChannelMessageStatusContext,
  ChannelSendContext,
  ChannelSendResult,
  ChannelStartContext,
  ChannelStatusSnapshot,
  ChannelStopContext,
  ChannelStreamBlockContext,
  ChannelStreamEndContext,
  ChannelTypingContext,
  GatewayInboundEnvelope,
  GatewayInboundMessage,
  GatewayLogger,
} from "../index.js";
import type { Gateway } from "../gateway.js";
import { sanitizeUntrustedContent } from "./sanitize.js";
import { revokeAgent } from "../../provision.js";

const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];
const RECONNECT_JITTER_RATIO = 0.25;
const KEEPALIVE_INTERVAL = 20_000;
const WS_HANDSHAKE_TIMEOUT_MS = 15_000;
const WS_STALE_TIMEOUT_MS = 60_000;
const MAX_AUTH_FAILURES = 5;
const SEEN_MESSAGES_CAP = 500;
const OWNER_CHAT_PREFIX = "rm_oc_";
const DM_ROOM_PREFIX = "rm_dm_";
const INBOX_POLL_LIMIT = 50;
const CHANNEL_PERMANENT_STOP = "channel_permanent_stop";
const DEFAULT_REPLYING_STATUS_EMOJI = "⏳";
// Matches the dispatcher's 30-minute turn hard timeout — a turn can never
// outlive its replying reaction. Clears are retried (below) so a lost DELETE
// is the only way to eat the full TTL.
const REPLYING_STATUS_TTL_SEC = 1800;

function withReconnectJitter(delayMs: number): { delayMs: number; jitterMs: number } {
  const jitterMs = Math.floor(Math.random() * delayMs * RECONNECT_JITTER_RATIO);
  return { delayMs: delayMs + jitterMs, jitterMs };
}

type InboxDrainTrigger =
  | "ws_auth_ok"
  | "ws_inbox_update"
  | "coalesced_inbox_update"
  | "has_more_continue"
  | "poll_interval";

/** Minimal surface the adapter needs from `BotCordClient`. Matches the subset used at runtime. */
export interface BotCordChannelClient {
  ensureToken(): Promise<string>;
  refreshToken(): Promise<string>;
  pollInbox(options?: {
    limit?: number;
    ack?: boolean;
    timeout?: number;
    roomId?: string;
  }): Promise<{ messages: InboxMessage[]; count: number; has_more: boolean }>;
  ackMessages(messageIds: string[]): Promise<void>;
  uploadFile?(
    filePath: string,
    filename: string,
    contentType?: string,
  ): Promise<{
    original_filename: string;
    url: string;
    content_type?: string;
    size_bytes?: number;
  }>;
  sendMessage(
    to: string,
    text: string,
    options?: { replyTo?: string; topic?: string; attachments?: MessageAttachment[]; traceId?: string | null },
  ): Promise<{ hub_msg_id?: string; message_id?: string } & Record<string, unknown>>;
  sendTypedMessage?(
    to: string,
    type: "result" | "error",
    text: string,
    options?: {
      replyTo?: string;
      topic?: string;
      attachments?: MessageAttachment[];
      errorRef?: string;
      traceId?: string | null;
    },
  ): Promise<{ hub_msg_id?: string; message_id?: string } & Record<string, unknown>>;
  getHubUrl(): string;
  onTokenRefresh?: (token: string, expiresAt: number) => void;
}

/** Factory that returns a ready-to-use BotCord client. Injection point for tests. */
export type BotCordClientFactory = (input: {
  agentId: string;
  hubBaseUrl?: string;
  credentialsPath?: string;
}) => BotCordChannelClient;

/** Options accepted by `createBotCordChannel()`. */
export interface BotCordChannelOptions {
  /** Channel instance id from config. */
  id: string;
  /** Gateway `accountId` — matches BotCord `agentId`. */
  accountId: string;
  /** BotCord `agentId` (usually identical to `accountId`). */
  agentId: string;
  /** Override for the credentials JSON path. Defaults to `~/.botcord/credentials/<agentId>.json`. */
  credentialsPath?: string;
  /** Override the Hub base URL. Defaults to the `hubUrl` stored in credentials. */
  hubBaseUrl?: string;
  /** Periodic inbox polling fallback. Set to 0 to disable. Defaults to 30s. */
  pollIntervalMs?: number;
  /** Test hook: supply a pre-built client instead of loading credentials from disk. */
  client?: BotCordChannelClient;
  /** Test hook: supply a client factory. Ignored when `client` is provided. */
  clientFactory?: BotCordClientFactory;
  /**
   * Test hook: override the raw WebSocket constructor. Useful for tests that
   * can't spin up a real WS server.
   */
  webSocketCtor?: typeof WebSocket;
  /** Test hook: override the connect/auth watchdog. Set <=0 to disable. Defaults to 15s. */
  wsHandshakeTimeoutMs?: number;
  /** Test hook: override the post-auth server-frame watchdog. Set <=0 to disable. Defaults to 60s. */
  wsStaleTimeoutMs?: number;
  /** Test hook: override local cleanup after Hub says the agent is unclaimed. */
  localRevokeAgent?: (agentId: string, log: GatewayLogger) => Promise<unknown>;
}

function isUnclaimedAgentError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status !== 403) return false;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('"code":"agent_not_claimed_generic"') ||
    message.includes('"code":"agent_not_claimed"') ||
    message.includes("agent_not_claimed_generic") ||
    message.includes("agent_not_claimed")
  );
}

function isTerminalAgentCredentialError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  const code = (err as { code?: unknown } | null)?.code;
  if (
    (status === 404 && (code === "key_not_found" || code === "agent_not_found")) ||
    (status === 403 && code === "key_not_active")
  ) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return (
    (message.includes('"code":"key_not_found"') ||
      message.includes('"code":"agent_not_found"') ||
      message.includes('"code":"key_not_active"') ||
      message.includes("key_not_found") ||
      message.includes("agent_not_found") ||
      message.includes("key_not_active")) &&
    (message.includes("Token refresh failed: 404") || message.includes("Token refresh failed: 403"))
  );
}

async function uploadOutboundAttachments(
  client: BotCordChannelClient,
  attachments: NonNullable<ChannelSendContext["message"]["attachments"]>,
  log: GatewayLogger,
): Promise<{ attachments: MessageAttachment[]; replacements: Array<{ sourcePath: string; url: string }> }> {
  if (attachments.length === 0) return { attachments: [], replacements: [] };
  if (!client.uploadFile) {
    log.warn("botcord send: outbound attachments skipped because uploadFile is unavailable", {
      count: attachments.length,
    });
    return { attachments: [], replacements: [] };
  }

  const uploaded: MessageAttachment[] = [];
  const replacements: Array<{ sourcePath: string; url: string }> = [];
  for (const attachment of attachments) {
    if (!attachment.filePath) {
      log.warn("botcord send: attachment without filePath skipped", {
        filename: attachment.filename ?? null,
      });
      continue;
    }
    try {
      const resp = await client.uploadFile(
        attachment.filePath,
        attachment.filename ?? basename(attachment.filePath),
        attachment.contentType,
      );
      if (attachment.sourcePath) {
        replacements.push({ sourcePath: attachment.sourcePath, url: resp.url });
      }
      uploaded.push({
        filename: resp.original_filename,
        url: resp.url,
        ...(resp.content_type ? { content_type: resp.content_type } : {}),
        ...(typeof resp.size_bytes === "number" ? { size_bytes: resp.size_bytes } : {}),
      });
    } catch (err) {
      log.warn("botcord send: attachment upload failed; continuing without it", {
        filename: attachment.filename ?? attachment.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { attachments: uploaded, replacements };
}

function rewriteUploadedAttachmentPaths(
  text: string,
  replacements: Array<{ sourcePath: string; url: string }>,
): string {
  let out = text;
  for (const { sourcePath, url } of replacements) {
    if (!sourcePath || !url) continue;
    out = out.replaceAll(sourcePath, url);
  }
  return out;
}

/** Default factory: wrap `loadStoredCredentials` + `new BotCordClient`. */
function defaultClientFactory(input: {
  agentId: string;
  hubBaseUrl?: string;
  credentialsPath?: string;
}): BotCordChannelClient {
  const credFile = input.credentialsPath ?? defaultCredentialsFile(input.agentId);
  const creds = loadStoredCredentials(credFile);
  const client = new BotCordClient({
    hubUrl: input.hubBaseUrl ?? creds.hubUrl,
    agentId: creds.agentId,
    keyId: creds.keyId,
    privateKey: creds.privateKey,
    token: creds.token,
    tokenExpiresAt: creds.tokenExpiresAt,
  });
  client.onTokenRefresh = (token, expiresAt) => {
    try {
      updateCredentialsToken(credFile, token, expiresAt);
    } catch {
      // persistence failures are non-fatal — next refresh will retry.
    }
  };
  return client as unknown as BotCordChannelClient;
}

/**
 * Classify inbound trust tier to decide whether to sanitize text.
 *
 * Mirrors `daemon/src/dispatcher.ts#classifyTrust`: owner-chat rooms
 * (`rm_oc_` prefix) and `dashboard_user_chat` come from the operator and
 * pass through verbatim; everything else gets sanitized before emit.
 */
function isOwnerTrust(msg: InboxMessage): boolean {
  if (msg.room_id?.startsWith(OWNER_CHAT_PREFIX)) return true;
  const sourceType = msg.source_type as string | undefined;
  if (sourceType === "dashboard_user_chat") return true;
  // Cloud Agent run tasks are Hub-issued on the user's behalf, same
  // trust posture as owner chat.
  if (sourceType === "cloud_agent_run") return true;
  return false;
}

/**
 * Map `InboxMessage` → `GatewayInboundMessage`. Field origins:
 *
 *   id                       → msg.hub_msg_id (inbox id, what dispatcher currently keys on)
 *   channel                  → options.channelId (the adapter's unique instance id)
 *   accountId                → options.accountId
 *   conversation.id          → msg.room_id (required; we skip upstream if missing)
 *   conversation.kind        → "direct" for rm_dm_ and rm_oc_ rooms, else "group"
 *   conversation.title       → msg.room_name (daemon uses the same field in logs)
 *   conversation.threadId    → msg.topic_id ?? msg.topic ?? null
 *   sender.id                → msg.envelope.from
 *   sender.name              → msg.source_user_name || undefined
 *   sender.kind              → "user" when trust==owner or source_type=="dashboard_human_room",
 *                              else "agent". "system" is not produced by daemon today.
 *   text                     → sanitized msg.text / envelope.payload.text (owner passes verbatim)
 *   raw                      → the full InboxMessage
 *   replyTo                  → msg.envelope.reply_to ?? null
 *   mentioned                → msg.mentioned ?? false
 *   receivedAt               → Date.now() (InboxMessage has no timestamp field today)
 *   trace.id                 → msg.hub_msg_id
 *   trace.streamable         → true only for owner-chat rooms (matches daemon's stream-block rule)
 */
function normalizeInbox(
  msg: InboxMessage,
  options: { channelId: string; accountId: string },
): GatewayInboundMessage | null {
  const env = msg.envelope;
  if (!env) return null;
  // `message` is the normal conversational envelope; `contact_request` is
  // a lightweight inbound asking the agent to notify its owner (the
  // composer appends the notify-owner hint); `cloud_run` carries a
  // Cloud Agent run task with embedded run_id + budget (the cloud
  // daemon's runtime adapter reads them from `raw.envelope.payload.cloud_run`
  // and reports usage back via /internal/cloud-agents/.../settle when the
  // run completes). All other envelope types (notification, system,
  // contact_added/removed, …) are still filtered out — they belong in
  // a separate push-notification path that daemon does not yet implement.
  const envType = env.type as string;
  if (
    envType !== "message" &&
    envType !== "contact_request" &&
    envType !== "cloud_run"
  )
    return null;
  if (!msg.room_id) return null;

  const rawText =
    msg.text ?? (typeof env.payload?.text === "string" ? (env.payload.text as string) : "");
  if (typeof rawText !== "string") return null;

  const ownerTrust = isOwnerTrust(msg);
  const text = ownerTrust ? rawText : sanitizeUntrustedContent(rawText);

  const isDm = msg.room_id.startsWith(DM_ROOM_PREFIX);
  const isOwnerChat = msg.room_id.startsWith(OWNER_CHAT_PREFIX);
  const sourceType = msg.source_type as string | undefined;
  const senderKind: "user" | "agent" =
    ownerTrust || sourceType === "dashboard_human_room" ? "user" : "agent";

  const senderName = msg.source_user_name ?? undefined;
  const threadId = msg.topic_id ?? msg.topic ?? null;
  const streamable = isOwnerChat;

  return {
    id: msg.hub_msg_id,
    channel: options.channelId,
    accountId: options.accountId,
    conversation: {
      id: msg.room_id,
      kind: isDm || isOwnerChat ? "direct" : "group",
      ...(msg.room_name ? { title: msg.room_name } : {}),
      threadId,
    },
    sender: {
      id: env.from,
      ...(senderName ? { name: senderName } : {}),
      kind: senderKind,
    },
    text,
    raw: msg,
    replyTo: env.reply_to ?? null,
    mentioned: msg.mentioned ?? false,
    receivedAt: Date.now(),
    trace: { id: msg.hub_msg_id, streamable },
  };
}

/**
 * Shape of the `raw` field when the channel batches multiple messages into
 * one envelope. Keeps the latest message's InboxMessage fields at top level
 * so existing accesses (`raw.envelope.type`, `raw.source_type`, …) still
 * work, and exposes the full list via `raw.batch`. `composeBotCordUserTurn`
 * reads `raw.batch` to build one `<agent-message>` / `<human-message>` block
 * per entry.
 */
export interface BatchedInboxRaw extends InboxMessage {
  batch: InboxMessage[];
}

/**
 * Normalize a group of InboxMessages for the same `(room, topic)` into a
 * single `GatewayInboundMessage`. The envelope carries the latest msg's
 * metadata (routing, session key, trace) and a `raw.batch` array the
 * composer uses to render per-sender blocks.
 *
 * `mentioned` is sticky: true if ANY message in the group is a mention.
 * Returns null if no message in the group is normalizable on its own.
 */
function normalizeInboxBatch(
  msgs: InboxMessage[],
  options: { channelId: string; accountId: string },
): GatewayInboundMessage | null {
  if (msgs.length === 0) return null;
  if (msgs.length === 1) return normalizeInbox(msgs[0]!, options);

  const latest = msgs[msgs.length - 1]!;
  const base = normalizeInbox(latest, options);
  if (!base) return null;

  // Fold sibling metadata into the base envelope. `text` is kept non-empty
  // when at least one batched member has a body, so the dispatcher's empty-
  // text skip rule doesn't drop the whole batch just because the latest
  // envelope was e.g. a zero-payload contact_request.
  const anyMentioned = msgs.some((m) => m.mentioned === true);
  let representativeText = base.text ?? "";
  if (!representativeText.trim()) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      const candidate =
        m.text ??
        (typeof m.envelope?.payload?.text === "string"
          ? (m.envelope.payload.text as string)
          : "");
      if (candidate && candidate.trim()) {
        representativeText = candidate;
        break;
      }
    }
  }
  return {
    ...base,
    text: representativeText,
    mentioned: anyMentioned,
    raw: { ...latest, batch: msgs } satisfies BatchedInboxRaw,
  };
}

/**
 * Fire-and-forget authenticated POST for presence/streaming control requests
 * (`/hub/typing`, `/hub/stream-block`). Mirrors `BotCordClient.hubFetch`'s 401
 * handling: a stale-but-unexpired token (e.g. after a Hub JWT secret rotation,
 * which `ensureToken()` won't refresh because it only refreshes near expiry) is
 * refreshed once and the request retried. Without this, typing/stream-block
 * silently 401 in a loop until the next actual message send happens to refresh
 * the token — leaving the conversation with no typing indicator or live stream.
 */
async function postControlWithRefresh(
  client: BotCordChannelClient,
  hubUrl: string,
  path: string,
  body: unknown,
  method = "POST",
): Promise<Response> {
  let token = await client.ensureToken();
  for (let attempt = 0; attempt <= 1; attempt++) {
    const resp = await fetch(`${hubUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 401 && attempt === 0) {
      token = await client.refreshToken();
      continue;
    }
    return resp;
  }
  throw new Error("postControlWithRefresh: exhausted retries");
}

/**
 * Construct a BotCord channel adapter.
 *
 * `start()` connects to Hub WS, drains `/hub/inbox` on every `inbox_update`,
 * normalizes messages, and emits envelopes with a `accept()` ack that commits
 * to Hub. The returned promise stays pending until `abortSignal` fires.
 */
export function createBotCordChannel(options: BotCordChannelOptions): ChannelAdapter {
  const channelType = "botcord";
  const factory = options.clientFactory ?? defaultClientFactory;
  let clientRef: BotCordChannelClient | null = options.client ?? null;
  const seenMessages = new Set<string>();
  const pendingHandoffMessages = new Set<string>();
  const handoffTails = new Map<string, Promise<void>>();
  let stopCallback: (() => void) | null = null;

  let statusSnapshot: ChannelStatusSnapshot = {
    channel: options.id,
    accountId: options.accountId,
    running: false,
    connected: false,
    reconnectAttempts: 0,
    lastError: null,
  };

  function rememberSeen(hubMsgId: string): boolean {
    if (seenMessages.has(hubMsgId)) return false;
    seenMessages.add(hubMsgId);
    if (seenMessages.size > SEEN_MESSAGES_CAP) {
      const first = seenMessages.values().next().value;
      if (first) seenMessages.delete(first);
    }
    return true;
  }

  function forgetSeen(hubMsgIds: string[]): void {
    for (const hubMsgId of hubMsgIds) {
      seenMessages.delete(hubMsgId);
      pendingHandoffMessages.delete(hubMsgId);
    }
  }

  function inboxGroupKey(msg: InboxMessage): string {
    const topic = msg.topic_id ?? msg.topic ?? "";
    return `${options.id}:${options.accountId}:${msg.room_id ?? ""}:${topic}`;
  }

  function queueGroupHandoff(groupKey: string, run: () => Promise<void>): void {
    const previous = handoffTails.get(groupKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    handoffTails.set(groupKey, current);
    void current.finally(() => {
      if (handoffTails.get(groupKey) === current) {
        handoffTails.delete(groupKey);
      }
    });
  }

  function ensureClient(): BotCordChannelClient {
    if (!clientRef) {
      clientRef = factory({
        agentId: options.agentId,
        hubBaseUrl: options.hubBaseUrl,
        credentialsPath: options.credentialsPath,
      });
    }
    return clientRef;
  }

  async function drainInbox(
    client: BotCordChannelClient,
    emit: (env: GatewayInboundEnvelope) => Promise<void>,
    log: GatewayLogger,
    trigger: InboxDrainTrigger,
  ): Promise<{ hasMore: boolean }> {
    const startedAt = Date.now();
    const resp = await client.pollInbox({ limit: INBOX_POLL_LIMIT, ack: false });
    const msgs = resp.messages ?? [];
    let duplicateCount = 0;
    let skippedCount = 0;
    let emittedGroups = 0;
    const logDrain = () => {
      log.info("botcord inbox drained", {
        trigger,
        count: msgs.length,
        responseCount: resp.count,
        hasMore: resp.has_more,
        limit: INBOX_POLL_LIMIT,
        ack: false,
        eligibleCount: eligible.length,
        duplicateCount,
        skippedCount,
        emittedGroups,
        durationMs: Date.now() - startedAt,
      });
    };
    const eligible: InboxMessage[] = [];
    if (msgs.length === 0) {
      logDrain();
      // Defensive: if Hub returns 0 messages, refuse to honor has_more=true.
      // A stuck cursor on the Hub side could otherwise produce an unbounded
      // poll loop here (count=0 with has_more=true on every iteration).
      return { hasMore: false };
    }

    // First pass: ack duplicates/skipped messages so Hub stops requeueing,
    // and collect eligible messages preserving poll order. Grouping by
    // `(room_id, topic)` mirrors plugin's `handleInboxMessageBatch` — the
    // same conversation thread folds into one turn so the agent sees all
    // new messages at once instead of running N turns back-to-back.
    for (const msg of msgs) {
      if (pendingHandoffMessages.has(msg.hub_msg_id)) {
        duplicateCount += 1;
        continue;
      }
      if (!rememberSeen(msg.hub_msg_id)) {
        duplicateCount += 1;
        try {
          await client.ackMessages([msg.hub_msg_id]);
        } catch (err) {
          log.warn("botcord duplicate ack failed", { err: String(err) });
        }
        continue;
      }
      const normalized = normalizeInbox(msg, {
        channelId: options.id,
        accountId: options.accountId,
      });
      if (!normalized) {
        skippedCount += 1;
        try {
          await client.ackMessages([msg.hub_msg_id]);
        } catch (err) {
          log.warn("botcord skip ack failed", { err: String(err) });
        }
        continue;
      }
      eligible.push(msg);
    }

    if (eligible.length === 0) {
      logDrain();
      return { hasMore: Boolean(resp.has_more) };
    }

    // Group by `(room_id, topic)`. Insertion order is the poll order, so
    // iterating the map yields groups with the same external chronology.
    const groups = new Map<string, InboxMessage[]>();
    for (const msg of eligible) {
      const key = inboxGroupKey(msg);
      const list = groups.get(key);
      if (list) list.push(msg);
      else groups.set(key, [msg]);
    }

    // Hand groups off independently: each `(room_id, topic)` group is its own
    // conversation thread, and the dispatcher already keys its per-turn queue
    // by `(channel, accountId, roomId, threadId)` (see `buildQueueKey` in
    // dispatcher.ts). Do not await runtime completion here; one slow room turn
    // must not hold the channel-wide inbox drain and starve newer messages
    // from other rooms.
    for (const group of groups.values()) {
      const normalized = normalizeInboxBatch(group, {
        channelId: options.id,
        accountId: options.accountId,
      });
      if (!normalized) continue;

      const hubIds = group.map((m) => m.hub_msg_id);
      for (const hubId of hubIds) pendingHandoffMessages.add(hubId);
      let accepted = false;
      const markAccepted = () => {
        if (accepted) return;
        accepted = true;
        for (const hubId of hubIds) pendingHandoffMessages.delete(hubId);
      };
      const envelope: GatewayInboundEnvelope = {
        message: normalized,
        ack: {
          accept: async () => {
            try {
              // Ack the entire batch together so Hub never re-delivers any
              // member of this turn if the agent succeeds on the group.
              await client.ackMessages(hubIds);
            } catch (err) {
              log.warn("botcord ack failed — relying on seen-cache dedup", {
                hubMsgIds: hubIds,
                err: String(err),
              });
            } finally {
              markAccepted();
            }
          },
        },
      };
      emittedGroups += 1;
      // Fire and continue draining, but preserve ordering per room/topic.
      // Different conversation threads can run independently; a newer message
      // in the same thread must not overtake an older handoff before the
      // dispatcher has processed it.
      queueGroupHandoff(inboxGroupKey(group[0]!), async () => {
        try {
          await emit(envelope);
          markAccepted();
        } catch (err) {
          if (!accepted) forgetSeen(hubIds);
          log.error("botcord emit threw", {
            hubMsgIds: hubIds,
            err: String(err),
          });
        }
      });
    }
    logDrain();
    return { hasMore: Boolean(resp.has_more) };
  }

  function startWsLoop(
    client: BotCordChannelClient,
    ctx: ChannelStartContext,
  ): Promise<void> {
    const { abortSignal, log, emit, setStatus } = ctx;
    const hubUrl = options.hubBaseUrl ?? client.getHubUrl();
    const wsCtor = options.webSocketCtor ?? WebSocket;

    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let handshakeTimer: NodeJS.Timeout | null = null;
    let staleTimer: NodeJS.Timeout | null = null;
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let reconnectAttempt = 0;
    let connectionSeq = 0;
    let consecutiveAuthFailures = 0;
    let running = true;
    let permanentStopping = false;
    let processing = false;
    let pendingUpdate = false;
    let pendingRefresh: Promise<unknown> | null = null;
    let resolveLoop: (() => void) | null = null;
    let rejectLoop: ((err: Error) => void) | null = null;

    const done = new Promise<void>((resolve, reject) => {
      resolveLoop = resolve;
      rejectLoop = reject;
    });

    function clearHandshakeTimer() {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    }

    function clearStaleTimer() {
      if (staleTimer) {
        clearTimeout(staleTimer);
        staleTimer = null;
      }
    }

    function clearTimers() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearHandshakeTimer();
      clearStaleTimer();
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function markStatus(patch: Partial<ChannelStatusSnapshot>) {
      statusSnapshot = { ...statusSnapshot, ...patch };
      setStatus(patch);
    }

    function terminateSocket(socket: WebSocket) {
      try {
        socket.terminate();
      } catch {
        try {
          socket.close();
        } catch {
          // ignore
        }
      }
    }

    function armHandshakeTimeout(socket: WebSocket, connectionId: number, agentId: string) {
      clearHandshakeTimer();
      const timeoutMs = options.wsHandshakeTimeoutMs ?? WS_HANDSHAKE_TIMEOUT_MS;
      if (timeoutMs <= 0) return;
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        if (!running || ws !== socket || connectionId !== connectionSeq) {
          return;
        }
        const readyState = socket.readyState;
        const lastError = `botcord ws handshake timeout after ${timeoutMs}ms`;
        log.warn("botcord ws handshake timeout", { agentId, timeoutMs, readyState });
        ws = null;
        markStatus({ connected: false, lastError });
        terminateSocket(socket);
        scheduleReconnect();
      }, timeoutMs);
      handshakeTimer.unref?.();
    }

    function armStaleTimeout(socket: WebSocket, connectionId: number, agentId: string) {
      clearStaleTimer();
      const timeoutMs = options.wsStaleTimeoutMs ?? WS_STALE_TIMEOUT_MS;
      if (timeoutMs <= 0) return;
      staleTimer = setTimeout(() => {
        staleTimer = null;
        if (!running || ws !== socket || connectionId !== connectionSeq) {
          return;
        }
        const readyState = socket.readyState;
        const lastError = `botcord ws stale after ${timeoutMs}ms without server frame`;
        log.warn("botcord ws stale", { agentId, timeoutMs, readyState });
        ws = null;
        markStatus({ connected: false, lastError });
        terminateSocket(socket);
        scheduleReconnect();
      }, timeoutMs);
      staleTimer.unref?.();
    }

    async function revokeLocalUnclaimedAgent(err: unknown) {
      if (!isUnclaimedAgentError(err)) return false;
      running = false;
      permanentStopping = true;
      clearTimers();
      try {
        ws?.close();
      } catch {
        // ignore
      }
      try {
        const result = options.localRevokeAgent
          ? await options.localRevokeAgent(options.agentId, log)
          : await revokeAgent(
              {
                agentId: options.agentId,
                deleteCredentials: true,
                deleteState: true,
                deleteWorkspace: false,
              },
              {
                gateway: {
                  removeChannel: async () => undefined,
                  removeManagedRoute: () => undefined,
                } as unknown as Gateway,
              },
            );
        log.warn("botcord agent unclaimed; revoked local binding", {
          agentId: options.agentId,
          result,
        });
        markStatus({
          running: false,
          connected: false,
          restartPending: false,
          lastStopAt: Date.now(),
          lastError: "agent not claimed; local binding revoked",
        });
      } catch (cleanupErr) {
        log.error("botcord unclaimed local revoke failed", {
          agentId: options.agentId,
          err: String(cleanupErr),
        });
        markStatus({
          running: false,
          connected: false,
          restartPending: false,
          lastStopAt: Date.now(),
          lastError: String(cleanupErr),
        });
      }
      permanentStopping = false;
      if (rejectLoop) {
        const r = rejectLoop;
        rejectLoop = null;
        resolveLoop = null;
        const stopErr = new Error("agent not claimed; local binding revoked") as Error & {
          code?: string;
        };
        stopErr.code = CHANNEL_PERMANENT_STOP;
        r(stopErr);
      }
      return true;
    }

    async function revokeLocalTerminalCredentials(err: unknown) {
      if (!isTerminalAgentCredentialError(err)) return false;
      running = false;
      permanentStopping = true;
      clearTimers();
      try {
        ws?.close();
      } catch {
        // ignore
      }
      try {
        const result = options.localRevokeAgent
          ? await options.localRevokeAgent(options.agentId, log)
          : await revokeAgent(
              {
                agentId: options.agentId,
                deleteCredentials: true,
                deleteState: true,
                deleteWorkspace: false,
              },
              {
                gateway: {
                  removeChannel: async () => undefined,
                  removeManagedRoute: () => undefined,
                } as unknown as Gateway,
              },
            );
        log.warn("botcord agent credentials rejected by Hub; revoked local binding", {
          agentId: options.agentId,
          err: String(err),
          result,
        });
        markStatus({
          running: false,
          connected: false,
          restartPending: false,
          lastStopAt: Date.now(),
          lastError: "agent credentials rejected by Hub; local binding revoked",
        });
      } catch (cleanupErr) {
        log.error("botcord terminal credential local revoke failed", {
          agentId: options.agentId,
          err: String(cleanupErr),
        });
        markStatus({
          running: false,
          connected: false,
          restartPending: false,
          lastStopAt: Date.now(),
          lastError: String(cleanupErr),
        });
      }
      permanentStopping = false;
      if (rejectLoop) {
        const r = rejectLoop;
        rejectLoop = null;
        resolveLoop = null;
        const stopErr = new Error(
          "agent credentials rejected by Hub; local binding revoked",
        ) as Error & {
          code?: string;
        };
        stopErr.code = CHANNEL_PERMANENT_STOP;
        r(stopErr);
      }
      return true;
    }

    async function fireInbox(trigger: InboxDrainTrigger) {
      if (processing) {
        pendingUpdate = true;
        log.debug("botcord inbox drain queued while previous drain is running", { trigger });
        return;
      }
      processing = true;
      try {
        let currentTrigger = trigger;
        let hasMore = false;
        do {
          pendingUpdate = false;
          const result = await drainInbox(client, emit, log, currentTrigger);
          hasMore = result.hasMore;
          // Prefer `has_more_continue` when this iteration is chained because
          // the previous poll capped at INBOX_POLL_LIMIT — distinguishes a
          // backlog drain from a coalesced ws_inbox_update drain in logs.
          currentTrigger = hasMore ? "has_more_continue" : "coalesced_inbox_update";
        } while ((pendingUpdate || hasMore) && running);
      } catch (err) {
        if (await revokeLocalUnclaimedAgent(err)) {
          return;
        }
        log.error("botcord inbox drain failed", { err: String(err) });
      } finally {
        processing = false;
      }
    }

    function scheduleReconnect() {
      if (!running) return;
      if (reconnectTimer) return;
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
      }
      const baseDelayMs =
        RECONNECT_BACKOFF[Math.min(reconnectAttempt, RECONNECT_BACKOFF.length - 1)];
      const { delayMs, jitterMs } = withReconnectJitter(baseDelayMs);
      reconnectAttempt += 1;
      markStatus({
        connected: false,
        restartPending: true,
        reconnectAttempts: reconnectAttempt,
      });
      log.info("botcord ws reconnect scheduled", {
        delayMs,
        baseDelayMs,
        jitterMs,
        attempt: reconnectAttempt,
      });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delayMs);
    }

    async function connect() {
      if (!running) return;
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
      }
      const agentId = options.agentId;
      markStatus({ connected: false, restartPending: false });
      if (pendingRefresh) {
        try {
          await pendingRefresh;
        } catch {
          // already logged by scheduler
        } finally {
          pendingRefresh = null;
        }
      }
      let token: string;
      try {
        token = await client.ensureToken();
      } catch (err) {
        if (await revokeLocalTerminalCredentials(err)) {
          return;
        }
        log.error("botcord ws token refresh failed", { agentId, err: String(err) });
        markStatus({ lastError: String(err) });
        scheduleReconnect();
        return;
      }

      const url = buildHubWebSocketUrl(hubUrl);
      log.info("botcord ws connecting", { url, agentId });

      const connectionId = ++connectionSeq;
      let socket: WebSocket;
      try {
        socket = new wsCtor(url);
        ws = socket;
      } catch (err) {
        log.error("botcord ws construct failed", { agentId, err: String(err) });
        markStatus({ lastError: String(err) });
        scheduleReconnect();
        return;
      }

      socket.on("open", () => {
        if (!running || ws !== socket || connectionId !== connectionSeq) {
          try {
            socket.close();
          } catch {
            // ignore
          }
          return;
        }
        socket.send(JSON.stringify({ type: "auth", token }));
      });
      armHandshakeTimeout(socket, connectionId, agentId);

      socket.on("message", (data: WebSocket.RawData) => {
        if (ws !== socket || connectionId !== connectionSeq) return;
        let msg: { type?: string; agent_id?: string } | null = null;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!msg || typeof msg.type !== "string") return;
        if (msg.type === "auth_ok") {
          clearHandshakeTimer();
          armStaleTimeout(socket, connectionId, agentId);
          reconnectAttempt = 0;
          consecutiveAuthFailures = 0;
          markStatus({
            running: true,
            connected: true,
            reconnectAttempts: 0,
            lastStartAt: Date.now(),
            lastError: null,
          });
          log.info("botcord ws authenticated", { agentId: msg.agent_id });
          void fireInbox("ws_auth_ok");
          const pollIntervalMs = options.pollIntervalMs ?? 30_000;
          if (pollTimer) clearInterval(pollTimer);
          if (pollIntervalMs > 0) {
            pollTimer = setInterval(() => {
              if (ws === socket && socket.readyState === WebSocket.OPEN) {
                void fireInbox("poll_interval");
              }
            }, pollIntervalMs);
            pollTimer.unref?.();
          }
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = setInterval(() => {
            if (ws === socket && socket.readyState === WebSocket.OPEN) {
              try {
                socket.send(JSON.stringify({ type: "ping" }));
              } catch {
                // ignore
              }
            }
          }, KEEPALIVE_INTERVAL);
        } else if (msg.type === "inbox_update") {
          armStaleTimeout(socket, connectionId, agentId);
          log.info("botcord ws inbox_update received");
          void fireInbox("ws_inbox_update");
        } else if (msg.type === "heartbeat" || msg.type === "pong") {
          armStaleTimeout(socket, connectionId, agentId);
          // no-op
        } else if (msg.type === "error" || msg.type === "auth_failed") {
          if (statusSnapshot.connected) {
            armStaleTimeout(socket, connectionId, agentId);
          }
          log.warn("botcord ws server error", { agentId, msg });
        }
      });

      socket.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason?.toString() || "";
        if (ws !== socket || connectionId !== connectionSeq) {
          log.debug("botcord ws stale close ignored", { agentId, code, reason: reasonStr });
          return;
        }
        log.info("botcord ws closed", { agentId, code, reason: reasonStr });
        clearTimers();
        ws = null;
        markStatus({ connected: false });
        if (!running) {
          if (permanentStopping) return;
          if (resolveLoop) {
            const r = resolveLoop;
            resolveLoop = null;
            rejectLoop = null;
            r();
          }
          return;
        }
        if (code === 4001) {
          consecutiveAuthFailures += 1;
          if (consecutiveAuthFailures >= MAX_AUTH_FAILURES) {
            log.error("botcord ws auth failing persistently — giving up reconnects", {
              agentId,
              failures: consecutiveAuthFailures,
            });
            running = false;
            markStatus({
              running: false,
              connected: false,
              lastStopAt: Date.now(),
              lastError: "auth failed repeatedly",
            });
            if (resolveLoop) {
              const r = resolveLoop;
              resolveLoop = null;
              rejectLoop = null;
              r();
            }
            return;
          }
          const refresh = (async () => {
            try {
              await client.refreshToken();
            } catch (err) {
              if (await revokeLocalTerminalCredentials(err)) {
                return;
              }
              log.error("botcord ws forced refresh failed", { agentId, err: String(err) });
            }
          })();
          pendingRefresh = refresh;
          void refresh.then(() => {
            if (pendingRefresh === refresh) {
              pendingRefresh = null;
            }
            scheduleReconnect();
          });
          return;
        }
        scheduleReconnect();
      });

      socket.on("error", (err: Error) => {
        if (ws !== socket || connectionId !== connectionSeq) return;
        log.warn("botcord ws error", { agentId, err: String(err) });
        markStatus({ lastError: String(err) });
      });
    }

    function stopLoop() {
      if (!running) return;
      running = false;
      clearTimers();
      markStatus({
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
      if (resolveLoop) {
        const r = resolveLoop;
        resolveLoop = null;
        rejectLoop = null;
        r();
      }
    }

    stopCallback = stopLoop;
    abortSignal.addEventListener("abort", stopLoop, { once: true });
    void connect();
    return done;
  }

  const adapter: ChannelAdapter = {
    id: options.id,
    type: channelType,

    async start(ctx: ChannelStartContext): Promise<void> {
      const client = ensureClient();
      // Only patch fields owned by the adapter; the manager is the single
      // writer for `channel` (== adapter.id) and `accountId`.
      const patch: Partial<ChannelStatusSnapshot> = {
        running: true,
        connected: false,
        reconnectAttempts: 0,
        lastStartAt: Date.now(),
        lastError: null,
      };
      statusSnapshot = { ...statusSnapshot, ...patch };
      ctx.setStatus(patch);
      await startWsLoop(client, ctx);
    },

    async stop(_ctx: ChannelStopContext): Promise<void> {
      if (stopCallback) {
        stopCallback();
        stopCallback = null;
      }
    },

    async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
      const client = ensureClient();
      const { message } = ctx;
      const options: {
        replyTo?: string;
        topic?: string;
        attachments?: MessageAttachment[];
        errorRef?: string;
        traceId?: string | null;
      } = {};
      if (message.replyTo) options.replyTo = message.replyTo;
      if (message.threadId) options.topic = message.threadId;
      if (message.errorRef) options.errorRef = message.errorRef;
      // Bind the reply to its originating run so owner-chat stream blocks
      // (keyed by the same trace_id) merge into this message instead of
      // orphaning into a separate placeholder.
      if (message.traceId) options.traceId = message.traceId;
      const upload = await uploadOutboundAttachments(client, message.attachments ?? [], ctx.log);
      if (upload.attachments.length > 0) options.attachments = upload.attachments;
      const text = rewriteUploadedAttachmentPaths(message.text, upload.replacements);
      const resp =
        message.type === "error" && client.sendTypedMessage
          ? await client.sendTypedMessage(message.conversationId, "error", text, options)
          : await client.sendMessage(message.conversationId, text, options);
      const providerMessageId =
        (resp && typeof resp.hub_msg_id === "string" && resp.hub_msg_id) ||
        (resp && typeof (resp as { message_id?: unknown }).message_id === "string"
          ? (resp as { message_id: string }).message_id
          : null);
      return { providerMessageId: providerMessageId ?? null };
    },

    async streamBlock(ctx: ChannelStreamBlockContext): Promise<void> {
      const client = ensureClient();
      const hubUrl = options.hubBaseUrl ?? client.getHubUrl();
      try {
        const block = ctx.block as { raw?: unknown; kind?: string; seq?: number } | undefined;
        const seq = typeof block?.seq === "number" ? block.seq : 0;
        const resp = await postControlWithRefresh(client, hubUrl, "/hub/stream-block", {
          trace_id: ctx.traceId,
          seq,
          block: normalizeBlockForHub(block, seq),
        });
        if (!resp.ok && resp.status !== 204) {
          const body = await resp.text().catch(() => "");
          ctx.log.warn("botcord stream-block non-ok", {
            status: resp.status,
            body: body.slice(0, 200),
          });
        }
      } catch (err) {
        ctx.log.warn("botcord stream-block failed", { err: String(err) });
      }
    },

    async streamEnd(ctx: ChannelStreamEndContext): Promise<void> {
      const client = ensureClient();
      const hubUrl = options.hubBaseUrl ?? client.getHubUrl();
      try {
        const resp = await postControlWithRefresh(client, hubUrl, "/hub/stream-end", {
          trace_id: ctx.traceId,
        });
        if (!resp.ok && resp.status !== 204) {
          const body = await resp.text().catch(() => "");
          ctx.log.warn("botcord stream-end non-ok", {
            status: resp.status,
            body: body.slice(0, 200),
          });
        }
      } catch (err) {
        ctx.log.warn("botcord stream-end failed", { err: String(err) });
      }
    },

    async typing(ctx: ChannelTypingContext): Promise<void> {
      const client = ensureClient();
      const hubUrl = options.hubBaseUrl ?? client.getHubUrl();
      try {
        const resp = await postControlWithRefresh(client, hubUrl, "/hub/typing", {
          room_id: ctx.conversationId,
        });
        if (!resp.ok && resp.status !== 204) {
          const body = await resp.text().catch(() => "");
          ctx.log.warn("botcord typing non-ok", {
            status: resp.status,
            body: body.slice(0, 200),
          });
        }
      } catch (err) {
        ctx.log.warn("botcord typing failed", { err: String(err) });
      }
    },

    async messageStatus(ctx: ChannelMessageStatusContext): Promise<void> {
      const client = ensureClient();
      const hubUrl = options.hubBaseUrl ?? client.getHubUrl();
      const body = {
        room_id: ctx.conversationId,
        turn_id: ctx.turnId,
      };
      const path = `/hub/messages/${encodeURIComponent(ctx.messageId)}/status-reactions`;
      // A lost clear leaves the reaction stuck for the full TTL, so retry it.
      const maxAttempts = ctx.phase === "cleared" ? 2 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const resp = ctx.phase === "started"
            ? await postControlWithRefresh(client, hubUrl, path, {
                ...body,
                kind: ctx.kind,
                emoji: ctx.emoji || DEFAULT_REPLYING_STATUS_EMOJI,
                ttl_sec: REPLYING_STATUS_TTL_SEC,
              })
            : await postControlWithRefresh(
                client,
                hubUrl,
                `${path}/${encodeURIComponent(ctx.kind)}`,
                body,
                "DELETE",
              );
          if (resp.ok || resp.status === 204) return;
          const respBody = await resp.text().catch(() => "");
          ctx.log.warn("botcord message status non-ok", {
            phase: ctx.phase,
            status: resp.status,
            attempt,
            body: respBody.slice(0, 200),
          });
          // 4xx won't succeed on retry (message/room gone, bad request).
          if (resp.status >= 400 && resp.status < 500) return;
        } catch (err) {
          ctx.log.warn("botcord message status failed", {
            phase: ctx.phase,
            messageId: ctx.messageId,
            attempt,
            err: String(err),
          });
        }
      }
    },

    status(): ChannelStatusSnapshot {
      return { ...statusSnapshot };
    },
  };

  return adapter;
}

// Re-export the normalizers for tests that want to exercise them directly.
export { normalizeInbox as __normalizeInboxForTests };
export { normalizeBlockForHub as __normalizeBlockForHubForTests };

/**
 * Reshape a runtime StreamBlock `{ raw, kind, seq }` into the
 * `{ kind, payload, seq }` form the owner-chat frontend renders.
 *
 * Daemon-internal kinds are Claude Code / Codex specific; the dashboard's
 * StreamBlocksView expects a smaller vocabulary (`assistant`, `tool_call`,
 * `tool_result`, `reasoning`) with structured `payload` fields. Without this
 * remap the UI falls back to printing the bare kind string per step, which
 * is what users see as "system / assistant_text / other / other".
 *
 * Extraction is best-effort — unknown shapes pass through as `other` with
 * an empty payload rather than throwing.
 */
function normalizeBlockForHub(
  block: { raw?: unknown; kind?: string; seq?: number } | undefined,
  seq: number,
): { kind: string; seq: number; payload: Record<string, unknown>; raw?: unknown } {
  const raw = (block?.raw ?? {}) as any;
  const kind = block?.kind ?? "other";
  const payload: Record<string, unknown> = {};
  const withRaw = (out: { kind: string; seq: number; payload: Record<string, unknown> }) => (
    block && "raw" in block ? { ...out, raw: block.raw } : out
  );

  if (kind === "assistant_text") {
    // Claude Code: {type:"assistant", message:{content:[{type:"text",text}]}}
    // Codex:       {type:"item.completed", item:{type:"agent_message", text}}
    // DeepSeek:    {event:"message.delta", payload:{content}} or
    //              {event:"item.delta", payload:{kind:"agent_message", delta}}
    let text = "";
    const contents = Array.isArray(raw?.message?.content) ? raw.message.content : [];
    for (const c of contents) {
      if (c?.type === "text" && typeof c.text === "string") text += c.text;
    }
    if (!text && typeof raw?.item?.text === "string") text = raw.item.text;
    if (!text && raw?.event === "message.delta" && typeof raw?.payload?.content === "string") {
      text = raw.payload.content;
    }
    if (
      !text &&
      raw?.event === "item.delta" &&
      (raw?.payload?.kind === "agent_message" || raw?.payload?.payload?.kind === "agent_message")
    ) {
      text =
        typeof raw?.payload?.delta === "string"
          ? raw.payload.delta
          : typeof raw?.payload?.payload?.delta === "string"
            ? raw.payload.payload.delta
            : "";
    }
    return { kind: "assistant", seq, payload: { text } };
  }

  if (kind === "tool_use") {
    // Claude Code, Codex, DeepSeek TUI, Kimi, and ACP all expose tool calls
    // with slightly different field names. Preserve the real invocation input
    // so the dashboard can show more than a bare "tool" label.
    const call = extractToolCall(raw);
    if (call) {
      payload.name = call.name;
      if (call.params !== undefined && !isEmptyRecord(call.params)) payload.params = call.params;
      if (call.id) payload.id = call.id;
      if (call.status) payload.status = call.status;
    }
    return withRaw({ kind: "tool_call", seq, payload });
  }

  if (kind === "tool_result") {
    const result = extractToolResult(raw);
    if (result) {
      if (result.name) payload.name = result.name;
      payload.result = result.result;
      if (result.id) payload.tool_use_id = result.id;
    }
    return withRaw({ kind: "tool_result", seq, payload });
  }

  if (kind === "system") {
    if (typeof raw?.subtype === "string") payload.subtype = raw.subtype;
    if (typeof raw?.session_id === "string") payload.session_id = raw.session_id;
    if (typeof raw?.model === "string") payload.model = raw.model;
    payload.details = formatBlockDetails(raw);
    return withRaw({ kind: "system", seq, payload });
  }

  if (kind === "thinking") {
    // Daemon-synthesized lifecycle marker. `raw` carries `{ phase, label?, source? }`
    // — see Dispatcher's status forwarding. The frontend uses `phase` to decide
    // whether to enter/leave the compact "Thinking..." UI; `label` is a free-form
    // human hint (e.g. "Searching web"). Treat as untrusted text — never inject.
    if (typeof raw?.phase === "string") payload.phase = raw.phase;
    if (typeof raw?.label === "string") payload.label = raw.label;
    if (typeof raw?.source === "string") payload.source = raw.source;
    payload.details = formatBlockDetails(raw);
    return withRaw({ kind: "thinking", seq, payload });
  }

  // "other" — e.g. Claude Code `type:"result"` end-of-turn summary.
  if (isTerminalRuntimeBlock(raw)) {
    payload.terminal = true;
    payload.details = formatBlockDetails(raw);
    const event = typeof raw?.event === "string" ? raw.event : undefined;
    const embedded = typeof raw?.payload?.event === "string" ? raw.payload.event : undefined;
    if (event || embedded) payload.event = event ?? embedded;
    return withRaw({ kind: "other", seq, payload });
  }
  if (raw?.type === "result") {
    if (typeof raw.result === "string") payload.text = raw.result;
    if (typeof raw.subtype === "string") payload.subtype = raw.subtype;
    if (typeof raw.total_cost_usd === "number") payload.total_cost_usd = raw.total_cost_usd;
  }
  return withRaw({ kind: "other", seq, payload });
}

function isTerminalRuntimeBlock(raw: any): boolean {
  const event = typeof raw?.event === "string" ? raw.event : undefined;
  const embedded = typeof raw?.payload?.event === "string" ? raw.payload.event : undefined;
  const terminal = event ?? embedded;
  return (
    terminal === "turn.completed" ||
    terminal === "turn.finished" ||
    terminal === "turn.done" ||
    terminal === "done"
  );
}

function extractToolCall(raw: any): { name: string; params?: unknown; id?: string; status?: string } | null {
  const contents = Array.isArray(raw?.message?.content) ? raw.message.content : [];
  const tu = contents.find((c: any) => c?.type === "tool_use");
  if (tu) {
    return {
      name: stringField(tu, "name") ?? "tool",
      params: parseMaybeJson(tu.input ?? tu.arguments),
      id: stringField(tu, "id"),
    };
  }

  const deepseek = extractDeepseekToolCall(raw);
  if (deepseek) return deepseek;

  const item = raw?.item;
  if (item && typeof item === "object") {
    const params = codexToolParams(item);
    return {
      name: stringField(item, "type") ?? stringField(item, "name") ?? "tool",
      params,
      id: stringField(item, "id"),
      status: stringField(item, "status"),
    };
  }

  const toolCalls = Array.isArray(raw?.tool_calls) ? raw.tool_calls : [];
  const toolCall = toolCalls.find((t: any) => t && typeof t === "object");
  if (toolCall) {
    const fn = toolCall.function && typeof toolCall.function === "object" ? toolCall.function : undefined;
    return {
      name: stringField(fn, "name") ?? stringField(toolCall, "name") ?? "tool",
      params: parseMaybeJson(fn?.arguments ?? toolCall.arguments ?? toolCall.input ?? toolCall.rawInput),
      id: stringField(toolCall, "id"),
    };
  }

  const update = raw?.params?.update ?? raw?.update;
  const acpTool = update?.toolCall ?? update?.tool_call ?? update?.tool;
  if (acpTool && typeof acpTool === "object") {
    return {
      name: stringField(acpTool, "name") ?? stringField(update, "name") ?? "tool",
      params: parseMaybeJson(
        acpTool.rawInput ??
          acpTool.raw_input ??
          acpTool.input ??
          acpTool.arguments ??
          acpTool.args ??
          acpTool.params,
      ) ?? acpTool,
      id: stringField(acpTool, "id") ?? stringField(update, "toolCallId"),
    };
  }

  return null;
}

function extractToolResult(raw: any): { name?: string; result: string; id?: string } | null {
  const contents = Array.isArray(raw?.message?.content) ? raw.message.content : [];
  const tr = contents.find((c: any) => c?.type === "tool_result");
  if (tr) {
    return {
      result: stringifyToolResult(tr.content),
      id: stringField(tr, "tool_use_id"),
    };
  }

  const deepseek = extractDeepseekToolResult(raw);
  if (deepseek) return deepseek;

  const item = raw?.item;
  if (item && typeof item === "object") {
    const result = codexToolResult(item);
    return {
      name: stringField(item, "type") ?? stringField(item, "name"),
      result: result || stringifyToolResult(item),
      id: stringField(item, "id"),
    };
  }

  if (raw?.role === "tool") {
    return {
      result: stringifyToolResult(raw.content),
      id: stringField(raw, "tool_call_id"),
    };
  }

  const update = raw?.params?.update ?? raw?.update;
  const acpTool = update?.toolCall ?? update?.tool_call ?? update?.tool;
  if (acpTool && typeof acpTool === "object") {
    const result =
      acpTool.output ??
      acpTool.result ??
      acpTool.content ??
      acpTool.error ??
      update.content ??
      update;
    return {
      name: stringField(acpTool, "name") ?? stringField(update, "name"),
      result: stringifyToolResult(result),
      id: stringField(acpTool, "id") ?? stringField(update, "toolCallId"),
    };
  }

  return null;
}

function extractDeepseekToolCall(raw: any): { name: string; params?: unknown; id?: string; status?: string } | null {
  const payload = raw?.payload;
  if (!payload || typeof payload !== "object") return null;
  const innerPayload = unwrapDeepseekPayload(raw);
  const event = stringField(raw, "event") ?? stringField(payload, "event");

  if (event === "tool.started") {
    const tool = innerPayload?.tool && typeof innerPayload.tool === "object" ? innerPayload.tool : undefined;
    return {
      name: stringField(innerPayload, "name") ?? stringField(tool, "name") ?? "tool",
      params: parseMaybeJson(
        innerPayload?.input ??
          innerPayload?.arguments ??
          innerPayload?.params ??
          tool?.input ??
          tool?.rawInput ??
          tool?.arguments ??
          tool?.params,
      ),
      id: stringField(innerPayload, "id") ?? stringField(tool, "id"),
      status: stringField(innerPayload, "status") ?? stringField(tool, "status"),
    };
  }

  if (event === "item.started") {
    const inner = innerPayload ?? {};
    const item = inner.item && typeof inner.item === "object" ? inner.item : undefined;
    const tool = inner.tool && typeof inner.tool === "object" ? inner.tool : item?.tool;
    const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : undefined;
    const metadataCommand =
      metadata && (metadata.command ?? metadata.cmd)
        ? { [metadata.command ? "command" : "cmd"]: metadata.command ?? metadata.cmd }
        : undefined;
    const itemParams = parseMaybeJson(
      item?.input ??
        item?.arguments ??
        item?.params ??
        metadata?.input ??
        metadata?.arguments ??
        metadata?.params ??
        metadataCommand ??
        item?.detail,
    );
    const detailParams =
      itemParams !== undefined
        ? itemParams
        : typeof item?.detail === "string" && item.detail.trim()
          ? item.detail.trim()
          : undefined;
    return {
      name:
        stringField(tool, "name") ??
        stringField(inner, "name") ??
        stringField(item, "name") ??
        inferDeepseekToolName(item) ??
        stringField(item, "type") ??
        "tool",
      params: parseMaybeJson(
        tool?.input ??
          tool?.rawInput ??
          tool?.arguments ??
          tool?.params ??
          inner.input ??
          inner.arguments ??
          inner.params ??
          item?.input ??
          item?.arguments ??
          item?.params ??
          metadata?.input ??
          metadata?.arguments ??
          metadata?.params ??
          metadataCommand,
      ) ?? detailParams ?? tool ?? item,
      id:
        stringField(tool, "id") ??
        stringField(inner, "id") ??
        stringField(item, "id") ??
        stringField(payload, "item_id"),
      status: stringField(tool, "status") ?? stringField(inner, "status") ?? stringField(item, "status"),
    };
  }

  return null;
}

function extractDeepseekToolResult(raw: any): { name?: string; result: string; id?: string } | null {
  const payload = raw?.payload;
  if (!payload || typeof payload !== "object") return null;
  const innerPayload = unwrapDeepseekPayload(raw);
  const event = stringField(raw, "event") ?? stringField(payload, "event");

  if (event === "tool.completed") {
    const result =
      innerPayload?.output ??
      innerPayload?.result ??
      innerPayload?.content ??
      innerPayload?.error ??
      innerPayload ??
      payload;
    return {
      name: stringField(innerPayload, "name"),
      result: stringifyToolResult(result),
      id: stringField(innerPayload, "id"),
    };
  }

  if (event === "item.completed" || event === "item.failed") {
    const inner = innerPayload ?? {};
    const item = inner.item && typeof inner.item === "object" ? inner.item : undefined;
    const result =
      item?.output ??
      item?.result ??
      item?.content ??
      item?.detail ??
      item?.summary ??
      item?.error ??
      inner.output ??
      inner.result ??
      inner.error ??
      item ??
      inner;
    return {
      name:
        stringField(item, "name") ??
        inferDeepseekToolName(item) ??
        stringField(inner, "name") ??
        stringField(item, "type"),
      result: stringifyToolResult(result),
      id: stringField(item, "id") ?? stringField(inner, "id") ?? stringField(payload, "item_id"),
    };
  }

  return null;
}

function unwrapDeepseekPayload(raw: any): any {
  const payload = raw?.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const nested = payload.payload;
  if (nested && typeof nested === "object") {
    const outerEvent = stringField(payload, "event");
    if (
      outerEvent ||
      nested.item ||
      nested.tool ||
      nested.turn ||
      nested.kind ||
      nested.output ||
      nested.result ||
      nested.error
    ) {
      return nested;
    }
  }
  return payload;
}

function formatBlockDetails(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const r = raw as any;
  const direct =
    typeof r.text === "string" ? r.text
    : typeof r.message === "string" ? r.message
    : typeof r.summary === "string" ? r.summary
    : typeof r.label === "string" ? r.label
    : typeof r.payload?.delta === "string" ? r.payload.delta
    : typeof r.payload?.item?.detail === "string" ? r.payload.item.detail
    : typeof r.payload?.item?.summary === "string" ? r.payload.item.summary
    : typeof r.payload?.payload?.item?.detail === "string" ? r.payload.payload.item.detail
    : typeof r.payload?.payload?.item?.summary === "string" ? r.payload.payload.item.summary
    : "";
  if (direct) return direct;

  const contentText = extractContentText(r.content ?? r.message?.content ?? r.params?.update?.content);
  if (contentText) return contentText;

  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function codexToolParams(item: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of [
    "command",
    "cmd",
    "args",
    "path",
    "query",
    "url",
    "name",
    "input",
    "arguments",
    "action",
    "changes",
  ]) {
    const value = item[key];
    if (value !== undefined && value !== null && value !== "") params[key] = value;
  }

  const action = item.action as Record<string, unknown> | undefined;
  if (action && typeof action === "object") {
    for (const key of ["query", "url", "command", "path"]) {
      const value = action[key];
      if (value !== undefined && value !== null && value !== "") params[key] = value;
    }
  }

  return params;
}

function codexToolResult(item: Record<string, unknown>): string {
  const parts: string[] = [];
  const status = typeof item.status === "string" ? item.status : "";
  const exitCode = item.exit_code ?? item.exitCode;
  if (status) parts.push(`status: ${status}`);
  if (typeof exitCode === "number" || typeof exitCode === "string") parts.push(`exit_code: ${exitCode}`);

  for (const key of ["output", "stdout", "stderr", "aggregated_output", "result", "summary"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  }

  const results = item.results;
  if (Array.isArray(results) && results.length > 0) {
    parts.push(JSON.stringify(results, null, 2));
  }

  return parts.join("\n");
}

function stringifyToolResult(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (typeof c?.text === "string") return c.text;
        return stringifyToolResult(c);
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function inferDeepseekToolName(item: any): string | undefined {
  const candidates = [stringField(item, "summary"), stringField(item, "detail")];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(/^([A-Za-z0-9_.:-]+)\s*(?:started|completed|failed|returned|:)/);
    if (match?.[1] && match[1] !== "tool_call") return match[1];
  }
  return undefined;
}

function isEmptyRecord(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function stringField(obj: any, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractContentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractContentText).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    const c = content as any;
    if (typeof c.text === "string") return c.text;
    if (typeof c.thinking === "string") return c.thinking;
    if (typeof c.content === "string") return c.content;
    if (Array.isArray(c.content)) return extractContentText(c.content);
  }
  return "";
}
