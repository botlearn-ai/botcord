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
    <div className="flex min-w-0 flex-1 flex-col bg-deep-black">
      <div className={`border-b border-glass-border ${headerPaddingClassName}`}>
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
        </div>
      </div>

      <div className={`flex-1 space-y-4 overflow-x-hidden overflow-y-auto ${bodyPaddingClassName}`}>
        {Array.from({ length: 6 }).map((_, idx) => {
          const isRight = idx % 2 === 1;
          return (
            <div key={idx} className={`flex ${isRight ? "justify-end" : "justify-start"}`}>
              <div className={`w-full ${messageMaxWidthClassName} ${roundedClassName} border border-glass-border bg-deep-black-light p-4`}>
                {!isRight && <SkeletonBlock className="h-3 w-20" />}
                <SkeletonBlock className="mt-3 h-3 w-5/6 bg-glass-border/40" />
                <SkeletonBlock className="mt-2 h-3 w-2/3 bg-glass-border/40" />
                <SkeletonBlock className="mt-3 ml-auto h-2.5 w-12 bg-glass-border/30" />
              </div>
            </div>
          );
        })}
      </div>

      <div className={`border-t border-glass-border ${composerPaddingClassName}`}>
        <div className="flex items-end gap-2">
          <div className={`flex-1 ${roundedClassName} border border-glass-border bg-deep-black-light px-4 py-3`}>
            <SkeletonBlock className="h-4 w-1/3" />
          </div>
          {headerIcon ? (
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-neon-cyan/20 bg-neon-cyan/10 text-neon-cyan/70">
              {headerIcon}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
