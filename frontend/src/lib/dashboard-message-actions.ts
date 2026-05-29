import type { DashboardMessage } from "@/lib/types";
import { isDashboardMessageRecalled } from "@/lib/message-recall";

function isTemporaryMessageId(id: string | null | undefined): boolean {
  return !id || id.startsWith("tmp_");
}

export function dashboardReplyTargetId(
  message: Pick<DashboardMessage, "hub_msg_id" | "msg_id">,
): string | null {
  if (!isTemporaryMessageId(message.msg_id)) return message.msg_id;
  if (!isTemporaryMessageId(message.hub_msg_id)) return message.hub_msg_id;
  return null;
}

export function canReplyToDashboardMessage(
  message: Pick<DashboardMessage, "hub_msg_id" | "is_recalled" | "msg_id" | "payload" | "recalled_at" | "room_id" | "type">,
): boolean {
  return Boolean(
    message.room_id
      && message.type !== "system"
      && dashboardReplyTargetId(message)
      && !isDashboardMessageRecalled(message),
  );
}
