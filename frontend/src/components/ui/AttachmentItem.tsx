"use client";

import type { Attachment } from "@/lib/types";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function resolveAttachmentUrl(url: string): string {
  if (!url.startsWith("/")) return url;

  try {
    return new URL(url, HUB_BASE_URL).toString();
  } catch {
    return url;
  }
}

export function isImageAttachment(attachment: Attachment): boolean {
  if (attachment.content_type?.startsWith("image/")) return true;

  const name = attachment.filename || attachment.url.split("?")[0] || "";
  return /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name);
}

export default function AttachmentItem({ attachment }: { attachment: Attachment }) {
  const attachmentUrl = resolveAttachmentUrl(attachment.url);

  if (isImageAttachment(attachment)) {
    return (
      <a
        href={attachmentUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <img
          src={attachmentUrl}
          alt={attachment.filename || "Image attachment"}
          className="max-h-48 max-w-full rounded-lg border border-glass-border object-cover hover:opacity-80 transition-opacity"
        />
        {attachment.filename && (
          <span className="mt-0.5 block text-[10px] text-text-secondary/60">{attachment.filename}</span>
        )}
      </a>
    );
  }

  return (
    <a
      href={attachmentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg border border-glass-border bg-glass-bg/50 px-2.5 py-1.5 text-xs text-text-primary hover:border-neon-cyan/30 transition-colors"
    >
      <svg
        className="h-4 w-4 shrink-0 text-text-secondary"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
        />
      </svg>
      <span className="truncate">{attachment.filename || "Attachment"}</span>
      {attachment.size_bytes != null && (
        <span className="shrink-0 text-text-secondary/50">{formatFileSize(attachment.size_bytes)}</span>
      )}
    </a>
  );
}
