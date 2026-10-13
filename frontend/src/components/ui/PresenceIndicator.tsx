/**
 * [INPUT]: 出席状态值（offline / online / busy / away / working）、VI 语义色与 clsx
 * [OUTPUT]: 对外提供 PresenceIndicator 与 PresenceStatus：静态出席状态点，xs 6 / sm 8 / md 10 / lg 12 四种尺寸，overlay 叠在头像右下角
 * [POS]: ui 身份与状态原语；dashboard PresenceDot 与团队 Agent 目录共用。SignalDot 表达运行进度，二者不互换
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；无循环动画，颜色以 VI.md 为准
 */

import { clsx } from "clsx";

export type PresenceStatus = "offline" | "online" | "busy" | "away" | "working";
export type PresenceIndicatorSize = "xs" | "sm" | "md" | "lg";

const SIZE: Record<PresenceIndicatorSize, string> = {
  xs: "h-1.5 w-1.5",
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
  lg: "h-3 w-3",
};

// Presence is a business state, independent of runtime progress.
const COLOR: Record<PresenceStatus, string> = {
  offline: "bg-text-tertiary",
  online: "bg-accent",
  busy: "bg-warning",
  away: "bg-text-secondary",
  working: "bg-accent",
};

export interface PresenceIndicatorProps {
  status: PresenceStatus;
  size?: PresenceIndicatorSize;
  /** Accessible name; omit when a visible label sits next to the dot. */
  label?: string;
  title?: string;
  /** Position at the bottom-right corner of a relative avatar wrapper. */
  overlay?: boolean;
  className?: string;
}

export default function PresenceIndicator({ status, size = "sm", label, title, overlay = false, className }: PresenceIndicatorProps) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={title}
      data-status={status}
      className={clsx(
        "inline-block shrink-0 rounded-full",
        overlay ? "absolute -bottom-0.5 -right-0.5 ring-2 ring-surface" : "ring-1 ring-surface",
        SIZE[size],
        COLOR[status] ?? COLOR.offline,
        className,
      )}
    />
  );
}
