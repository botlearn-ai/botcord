/**
 * Owner-unified Messages list.
 *
 * The Messages tab shows the human owner's full activity surface — their own
 * conversations interleaved with all conversations of bots they own. Each
 * bot-originated room is tagged with `_originAgent` so:
 *   - the row can render a "via <bot>" hint
 *   - the chat pane can render a read-only banner when opened
 *
 * Origin determination comes from `/api/humans/me/agent-rooms`: any room in
 * that list is visible because one or more owned bots participates in it.
 * Rooms not in that list are treated as the human owner's own.
 */

import type { DashboardRoom, HumanAgentRoomSummary, ParticipantType } from "@/lib/types";
import { parseDmRoomId } from "@/components/dashboard/dmRoom";
import { compareRoomsByActivityDesc } from "@/store/dashboard-shared";

interface MergeOpts {
  ownRooms: DashboardRoom[];
  ownedAgentRooms: HumanAgentRoomSummary[];
}

function originFor(room: HumanAgentRoomSummary): { agent_id: string; display_name: string } | null {
  const bot = room.bots[0];
  return bot ? { agent_id: bot.agent_id, display_name: bot.display_name } : null;
}

/**
 * Infer the DM peer's participant type for an owned-bot DM room.
 *
 * `HumanAgentRoomSummary` doesn't carry peer_type, but DM rooms (`rm_dm_*`)
 * encode both participant ids in the room_id with `ag_` / `hu_` prefixes.
 * For DMs we resolve the non-bot side; for groups peer_type is irrelevant.
 */
function inferPeerTypeForOwnedAgentRoom(
  room: HumanAgentRoomSummary,
): ParticipantType | undefined {
  if ((room.member_count ?? 0) > 2) return undefined;
  const parsed = parseDmRoomId(room.room_id);
  if (!parsed) return undefined;
  const botIds = new Set(room.bots.map((b) => b.agent_id));
  const peer = botIds.has(parsed.a) ? parsed.b : parsed.a;
  return peer.startsWith("hu_") ? "human" : "agent";
}

export function ownedAgentRoomToDashboardRoom(room: HumanAgentRoomSummary): DashboardRoom {
  const origin = originFor(room);
  return {
    room_id: room.room_id,
    name: room.name,
    description: room.description ?? "",
    owner_id: room.owner_id,
    owner_type: "agent",
    visibility: room.visibility,
    join_policy: room.join_policy ?? undefined,
    member_count: room.member_count,
    my_role: room.bots[0]?.role ?? "member",
    created_at: room.created_at ?? null,
    rule: room.rule,
    required_subscription_product_id: room.required_subscription_product_id ?? null,
    last_viewed_at: null,
    has_unread: false,
    unread_count: 0,
    last_message_preview: room.last_message_preview,
    last_message_at: room.last_message_at,
    last_sender_name: room.last_sender_name,
    allow_human_send: room.allow_human_send ?? undefined,
    peer_type: inferPeerTypeForOwnedAgentRoom(room),
    _originAgent: origin ?? undefined,
  };
}

export function mergeOwnerVisibleRooms({ ownRooms, ownedAgentRooms }: MergeOpts): DashboardRoom[] {
  const seen = new Set(ownRooms.map((room) => room.room_id));
  const tagged = [
    ...ownRooms,
    ...ownedAgentRooms
      .filter((room) => !seen.has(room.room_id))
      .map(ownedAgentRoomToDashboardRoom),
  ];

  return tagged.sort(compareRoomsByActivityDesc);
}

/**
 * Messages filter taxonomy. Two parent buckets — `self` (the human owner is a
 * participant; can send) and `bots` (an owned bot is the participant; the
 * owner observes). Each parent has an `*-all` aggregate.
 *
 * This is a pure **filter** over a single unified data set — not a role
 * switch. Whether a conversation is read-only is determined per-room
 * (`_originAgent` presence), not by which filter is active.
 */
export type MessagesFilterKey =
  | "self-all"
  | "self-my-bot"
  | "self-third-bot"
  | "self-human"
  | "self-group"
  | "bots-all"
  | "bots-bot-bot"
  | "bots-bot-human"
  | "bots-group";

/**
 * Classify a single room into its most-specific filter bucket.
 *
 * - `_originAgent` present → owned bot's conversation (observer)
 * - DM (member_count ≤ 2) → split by peer type / ownership
 * - Group (member_count > 2) → `*-group`
 *
 * `selfMyBotRoomIds` is the set of room_ids returned by
 * `/api/humans/me/agent-rooms`. A DM that the human participates in AND that
 * one of their owned bots also participates in is the human ↔ own-bot case.
 */
export function classifyMessagesRoom(
  room: import("@/lib/types").DashboardRoom,
  selfMyBotRoomIds: Set<string>,
): MessagesFilterKey {
  const isObserver = !!room._originAgent;
  const isGroup = (room.member_count ?? 0) > 2;

  if (isObserver) {
    if (isGroup) return "bots-group";
    if (room.peer_type === "human") return "bots-bot-human";
    return "bots-bot-bot";
  }

  if (isGroup) return "self-group";
  if (room.peer_type === "human") return "self-human";
  // Agent peer: distinguish my-owned bot vs a third-party bot.
  if (selfMyBotRoomIds.has(room.room_id)) return "self-my-bot";
  return "self-third-bot";
}

/** Apply a filter key against the unified room list. */
export function applyMessagesFilter(
  rooms: import("@/lib/types").DashboardRoom[],
  filter: MessagesFilterKey,
  selfMyBotRoomIds: Set<string>,
): import("@/lib/types").DashboardRoom[] {
  if (filter === "self-all") return rooms.filter((r) => !r._originAgent);
  if (filter === "bots-all") return rooms.filter((r) => !!r._originAgent);
  return rooms.filter((r) => classifyMessagesRoom(r, selfMyBotRoomIds) === filter);
}

/** Count per filter key for sidebar badges. */
export function countMessagesByFilter(
  rooms: import("@/lib/types").DashboardRoom[],
  selfMyBotRoomIds: Set<string>,
): Record<MessagesFilterKey, number> {
  const counts: Record<MessagesFilterKey, number> = {
    "self-all": 0,
    "self-my-bot": 0,
    "self-third-bot": 0,
    "self-human": 0,
    "self-group": 0,
    "bots-all": 0,
    "bots-bot-bot": 0,
    "bots-bot-human": 0,
    "bots-group": 0,
  };
  for (const room of rooms) {
    const key = classifyMessagesRoom(room, selfMyBotRoomIds);
    counts[key] += 1;
    if (key.startsWith("self-")) counts["self-all"] += 1;
    else counts["bots-all"] += 1;
  }
  return counts;
}
