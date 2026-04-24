/**
 * Room static context builder — injects room name, description, rule, and
 * member list into the system prompt for group conversations. Mirrors
 * `plugin/src/room-context.ts#buildRoomStaticContext` so Claude Code in
 * daemon-mode carries the same awareness as when hosted by OpenClaw.
 *
 * Scope:
 *   - Group rooms only. DMs (`rm_dm_`) and owner-chat (`rm_oc_`) rooms skip
 *     the block — DMs don't need it and owner-chat already has a scene
 *     prompt from system-context.ts.
 *   - Cached per `accountId:roomId` with a 5-minute TTL to keep Hub load
 *     bounded. Fetch failures are NOT cached so the next turn retries.
 *   - Concurrent fetches are de-duplicated via an in-flight promise slot.
 */
import { sanitizeUntrustedContent } from "./gateway/index.js";
import type { GatewayInboundMessage } from "./gateway/index.js";

/** Subset of Hub `/hub/rooms/:id` needed to render the block. */
export interface RoomInfoSnapshot {
  room_id: string;
  name?: string;
  description?: string;
  rule?: string | null;
  visibility?: string;
  join_policy?: string;
  member_count?: number;
}

/** Subset of a room-member record needed to render the block. */
export interface RoomMemberSnapshot {
  agent_id: string;
  display_name?: string;
  role?: string;
}

/** Combined result returned by the injected fetcher. */
export interface RoomContextFetchResult {
  room: RoomInfoSnapshot;
  members: RoomMemberSnapshot[];
}

/** Injected fetcher — daemon wraps a `BotCordClient` behind this contract. */
export type RoomContextFetcher = (params: {
  accountId: string;
  roomId: string;
}) => Promise<RoomContextFetchResult | null>;

/** Minimal logger surface — matches the daemon/gateway logger shape. */
interface CtxLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface RoomContextBuilderOptions {
  fetchRoomInfo: RoomContextFetcher;
  /** Cache TTL in ms. Defaults to 5 minutes to match the plugin. */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  log?: CtxLogger;
}

interface CacheEntry {
  blockText: string | null;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Strip CR/LF so tenant-controlled values can't reshape the prompt header. */
function stripNewlines(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

/** Render the block. Exported for tests; production callers go through the builder. */
export function renderRoomContextBlock(
  room: RoomInfoSnapshot,
  members: RoomMemberSnapshot[],
): string {
  const safeName = sanitizeUntrustedContent(stripNewlines(room.name ?? ""));
  const lines: string[] = [
    "[BotCord Room Context]",
    `Room: ${safeName || "(unnamed)"} (${room.room_id})`,
  ];
  if (room.description) {
    lines.push(`Description: ${sanitizeUntrustedContent(room.description)}`);
  }
  if (room.rule) {
    lines.push(`Rule: ${sanitizeUntrustedContent(room.rule)}`);
  }
  if (room.visibility || room.join_policy) {
    const visibility = room.visibility ?? "unknown";
    const joinPolicy = room.join_policy ?? "unknown";
    lines.push(`Visibility: ${visibility}, Join: ${joinPolicy}`);
  }
  if (members.length > 0) {
    const list = members
      .map((m) => {
        const raw = m.display_name || m.agent_id;
        const safe = sanitizeUntrustedContent(stripNewlines(raw));
        return m.role && m.role !== "member" ? `${safe} (${m.role})` : safe;
      })
      .join(", ");
    lines.push(`Members (${members.length}): ${list}`);
  }
  return lines.join("\n");
}

/**
 * Return `true` if the inbound message is eligible for a room-context block.
 * Exported for tests + reuse by the system-context builder.
 */
export function shouldInjectRoomContext(message: GatewayInboundMessage): boolean {
  if (message.conversation.kind !== "group") return false;
  const id = message.conversation.id;
  if (id.startsWith("rm_dm_")) return false;
  if (id.startsWith("rm_oc_")) return false;
  return true;
}

/**
 * Create a per-turn builder: `(msg) => Promise<string | null>`. The returned
 * function honors TTL, dedupes concurrent fetches, and tolerates fetcher
 * failures (logs + returns null so the turn is never blocked).
 */
export function createRoomStaticContextBuilder(
  opts: RoomContextBuilderOptions,
): (message: GatewayInboundMessage) => Promise<string | null> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<string | null>>();

  return async function getBlock(message) {
    if (!shouldInjectRoomContext(message)) return null;
    const accountId = message.accountId;
    const roomId = message.conversation.id;
    const key = `${accountId}:${roomId}`;

    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < ttl) return hit.blockText;

    const existing = inflight.get(key);
    if (existing) return existing;

    const p = (async () => {
      try {
        const result = await opts.fetchRoomInfo({ accountId, roomId });
        if (!result) return null;
        const blockText = renderRoomContextBlock(result.room, result.members);
        cache.set(key, { blockText, fetchedAt: now() });
        return blockText;
      } catch (err) {
        opts.log?.warn("daemon.room-context.fetch-failed", {
          accountId,
          roomId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't poison the cache — next turn will retry.
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}
