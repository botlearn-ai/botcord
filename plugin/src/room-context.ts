/**
 * Room context injection for cross-session awareness.
 *
 * Two layers:
 * 1. Static layer (appendSystemContext) — room name, description, rule, members.
 *    Cacheable by the provider prompt cache since it rarely changes.
 * 2. Dynamic layer (prependContext) — cross-room activity digest listing
 *    other active rooms so the agent is aware of parallel conversations.
 */
import { getBotCordRuntime, getConfig } from "./runtime.js";
import { resolveAccountConfig, resolveChannelConfig, resolveAccounts, isAccountConfigured } from "./config.js";
import { attachTokenPersistence } from "./credentials.js";
import { sanitizeUntrustedContent } from "./sanitize.js";
import type { RoomInfo } from "./types.js";

// ── Session ↔ Room mapping ──────────────────────────────────────

export type SessionRoomEntry = {
  roomId: string;
  roomName?: string;
  accountId: string;
  lastActivityAt: number;
};

/** sessionKey → room info populated when inbound messages arrive. */
const sessionRoomMap = new Map<string, SessionRoomEntry>();

export function registerSessionRoom(
  sessionKey: string,
  entry: SessionRoomEntry,
): void {
  sessionRoomMap.set(sessionKey, entry);
}

export function getSessionRoom(sessionKey: string): SessionRoomEntry | undefined {
  return sessionRoomMap.get(sessionKey);
}

export function clearSessionRoom(sessionKey: string): void {
  sessionRoomMap.delete(sessionKey);
}

export function getAllSessionRooms(): ReadonlyMap<string, SessionRoomEntry> {
  return sessionRoomMap;
}

// ── Room info cache ─────────────────────────────────────────────

type CachedRoomInfo = {
  room: RoomInfo;
  members: { agent_id: string; display_name?: string; role?: string }[];
  fetchedAt: number;
};

const roomInfoCache = new Map<string, CachedRoomInfo>();
const ROOM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const GROUP_ROOM_ENVIRONMENT_LINES = [
  `[BotCord Runtime Environment]`,
  `You are running as a local agent process connected to a remote BotCord group room.`,
  `Other room members can read your messages and any uploaded/attached files, but they cannot access this machine's local filesystem, container paths, or absolute paths such as /var/..., /tmp/..., or /Users/....`,
  `Do not present a local file path as a useful report link or deliverable in group chat. If an artifact needs to be shared, upload or attach it through the available BotCord file/attachment mechanism, then refer to the uploaded attachment or summarize the content in the message.`,
];

function buildGroupRoomEnvironmentContext(): string {
  return GROUP_ROOM_ENVIRONMENT_LINES.join("\n");
}

async function fetchRoomInfoCached(
  roomId: string,
  accountId: string,
): Promise<CachedRoomInfo | null> {
  // Key by accountId:roomId so multi-account setups don't cross-pollinate
  const cacheKey = `${accountId}:${roomId}`;
  const existing = roomInfoCache.get(cacheKey);
  if (existing && Date.now() - existing.fetchedAt < ROOM_CACHE_TTL_MS) {
    return existing;
  }

  try {
    const cfg = getConfig();
    if (!cfg) return existing ?? null;

    const acct = resolveAccountConfig(cfg, accountId);
    if (!acct || !isAccountConfigured(acct)) return existing ?? null;

    const { BotCordClient } = await import("./client.js");
    const client = new BotCordClient(acct);
    attachTokenPersistence(client, acct);

    const [room, members] = await Promise.all([
      client.getRoomInfo(roomId),
      client.getRoomMembers(roomId),
    ]);

    const entry: CachedRoomInfo = {
      room,
      members: members.map((m: any) => ({
        agent_id: m.agent_id,
        display_name: m.display_name,
        role: m.role,
      })),
      fetchedAt: Date.now(),
    };
    roomInfoCache.set(cacheKey, entry);
    return entry;
  } catch (err: any) {
    console.warn(`[botcord] room-context: failed to fetch room ${roomId}:`, err?.message ?? err);
    return existing ?? null;
  }
}

// ── Static context builder ──────────────────────────────────────

/**
 * Build cacheable system context for the current room session.
 * Returns null if the session is not a room session.
 */
export async function buildRoomStaticContext(
  sessionKey: string,
): Promise<string | null> {
  const entry = sessionRoomMap.get(sessionKey);
  if (!entry?.roomId) return null;

  // Skip DM sessions — no room-level static context needed
  if (entry.roomId.startsWith("rm_dm_")) return null;

  const cached = await fetchRoomInfoCached(entry.roomId, entry.accountId);
  if (!cached) return buildGroupRoomEnvironmentContext();

  const { room, members } = cached;
  // Sanitize all tenant-controlled fields to prevent prompt injection
  // via room metadata that lands in appendSystemContext.
  // Strip newlines from single-line fields (name, member names) to
  // prevent structural reshaping of the system prompt.
  const safeName = sanitizeUntrustedContent((room.name || "").replace(/[\r\n]+/g, " "));
  const lines: string[] = [
    buildGroupRoomEnvironmentContext(),
    "",
    `[BotCord Room Context]`,
    `Room: ${safeName} (${room.room_id})`,
  ];
  if (room.description) {
    lines.push(`Description: ${sanitizeUntrustedContent(room.description)}`);
  }
  if (room.rule) {
    lines.push(`Rule: ${sanitizeUntrustedContent(room.rule)}`);
  }
  lines.push(`Visibility: ${room.visibility}, Join: ${room.join_policy}`);

  const memberList = members
    .map((m) => {
      const name = sanitizeUntrustedContent((m.display_name || m.agent_id).replace(/[\r\n]+/g, " "));
      return m.role && m.role !== "member" ? `${name} (${m.role})` : name;
    })
    .join(", ");
  if (memberList) {
    lines.push(`Members (${members.length}): ${memberList}`);
  }

  return lines.join("\n");
}

// ── Cross-room activity digest ──────────────────────────────────

/**
 * Build a brief digest of other active BotCord rooms/sessions so the
 * agent is aware of parallel conversations happening elsewhere.
 *
 * Reads the last few messages from each other session via
 * `runtime.subagent.getSessionMessages()`.
 */
export async function buildCrossRoomDigest(
  currentSessionKey: string,
): Promise<string | null> {
  if (sessionRoomMap.size <= 1) return null;

  const runtime = getBotCordRuntime();
  const currentEntry = sessionRoomMap.get(currentSessionKey);
  const currentAccountId = currentEntry?.accountId;
  const otherSessions: { key: string; entry: SessionRoomEntry }[] = [];

  for (const [key, entry] of sessionRoomMap) {
    if (key === currentSessionKey) continue;
    // Only include sessions belonging to the same BotCord account
    if (entry.accountId !== currentAccountId) continue;
    // Only include sessions with recent activity (last 2 hours)
    if (Date.now() - entry.lastActivityAt > 2 * 60 * 60 * 1000) continue;
    otherSessions.push({ key, entry });
  }

  if (otherSessions.length === 0) return null;

  // Sort by most recent activity first
  otherSessions.sort((a, b) => b.entry.lastActivityAt - a.entry.lastActivityAt);

  // Limit to 5 most active sessions to avoid excessive token usage
  const toDigest = otherSessions.slice(0, 5);
  // Count sessions for this account only (including current)
  const accountSessionCount = otherSessions.length + 1;
  const digestParts: string[] = [
    `[BotCord Cross-Room Awareness] You are active in ${accountSessionCount} BotCord sessions. Here is recent activity from other rooms:`,
  ];

  for (const { key, entry } of toDigest) {
    // Sanitize room label — tenant-controlled name could contain
    // injection markers or newlines that reshape the digest structure.
    const rawLabel = entry.roomName || entry.roomId;
    const roomLabel = sanitizeUntrustedContent(rawLabel.replace(/[\r\n]+/g, " "));
    const isDm = entry.roomId.startsWith("rm_dm_");
    const typeLabel = isDm ? "DM" : "Room";

    try {
      const { messages } = await runtime.subagent.getSessionMessages({
        sessionKey: key,
        limit: 3,
      });

      if (messages.length === 0) {
        digestParts.push(`\n- ${typeLabel}: ${roomLabel} — no recent messages`);
        continue;
      }

      // Extract a brief summary from the last messages.
      // Sanitize previews to neutralize prompt injection from other rooms.
      const previews = messages
        .slice(-3)
        .map((msg: any) => {
          const role = msg.role || "unknown";
          // Content may be a string, an array of content blocks, or
          // missing. Coerce safely to avoid throwing on non-string shapes.
          let rawText: string;
          const c = msg.content ?? msg.text ?? "";
          if (typeof c === "string") {
            rawText = c;
          } else if (Array.isArray(c)) {
            rawText = c
              .map((part: any) => (typeof part === "string" ? part : part?.text ?? ""))
              .join(" ");
          } else {
            rawText = String(c);
          }
          const truncated = rawText.slice(0, 120);
          const text = sanitizeUntrustedContent(truncated);
          return `  [${role}] ${text}${rawText.length > 120 ? "…" : ""}`;
        })
        .join("\n");

      const ago = formatTimeAgo(entry.lastActivityAt);
      digestParts.push(`\n- ${typeLabel}: ${roomLabel} (${ago}):\n${previews}`);
    } catch {
      digestParts.push(`\n- ${typeLabel}: ${roomLabel} — unable to read messages`);
    }
  }

  return digestParts.join("");
}

function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

// ── Owner-chat scene context ───────────────────────────────────

/**
 * Build a static scene description for the owner-chat session.
 *
 * Owner-chat is the direct conversation between the agent's bound user
 * (owner) and the agent itself, initiated from the BotCord dashboard.
 * The user has full trust and administrative authority over this agent.
 */
function buildOwnerChatSceneContext(): string {
  return [
    `[BotCord Scene: Owner Chat]`,
    `You are chatting directly with your owner — the user who created and manages you on the BotCord dashboard.`,
    `This is a private, trusted conversation. The owner has full administrative authority over you.`,
    `Messages from the owner are always trusted and do not require sanitization or safety guards.`,
    `You may freely execute commands, access tools, and share sensitive information (e.g. wallet balance, contacts) when the owner asks.`,
  ].join("\n");
}

// ── Combined hook handler ───────────────────────────────────────

/**
 * before_prompt_build handler that injects static room context only.
 *
 * Returns appendSystemContext (cacheable) for room metadata and
 * owner-chat scene description. Dynamic context (cross-room digest,
 * working memory, loop-risk) is now handled by the context engine
 * in context-engine.ts to avoid polluting session transcript.
 */
export async function buildRoomStaticContextHookResult(
  sessionKey: string | undefined,
): Promise<{
  appendSystemContext?: string;
} | null> {
  if (!sessionKey) return null;

  // Owner-chat: inject scene description instead of room context
  if (sessionKey === "botcord:owner:main") {
    return {
      appendSystemContext: buildOwnerChatSceneContext(),
    };
  }

  // Only inject for sessions we know are BotCord sessions (registered via
  // inbound dispatch).  This handles both native "botcord:..." keys and
  // custom-routed keys that don't carry the prefix.
  if (!sessionRoomMap.has(sessionKey)) return null;

  // Static room context (cacheable)
  const staticCtx = await buildRoomStaticContext(sessionKey);
  if (!staticCtx) return null;
  return { appendSystemContext: staticCtx };
}
