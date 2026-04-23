/**
 * [INPUT]: 依赖 dashboard 类型定义、@/lib/api 的 active-agent 工具与浏览器时间解析
 * [OUTPUT]: 对外提供 dashboard chat/unread/realtime store 共用的房间摘要与时间比较工具
 * [POS]: frontend store 层的共享基础模块，负责消除多 store 拆分后的重复逻辑
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import type {
  DashboardMessage,
  DashboardOverview,
  DashboardRoom,
  HumanRoomSummary,
  PublicRoom,
} from "@/lib/types";
import { getActiveAgentId } from "@/lib/api";

export const roomMessagesInFlight = new Set<string>();
export const roomPollInFlight = new Set<string>();

export function toRoomSummary(room: PublicRoom): DashboardRoom {
  return {
    room_id: room.room_id,
    name: room.name,
    description: room.description,
    owner_id: room.owner_id,
    visibility: room.visibility,
    join_policy: room.join_policy,
    member_count: room.member_count,
    my_role: "viewer",
    rule: room.rule ?? null,
    required_subscription_product_id: room.required_subscription_product_id,
    last_viewed_at: null,
    has_unread: false,
    last_message_preview: room.last_message_preview,
    last_message_at: room.last_message_at,
    last_sender_name: room.last_sender_name,
  };
}

export function hasReadyActiveAgent(token: string | null, activeAgentId?: string | null): activeAgentId is string {
  return Boolean(token && (activeAgentId || getActiveAgentId()));
}

export function getIsoTimestampValue(isoTime: string | null | undefined): number {
  if (!isoTime) return 0;
  const value = Date.parse(isoTime);
  return Number.isNaN(value) ? 0 : value;
}

/** Owner-chat rooms (rm_oc_*) are shown via the dedicated UserChatPane entry, not the room list. */
function isOwnerChatRoom(roomId: string): boolean {
  return roomId.startsWith("rm_oc_");
}

export function humanRoomToDashboardRoom(r: HumanRoomSummary): DashboardRoom {
  return {
    room_id: r.room_id,
    name: r.name,
    description: r.description,
    owner_id: r.owner_id,
    visibility: r.visibility,
    join_policy: r.join_policy,
    member_count: 0,
    my_role: r.my_role,
    rule: null,
    required_subscription_product_id: null,
    last_viewed_at: null,
    has_unread: false,
    last_message_preview: null,
    last_message_at: null,
    last_sender_name: null,
  };
}

export function buildVisibleMessageRooms(state: {
  overview: DashboardOverview | null;
  recentVisitedRooms: PublicRoom[];
  token: string | null;
  humanRooms?: HumanRoomSummary[];
}): DashboardRoom[] {
  const joinedRooms = (state.overview?.rooms || []).filter((room) => !isOwnerChatRoom(room.room_id));
  const joinedRoomIds = new Set(joinedRooms.map((room) => room.room_id));
  const recentUnjoinedRooms = state.recentVisitedRooms
    .filter((room) => !joinedRoomIds.has(room.room_id) && !isOwnerChatRoom(room.room_id))
    .map(toRoomSummary);
  const allKnownRoomIds = new Set([...joinedRoomIds, ...recentUnjoinedRooms.map((r) => r.room_id)]);
  const humanOnlyRooms = (state.humanRooms || [])
    .filter((r) => !allKnownRoomIds.has(r.room_id) && !isOwnerChatRoom(r.room_id))
    .map(humanRoomToDashboardRoom);
  const mergedRooms = [...joinedRooms, ...recentUnjoinedRooms, ...humanOnlyRooms].sort((a, b) => {
    const aTs = a.last_message_at ? Date.parse(a.last_message_at) : 0;
    const bTs = b.last_message_at ? Date.parse(b.last_message_at) : 0;
    return bTs - aTs;
  });
  return state.token ? mergedRooms : state.recentVisitedRooms.map(toRoomSummary);
}

export function getLatestSeenAtForRoom(
  roomId: string,
  data: {
    messages: Record<string, DashboardMessage[]>;
    overview: DashboardOverview | null;
    publicRoomDetails: Record<string, PublicRoom>;
    publicRooms: PublicRoom[];
    recentVisitedRooms: PublicRoom[];
  },
): string | null {
  const latestMessage = data.messages[roomId]?.[data.messages[roomId].length - 1];
  if (latestMessage?.created_at) return latestMessage.created_at;

  const joinedRoom = data.overview?.rooms.find((room) => room.room_id === roomId);
  if (joinedRoom?.last_message_at) return joinedRoom.last_message_at;

  const publicRoom = data.publicRoomDetails[roomId] || data.publicRooms.find((room) => room.room_id === roomId);
  if (publicRoom?.last_message_at) return publicRoom.last_message_at;

  const recentRoom = data.recentVisitedRooms.find((room) => room.room_id === roomId);
  return recentRoom?.last_message_at ?? null;
}
