"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Loader2, X } from "lucide-react";
import type { Attachment } from "@/lib/types";
import {
  DOCUMENT_PREVIEW_MAX_BYTES,
  getAttachmentPreviewFetchUrl,
  getAttachmentPreviewKind,
} from "@/lib/attachment-preview";
import MarkdownContent from "@/components/ui/MarkdownContent";
import { resolveAttachmentUrl } from "@/components/ui/AttachmentItem";

interface DocumentPreviewPaneProps {
  attachment: Attachment;
  onClose: () => void;
}

function formatPreviewSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeJsonPreview(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function DocumentPreviewPane({ attachment, onClose }: DocumentPreviewPaneProps) {
  const kind = getAttachmentPreviewKind(attachment);
  const title = attachment.filename || "Attachment";
  const sourceUrl = resolveAttachmentUrl(attachment.url);
  const fetchUrl = useMemo(() => getAttachmentPreviewFetchUrl(attachment), [attachment]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLarge = kind !== "image" && attachment.size_bytes != null && attachment.size_bytes > DOCUMENT_PREVIEW_MAX_BYTES;

  useEffect(() => {
    if (!kind || tooLarge || kind === "image") {
      setContent("");
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setContent("");
    setError(null);
    setLoading(true);

    fetch(fetchUrl, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Preview failed (${res.status})`);
        }
        const length = Number(res.headers.get("Content-Length") || "0");
        if (length > DOCUMENT_PREVIEW_MAX_BYTES) {
          throw new Error(`Preview is larger than ${formatPreviewSize(DOCUMENT_PREVIEW_MAX_BYTES)}`);
        }
        return res.text();
      })
      .then((text) => {
        if (!controller.signal.aborted) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Preview failed");
        setLoading(false);
      });

    return () => controller.abort();
  }, [fetchUrl, kind, tooLarge]);

  const renderedBody = (() => {
    if (!kind) {
      return (
        <PreviewStateMessage
          title="Preview unavailable"
          detail="This attachment type cannot be shown inline."
        />
      );
    }
    if (tooLarge) {
      return (
        <PreviewStateMessage
          title="Preview too large"
          detail={`This file is larger than ${formatPreviewSize(DOCUMENT_PREVIEW_MAX_BYTES)}.`}
        />
      );
    }
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center text-text-secondary">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      );
    }
    if (error) {
      return <PreviewStateMessage title="Preview failed" detail={error} />;
    }
    if (kind === "image") {
      return (
        <div className="flex min-h-full items-center justify-center p-3 sm:p-6">
          <img
            src={sourceUrl}
            alt={title}
            className="max-h-full max-w-full object-contain shadow-2xl"
            loading="lazy"
            decoding="async"
          />
        </div>
      );
    }
    if (kind === "markdown") {
      return (
        <div className="min-h-full px-4 py-3">
          <MarkdownContent content={content} />
        </div>
      );
    }
    if (kind === "html") {
      return (
        <iframe
          title={title}
          sandbox="allow-popups"
          srcDoc={content}
          className="h-full w-full border-0 bg-white"
        />
      );
    }

    const displayContent = kind === "json" ? normalizeJsonPreview(content) : content;
    return (
      <pre className="min-h-full whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-5 text-text-primary">
        {displayContent}
      </pre>
    );
  })();

  return (
    <aside className="flex h-full w-[min(42vw,560px)] min-w-[360px] shrink-0 flex-col border-l border-glass-border bg-deep-black shadow-2xl shadow-black/40 max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full max-md:min-w-0">
      <div className="flex min-h-14 items-center gap-2 border-b border-glass-border px-3">
        <FileText className="h-4 w-4 shrink-0 text-neon-cyan" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">{title}</div>
          <div className="truncate text-[11px] text-text-secondary/70">
            {attachment.size_bytes != null ? formatPreviewSize(attachment.size_bytes) : "Document preview"}
          </div>
        </div>
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={title}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
          aria-label="Download attachment"
          title="Download"
        >
          <Download className="h-4 w-4" />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
          aria-label="Close preview"
          title="Close preview"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-zinc-950/30">
        {renderedBody}
      </div>
    </aside>
  );
}

function PreviewStateMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-xs">
        <div className="text-sm font-medium text-text-primary">{title}</div>
        <div className="mt-1 text-xs leading-5 text-text-secondary">{detail}</div>
      </div>
    </div>
  );
}
