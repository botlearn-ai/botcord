"use client";

/**
 * [INPUT]: 依赖 react 的 useMemo/useState，依赖 i18n 文案与 AgentBindDialog 完成账户菜单和绑定流程
 * [OUTPUT]: 对外提供 AccountMenu 组件，承载用户头像菜单与 agent 管理操作
 * [POS]: dashboard 左下角统一用户入口，集中切换身份/绑定/创建/账户动作
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo, useState } from "react";
import type { UserAgent, UserProfile } from "@/lib/types";
import AgentBindDialog from "./AgentBindDialog";
import CredentialResetDialog from "./CredentialResetDialog";
import UnbindAgentDialog from "./UnbindAgentDialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, KeyRound, LogOut, Plus, RefreshCw, Settings, Unlink, User } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { accountMenu, bindDialog } from "@/lib/i18n/translations/dashboard";
import { common } from "@/lib/i18n/translations/common";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useShallow } from "zustand/react/shallow";

interface AccountMenuProps {
  user: UserProfile | null;
  agents: UserAgent[];
  activeAgentId: string | null;
  pendingRequests: number;
  onSwitchAgent: (agentId: string) => Promise<void> | void;
  onLogout: () => void;
  onAgentBound: (agentId: string) => Promise<void> | void;
  onAgentUnbound: (agentId: string) => Promise<void> | void;
  onRefreshStatus?: () => Promise<void> | void;
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
  onSwitchAgent,
  onLogout,
  onAgentBound,
  onAgentUnbound,
  onRefreshStatus,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [showBindDialog, setShowBindDialog] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showUnbindDialog, setShowUnbindDialog] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const locale = useLanguage();
  const t = accountMenu[locale];
  const tc = common[locale];
  const { human, viewMode, setViewMode } = useDashboardSessionStore(useShallow((state) => ({
    human: state.human,
    viewMode: state.viewMode,
    setViewMode: state.setViewMode,
  })));

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
            {/* Mode indicator dot */}
            <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-deep-black-light ${viewMode === "human" ? "bg-neon-purple" : "bg-neon-cyan"}`} />
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
              {human ? (
                <p className="mt-1 truncate font-mono text-[11px] text-text-secondary/70" title={human.human_id}>
                  {human.human_id}
                </p>
              ) : null}
              <div className="text-xs leading-none text-text-secondary mt-1 flex items-center gap-1.5">
                {activeAgent ? (
                  <>
                    {t.active}{activeAgent.display_name}
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${activeAgent.ws_online ? "bg-emerald-400" : "bg-zinc-500"}`} />
                    <span className={activeAgent.ws_online ? "text-emerald-400" : "text-zinc-500"}>
                      {activeAgent.ws_online ? t.wsOnline : t.wsOffline}
                    </span>
                    {onRefreshStatus && (
                      <button
                        type="button"
                        disabled={refreshing}
                        onClick={async (e) => {
                          e.stopPropagation();
                          setRefreshing(true);
                          try { await onRefreshStatus(); } finally { setRefreshing(false); }
                        }}
                        className="ml-0.5 p-0.5 rounded text-text-secondary hover:text-neon-cyan transition-colors disabled:opacity-50 disabled:pointer-events-none"
                        title={t.refreshStatus}
                        aria-label={t.refreshStatus}
                      >
                        <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                      </button>
                    )}
                  </>
                ) : t.noActiveAgent}
              </div>
            </div>

            {/* Participant switcher: Human vs Agent observer mode */}
            {human && (
              <DropdownMenu.Group>
                <DropdownMenu.Label className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  {locale === "zh" ? "当前身份" : "View as"}
                </DropdownMenu.Label>
                <DropdownMenu.Item
                  onClick={() => setViewMode("human")}
                  className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus:bg-neon-purple/10"
                >
                  <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full mr-2 bg-neon-purple" />
                  <span className="flex-1 truncate text-text-primary">
                    {locale === "zh" ? "你 (Human)" : "You (Human)"}
                  </span>
                  {viewMode === "human" && <Check className="h-4 w-4 text-neon-purple ml-2" />}
                </DropdownMenu.Item>
                {agents.length > 0 && (
                  <div className="max-h-32 overflow-y-auto">
                    {agents.map((agent) => (
                      <DropdownMenu.Item
                        key={agent.agent_id}
                        onClick={() => { void onSwitchAgent(agent.agent_id); setViewMode("agent"); }}
                        className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus:bg-glass-bg"
                      >
                        <span className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full mr-2 ${agent.ws_online ? "bg-emerald-400" : "bg-zinc-500"}`} />
                        <span className="flex-1 truncate text-text-primary">
                          {agent.display_name}
                        </span>
                        <span className="ml-1.5 text-[10px] text-text-secondary/60">
                          {locale === "zh" ? "旁观" : "observer"}
                        </span>
                        {viewMode === "agent" && agent.agent_id === activeAgentId && (
                          <Check className="h-4 w-4 text-neon-cyan ml-2" />
                        )}
                      </DropdownMenu.Item>
                    ))}
                  </div>
                )}
              </DropdownMenu.Group>
            )}

            {/* Agent management section */}
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
                      <span className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full mr-2 ${agent.ws_online ? "bg-emerald-400" : "bg-zinc-500"}`} />
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

            <DropdownMenu.Item
              disabled={!activeAgentId}
              onClick={() => activeAgentId && setShowResetDialog(true)}
              className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors text-amber-300 focus:bg-amber-300/10 focus:text-amber-300 data-[disabled]:cursor-not-allowed data-[disabled]:text-text-secondary/50"
            >
              <KeyRound className="mr-2 h-4 w-4" />
              <span>{activeAgentId ? t.resetCredential : t.resetCredentialDisabled}</span>
            </DropdownMenu.Item>

            <DropdownMenu.Item
              disabled={!activeAgent}
              onClick={() => activeAgent && setShowUnbindDialog(true)}
              className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors text-red-400 focus:bg-red-400/10 focus:text-red-400 data-[disabled]:cursor-not-allowed data-[disabled]:text-text-secondary/50"
            >
              <Unlink className="mr-2 h-4 w-4" />
              <span>{activeAgent ? t.unbindAgent : t.unbindAgentDisabled}</span>
            </DropdownMenu.Item>

            {user?.beta_admin && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-glass-border" />
                <DropdownMenu.Item
                  onClick={() => { window.location.href = "/admin"; }}
                  className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors text-neon-purple focus:bg-neon-purple/10 focus:text-neon-purple"
                >
                  <Settings className="mr-2 h-4 w-4" />
                  <span>{locale === "zh" ? "管理后台" : "Admin"}</span>
                </DropdownMenu.Item>
              </>
            )}

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
      {showResetDialog && activeAgentId ? (
        <CredentialResetDialog
          agentId={activeAgentId}
          onClose={() => setShowResetDialog(false)}
        />
      ) : null}
      {showUnbindDialog && activeAgentId && activeAgent ? (
        <UnbindAgentDialog
          agentId={activeAgentId}
          agentName={activeAgent.display_name}
          onClose={() => setShowUnbindDialog(false)}
          onUnbound={onAgentUnbound}
        />
      ) : null}
    </>
  );
}
