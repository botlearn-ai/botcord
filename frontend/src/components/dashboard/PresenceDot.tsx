/**
 * [INPUT]: 依赖 usePresenceStore 读取 agent 富状态
 * [OUTPUT]: 对外提供 <PresenceDot />，按 effectiveStatus 渲染不同颜色 (offline/online/busy/away/working)
 * [POS]: frontend dashboard 通用出席状态指示器，独立于具体业务列表
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import clsx from "clsx";
import {
  AgentEffectiveStatus,
  usePresenceStatus,
} from "@/store/usePresenceStore";

interface PresenceDotProps {
  agentId: string | null | undefined;
  size?: "xs" | "sm" | "md";
  fallback?: boolean;
  className?: string;
  showOffline?: boolean;
  title?: string;
}

const SIZE_MAP = {
  xs: "h-1.5 w-1.5",
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
} as const;

// Presence is independent of runtime progress: keep these business states intact.
const COLOR_MAP: Record<AgentEffectiveStatus, string> = {
  offline: "bg-text-tertiary",
  online: "bg-accent",
  busy: "bg-warning",
  away: "bg-text-secondary",
  working: "bg-accent",
};

const LABEL_MAP: Record<AgentEffectiveStatus, string> = {
  offline: "离线",
  online: "在线",
  busy: "忙碌",
  away: "暂离",
  working: "工作中",
};

export function PresenceDot({
  agentId,
  size = "sm",
  fallback,
  className,
  showOffline = true,
  title,
}: PresenceDotProps) {
  const entry = usePresenceStatus(agentId);
  const status: AgentEffectiveStatus = entry
    ? entry.effectiveStatus
    : fallback
      ? "online"
      : "offline";

  if (status === "offline" && !showOffline) return null;

  return (
    <span
      aria-label={status}
      title={title ?? LABEL_MAP[status]}
      className={clsx(
        "inline-block rounded-full ring-1 ring-surface",
        SIZE_MAP[size],
        COLOR_MAP[status],
        className,
      )}
    />
  );
}
