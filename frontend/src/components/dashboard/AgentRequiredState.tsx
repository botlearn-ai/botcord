"use client";

/**
 * [INPUT]: 依赖 session store 提供用户资料刷新
 * [OUTPUT]: 对外提供 AgentRequiredState 组件，渲染“缺少当前 agent”空态
 * [POS]: dashboard 身份前置条件的复用提示层，被仍需 Bot 连接前置条件的视图消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import EmptyState from "@/components/ui/EmptyState";
import { Bot } from "lucide-react";
import { useLanguage } from "@/lib/i18n";

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
  const hint =
    locale === "zh"
      ? "请先在已连接设备上创建一个 Bot。"
      : "Create a Bot from a connected device first.";

  return <EmptyState icon={<Bot size={24} strokeWidth={1.75} />} compact={compact} title={title} description={<>{description}<br />{hint}</>} />;
}
