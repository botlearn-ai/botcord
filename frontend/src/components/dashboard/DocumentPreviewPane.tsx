"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
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

export const DOCUMENT_PREVIEW_MIN_WIDTH = 360;
export const DOCUMENT_PREVIEW_MAX_WIDTH = 960;
export const DOCUMENT_PREVIEW_DEFAULT_WIDTH = 560;

const DOCUMENT_PREVIEW_STORAGE_KEY = "botcord.documentPreviewPaneWidth";
const DOCUMENT_PREVIEW_MAIN_PANE_GUTTER = 360;

export function clampDocumentPreviewWidth(width: number, viewportWidth?: number): number {
  const safeWidth = Number.isFinite(width) ? width : DOCUMENT_PREVIEW_DEFAULT_WIDTH;
  const viewportMax = viewportWidth == null
    ? DOCUMENT_PREVIEW_MAX_WIDTH
    : Math.max(DOCUMENT_PREVIEW_MIN_WIDTH, viewportWidth - DOCUMENT_PREVIEW_MAIN_PANE_GUTTER);
  const maxWidth = Math.min(DOCUMENT_PREVIEW_MAX_WIDTH, viewportMax);

  return Math.min(maxWidth, Math.max(DOCUMENT_PREVIEW_MIN_WIDTH, Math.round(safeWidth)));
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
  const [paneWidth, setPaneWidth] = useState(DOCUMENT_PREVIEW_DEFAULT_WIDTH);
  const [paneWidthReady, setPaneWidthReady] = useState(false);
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef({
    x: 0,
    width: DOCUMENT_PREVIEW_DEFAULT_WIDTH,
  });
  const tooLarge = kind !== "image" && attachment.size_bytes != null && attachment.size_bytes > DOCUMENT_PREVIEW_MAX_BYTES;

  useEffect(() => {
    try {
      const savedWidthValue = window.localStorage.getItem(DOCUMENT_PREVIEW_STORAGE_KEY);
      if (savedWidthValue !== null) {
        const savedWidth = Number(savedWidthValue);
        if (Number.isFinite(savedWidth)) {
          setPaneWidth(clampDocumentPreviewWidth(savedWidth, window.innerWidth));
        }
      }
    } catch {
      // localStorage may be blocked; resizing still works for the current pane.
    } finally {
      setPaneWidthReady(true);
    }
  }, []);

  useEffect(() => {
    if (!paneWidthReady || resizing) return;

    try {
      window.localStorage.setItem(DOCUMENT_PREVIEW_STORAGE_KEY, String(paneWidth));
    } catch {
      // Non-fatal: the pane keeps the current in-memory width.
    }
  }, [paneWidth, paneWidthReady, resizing]);

  useEffect(() => {
    const handleWindowResize = () => {
      setPaneWidth((width) => clampDocumentPreviewWidth(width, window.innerWidth));
    };

    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  useEffect(() => {
    if (!resizing) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    const handlePointerMove = (event: PointerEvent) => {
      const delta = resizeStartRef.current.x - event.clientX;
      setPaneWidth(clampDocumentPreviewWidth(resizeStartRef.current.width + delta, window.innerWidth));
    };

    const stopResize = () => setResizing(false);

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", stopResize);
    document.addEventListener("pointercancel", stopResize);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", stopResize);
      document.removeEventListener("pointercancel", stopResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [resizing]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    event.preventDefault();
    resizeStartRef.current = {
      x: event.clientX,
      width: paneWidth,
    };
    setResizing(true);
  }, [paneWidth]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 80 : 24;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPaneWidth((width) => clampDocumentPreviewWidth(width + step, window.innerWidth));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setPaneWidth((width) => clampDocumentPreviewWidth(width - step, window.innerWidth));
    } else if (event.key === "Home") {
      event.preventDefault();
      setPaneWidth(clampDocumentPreviewWidth(DOCUMENT_PREVIEW_MIN_WIDTH, window.innerWidth));
    } else if (event.key === "End") {
      event.preventDefault();
      setPaneWidth(clampDocumentPreviewWidth(DOCUMENT_PREVIEW_MAX_WIDTH, window.innerWidth));
    }
  }, []);

  const paneStyle = {
    "--document-preview-pane-width": `${paneWidth}px`,
  } as CSSProperties;

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
    <aside
      style={paneStyle}
      className="relative flex h-full w-[var(--document-preview-pane-width)] max-w-[78vw] min-w-[360px] shrink-0 flex-col border-l border-glass-border bg-deep-black shadow-2xl shadow-black/40 max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full max-md:max-w-none max-md:min-w-0"
    >
      {resizing && (
        <div className="fixed inset-0 z-[80] cursor-col-resize max-md:hidden" aria-hidden="true" />
      )}
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize preview pane"
        aria-orientation="vertical"
        aria-valuemin={DOCUMENT_PREVIEW_MIN_WIDTH}
        aria-valuemax={DOCUMENT_PREVIEW_MAX_WIDTH}
        aria-valuenow={paneWidth}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        className={`absolute -left-1 top-0 z-[90] hidden h-full w-2 cursor-col-resize items-center justify-center outline-none transition-colors md:flex ${
          resizing ? "bg-neon-cyan/25" : "hover:bg-neon-cyan/20 focus-visible:bg-neon-cyan/25"
        }`}
      >
        <span className="h-12 w-px rounded-full bg-text-secondary/40" />
      </div>
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
      <div className={`min-h-0 flex-1 overflow-auto bg-zinc-950/30 ${resizing ? "pointer-events-none" : ""}`}>
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
