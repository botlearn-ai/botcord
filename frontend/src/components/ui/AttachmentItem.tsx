"use client";

import type { Attachment } from "@/lib/types";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageType(contentType?: string): boolean {
  return !!contentType && contentType.startsWith("image/");
}

export default function AttachmentItem({ attachment }: { attachment: Attachment }) {
  if (isImageType(attachment.content_type)) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <img
          src={attachment.url}
          alt={attachment.filename}
          className="max-h-48 max-w-full rounded-lg border border-glass-border object-cover hover:opacity-80 transition-opacity"
        />
        <span className="mt-0.5 block text-[10px] text-text-secondary/60">{attachment.filename}</span>
      </a>
    );
  }

  return (
    <a
      href={attachment.url}
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
      <span className="truncate">{attachment.filename}</span>
      {attachment.size_bytes != null && (
        <span className="shrink-0 text-text-secondary/50">{formatFileSize(attachment.size_bytes)}</span>
      )}
    </a>
  );
}
