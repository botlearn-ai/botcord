"use client";

/**
 * [INPUT]: 依赖 dashboard 骨架视觉 token、Tailwind 原子类与可选图标/布局参数渲染消息面板加载态
 * [OUTPUT]: 对外提供 DashboardMessagePaneSkeleton 组件，统一渲染 header、消息气泡与输入区骨架
 * [POS]: dashboard 消息类视图的共享骨架层，被 `DashboardShellSkeleton` 与 `UserChatPane` 复用，避免两套消息占位样式漂移
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import type { ReactNode } from "react";

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`dashboard-skeleton-block rounded ${className}`} />;
}

type MessageFeedSkeletonProps = {
  className?: string;
  contentClassName?: string;
  rows?: number;
  label?: string;
  bubbleMaxWidthClassName?: string;
  bubbleRoundedClassName?: string;
};

const messageWidths = ["w-[72%]", "w-[56%]", "w-[82%]", "w-[64%]", "w-[48%]", "w-[76%]"];

/**
 * The message body skeleton intentionally mirrors `MessageBubble`: sender
 * avatar/action slot, sender metadata, variable copy width, and a timestamp.
 * Keeping it separate lets the ordinary room pane and the owner-chat shell
 * share the same geometry instead of falling back to generic rectangular rows.
 */
export function MessageFeedSkeleton({
  className = "",
  contentClassName = "px-4 py-3",
  rows = 6,
  label = "Loading messages",
  bubbleMaxWidthClassName = "max-w-[70%]",
  bubbleRoundedClassName = "rounded-2xl",
}: MessageFeedSkeletonProps) {
  return (
    <div
      className={`relative min-h-0 flex-1 overflow-hidden ${className}`}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className={`h-full space-y-3 overflow-hidden ${contentClassName}`}>
        {Array.from({ length: rows }).map((_, idx) => {
          const isOwn = idx % 3 === 1;
          const bodyWidth = messageWidths[idx % messageWidths.length];
          return (
            <div
              key={idx}
              className={`flex items-start gap-2 ${isOwn ? "justify-end" : "justify-start"}`}
              style={{ animationDelay: `${idx * 70}ms` }}
            >
              {isOwn ? <SkeletonBlock className="mt-1 h-8 w-8 shrink-0 rounded-xl bg-glass-border/35" /> : null}
              {!isOwn ? <SkeletonBlock className="mt-0.5 h-8 w-8 shrink-0 rounded-full bg-glass-border/35" /> : null}
              <div
                className={`liquid-message ${bodyWidth} ${bubbleMaxWidthClassName} min-w-[11rem] ${bubbleRoundedClassName} border border-glass-border px-3 py-2 ${
                  isOwn ? "bg-neon-cyan/5" : "bg-glass-bg/35"
                }`}
              >
                <div className={`flex items-center gap-1.5 ${isOwn ? "justify-end" : ""}`}>
                  <SkeletonBlock className="h-4 w-4 rounded-full bg-glass-border/45" />
                  <SkeletonBlock className="h-3 w-16 bg-glass-border/45" />
                  {!isOwn ? <SkeletonBlock className="h-3 w-10 bg-glass-border/30" /> : null}
                </div>
                <SkeletonBlock className="mt-2 h-3 w-full bg-glass-border/40" />
                <SkeletonBlock className={`mt-1.5 h-3 ${idx % 2 === 0 ? "w-4/5" : "w-3/5"} bg-glass-border/35`} />
                {idx % 4 === 0 ? <SkeletonBlock className="mt-1.5 h-3 w-2/5 bg-glass-border/30" /> : null}
                <SkeletonBlock className={`mt-2 h-2.5 w-12 bg-glass-border/30 ${isOwn ? "ml-auto" : ""}`} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MessageHistoryLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-1.5" role="status" aria-live="polite">
      <span className="dashboard-history-loader h-2 w-16 rounded-full" aria-hidden="true" />
      <span className="text-[11px] text-text-secondary">{label}</span>
    </div>
  );
}

export function MessageRoomHeaderSkeleton({ label = "Loading room" }: { label?: string }) {
  return (
    <div className="liquid-toolbar flex min-h-16 items-center justify-between gap-2 border-b border-glass-border px-4 py-3 max-md:min-h-12 max-md:px-2 max-md:py-2" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="min-w-0 flex-1">
        <SkeletonBlock className="h-4 w-36 max-w-[60%]" />
        <SkeletonBlock className="mt-2 h-3 w-52 max-w-[78%] bg-glass-border/40" />
      </div>
      <div aria-hidden="true" className="flex shrink-0 items-center gap-1.5">
        <SkeletonBlock className="h-8 w-8 rounded-lg bg-glass-border/40" />
        <SkeletonBlock className="h-8 w-8 rounded-lg bg-glass-border/40" />
      </div>
    </div>
  );
}

export function MessageComposerSkeleton({ label = "Loading message composer" }: { label?: string }) {
  return (
    <div className="flex items-end gap-2" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="liquid-composer flex h-12 flex-1 items-center rounded-2xl border border-glass-border px-3">
        <SkeletonBlock className="h-3 w-2/5 bg-glass-border/40" />
      </div>
      <SkeletonBlock className="h-9 w-9 shrink-0 rounded-xl bg-neon-cyan/15" />
    </div>
  );
}

interface DashboardMessagePaneSkeletonProps {
  headerIcon?: ReactNode;
  headerPaddingClassName?: string;
  bodyPaddingClassName?: string;
  composerPaddingClassName?: string;
  messageMaxWidthClassName?: string;
  roundedClassName?: string;
}

export default function DashboardMessagePaneSkeleton({
  headerIcon,
  headerPaddingClassName = "px-5 py-4",
  bodyPaddingClassName = "px-5 py-5",
  composerPaddingClassName = "px-5 py-4",
  messageMaxWidthClassName = "max-w-[68%]",
  roundedClassName = "rounded-2xl",
}: DashboardMessagePaneSkeletonProps) {
  return (
    <div className="dashboard-main flex min-w-0 flex-1 flex-col" aria-busy="true">
      <div className={`liquid-toolbar border-b border-glass-border ${headerPaddingClassName}`}>
        <div className="flex items-center gap-2">
          {headerIcon ? (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-neon-cyan/20 bg-neon-cyan/5 text-neon-cyan/70">
              {headerIcon}
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="mt-2 h-3 w-48 bg-glass-border/40" />
          </div>
          <div className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
            <SkeletonBlock className="h-8 w-8 rounded-lg bg-glass-border/35" />
            <SkeletonBlock className="h-8 w-8 rounded-lg bg-glass-border/35" />
          </div>
        </div>
      </div>

      <MessageFeedSkeleton
        contentClassName={bodyPaddingClassName}
        bubbleMaxWidthClassName={messageMaxWidthClassName}
        bubbleRoundedClassName={roundedClassName}
      />

      <div className={`liquid-toolbar border-t border-glass-border ${composerPaddingClassName}`}>
        <MessageComposerSkeleton />
      </div>
    </div>
  );
}
