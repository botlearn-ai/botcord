/**
 * [INPUT]: 依赖 VI 颜色语义类（bg-surface-sunken、border-border-strong、text-text-secondary…）与 clsx
 * [OUTPUT]: 对外提供 EmptyState：居中的图标 + 标题 + 说明 + 操作空状态，可选 compact 与虚线边框（bordered）
 * [POS]: ui 基础原语；列表为空、搜索无结果、首次使用引导统一从这里出；不使用渐变或模糊光斑
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；颜色与圆角以 docs/brand/botcord-vi/VI.md §3.5、§9 为准
 */

import type { ReactNode } from "react";
import { clsx } from "clsx";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  /** Dashed border around the whole state. */
  bordered?: boolean;
  className?: string;
}

export default function EmptyState({ icon, title, description, action, compact = false, bordered = false, className }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-12",
        bordered && "rounded-xl border border-dashed border-border-strong",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={clsx(
            "inline-flex items-center justify-center rounded-full bg-surface-sunken text-text-secondary",
            compact ? "h-8 w-8 [&>svg]:h-4 [&>svg]:w-4" : "h-12 w-12 [&>svg]:h-6 [&>svg]:w-6",
          )}
        >
          {icon}
        </span>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1">
        <p className={clsx("font-semibold text-text-primary", compact ? "text-sm" : "text-base")}>{title}</p>
        {description ? (
          <p className={clsx("text-text-secondary", compact ? "text-xs" : "text-sm")}>{description}</p>
        ) : null}
      </div>
      {action ? <div className={compact ? "mt-1" : "mt-2"}>{action}</div> : null}
    </div>
  );
}
