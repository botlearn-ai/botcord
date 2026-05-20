"use client";

import type { ReactNode } from "react";
import { isValidElement, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

interface MarkdownContentProps {
  content: string;
  renderMention?: (mention: { id: string; label: string }) => ReactNode;
  mentionCandidates?: MentionTextCandidate[];
}

export interface MentionTextCandidate {
  id: string;
  label: string;
}

interface HastTextNode {
  type: "text";
  value: string;
}

interface HastElementNode {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

interface HastRootNode {
  type: "root";
  children?: HastNode[];
}

type HastNode = HastTextNode | HastElementNode | HastRootNode | { type?: string; [key: string]: unknown };

const MENTION_WITH_ID_RE = /@([^\n@]*?)\(((?:ag|hu)_[^)]+)\)/g;

function isMentionStartBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s([{'"“‘]/.test(value[index - 1]);
}

function isMentionEndBoundary(value: string, index: number): boolean {
  const after = value[index];
  return after === undefined || /[\s.,!?;:()[\]{}'"“”‘’]/.test(after);
}

export function splitPlainMentionText(value: string, candidates: MentionTextCandidate[] = []): HastNode[] {
  const sortedCandidates = candidates
    .filter((candidate) => candidate.id && candidate.label)
    .sort((a, b) => b.label.length - a.label.length);

  if (sortedCandidates.length === 0) {
    return [{ type: "text", value }];
  }

  const nodes: HastNode[] = [];
  let cursor = 0;
  let textStart = 0;

  while (cursor < value.length) {
    if (value[cursor] !== "@" || !isMentionStartBoundary(value, cursor)) {
      cursor += 1;
      continue;
    }

    const restLower = value.slice(cursor + 1).toLowerCase();
    const match = sortedCandidates.find((candidate) => {
      if (!restLower.startsWith(candidate.label.toLowerCase())) return false;
      return isMentionEndBoundary(value, cursor + 1 + candidate.label.length);
    });

    if (!match) {
      cursor += 1;
      continue;
    }

    if (cursor > textStart) {
      nodes.push({ type: "text", value: value.slice(textStart, cursor) });
    }
    nodes.push({
      type: "element",
      tagName: "span",
      properties: {
        "data-mention-id": match.id,
        "data-mention-label": match.label,
      },
      children: [{ type: "text", value: `@${match.label}` }],
    });
    cursor = cursor + 1 + match.label.length;
    textStart = cursor;
  }

  if (textStart < value.length) {
    nodes.push({ type: "text", value: value.slice(textStart) });
  }

  return nodes.length > 0 ? nodes : [{ type: "text", value }];
}

function splitMentionText(value: string, candidates: MentionTextCandidate[] = []): HastNode[] {
  const nodes: HastNode[] = [];
  let lastIndex = 0;
  MENTION_WITH_ID_RE.lastIndex = 0;

  for (const match of value.matchAll(MENTION_WITH_ID_RE)) {
    const index = match.index ?? 0;
    const rawLabel = match[1]?.trim();
    const id = match[2];
    if (!rawLabel || !id) continue;

    if (index > lastIndex) {
      nodes.push(...splitPlainMentionText(value.slice(lastIndex, index), candidates));
    }
    nodes.push({
      type: "element",
      tagName: "span",
      properties: {
        "data-mention-id": id,
        "data-mention-label": rawLabel,
      },
      children: [{ type: "text", value: `@${rawLabel}` }],
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < value.length) {
    nodes.push(...splitPlainMentionText(value.slice(lastIndex), candidates));
  }

  return nodes.length > 0 ? nodes : [{ type: "text", value }];
}

function isHastText(node: HastNode): node is HastTextNode {
  return node.type === "text" && typeof (node as { value?: unknown }).value === "string";
}

function isHastElement(node: HastNode): node is HastElementNode {
  return node.type === "element" && typeof (node as { tagName?: unknown }).tagName === "string";
}

function rehypeMentions(options?: { candidates?: MentionTextCandidate[] }) {
  const skipTags = new Set(["a", "code", "pre", "script", "style"]);
  const candidates = options?.candidates ?? [];

  const visit = (node: HastNode, parentTag?: string) => {
    if (!("children" in node) || !Array.isArray(node.children)) return;
    const nextChildren: HastNode[] = [];
    const currentTag = isHastElement(node) ? node.tagName : parentTag;

    for (const child of node.children) {
      if (isHastText(child) && !skipTags.has(currentTag ?? "")) {
        nextChildren.push(...splitMentionText(child.value, candidates));
        continue;
      }
      visit(child, currentTag);
      nextChildren.push(child);
    }

    node.children = nextChildren;
  };

  return (tree: HastRootNode) => visit(tree);
}

function nodeToText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeToText(node.props.children);
  return "";
}

function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  const text = nodeToText(children).replace(/\n$/, "");

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1600);
    } catch {
      // The code remains selectable when clipboard access is unavailable.
    }
  };

  return (
    <div className="group relative mb-2 last:mb-0">
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="absolute right-2 top-2 z-10 inline-flex h-7 items-center gap-1.5 rounded-md border border-glass-border bg-black/70 px-2 text-[11px] font-medium text-text-secondary shadow-lg shadow-black/20 transition hover:border-neon-cyan/40 hover:text-text-primary focus:outline-none focus:ring-1 focus:ring-neon-cyan/50"
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied code" : "Copy code"}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-neon-green" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="max-w-full overflow-x-auto rounded-lg border border-glass-border bg-black/40 p-3 pb-4 pr-20 font-mono text-xs text-neon-cyan/90 [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&>code]:!block [&>code]:!rounded-none [&>code]:!border-0 [&>code]:!bg-transparent [&>code]:!p-0 [&>code]:!text-xs [&>code]:!text-neon-cyan/90">
        {children}
      </pre>
    </div>
  );
}

function createComponents(renderMention?: MarkdownContentProps["renderMention"]): Components {
  return {
    p: ({ children }) => (
      <p className="mb-2 last:mb-0">{children}</p>
    ),
    span: ({ children, ...props }) => {
      const attrs = props as Record<string, unknown>;
      const rawId = attrs["data-mention-id"] ?? attrs.dataMentionId;
      const rawLabel = attrs["data-mention-label"] ?? attrs.dataMentionLabel;
      const id = typeof rawId === "string" ? rawId : null;
      const label = typeof rawLabel === "string" ? rawLabel : null;
      if (id && label && renderMention) {
        return <>{renderMention({ id, label })}</>;
      }
      return <span>{children}</span>;
    },
    strong: ({ children }) => (
      <strong className="font-semibold text-text-primary">{children}</strong>
    ),
    em: ({ children }) => (
      <em className="italic text-text-primary/90">{children}</em>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-neon-cyan underline underline-offset-2 hover:text-neon-cyan/80 transition-colors"
      >
        {children}
      </a>
    ),
    ul: ({ children }) => (
      <ul className="mb-2 ml-4 list-disc last:mb-0 [&>li]:mb-0.5">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-2 ml-4 list-decimal last:mb-0 [&>li]:mb-0.5">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="text-text-primary">{children}</li>
    ),
    code: ({ className, children }) => {
      const isBlock = className?.includes("language-");
      if (isBlock) {
        return (
          <code className="block whitespace-pre">
            {children}
          </code>
        );
      }
      return (
        <code className="rounded border border-glass-border bg-black/30 px-1.5 py-0.5 font-mono text-xs text-neon-cyan/90">
          {children}
        </code>
      );
    },
    pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
    blockquote: ({ children }) => (
      <blockquote className="mb-2 border-l-2 border-neon-purple/50 pl-3 text-text-secondary last:mb-0">
        {children}
      </blockquote>
    ),
    h1: ({ children }) => (
      <h1 className="mb-1.5 text-base font-bold text-text-primary">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-1 text-sm font-bold text-text-primary">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1 text-sm font-semibold text-text-primary">{children}</h3>
    ),
    hr: () => (
      <hr className="my-2 border-glass-border" />
    ),
    table: ({ children }) => (
      <div className="mb-2 overflow-x-auto last:mb-0">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="border-b border-glass-border">{children}</thead>
    ),
    th: ({ children }) => (
      <th className="px-2 py-1 text-left font-semibold text-text-primary">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border-t border-glass-border/50 px-2 py-1 text-text-secondary">{children}</td>
    ),
  };
}

export default function MarkdownContent({ content, renderMention, mentionCandidates }: MarkdownContentProps) {
  return (
    <div className="break-words text-sm text-text-primary [&>*:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeMentions, { candidates: mentionCandidates ?? [] }]]}
        components={createComponents(renderMention)}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
