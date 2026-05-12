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
