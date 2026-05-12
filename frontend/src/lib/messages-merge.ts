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

import type { DashboardRoom, HumanAgentRoomSummary } from "@/lib/types";

interface MergeOpts {
  ownRooms: DashboardRoom[];
  ownedAgentRooms: HumanAgentRoomSummary[];
}

function originFor(room: HumanAgentRoomSummary): { agent_id: string; display_name: string } | null {
  const bot = room.bots[0];
  return bot ? { agent_id: bot.agent_id, display_name: bot.display_name } : null;
}

function ownedAgentRoomToDashboardRoom(room: HumanAgentRoomSummary): DashboardRoom {
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
    peer_type: "agent",
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

  return tagged.sort((a, b) => {
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return tb - ta;
  });
}

/** Look up the origin agent for a single roomId without rebuilding the full list. */
export function findOriginAgentForRoom(
  roomId: string,
  ownedAgentRooms: HumanAgentRoomSummary[],
): { agent_id: string; display_name: string } | null {
  const room = ownedAgentRooms.find((item) => item.room_id === roomId);
  return room ? originFor(room) : null;
}
