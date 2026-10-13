/**
 * [INPUT]: lucide 图标子元素、VI 语义色（bg-accent-soft、text-accent-text、bg-surface-sunken）与 clsx
 * [OUTPUT]: 对外提供 IconTile：accent / neutral 两种色调，sm 36 / md 44 / lg 64 三种尺寸的图标底块
 * [POS]: ui 身份与状态原语；页面标题、入口卡片、空引导中的图标底块统一从这里出，不再手写 bg-neon-cyan/10
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；圆角与颜色以 VI.md 为准
 */

import type { HTMLAttributes } from "react";
import { clsx } from "clsx";

export type IconTileTone = "accent" | "neutral";
export type IconTileSize = "sm" | "md" | "lg";

const TONE: Record<IconTileTone, string> = {
  accent: "bg-accent-soft text-accent-text",
  neutral: "bg-surface-sunken text-text-secondary",
};

// Icon sizes follow VI 20 / 20 / 24 (lg uses 32 for empty-state illustrations).
const SIZE: Record<IconTileSize, string> = {
  sm: "h-9 w-9 rounded-lg [&>svg]:h-5 [&>svg]:w-5",
  md: "h-11 w-11 rounded-xl [&>svg]:h-6 [&>svg]:w-6",
  lg: "h-16 w-16 rounded-2xl [&>svg]:h-8 [&>svg]:w-8",
};

export interface IconTileProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: IconTileTone;
  size?: IconTileSize;
}

export default function IconTile({ tone = "accent", size = "md", className, children, ...rest }: IconTileProps) {
  return (
    <span
      aria-hidden="true"
      {...rest}
      className={clsx("inline-flex shrink-0 items-center justify-center", TONE[tone], SIZE[size], className)}
    >
      {children}
    </span>
  );
}
