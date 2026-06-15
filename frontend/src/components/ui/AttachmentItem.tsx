"use client";

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { Attachment } from "@/lib/types";
import { isPreviewableAttachment } from "@/lib/attachment-preview";
import ImagePreviewOverlay from "@/components/ui/ImagePreviewOverlay";

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

export function getPreviewableImageAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter((attachment) => isImageAttachment(attachment) && isPreviewableAttachment(attachment));
}

export function attachmentIdentity(attachment: Attachment): string {
  return `${attachment.url}\n${attachment.filename || ""}`;
}

export function attachmentGalleryIndex(attachments: Attachment[], attachment: Attachment): number {
  const identity = attachmentIdentity(attachment);
  const index = attachments.findIndex((item) => attachmentIdentity(item) === identity);
  if (index >= 0) return index;
  return attachments.findIndex((item) => item.url === attachment.url);
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

interface AttachmentItemProps {
  attachment: Attachment;
  previewAttachments?: Attachment[];
  onPreview?: (attachment: Attachment, previewAttachments?: Attachment[]) => void;
}

function AttachmentFileLink({
  attachment,
  attachmentUrl,
  onPreview,
}: {
  attachment: Attachment;
  attachmentUrl: string;
  onPreview?: (attachment: Attachment, previewAttachments?: Attachment[]) => void;
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

export default function AttachmentItem({ attachment, previewAttachments, onPreview }: AttachmentItemProps) {
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
                onPreview(attachment, previewAttachments);
              } else {
                setPreviewOpen(true);
              }
            }}
            className="group inline-flex min-h-24 min-w-24 max-w-full items-center justify-center overflow-hidden rounded-lg border border-glass-border bg-black/20 text-left"
            aria-label={`Preview ${title}`}
          >
            <img
              src={attachmentUrl}
              alt={title}
              className="block max-h-48 max-w-full cursor-zoom-in object-contain transition-opacity group-hover:opacity-80"
              loading="eager"
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
