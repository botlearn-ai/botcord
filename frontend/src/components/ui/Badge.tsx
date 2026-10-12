/**
 * [INPUT]: 依赖 VI 颜色语义类（bg-accent-soft、text-accent-text、bg-success-soft、border-danger…）与 clsx
 * [OUTPUT]: 对外提供 Badge：neutral / accent / success / warning / danger 五种色调，soft / outline 两种变体，sm / md 两种尺寸，可选 dot 与 icon
 * [POS]: ui 基础原语；状态标签、计费标签、角色标签统一从这里出，不再手写徽章 className（未读计数仍用 UnreadBadge）
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；颜色以 docs/brand/botcord-vi/VI.md §3.4、§3.5 为准
 */

import type { HTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type BadgeVariant = "soft" | "outline";
export type BadgeSize = "sm" | "md";

const TONE: Record<BadgeVariant, Record<BadgeTone, string>> = {
  soft: {
    neutral: "border-transparent bg-surface-sunken text-text-secondary",
    accent: "border-transparent bg-accent-soft text-accent-text",
    success: "border-transparent bg-success-soft text-success",
    warning: "border-transparent bg-warning-soft text-warning",
    danger: "border-transparent bg-danger-soft text-danger",
  },
  outline: {
    neutral: "border-border-strong text-text-secondary",
    accent: "border-accent/50 text-accent-text",
    success: "border-success/50 text-success",
    warning: "border-warning/50 text-warning",
    danger: "border-danger/50 text-danger",
  },
};

const SIZE: Record<BadgeSize, string> = {
  sm: "h-5 gap-1 px-2 text-xs",
  md: "h-6 gap-1.5 px-2.5 text-xs",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Leading status dot in the tone colour. */
  dot?: boolean;
  icon?: ReactNode;
}

export default function Badge({
  tone = "neutral",
  variant = "soft",
  size = "sm",
  dot = false,
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      data-tone={tone}
      className={clsx(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border font-medium leading-none",
        TONE[variant][tone],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {dot ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" /> : null}
      {icon ? <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span> : null}
      {children}
    </span>
  );
}
