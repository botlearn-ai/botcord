import type { DashboardMessage, DashboardRoom } from "@/lib/types";

const MESSAGE_RECALL_WINDOW_MS = 2 * 60 * 1000;

export function isDashboardMessageRecalled(message: Pick<DashboardMessage, "is_recalled" | "recalled_at" | "payload">): boolean {
  return Boolean(
    message.is_recalled
      || message.recalled_at
      || message.payload?.recalled
      || message.payload?.is_recalled,
  );
}

export function recalledMessageLabel(locale: string): string {
  return locale === "zh" ? "消息已撤回" : "Message recalled";
}

export function hasDashboardRecallAdminCapability(
  room: Pick<DashboardRoom, "my_role" | "owner_id" | "owner_type"> | null | undefined,
  ownedAgentIds: readonly string[],
  humanId?: string | null,
): boolean {
  if (!room) return false;
  if (room.my_role === "owner" || room.my_role === "admin") return true;
  if (room.owner_type === "human" && humanId && room.owner_id === humanId) return true;
  if (room.owner_type === "agent" && ownedAgentIds.includes(room.owner_id)) return true;
  return false;
}

export function canRecallDashboardMessage({
  message,
  room,
  isOwn,
  ownedAgentIds,
  humanId,
  userId,
  nowMs = Date.now(),
}: {
  message: DashboardMessage;
  room: Pick<DashboardRoom, "my_role" | "owner_id" | "owner_type"> | null | undefined;
  isOwn: boolean;
  ownedAgentIds: readonly string[];
  humanId?: string | null;
  userId?: string | null;
  nowMs?: number;
}): boolean {
  if (
    message.type !== "message"
    || !message.room_id
    || !message.msg_id
    || message.room_id.startsWith("rm_oc_")
    || message.hub_msg_id?.startsWith("tmp_")
    || message.msg_id.startsWith("tmp_")
    || isDashboardMessageRecalled(message)
  ) {
    return false;
  }

  if (hasDashboardRecallAdminCapability(room, ownedAgentIds, humanId)) return true;
  const isViewerAuthored =
    isOwn
    || Boolean(humanId && message.sender_id === humanId)
    || Boolean(userId && message.source_user_id === userId);
  if (!isViewerAuthored) return false;

  const createdMs = Date.parse(message.created_at);
  if (Number.isNaN(createdMs)) return true;
  return nowMs - createdMs <= MESSAGE_RECALL_WINDOW_MS;
}
