/**
 * [INPUT]: 依赖 usePresenceStore 读取 agent 富状态，ui/PresenceIndicator 负责视觉
 * [OUTPUT]: 对外提供 <PresenceDot />，按 effectiveStatus 渲染 PresenceIndicator (offline/online/busy/away/working)
 * [POS]: frontend dashboard 通用出席状态指示器，独立于具体业务列表
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import PresenceIndicator from "@/components/ui/PresenceIndicator";
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
    <PresenceIndicator
      status={status}
      size={size}
      label={status}
      title={title ?? LABEL_MAP[status]}
      className={className}
    />
  );
}
