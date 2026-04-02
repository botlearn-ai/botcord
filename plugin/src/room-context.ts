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
  if (!cached) return null;

  const { room, members } = cached;
  const lines: string[] = [
    `[BotCord Room Context]`,
    `Room: ${room.name} (${room.room_id})`,
  ];
  if (room.description) {
    lines.push(`Description: ${room.description}`);
  }
  if (room.rule) {
    lines.push(`Rule: ${room.rule}`);
  }
  lines.push(`Visibility: ${room.visibility}, Join: ${room.join_policy}`);

  const memberList = members
    .map((m) => {
      const name = m.display_name || m.agent_id;
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
    const roomLabel = entry.roomName || entry.roomId;
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

      // Extract a brief summary from the last messages
      const previews = messages
        .slice(-3)
        .map((msg: any) => {
          const role = msg.role || "unknown";
          const text = (msg.content || msg.text || "").slice(0, 120);
          return `  [${role}] ${text}${text.length >= 120 ? "…" : ""}`;
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
 * before_prompt_build handler that injects room context.
 * Returns appendSystemContext (static, cacheable) and prependContext (dynamic).
 */
export async function buildRoomContextHookResult(
  sessionKey: string | undefined,
): Promise<{
  appendSystemContext?: string;
  prependContext?: string;
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

  const result: { appendSystemContext?: string; prependContext?: string } = {};

  // Layer 1: Static room context (cacheable)
  const staticCtx = await buildRoomStaticContext(sessionKey);
  if (staticCtx) {
    result.appendSystemContext = staticCtx;
  }

  // Layer 2: Cross-room activity digest (dynamic, per-turn)
  const digest = await buildCrossRoomDigest(sessionKey);
  if (digest) {
    result.prependContext = digest;
  }

  if (!result.appendSystemContext && !result.prependContext) return null;
  return result;
}
