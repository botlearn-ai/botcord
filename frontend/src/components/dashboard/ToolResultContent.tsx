"use client";

/**
 * Rich tool result renderer with content-type detection (JSON / Markdown / Plain text),
 * copy-to-clipboard, and full-screen overlay for large payloads.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { Copy, Check, Maximize2, X } from "lucide-react";
import MarkdownContent from "@/components/ui/MarkdownContent";

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
            <span className="text-cyan-400">{key}</span>
            <span className="text-zinc-500">{colon}</span>
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
    <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words">
      {parts.map((el, i) => (
        <div key={i}>{el}</div>
      ))}
    </pre>
  );
}

function getValueClass(value: string): string {
  const v = value.trim().replace(/,\s*$/, "");
  if (v.startsWith('"')) return "text-emerald-400";
  if (v === "true" || v === "false") return "text-amber-400";
  if (v === "null") return "text-zinc-500 italic";
  if (/^-?\d/.test(v)) return "text-purple-400";
  return "text-zinc-400"; // punctuation: {, }, [, ]
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
    <button
      onClick={handleCopy}
      className={`p-1 rounded hover:bg-white/10 transition-colors ${className ?? ""}`}
      title="复制"
    >
      {copied ? (
        <Check className="w-3 h-3 text-emerald-400" />
      ) : (
        <Copy className="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
      )}
    </button>
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
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-glass-border bg-zinc-950/80">
        <div className="flex items-center gap-3">
          <span className="text-sm font-mono text-emerald-400">{title}</span>
          <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
            {contentType.toUpperCase()}
          </span>
          <span className="text-xs text-zinc-600">
            {rawText.length.toLocaleString()} 字符
          </span>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton text={rawText} />
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4 text-zinc-400 hover:text-zinc-200" />
          </button>
        </div>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          <ResultRenderer text={rawText} contentType={contentType} fullMode />
        </div>
      </div>
    </div>,
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
      <div className="bg-zinc-950/50 rounded-md px-3 py-2 overflow-x-auto">
        <JsonHighlight text={formattedJson} />
      </div>
    );
  }

  if (contentType === "markdown") {
    return (
      <div className={`${fullMode ? "text-sm" : "text-xs"} text-zinc-300`}>
        <MarkdownContent content={text} />
      </div>
    );
  }

  // Plain text
  return (
    <pre className="text-[11px] text-zinc-400 font-mono bg-zinc-950/50 rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words">
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
}

export default function ToolResultContent({
  result,
  toolName = "tool",
}: ToolResultContentProps) {
  const [fullScreen, setFullScreen] = useState(false);

  // Unwrap Claude-style content array if present
  const rawText = useMemo(() => {
    const trimmed = result.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        // Claude API content format: { content: [{ type: "text", text: "..." }] }
        if (parsed?.content?.[0]?.text && typeof parsed.content[0].text === "string") {
          return parsed.content[0].text as string;
        }
      } catch {
        /* not valid JSON */
      }
    }
    return result;
  }, [result]);

  const contentType = useMemo(() => detectContentType(rawText), [rawText]);
  const truncated = rawText.length > MAX_INLINE_CHARS;
  const displayText = truncated
    ? rawText.slice(0, MAX_INLINE_CHARS)
    : rawText;

  return (
    <div className="mt-1 ml-5">
      {/* Toolbar */}
      <div className="flex items-center gap-1 mb-1">
        <span className="text-[10px] text-zinc-600 bg-zinc-800/60 px-1.5 py-0.5 rounded">
          {contentType === "json" ? "JSON" : contentType === "markdown" ? "Markdown" : "Text"}
        </span>
        <CopyButton text={rawText} />
        {(truncated || rawText.length > 500) && (
          <button
            onClick={() => setFullScreen(true)}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title="全屏查看"
          >
            <Maximize2 className="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
          </button>
        )}
      </div>

      {/* Inline content */}
      <div className="max-h-[400px] overflow-y-auto rounded-md">
        <ResultRenderer text={displayText} contentType={contentType} />
      </div>

      {truncated && (
        <button
          onClick={() => setFullScreen(true)}
          className="mt-1 text-[10px] text-cyan-500 hover:text-cyan-400 transition-colors"
        >
          内容过长，点击查看全文（{rawText.length.toLocaleString()} 字符）
        </button>
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
