/**
 * [INPUT]: 依赖 /logo.svg、全局 botcord-loader CSS 动效与 clsx 组合外部样式
 * [OUTPUT]: 对外提供 BotCordLoader 与 BotCordLoadingScreen，统一品牌加载动效
 * [POS]: ui 基础加载原语，供 App Router、dashboard 冷启动与公开分享页复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { clsx } from "clsx";

type BotCordLoaderSize = "sm" | "md" | "lg";

interface BotCordLoaderProps {
  label?: string;
  size?: BotCordLoaderSize;
  showLabel?: boolean;
  className?: string;
}

interface BotCordLoadingScreenProps {
  label?: string;
  className?: string;
}

const visualSize: Record<BotCordLoaderSize, string> = {
  sm: "h-10 w-10",
  md: "h-16 w-16",
  lg: "h-24 w-24",
};

const coreSize: Record<BotCordLoaderSize, string> = {
  sm: "h-5 w-5",
  md: "h-8 w-8",
  lg: "h-12 w-12",
};

export function BotCordLoader({
  label = "Loading BotCord",
  size = "md",
  showLabel = true,
  className,
}: BotCordLoaderProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className={clsx("inline-flex flex-col items-center justify-center gap-3", className)}
    >
      <div className={clsx("botcord-loader relative", visualSize[size])} aria-hidden="true">
        <span className="botcord-loader-halo" />
        <span className="botcord-loader-frame" />
        <span className={clsx("botcord-loader-core", coreSize[size])}>
          <span className="botcord-loader-logo-track h-[68%] w-[68%]">
            <img src="/logo.svg" alt="" className="h-full w-full" />
          </span>
        </span>
      </div>

      {showLabel ? (
        <span className="inline-flex items-center text-xs font-medium uppercase tracking-[0.16em] text-text-secondary">
          {label}
          <span className="botcord-loader-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </span>
      ) : null}
    </div>
  );
}

export function BotCordLoadingScreen({
  label = "Loading BotCord",
  className,
}: BotCordLoadingScreenProps) {
  return (
    <div className={clsx("flex min-h-[60vh] items-center justify-center", className)}>
      <BotCordLoader label={label} size="lg" />
    </div>
  );
}
