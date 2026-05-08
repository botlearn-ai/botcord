/**
 * [INPUT]: public Hub share endpoint and app URL environment
 * [OUTPUT]: server-side helpers for share-link social metadata and OG image rendering
 * [POS]: shared metadata layer for /share/[shareId], isolated from browser auth API helpers
 */

import type { SharedRoomResponse } from "@/lib/types";

const DEFAULT_APP_URL = "https://www.botcord.chat";
const DEFAULT_HUB_URL = "https://api.botcord.chat";

export type ShareMetadataData = {
  shareId: string;
  roomName: string;
  roomDescription: string;
  sharedBy: string;
  sharedAt: string;
  messageCount: number;
  memberCount: number;
  entryType: SharedRoomResponse["entry_type"];
};

export function getAppBaseUrl(): string {
  return normalizeAbsoluteUrl(process.env.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL);
}

export async function getShareMetadataData(shareId: string): Promise<ShareMetadataData | null> {
  if (!shareId) return null;

  const hubBaseUrl = normalizeAbsoluteUrl(process.env.NEXT_PUBLIC_HUB_BASE_URL || DEFAULT_HUB_URL);
  const url = `${hubBaseUrl}/api/share/${encodeURIComponent(shareId)}`;

  try {
    const res = await fetch(url, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as SharedRoomResponse;
    return {
      shareId: data.share_id,
      roomName: data.room.name || "BotCord shared room",
      roomDescription: data.room.description || "",
      sharedBy: data.shared_by || "BotCord",
      sharedAt: data.shared_at,
      messageCount: data.messages.length,
      memberCount: data.room.member_count,
      entryType: data.entry_type,
    };
  } catch {
    return null;
  }
}

export function buildShareTitle(data: ShareMetadataData | null): string {
  if (!data) return "BotCord shared room";
  return `${data.roomName} | BotCord shared room`;
}

export function buildShareDescription(data: ShareMetadataData | null): string {
  if (!data) return "Open this BotCord room snapshot and continue in the chat app.";

  const roomDescription = normalizeWhitespace(data.roomDescription);
  if (roomDescription) return truncate(roomDescription, 150);

  const messageLabel = data.messageCount === 1 ? "message" : "messages";
  const memberLabel = data.memberCount === 1 ? "member" : "members";
  return `A read-only BotCord room snapshot shared by ${data.sharedBy}, with ${data.messageCount} ${messageLabel} and ${data.memberCount} ${memberLabel}.`;
}

export function truncate(value: string, maxLength: number): string {
  const text = normalizeWhitespace(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}...`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeAbsoluteUrl(value: string): string {
  const trimmed = value.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return stripTrailingSlash(withProtocol);
}
