"use client";

/**
 * Rich tool result renderer with content-type detection (JSON / Markdown / Plain text),
 * copy-to-clipboard, and full-screen overlay for large payloads.
 */

import DialogSurface from "@/components/ui/DialogSurface";
import Badge from "@/components/ui/Badge";
import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy, Check, Maximize2, X } from "lucide-react";
import MarkdownContent from "@/components/ui/MarkdownContent";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

type ContentType = "json" | "markdown" | "plain";

function detectContentType(text: string): ContentType {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      /* not valid JSON */
    }
  }
  // Heuristic: check for common markdown patterns
  if (
    /^#{1,6}\s/m.test(text) ||
    /\*\*[^*]+\*\*/m.test(text) ||
    /```[\s\S]*?```/m.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /\[.+?\]\(.+?\)/m.test(text) ||
    /^>\s/m.test(text)
  ) {
    return "markdown";
  }
  return "plain";
}

// ---------------------------------------------------------------------------
// JSON pretty-printer with basic syntax coloring (no extra deps)
// ---------------------------------------------------------------------------

function JsonHighlight({ text }: { text: string }) {
  const parts = useMemo(() => {
    const lines = text.split("\n");
    return lines.map((line) => {
      // Key-value pair: "key": value
      const keyMatch = line.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)/);
      if (keyMatch) {
        const [, indent, key, colon, value] = keyMatch;
        return (
          <>
            <span>{indent}</span>
            <span className="text-accent-text">{key}</span>
            <span className="text-text-secondary">{colon}</span>
            <span className={getValueClass(value)}>{value}</span>
          </>
        );
      }
      // Standalone value (array element, etc)
      const valMatch = line.match(/^(\s*)(.*)/);
      if (valMatch) {
        const [, indent, value] = valMatch;
        return (
          <>
            <span>{indent}</span>
            <span className={getValueClass(value)}>{value}</span>
          </>
        );
      }
      return <span>{line}</span>;
    });
  }, [text]);

  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
      {parts.map((el, i) => (
        <div key={i}>{el}</div>
      ))}
    </pre>
  );
}

function getValueClass(value: string): string {
  const v = value.trim().replace(/,\s*$/, "");
  if (v.startsWith('"')) return "text-success";
  if (v === "true" || v === "false") return "text-warning";
  if (v === "null") return "italic text-text-secondary";
  if (/^-?\d/.test(v)) return "text-purple-400";
  return "text-text-secondary"; // punctuation: {, }, [, ]
}

// ---------------------------------------------------------------------------
// Copy button
// ---------------------------------------------------------------------------

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  }, [text]);

  return (
    <IconButton size="sm" label="复制"
      onClick={handleCopy}

      title="复制"
    >
      {copied ? (
        <Check className="w-3 h-3 text-success" />
      ) : (
        <Copy className="h-3 w-3 text-text-secondary" />
      )}
    </IconButton>
  );
}

// ---------------------------------------------------------------------------
// Full-screen overlay
// ---------------------------------------------------------------------------

function FullScreenOverlay({
  title,
  rawText,
  contentType,
  onClose,
}: {
  title: string;
  rawText: string;
  contentType: ContentType;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

  const closeWithMotion = useCallback(() => {
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      direction: "bottom",
      onComplete: onClose,
    });
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, {
      direction: "bottom",
      onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; },
    });
    return () => cleanupAnime(animationRef.current);
  }, [closeWithMotion]);

  return createPortal(
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} title={title} onClose={closeWithMotion} size="full" className="h-[90dvh]" overlayClassName="z-[9999]">
        {/* Header */}
        <div className="liquid-toolbar flex items-center justify-between border-b border-glass-border px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-mono text-success">{title}</span>
            <Badge tone="neutral" className="">
              {contentType.toUpperCase()}
            </Badge>
            <span className="text-xs text-text-secondary">
              {rawText.length.toLocaleString()} 字符
            </span>
          </div>
          <div className="flex items-center gap-2">
            <CopyButton text={rawText} />
            <IconButton label="关闭预览 / Close preview" size="sm"
              onClick={closeWithMotion}

            >
              <X className="h-4 w-4 text-text-secondary" />
            </IconButton>
          </div>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-4xl mx-auto">
            <ResultRenderer text={rawText} contentType={contentType} fullMode />
          </div>
        </div>
    </DialogSurface>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Content renderer by type
// ---------------------------------------------------------------------------

function ResultRenderer({
  text,
  contentType,
  fullMode = false,
}: {
  text: string;
  contentType: ContentType;
  fullMode?: boolean;
}) {
  const formattedJson = useMemo(() => {
    if (contentType !== "json") return text;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }, [text, contentType]);

  if (contentType === "json") {
    return (
      <div className="liquid-tool-surface overflow-x-auto rounded-md px-3 py-2">
        <JsonHighlight text={formattedJson} />
      </div>
    );
  }

  if (contentType === "markdown") {
    return (
      <div className={`${fullMode ? "text-sm" : "text-xs"} text-text-primary`}>
        <MarkdownContent content={text} />
      </div>
    );
  }

  // Plain text
  return (
    <pre className="liquid-tool-surface overflow-x-auto rounded-md px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-text-primary">
      {text}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------

/** Max characters before truncation in inline view. */
const MAX_INLINE_CHARS = 50_000;

export interface ToolResultContentProps {
  /** Raw result string */
  result: string;
  /** Tool name (for fullscreen title) */
  toolName?: string;
  /** Disable Claude content-array unwrapping when rendering tool inputs. */
  unwrapContentArray?: boolean;
}

export default function ToolResultContent({
  result,
  toolName = "tool",
  unwrapContentArray = true,
}: ToolResultContentProps) {
  const [fullScreen, setFullScreen] = useState(false);

  // Unwrap Claude-style content array if present
  const rawText = useMemo(() => {
    const trimmed = result.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        // Claude API content format: { content: [{ type: "text", text: "..." }] }
        if (unwrapContentArray && parsed?.content?.[0]?.text && typeof parsed.content[0].text === "string") {
          return parsed.content[0].text as string;
        }
      } catch {
        /* not valid JSON */
      }
    }
    return result;
  }, [result, unwrapContentArray]);

  const contentType = useMemo(() => detectContentType(rawText), [rawText]);
  const truncated = rawText.length > MAX_INLINE_CHARS;
  const displayText = truncated
    ? rawText.slice(0, MAX_INLINE_CHARS)
    : rawText;

  return (
    <div className="liquid-tool-surface mt-1 ml-5 rounded-lg p-1.5">
      {/* Toolbar */}
      <div className="flex items-center gap-1 mb-1">
        <Badge tone="neutral" className="">
          {contentType === "json" ? "JSON" : contentType === "markdown" ? "Markdown" : "Text"}
        </Badge>
        <CopyButton text={rawText} />
        {(truncated || rawText.length > 500) && (
          <IconButton size="sm" label="全屏查看"
            onClick={() => setFullScreen(true)}

            title="全屏查看"
          >
            <Maximize2 className="h-3 w-3 text-text-secondary" />
          </IconButton>
        )}
      </div>

      {/* Inline content */}
      <div className="max-h-[400px] overflow-y-auto rounded-md">
        <ResultRenderer text={displayText} contentType={contentType} />
      </div>

      {truncated && (
        <Button variant="inline"
          onClick={() => setFullScreen(true)}
          className="mt-1"
        >
          内容过长，点击查看全文（{rawText.length.toLocaleString()} 字符）
        </Button>
      )}

      {/* Full-screen overlay */}
      {fullScreen && (
        <FullScreenOverlay
          title={toolName}
          rawText={rawText}
          contentType={contentType}
          onClose={() => setFullScreen(false)}
        />
      )}
    </div>
  );
}
