/**
 * [INPUT]: 依赖 VI 颜色语义类（bg-surface、border-border、text-text-secondary…）与 clsx；头像、图标、操作由调用方传入
 * [OUTPUT]: 对外提供 StatusCapsule：头像 + 名称 + 一行状态 + 可选右侧操作的胶囊，高 40px（compact 32px）
 * [POS]: ui 身份与状态原语；agent 当前状态、等待授权（拒绝 / 允许）等场景统一用它展示
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；版式以 docs/brand/botcord-vi/VI.md §6.4 为准
 */

import type { ReactNode } from "react";
import { clsx } from "clsx";

export interface StatusCapsuleProps {
  /** Usually an `<Avatar kind="agent" status=… />`. */
  avatar: ReactNode;
  name: ReactNode;
  status: ReactNode;
  /** Optional leading icon for the status line. */
  icon?: ReactNode;
  /** Right-side actions, e.g. Deny / Allow buttons while waiting for approval. */
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}

export default function StatusCapsule({ avatar, name, status, icon, actions, compact = false, className }: StatusCapsuleProps) {
  return (
    <div
      className={clsx(
        "inline-flex min-w-0 max-w-full items-center rounded-full border border-border bg-surface shadow-sm",
        compact ? "h-8 gap-2 pl-0.5" : "h-10 gap-2.5 pl-1",
        // With actions the trailing button sits close to the edge; otherwise leave room after the text.
        actions ? (compact ? "pr-0.5" : "pr-1") : compact ? "pr-3" : "pr-4",
        className,
      )}
    >
      <span className="inline-flex shrink-0">{avatar}</span>
      {/* Compact (32px) puts name and status on one line; the default stacks them. */}
      <span className={clsx("flex min-w-0 flex-1", compact ? "items-baseline gap-2" : "flex-col justify-center")}>
        <span className="truncate text-[13px] font-semibold leading-tight text-text-primary">{name}</span>
        <span className="flex min-w-0 items-center gap-1 text-xs leading-tight text-text-secondary">
          {icon ? <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:h-3 [&>svg]:w-3">{icon}</span> : null}
          <span className="truncate">{status}</span>
        </span>
      </span>
      {actions ? <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</span> : null}
    </div>
  );
}
