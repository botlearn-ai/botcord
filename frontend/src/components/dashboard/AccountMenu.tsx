"use client";

/**
 * [INPUT]: 依赖 react 的 useEffect/useMemo/useRef/useState，依赖 AgentBindDialog 完成绑定流程
 * [OUTPUT]: 对外提供 AccountMenu 组件，承载用户头像菜单与 agent 管理操作
 * [POS]: dashboard 左下角统一用户入口，集中切换身份/绑定/创建/账户动作
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { UserAgent, UserProfile } from "@/lib/types";
import AgentBindDialog from "./AgentBindDialog";

interface AccountMenuProps {
  user: UserProfile | null;
  agents: UserAgent[];
  activeAgentId: string | null;
  pendingRequests: number;
  loading: boolean;
  onSwitchAgent: (agentId: string) => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
  onLogout: () => void;
  onAgentBound: (agentId: string) => Promise<void> | void;
}

function getAvatarSeed(user: UserProfile | null): string {
  const base = user?.display_name || user?.email || "U";
  return base.slice(0, 1).toUpperCase();
}

export default function AccountMenu({
  user,
  agents,
  activeAgentId,
  pendingRequests,
  loading,
  onSwitchAgent,
  onRefresh,
  onLogout,
  onAgentBound,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [showBindDialog, setShowBindDialog] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.agent_id === activeAgentId) || null,
    [agents, activeAgentId],
  );

  return (
    <>
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-glass-border bg-deep-black-light text-sm font-bold text-neon-cyan transition-colors hover:border-neon-cyan/50 hover:bg-glass-bg"
          title="Account"
        >
          {getAvatarSeed(user)}
          {pendingRequests > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-neon-purple px-1 text-[9px] font-bold text-black">
              {pendingRequests > 9 ? "9+" : pendingRequests}
            </span>
          )}
        </button>

        {open && (
          <div className="absolute bottom-12 left-0 z-[70] w-72 rounded-xl border border-glass-border bg-deep-black p-3 shadow-2xl">
            <div className="border-b border-glass-border pb-2">
              <p className="truncate text-xs font-semibold text-text-primary">
                {user?.display_name || user?.email || "User"}
              </p>
              <p className="truncate text-[10px] text-text-secondary">
                {activeAgent ? `Active: ${activeAgent.display_name}` : "No active agent"}
              </p>
            </div>

            <div className="mt-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                Agent Identity
              </p>
              {agents.length === 0 ? (
                <p className="rounded border border-glass-border bg-deep-black-light px-2 py-1.5 text-[11px] text-text-secondary">
                  No agent yet. Use "Bind" or "Create" below.
                </p>
              ) : (
                <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                  {agents.map((agent) => (
                    <button
                      key={agent.agent_id}
                      onClick={() => {
                        onSwitchAgent(agent.agent_id);
                        setOpen(false);
                      }}
                      className={`w-full rounded-lg border px-2 py-1.5 text-left transition-colors ${
                        agent.agent_id === activeAgentId
                          ? "border-neon-cyan/50 bg-neon-cyan/10"
                          : "border-glass-border hover:bg-glass-bg"
                      }`}
                    >
                      <p className="truncate text-xs font-medium text-text-primary">{agent.display_name}</p>
                      <p className="truncate font-mono text-[10px] text-text-secondary">{agent.agent_id}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-3 space-y-2">
              <button
                onClick={() => setShowBindDialog(true)}
                className="w-full rounded border border-neon-cyan/40 bg-neon-cyan/10 px-2 py-1.5 text-[11px] font-semibold text-neon-cyan hover:bg-neon-cyan/20"
              >
                Create Agent
              </button>
              <button
                onClick={() => {
                  onRefresh();
                  setOpen(false);
                }}
                disabled={loading}
                className="w-full rounded border border-glass-border px-2 py-1.5 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                onClick={onLogout}
                className="w-full rounded border border-red-400/40 bg-red-400/10 px-2 py-1.5 text-[11px] text-red-300 hover:bg-red-400/20"
              >
                Logout
              </button>
            </div>
          </div>
        )}
      </div>

      {showBindDialog && (
        <AgentBindDialog
          onClose={() => setShowBindDialog(false)}
          onSuccess={onAgentBound}
        />
      )}
    </>
  );
}
