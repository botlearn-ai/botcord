"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, FileText, X } from "lucide-react";
import type { Attachment } from "@/lib/types";
import { isPreviewableAttachment } from "@/lib/attachment-preview";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

const failedAttachmentImageUrls = new Set<string>();

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

function attachmentImageFailureKey(url: string): string {
  return url.trim();
}

export function rememberFailedAttachmentImageUrl(url: string): void {
  const key = attachmentImageFailureKey(url);
  if (key) {
    failedAttachmentImageUrls.add(key);
  }
}

export function hasFailedAttachmentImageUrl(url: string): boolean {
  const key = attachmentImageFailureKey(url);
  return key ? failedAttachmentImageUrls.has(key) : false;
}

function ImagePreviewOverlay({
  src,
  title,
  onClose,
  onImageError,
}: {
  src: string;
  title: string;
  onClose: () => void;
  onImageError: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[9999] flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-glass-border bg-deep-black/85 px-3 py-2 sm:px-5">
        <span className="min-w-0 truncate text-sm font-medium text-text-primary">{title}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
            aria-label="Open original image"
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
            aria-label="Close image preview"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-6">
        <img
          src={src}
          alt={title}
          className="max-h-[calc(100vh-6.5rem)] max-w-full object-contain shadow-2xl"
          onError={onImageError}
        />
      </div>
    </div>,
    document.body,
  );
}

interface AttachmentItemProps {
  attachment: Attachment;
  onPreview?: (attachment: Attachment) => void;
}

function AttachmentFileLink({
  attachment,
  attachmentUrl,
  onPreview,
}: {
  attachment: Attachment;
  attachmentUrl: string;
  onPreview?: (attachment: Attachment) => void;
}) {
  const canPreview = Boolean(onPreview && isPreviewableAttachment(attachment));
  const content = (
    <>
      <FileText className="h-4 w-4 shrink-0 text-text-secondary" />
      <span className="truncate">{attachment.filename || "Attachment"}</span>
      {attachment.size_bytes != null && (
        <span className="shrink-0 text-text-secondary/50">{formatFileSize(attachment.size_bytes)}</span>
      )}
    </>
  );

  if (canPreview) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onPreview?.(attachment);
        }}
        className="flex max-w-full items-center gap-2 rounded-lg border border-glass-border bg-glass-bg/50 px-2.5 py-1.5 text-left text-xs text-text-primary hover:border-neon-cyan/30 transition-colors"
      >
        {content}
      </button>
    );
  }

  return (
    <a
      href={attachmentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg border border-glass-border bg-glass-bg/50 px-2.5 py-1.5 text-xs text-text-primary hover:border-neon-cyan/30 transition-colors"
    >
      {content}
    </a>
  );
}

export default function AttachmentItem({ attachment, onPreview }: AttachmentItemProps) {
  const attachmentUrl = resolveAttachmentUrl(attachment.url);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(() => hasFailedAttachmentImageUrl(attachmentUrl));
  const imageAttachment = isImageAttachment(attachment);

  useEffect(() => {
    setPreviewOpen(false);
    setImageFailed(hasFailedAttachmentImageUrl(attachmentUrl));
  }, [attachmentUrl]);

  const handleImageError = () => {
    rememberFailedAttachmentImageUrl(attachmentUrl);
    setPreviewOpen(false);
    setImageFailed(true);
  };

  if (imageAttachment && !imageFailed) {
    const title = attachment.filename || "Image attachment";

    return (
      <>
        <div className="max-w-full">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (onPreview) {
                onPreview(attachment);
              } else {
                setPreviewOpen(true);
              }
            }}
            className="group block max-w-full text-left"
            aria-label={`Preview ${title}`}
          >
            <img
              src={attachmentUrl}
              alt={title}
              className="max-h-48 max-w-full cursor-zoom-in rounded-lg border border-glass-border object-contain transition-opacity group-hover:opacity-80"
              loading="lazy"
              decoding="async"
              onError={handleImageError}
            />
          </button>
          {attachment.filename && (
            <span className="mt-0.5 block text-[10px] text-text-secondary/60">{attachment.filename}</span>
          )}
        </div>
        {!onPreview && previewOpen && (
          <ImagePreviewOverlay
            src={attachmentUrl}
            title={title}
            onClose={() => setPreviewOpen(false)}
            onImageError={handleImageError}
          />
        )}
      </>
    );
  }

  return (
    <AttachmentFileLink
      attachment={attachment}
      attachmentUrl={attachmentUrl}
      onPreview={imageAttachment ? undefined : onPreview}
    />
  );
}
