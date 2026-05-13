/**
 * Owner-unified Messages list.
 *
 * The Messages tab shows the human owner's full activity surface — their own
 * conversations interleaved with all conversations of bots they own. Each
 * bot-originated room is tagged with `_originAgent` so:
 *   - the row can render a "via <bot>" hint
 *   - the chat pane can render a read-only banner when opened
 *
 * Origin determination comes from `/api/humans/me/agent-rooms`. Rooms not in
 * that source are treated as the human owner's own.
 */

import type { DashboardRoom, HumanAgentRoomSummary, ParticipantType } from "@/lib/types";
import { parseDmRoomId } from "@/components/dashboard/dmRoom";
import { compareRoomsByActivityDesc, isOwnerChatRoom } from "@/store/dashboard-shared";

interface MergeOpts {
  ownRooms: DashboardRoom[];
  ownedAgentRooms: HumanAgentRoomSummary[];
}

function originFor(room: HumanAgentRoomSummary): { agent_id: string; display_name: string } | null {
  const bot = room.bots[0];
  return bot ? { agent_id: bot.agent_id, display_name: bot.display_name } : null;
}

function inferPeerTypeForOwnedAgentRoom(room: HumanAgentRoomSummary): ParticipantType | undefined {
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
    members_preview: room.members_preview ?? undefined,
    peer_type: isOwnerChatRoom(room.room_id) ? "agent" : inferPeerTypeForOwnedAgentRoom(room),
    _originAgent: origin ?? undefined,
  };
}

export function mergeOwnerVisibleRooms({ ownedAgentRooms, ownRooms }: MergeOpts): DashboardRoom[] {
  const seen = new Set(ownRooms.map((room) => room.room_id));
  return [
    ...ownRooms,
    ...ownedAgentRooms
      .filter((room) => !seen.has(room.room_id))
      .map(ownedAgentRoomToDashboardRoom),
  ].sort(compareRoomsByActivityDesc);
}

/**
 * Messages filter taxonomy. Two parent buckets — "self" (I am the participant)
 * and "bots" (one of my owned bots is the participant; I observe). Each parent
 * has an `*-all` aggregate that's the default leaf inside it.
 *
 * Important: this is a pure **filter** over a single unified data set —
 * NOT a role-switch. The owner identity never changes; whether a conversation
 * is read-only is determined per-room (`_originAgent` presence), not by
 * which filter is active.
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

function isPrivateMessageRoom(room: Pick<DashboardRoom, "room_id">): boolean {
  return room.room_id.startsWith("rm_dm_") || isOwnerChatRoom(room.room_id);
}

function hasOwnedAgentParticipant(room: Pick<DashboardRoom, "owner_id" | "room_id">, ownedAgentIds: Set<string>): boolean {
  if (ownedAgentIds.has(room.owner_id)) return true;
  const parsed = parseDmRoomId(room.room_id);
  if (parsed && (ownedAgentIds.has(parsed.a) || ownedAgentIds.has(parsed.b))) return true;
  return [...ownedAgentIds].some((agentId) => room.room_id.includes(agentId));
}

function inferDmPeerType(
  room: Pick<DashboardRoom, "room_id" | "peer_type" | "_originAgent">,
): ParticipantType | undefined {
  if (room.peer_type) return room.peer_type;
  const parsed = parseDmRoomId(room.room_id);
  if (!parsed) return undefined;

  const aIsHuman = parsed.a.startsWith("hu_");
  const bIsHuman = parsed.b.startsWith("hu_");
  if (aIsHuman && bIsHuman) return "human";
  if (!aIsHuman && !bIsHuman) return "agent";

  // For observed bot rooms, peer_type means "who my bot is talking to".
  // Mixed ag/hu DMs are therefore bot-human conversations.
  if (room._originAgent) return "human";

  // For the human owner's own mixed DM, the peer is the agent endpoint.
  return "agent";
}

/**
 * Classify a single room into its most-specific filter bucket. Used both for
 * filtering the visible list and for computing sidebar counts.
 *
 * - `_originAgent` present → bot's conversation (observer mode for the owner)
 * - DM (`rm_dm_*`) → split by peer type
 *   - peer_type === "agent" + peer is an owned bot → self-my-bot
 *   - peer_type === "agent" + peer is NOT an owned bot → self-third-bot
 *   - peer_type === "human" → self-human
 * - Non-DM room → *-group
 */
export function classifyMessagesRoom(
  room: import("@/lib/types").DashboardRoom,
  ownedAgentIds: Set<string>,
): MessagesFilterKey {
  if (isOwnerChatRoom(room.room_id)) return "self-my-bot";

  const isObserver = !!room._originAgent;
  const isPrivateChat = isPrivateMessageRoom(room);
  const dmPeerType = isPrivateChat ? inferDmPeerType(room) : undefined;

  if (isObserver) {
    if (!isPrivateChat) return "bots-group";
    if (dmPeerType === "human") return "bots-bot-human";
    return "bots-bot-bot";
  }

  if (!isPrivateChat) return "self-group";
  if (dmPeerType === "human") return "self-human";
  // Agent peer: did I bring this bot into existence (my owned bot)?
  if (hasOwnedAgentParticipant(room, ownedAgentIds)) return "self-my-bot";
  return "self-third-bot";
}

/** Apply a filter key against the unified room list. */
export function applyMessagesFilter(
  rooms: import("@/lib/types").DashboardRoom[],
  filter: MessagesFilterKey,
  ownedAgentIds: Set<string>,
): import("@/lib/types").DashboardRoom[] {
  if (filter === "self-all") {
    return rooms.filter((r) => !r._originAgent || isOwnerChatRoom(r.room_id));
  }
  if (filter === "bots-all") {
    return rooms.filter((r) => !!r._originAgent && !isOwnerChatRoom(r.room_id));
  }
  return rooms.filter((r) => classifyMessagesRoom(r, ownedAgentIds) === filter);
}

/** Count per filter key for sidebar badges. */
export function countMessagesByFilter(
  rooms: import("@/lib/types").DashboardRoom[],
  ownedAgentIds: Set<string>,
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
    const key = classifyMessagesRoom(room, ownedAgentIds);
    counts[key] += 1;
    if (key.startsWith("self-")) counts["self-all"] += 1;
    else if (key.startsWith("bots-")) counts["bots-all"] += 1;
  }
  return counts;
}
