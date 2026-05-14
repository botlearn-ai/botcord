"use client";

/**
 * [INPUT]: 依赖 session store 提供用户资料刷新，依赖 AgentBindDialog 提供统一绑定入口
 * [OUTPUT]: 对外提供 AgentRequiredState 组件，渲染“缺少当前 agent”空态与恢复动作
 * [POS]: dashboard 身份前置条件的复用提示层，被仍需 Bot 连接前置条件的视图消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useCallback, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { bindDialog } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import AgentBindDialog from "./AgentBindDialog";

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
  const { refreshUserProfile } = useDashboardSessionStore(useShallow((state) => ({
    refreshUserProfile: state.refreshUserProfile,
  })));
  const [showBindDialog, setShowBindDialog] = useState(false);
  const locale = useLanguage();
  const tb = bindDialog[locale];

  const handleAgentBound = useCallback(async () => {
    await refreshUserProfile();
    setShowBindDialog(false);
  }, [refreshUserProfile]);

  const containerClass = compact
    ? "space-y-3 rounded-xl border border-glass-border bg-glass-bg p-4"
    : "w-full max-w-md rounded-2xl border border-glass-border bg-glass-bg p-6 text-center backdrop-blur-xl";

  return (
    <>
      <div className={containerClass}>
        <p className={`${compact ? "text-sm" : "text-lg"} font-semibold text-text-primary`}>
          {title}
        </p>
        <p className={`${compact ? "text-xs" : "mt-2 text-sm"} leading-relaxed text-text-secondary`}>
          {description}
        </p>
        <div className={`${compact ? "space-y-2" : "mt-5 flex flex-col gap-3"}`}>
          <button
            onClick={() => setShowBindDialog(true)}
            className="w-full rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            {tb.linkAgentWithAi}
          </button>
        </div>
      </div>
      {showBindDialog ? (
        <AgentBindDialog
          onClose={() => setShowBindDialog(false)}
          onSuccess={handleAgentBound}
        />
      ) : null}
    </>
  );
}
