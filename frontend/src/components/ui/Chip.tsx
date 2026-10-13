/**
 * [INPUT]: 子内容、可选前置图标、可选移除动作；依赖 IconButton、lucide X / Loader2 与 VI 语义色
 * [OUTPUT]: 对外提供 Chip：紧凑描边标签，可选 onRemove（必填 removeLabel），removing 时显示加载并禁用
 * [POS]: ui 内容原语；房间 Agent 能力、按人规则等“对象 + 属性”的标签统一从这里出。纯状态文字用 Badge
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；可渲染为 span / li
 */

import { createElement } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";
import { Loader2, X } from "lucide-react";
import IconButton from "./IconButton";

export interface ChipProps extends HTMLAttributes<HTMLElement> {
  as?: "span" | "li";
  /** Use "start" when children can grow taller (e.g. an expandable AccessBadge). */
  align?: "center" | "start";
  icon?: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  removing?: boolean;
  removeDisabled?: boolean;
}

export default function Chip({ as = "span", align = "center", icon, onRemove, removeLabel, removing = false, removeDisabled = false, className, children, ...rest }: ChipProps) {
  return createElement(
    as,
    {
      ...rest,
      className: clsx(
        "inline-flex max-w-full shrink-0 gap-1.5 rounded-lg border border-border bg-surface-sunken py-1 text-xs leading-5 text-text-primary",
        align === "start" ? "items-start" : "items-center",
        onRemove ? "pl-2 pr-0.5" : "px-2",
        className,
      ),
    },
    icon ? <span aria-hidden="true" className="inline-flex shrink-0 py-0.5 text-accent-text [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span> : null,
    <span className="inline-flex min-w-0 items-start gap-1.5">{children}</span>,
    onRemove ? (
      <IconButton danger size="sm" label={removeLabel ?? "Remove"} disabled={removing || removeDisabled} onClick={onRemove}>
        {removing ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <X />}
      </IconButton>
    ) : null,
  );
}
