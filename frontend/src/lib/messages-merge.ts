/**
 * Owner-unified Messages list.
 *
 * The Messages tab shows the human owner's full activity surface — their own
 * conversations interleaved with all conversations of bots they own. Each
 * bot-originated room is tagged with `_originAgent` so:
 *   - the row can render a "via <bot>" hint
 *   - the chat pane can render a read-only banner when opened
 *
 * Origin determination is data-driven: any room found under
 * `devBotRoomsByAgent[agentId]` is considered that agent's conversation.
 * Rooms not in any bot map are treated as the human owner's own.
 */

import type { DashboardRoom, UserAgent } from "@/lib/types";
import { devBotRoomsByAgent } from "@/lib/dev-bypass";

interface MergeOpts {
  ownedAgents: UserAgent[];
  ownRooms: DashboardRoom[];
}

export function mergeOwnerVisibleRooms({ ownedAgents, ownRooms }: MergeOpts): DashboardRoom[] {
  const tagged: DashboardRoom[] = [];

  // Owner's own rooms first (no _originAgent — owner is a participant).
  for (const room of ownRooms) tagged.push(room);

  // Each owned bot's rooms, tagged with the bot's identity for downstream UI.
  for (const agent of ownedAgents) {
    const botRooms = (devBotRoomsByAgent[agent.agent_id] as unknown as DashboardRoom[]) ?? [];
    const origin = { agent_id: agent.agent_id, display_name: agent.display_name };
    for (const room of botRooms) tagged.push({ ...room, _originAgent: origin });
  }

  // Sort by latest activity, most recent first.
  return tagged.sort((a, b) => {
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return tb - ta;
  });
}

/** Look up the origin agent for a single roomId without rebuilding the full list. */
export function findOriginAgentForRoom(
  roomId: string,
  ownedAgents: UserAgent[],
): { agent_id: string; display_name: string } | null {
  for (const agent of ownedAgents) {
    const rooms = devBotRoomsByAgent[agent.agent_id] ?? [];
    if (rooms.some((r) => r.room_id === roomId)) {
      return { agent_id: agent.agent_id, display_name: agent.display_name };
    }
  }
  return null;
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

/**
 * Classify a single room into its most-specific filter bucket. Used both for
 * filtering the visible list and for computing sidebar counts.
 *
 * - `_originAgent` present → bot's conversation (observer mode for the owner)
 * - DM (member_count ≤ 2) → split by peer type
 *   - peer_type === "agent" + peer is an owned bot → self-my-bot
 *   - peer_type === "agent" + peer is NOT an owned bot → self-third-bot
 *   - peer_type === "human" → self-human
 * - Group (member_count > 2) → *-group
 */
export function classifyMessagesRoom(
  room: import("@/lib/types").DashboardRoom,
  ownedAgentIds: Set<string>,
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
  // Agent peer: did I bring this bot into existence (my owned bot)?
  if (room.owner_id && ownedAgentIds.has(room.owner_id)) return "self-my-bot";
  return "self-third-bot";
}

/** Apply a filter key against the unified room list. */
export function applyMessagesFilter(
  rooms: import("@/lib/types").DashboardRoom[],
  filter: MessagesFilterKey,
  ownedAgentIds: Set<string>,
): import("@/lib/types").DashboardRoom[] {
  if (filter === "self-all") {
    return rooms.filter((r) => !r._originAgent);
  }
  if (filter === "bots-all") {
    return rooms.filter((r) => !!r._originAgent);
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
    else counts["bots-all"] += 1;
  }
  return counts;
}
