"use client";

/**
 * [INPUT]: 依赖 react 的 useEffect/useMemo/useRef/useState，依赖 AgentBindDialog 完成绑定流程
 * [OUTPUT]: 对外提供 AccountMenu 组件，承载用户头像菜单与 agent 管理操作
 * [POS]: dashboard 左下角统一用户入口，集中切换身份/绑定/创建/账户动作
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo, useState } from "react";
import type { UserAgent, UserProfile } from "@/lib/types";
import AgentBindDialog from "./AgentBindDialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, LogOut, Plus, User } from "lucide-react";

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
  onRefresh, // Kept for compatibility, though refresh button is removed
  onLogout,
  onAgentBound,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [showBindDialog, setShowBindDialog] = useState(false);
  const locale = useLanguage();
  const t = accountMenu[locale];
  const tc = common[locale];

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.agent_id === activeAgentId) || null,
    [agents, activeAgentId],
  );

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-glass-border bg-deep-black-light text-sm font-bold text-neon-cyan transition-colors hover:border-neon-cyan/50 hover:bg-glass-bg focus:outline-none focus:ring-2 focus:ring-neon-cyan/50"
            title={t.account}
          >
            {getAvatarSeed(user)}
            {pendingRequests > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-neon-purple px-1 text-[9px] font-bold text-black">
                {pendingRequests > 9 ? "9+" : pendingRequests}
              </span>
            )}
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            sideOffset={12}
            side="top"
            align="start"
            className="z-[70] min-w-[280px] rounded-xl border border-glass-border bg-deep-black/95 backdrop-blur p-1.5 shadow-2xl animate-in fade-in-80 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-100 data-[state=closed]:zoom-out-95"
          >
            <div className="flex flex-col space-y-1 px-2 py-2 mb-1 border-b border-glass-border">
              <p className="text-sm font-medium leading-none text-text-primary">
                {user?.display_name || user?.email || t.user}
              </p>
              <p className="text-xs leading-none text-text-secondary mt-1">
                {activeAgent ? `${t.active}${activeAgent.display_name}` : t.noActiveAgent}
              </p>
            </div>

            <DropdownMenu.Group>
              <DropdownMenu.Label className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
                <User className="h-3 w-3" />
                {t.agentIdentity}
              </DropdownMenu.Label>
              {agents.length === 0 ? (
                <div className="px-2 py-2 text-xs text-text-secondary">
                  {t.noAgentYet}
                </div>
              ) : (
                <div className="max-h-44 overflow-y-auto">
                  {agents.map((agent) => (
                    <DropdownMenu.Item
                      key={agent.agent_id}
                      onClick={() => onSwitchAgent(agent.agent_id)}
                      className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus:bg-glass-bg data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    >
                      <span className="flex-1 truncate text-text-primary">
                        {agent.display_name}
                      </span>
                      {agent.agent_id === activeAgentId && (
                        <Check className="h-4 w-4 text-neon-cyan ml-2" />
                      )}
                    </DropdownMenu.Item>
                  ))}
                </div>
              )}
            </DropdownMenu.Group>

            <DropdownMenu.Separator className="my-1 h-px bg-glass-border" />

            <DropdownMenu.Item
              onClick={() => setShowBindDialog(true)}
              className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors text-neon-cyan focus:bg-neon-cyan/10 focus:text-neon-cyan"
            >
              <Plus className="mr-2 h-4 w-4" />
              <span>{bindDialog[locale].linkAgentWithAi}</span>
            </DropdownMenu.Item>

            <DropdownMenu.Separator className="my-1 h-px bg-glass-border" />

            <DropdownMenu.Item
              onClick={onLogout}
              className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors text-text-secondary focus:bg-red-500/10 focus:text-red-400"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>{tc.logout}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {showBindDialog && (
        <AgentBindDialog
          onClose={() => setShowBindDialog(false)}
          onSuccess={onAgentBound}
        />
      )}
    </>
  );
}
