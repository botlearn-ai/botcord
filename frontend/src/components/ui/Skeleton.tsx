/**
 * [INPUT]: 依赖全局 .dashboard-skeleton-block 动画（app/globals.css）与 clsx
 * [OUTPUT]: 对外提供 Skeleton：line / block / circle 三种占位形状，可设 width / height
 * [POS]: ui 加载原语；列表、卡片、头像的加载占位统一从这里出；纯装饰，aria-hidden
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；圆角以 docs/brand/botcord-vi/VI.md §9 为准
 */

import type { CSSProperties } from "react";
import { clsx } from "clsx";

export type SkeletonShape = "line" | "block" | "circle";

const SHAPE: Record<SkeletonShape, string> = {
  line: "h-3 w-full rounded",
  block: "h-16 w-full rounded-xl",
  circle: "h-9 w-9 rounded-full",
};

export interface SkeletonProps {
  shape?: SkeletonShape;
  /** Number = px; string = any CSS length. */
  width?: number | string;
  height?: number | string;
  className?: string;
}

export default function Skeleton({ shape = "line", width, height, className }: SkeletonProps) {
  // A circle given only one dimension stays round.
  const resolvedHeight = height ?? (shape === "circle" ? width : undefined);
  const resolvedWidth = width ?? (shape === "circle" ? height : undefined);
  const style: CSSProperties = {};
  if (resolvedWidth !== undefined) style.width = resolvedWidth;
  if (resolvedHeight !== undefined) style.height = resolvedHeight;

  return (
    <span
      aria-hidden="true"
      data-shape={shape}
      className={clsx("dashboard-skeleton-block block shrink-0", SHAPE[shape], className)}
      style={style}
    />
  );
}
