"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

interface MarkdownContentProps {
  content: string;
}

const components: Components = {
  p: ({ children }) => (
    <p className="mb-2 last:mb-0">{children}</p>
  ),
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
        <code className="block overflow-x-auto rounded-lg border border-glass-border bg-black/40 p-3 font-mono text-xs text-neon-cyan/90">
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
  pre: ({ children }) => (
    <pre className="mb-2 last:mb-0">{children}</pre>
  ),
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

export default function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="break-words text-sm text-text-primary [&>*:first-child]:mt-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
