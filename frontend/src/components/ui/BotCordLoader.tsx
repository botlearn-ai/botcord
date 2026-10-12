/**
 * [INPUT]: 依赖 BrandMark 的 cord 路径、全局 botcord-loader CSS 动效（Node·Cord 发送态）与 clsx 组合外部样式
 * [OUTPUT]: 对外提供 BotCordLoader、BotCordLoadingScreen 与移动端品牌加载状态，统一品牌加载动效
 * [POS]: ui 基础加载原语，供 App Router、dashboard 冷启动与公开分享页复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { clsx } from "clsx";
import { BRAND_CORD_PATH } from "@/components/ui/BrandMark";

type BotCordLoaderSize = "xs" | "sm" | "md" | "lg";

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

interface MobileBotCordLoadingProps {
  label: string;
  size?: BotCordLoaderSize;
  className?: string;
  textClassName?: string;
}

const visualSize: Record<BotCordLoaderSize, string> = {
  xs: "h-5 w-5",
  sm: "h-8 w-8",
  md: "h-12 w-12",
  lg: "h-16 w-16",
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
      {/* Node·Cord "sending" state: the signal dot travels along the cord (VI §8). */}
      <svg viewBox="0 0 48 48" fill="none" className={clsx("text-text-primary", visualSize[size])} aria-hidden="true">
        <path d={BRAND_CORD_PATH} stroke="currentColor" strokeWidth={5.5} strokeLinecap="round" opacity={0.9} />
        <circle cx={8.5} cy={34} r={7} fill="currentColor" />
        <circle className="botcord-loader-signal" cx={39.5} cy={14} r={7} fill="var(--bc-brand)" />
        <circle className="botcord-loader-courier" r={3} fill="var(--bc-brand)" />
      </svg>

      {showLabel ? (
        <span className="inline-flex items-center type-body-sm text-text-secondary">
          {label}
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

export function MobileBotCordLoading({
  label,
  size = "sm",
  className,
  textClassName,
}: MobileBotCordLoadingProps) {
  return (
    <div className={clsx("flex items-center justify-center", className)}>
      <BotCordLoader label={label} size={size} className="md:hidden" />
      <span className={clsx("hidden md:inline-flex", textClassName)}>{label}</span>
    </div>
  );
}
