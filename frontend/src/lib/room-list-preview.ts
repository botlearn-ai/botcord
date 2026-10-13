import type { DashboardMessage, DashboardRoom } from "./types";
import { getIsoTimestampValue } from "@/store/dashboard-shared";
import { isDashboardMessageRecalled, recalledMessageLabel } from "./message-recall";

interface OwnerPreview {
  createdAt: string;
  text: string;
  senderName?: string;
  attachments?: unknown[];
}

/** Sorting, date, text, and sender always come from the same newest source. */
export function resolveRoomListPreview(
  room: DashboardRoom,
  cached: DashboardMessage | null,
  owner: OwnerPreview | null,
  locale: "zh" | "en",
) {
  const candidates = [{
    at: room.last_message_at ?? null,
    text: room.last_message_preview === "Message recalled"
      ? recalledMessageLabel(locale) : room.last_message_preview ?? "",
    sender: room.last_sender_name ?? "",
  }];
  if (cached) candidates.push({
    at: cached.created_at,
    text: isDashboardMessageRecalled(cached) ? recalledMessageLabel(locale) : cached.text,
    sender: cached.sender_name ?? "",
  });
  if (owner) candidates.push({
    at: owner.createdAt,
    text: owner.text || (owner.attachments?.length ? "[Attachment]" : ""),
    sender: owner.senderName ?? "",
  });
  const latest = candidates.reduce((best, next) =>
    getIsoTimestampValue(next.at) > getIsoTimestampValue(best.at) ? next : best,
  );
  return { ...latest, timestamp: getIsoTimestampValue(latest.at) };
}
