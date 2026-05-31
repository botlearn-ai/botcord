import type { Attachment } from "@/lib/types";

export type AttachmentPreviewKind = "markdown" | "html" | "json" | "text";

export const DOCUMENT_PREVIEW_MAX_BYTES = 1024 * 1024;

const BOTCORD_FILE_PATH_RE = /^\/hub\/files\/(f_[a-zA-Z0-9_-]+)$/;

const TEXT_EXTENSION_RE = /\.(csv|env|ini|log|sql|toml|tsv|txt|xml|ya?ml)$/i;
const CODE_EXTENSION_RE = /\.(css|go|java|js|jsx|jsonl|kt|mjs|php|py|rb|rs|sh|tsx?|vue)$/i;

function lowerContentType(attachment: Attachment): string {
  return (attachment.content_type || "").split(";")[0]?.trim().toLowerCase() || "";
}

function lowerFilename(attachment: Attachment): string {
  return (attachment.filename || attachment.url.split("?")[0] || "").toLowerCase();
}

export function getAttachmentPreviewKind(attachment: Attachment): AttachmentPreviewKind | null {
  const contentType = lowerContentType(attachment);
  const name = lowerFilename(attachment);

  if (contentType === "text/markdown" || contentType === "text/x-markdown" || /\.mdx?$/i.test(name)) {
    return "markdown";
  }
  if (contentType === "text/html" || /\.html?$/i.test(name)) {
    return "html";
  }
  if (contentType === "application/json" || contentType.endsWith("+json") || /\.json$/i.test(name)) {
    return "json";
  }
  if (
    contentType.startsWith("text/") ||
    contentType === "application/xml" ||
    contentType.endsWith("+xml") ||
    TEXT_EXTENSION_RE.test(name) ||
    CODE_EXTENSION_RE.test(name)
  ) {
    return "text";
  }

  return null;
}

export function isPreviewableAttachment(attachment: Attachment): boolean {
  if (!getAttachmentPreviewKind(attachment)) return false;
  return attachment.size_bytes == null || attachment.size_bytes <= DOCUMENT_PREVIEW_MAX_BYTES;
}

export function getBotCordFileIdFromUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw, "https://botcord.local");
    return parsed.pathname.match(BOTCORD_FILE_PATH_RE)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function getAttachmentPreviewFetchUrl(attachment: Attachment): string {
  const fileId = getBotCordFileIdFromUrl(attachment.url);
  if (fileId) {
    return `/api/files/${encodeURIComponent(fileId)}`;
  }
  return attachment.url;
}
