/**
 * [INPUT]: 依赖 dashboard 类型定义、@/lib/api 的 active-agent 工具与浏览器时间解析
 * [OUTPUT]: 对外提供 dashboard chat/unread/realtime store 共用的房间摘要、合并与时间比较工具
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
export const roomMessagesReloadPending = new Set<string>();
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

type RoomActivityLike = {
  last_message_at: string | null;
  created_at?: string | null;
};

export function getRoomActivityTimestamp(room: RoomActivityLike): number {
  return getIsoTimestampValue(room.last_message_at) || getIsoTimestampValue(room.created_at);
}

export function compareRoomsByActivityDesc<T extends RoomActivityLike>(a: T, b: T): number {
  return getRoomActivityTimestamp(b) - getRoomActivityTimestamp(a);
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
    owner_type: r.owner_type,
    visibility: r.visibility,
    join_policy: r.join_policy,
    member_count: r.member_count,
    my_role: r.my_role,
    rule: r.rule,
    required_subscription_product_id: r.required_subscription_product_id,
    default_send: r.default_send,
    default_invite: r.default_invite,
    max_members: r.max_members,
    slow_mode_seconds: r.slow_mode_seconds,
    last_viewed_at: null,
    has_unread: false,
    last_message_preview: r.last_message_preview ?? null,
    last_message_at: r.last_message_at ?? null,
    last_sender_name: r.last_sender_name ?? null,
    allow_human_send: r.allow_human_send,
    created_at: r.created_at,
    members_preview: r.members_preview ?? undefined,
  };
}

export function mergeDashboardRoomsWithHumanRooms(
  agentRooms: DashboardRoom[],
  humanRooms: HumanRoomSummary[],
): DashboardRoom[] {
  if (humanRooms.length === 0) {
    return [...agentRooms].sort(compareRoomsByActivityDesc);
  }

  const seen = new Set(agentRooms.map((room) => room.room_id));
  const humanOnlyRooms = humanRooms
    .filter((room) => !seen.has(room.room_id))
    .map(humanRoomToDashboardRoom);
  return [...agentRooms, ...humanOnlyRooms].sort(compareRoomsByActivityDesc);
}

export function isRoomOwnedByCurrentViewer(
  room: Pick<DashboardRoom, "owner_id" | "owner_type">,
  viewer: { activeAgentId?: string | null; humanId?: string | null },
): boolean {
  const ownerType = room.owner_type ?? "agent";
  if (ownerType === "human") {
    return Boolean(viewer.humanId && room.owner_id === viewer.humanId);
  }
  return Boolean(viewer.activeAgentId && room.owner_id === viewer.activeAgentId);
}

export function buildVisibleMessageRooms(state: {
  overview: DashboardOverview | null;
  recentVisitedRooms: PublicRoom[];
  token: string | null;
  humanRooms?: HumanRoomSummary[];
}): DashboardRoom[] {
  if (!state.token) {
    return [];
  }

  const joinedRooms = (state.overview?.rooms || []).filter((room) => !isOwnerChatRoom(room.room_id));
  const joinedRoomIds = new Set(joinedRooms.map((room) => room.room_id));
  const recentUnjoinedRooms = state.recentVisitedRooms
    .filter((room) => !joinedRoomIds.has(room.room_id) && !isOwnerChatRoom(room.room_id))
    .map(toRoomSummary);
  const humanRooms = (state.humanRooms || []).filter((room) => !isOwnerChatRoom(room.room_id));
  return mergeDashboardRoomsWithHumanRooms([...joinedRooms, ...recentUnjoinedRooms], humanRooms);
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
