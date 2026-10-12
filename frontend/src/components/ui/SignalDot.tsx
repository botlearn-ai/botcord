/**
 * [INPUT]: 依赖 VI 颜色语义类（bg-brand、bg-warning、bg-success、text-tertiary…）、styles/ui-motion.css 的 bc-signal-* 动画与 clsx
 * [OUTPUT]: 对外提供 SignalDot 与 AgentSignal 类型：agent 运行状态信号点，xs / sm / md 三种尺寸（8 / 10 / 12px）
 * [POS]: ui 身份与状态原语；Avatar 右上角状态点、成员列表、状态胶囊统一从这里出
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；状态与动画以 docs/brand/botcord-vi/VI.md §6.3、§8 为准
 */

import { clsx } from "clsx";

export type AgentSignal = "idle" | "online" | "thinking" | "replying" | "waiting" | "done" | "offline";
export type SignalDotSize = "xs" | "sm" | "md";

const SIZE: Record<SignalDotSize, string> = {
  xs: "h-2 w-2",
  sm: "h-2.5 w-2.5",
  md: "h-3 w-3",
};

const TONE: Record<AgentSignal, string> = {
  idle: "bg-text-tertiary",
  online: "bg-brand",
  thinking: "bg-brand bc-signal-breathe",
  replying: "bg-brand",
  waiting: "bg-warning",
  done: "bg-success",
  // Hollow grey ring; the surface fill keeps it hollow on top of an avatar.
  offline: "border-2 border-text-tertiary bg-surface",
};

export interface SignalDotProps {
  status: AgentSignal;
  size?: SignalDotSize;
  className?: string;
}

export default function SignalDot({ status, size = "sm", className }: SignalDotProps) {
  return (
    <span
      role="img"
      aria-label={status}
      data-status={status}
      className={clsx("relative inline-block shrink-0 rounded-full", SIZE[size], TONE[status], className)}
    >
      {status === "waiting" ? (
        <span aria-hidden="true" className="bc-signal-blink pointer-events-none absolute -inset-1 rounded-full border-2 border-warning" />
      ) : null}
      {status === "done" ? (
        <span aria-hidden="true" className="bc-signal-ripple pointer-events-none absolute inset-0 rounded-full bg-success" />
      ) : null}
    </span>
  );
}
