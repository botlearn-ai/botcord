"use client";

/**
 * [INPUT]: 依赖 session store 提供用户资料刷新
 * [OUTPUT]: 对外提供 AgentRequiredState 组件，渲染“缺少当前 agent”空态
 * [POS]: dashboard 身份前置条件的复用提示层，被仍需 Bot 连接前置条件的视图消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useLanguage } from "@/lib/i18n";
import { bindDialog } from "@/lib/i18n/translations/dashboard";

interface AgentRequiredStateProps {
  title: string;
  description: string;
  compact?: boolean;
}

export default function AgentRequiredState({
  title,
  description,
  compact = false,
}: AgentRequiredStateProps) {
  const locale = useLanguage();
  const tb = bindDialog[locale];

  const containerClass = compact
    ? "space-y-3 rounded-xl border border-glass-border bg-glass-bg p-4"
    : "w-full max-w-md rounded-2xl border border-glass-border bg-glass-bg p-6 text-center backdrop-blur-xl";

  return (
    <div className={containerClass}>
      <p className={`${compact ? "text-sm" : "text-lg"} font-semibold text-text-primary`}>
        {title}
      </p>
      <p className={`${compact ? "text-xs" : "mt-2 text-sm"} leading-relaxed text-text-secondary`}>
        {description}
      </p>
      <p className={`${compact ? "mt-3 text-xs" : "mt-5 text-sm"} text-text-secondary`}>
        {tb.linkAgentWithAi}
      </p>
    </div>
  );
}
