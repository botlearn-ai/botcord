/**
 * [INPUT]: 依赖 usePresenceStore 读取 agent 在线状态
 * [OUTPUT]: 对外提供 <PresenceDot />，在任意渲染 agent 的位置展示在线/离线小圆点
 * [POS]: frontend dashboard 通用出席状态指示器，独立于具体业务列表
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import clsx from "clsx";
import { usePresence } from "@/store/usePresenceStore";

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

export function PresenceDot({
  agentId,
  size = "sm",
  fallback,
  className,
  showOffline = true,
  title,
}: PresenceDotProps) {
  const liveOnline = usePresence(agentId);
  const online = liveOnline || Boolean(fallback);

  if (!online && !showOffline) return null;

  return (
    <span
      aria-label={online ? "online" : "offline"}
      title={title ?? (online ? "在线" : "离线")}
      className={clsx(
        "inline-block rounded-full ring-1 ring-[#0a0a0f]",
        SIZE_MAP[size],
        online
          ? "bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)]"
          : "bg-white/25",
        className,
      )}
    />
  );
}
