"use client";

import { startTransition, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { sidebar } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import { Bot, Plus, Settings2 } from "lucide-react";
import DaemonInstallCommand from "@/components/daemon/DaemonInstallCommand";
import DeviceSettingsModal from "./DeviceSettingsModal";
import AgentSettingsDrawer from "@/components/dashboard/AgentSettingsDrawer";
import type { UserAgent } from "@/lib/types";

interface AgentRowProps {
  bot: UserAgent;
  isSelected: boolean;
  onSelect: (agentId: string) => void;
  onOpenSettings: (bot: UserAgent) => void;
}

function AgentRow({ bot, isSelected, onSelect, onOpenSettings }: AgentRowProps) {
  return (
    <div className="group relative">
      <button
        onClick={() => onSelect(bot.agent_id)}
        className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 pr-8 text-left transition-colors ${
          isSelected
            ? "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan"
            : "border-transparent text-text-secondary hover:border-glass-border hover:bg-glass-bg hover:text-text-primary"
        }`}
      >
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-glass-bg">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {bot.display_name || bot.agent_id}
          </span>
          <span className="block truncate font-mono text-[10px] text-text-secondary/60">
            {bot.agent_id}
          </span>
        </span>
        {bot.ws_online && (
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-neon-green" />
        )}
      </button>
      <button
        type="button"
        title="Agent 设置"
        onClick={(e) => { e.stopPropagation(); onOpenSettings(bot); }}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded opacity-0 text-text-secondary/40 transition-all group-hover:opacity-100 hover:bg-glass-bg hover:text-text-secondary"
      >
        <Settings2 className="h-3 w-3" />
      </button>
    </div>
  );
}

interface BotsPanelProps {
  refreshingBots: boolean;
  onOpenCreateBot: () => void;
  onCreateBotForDaemon: (daemonId: string) => void;
  onRefreshDaemons: () => void;
}

export default function BotsPanel({
  refreshingBots,
  onOpenCreateBot,
  onCreateBotForDaemon,
  onRefreshDaemons,
}: BotsPanelProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = sidebar[locale];

  const { ownedAgents } = useDashboardSessionStore(useShallow((s) => ({
    ownedAgents: s.ownedAgents,
  })));
  const { selectedBotAgentId, setSelectedBotAgentId } = useDashboardUIStore(useShallow((s) => ({
    selectedBotAgentId: s.selectedBotAgentId,
    setSelectedBotAgentId: s.setSelectedBotAgentId,
  })));
  const daemons = useDaemonStore((s) => s.daemons);
  const renameDaemon = useDaemonStore((s) => s.rename);
  const renamingId = useDaemonStore((s) => s.renamingId);

  const [showAddDevice, setShowAddDevice] = useState(false);
  const [deviceSettingsId, setDeviceSettingsId] = useState<string | null>(null);
  const [agentSettingsBot, setAgentSettingsBot] = useState<UserAgent | null>(null);

  const handleSelectAgent = (agentId: string) => {
    setSelectedBotAgentId(agentId);
    startTransition(() => {
      router.push(`/chats/bots/${encodeURIComponent(agentId)}`);
    });
  };

  // Group agents by daemon_instance_id
  const byDaemon = new Map<string, UserAgent[]>();
  const unbound: UserAgent[] = [];
  for (const agent of ownedAgents) {
    const did = agent.daemon_instance_id;
    if (did) {
      if (!byDaemon.has(did)) byDaemon.set(did, []);
      byDaemon.get(did)!.push(agent);
    } else {
      unbound.push(agent);
    }
  }

  const allDaemonIds = new Set([
    ...daemons.map((d) => d.id),
    ...byDaemon.keys(),
  ]);

  const isEmpty = ownedAgents.length === 0 && allDaemonIds.size === 0;

  const settingsDaemon = deviceSettingsId ? daemons.find((d) => d.id === deviceSettingsId) : null;

  return (
    <div className="p-2 space-y-3">
      {/* Device sections */}
      {Array.from(allDaemonIds).map((did) => {
        const daemon = daemons.find((d) => d.id === did);
        const daemonAgents = byDaemon.get(did) ?? [];
        const label = daemon?.label || did.slice(0, 8);
        const isOnline = daemon?.status === "online";
        return (
          <div key={did} className="rounded-xl border border-glass-border/50 bg-glass-bg/20">
            <div className="flex items-center gap-2 px-3 py-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary/60">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0H3" />
              </svg>
              <button
                type="button"
                onClick={() => setDeviceSettingsId(did)}
                className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-text-secondary/80 hover:text-text-primary transition-colors"
              >
                {label}
              </button>
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${isOnline ? "bg-neon-green" : "bg-text-secondary/30"}`} />
              <button
                type="button"
                title={locale === "zh" ? "设备设置" : "Device settings"}
                onClick={() => setDeviceSettingsId(did)}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-secondary/40 transition-colors hover:bg-glass-bg hover:text-text-secondary"
              >
                <Settings2 className="h-3 w-3" />
              </button>
              <button
                type="button"
                title={locale === "zh" ? "在此设备创建 Agent" : "Create agent on this device"}
                onClick={() => onCreateBotForDaemon(did)}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-secondary/50 transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
            {daemonAgents.length > 0 ? (
              <div className="px-2 pb-2 space-y-1">
                {daemonAgents.map((bot) => (
                  <AgentRow
                    key={bot.agent_id}
                    bot={bot}
                    isSelected={selectedBotAgentId === bot.agent_id}
                    onSelect={handleSelectAgent}
                    onOpenSettings={setAgentSettingsBot}
                  />
                ))}
              </div>
            ) : (
              <p className="px-3 pb-2.5 text-[10px] text-text-secondary/40">
                {locale === "zh" ? "暂无 Agent" : "No agents yet"}
              </p>
            )}
          </div>
        );
      })}

      {/* Unbound agents */}
      {unbound.length > 0 && (
        <div className="rounded-xl border border-glass-border/50 bg-glass-bg/20">
          <div className="flex items-center gap-2 px-3 py-2">
            <Bot className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary/60" />
            <span className="flex-1 text-[11px] font-semibold text-text-secondary/80">
              {locale === "zh" ? "未关联设备" : "No Device"}
            </span>
          </div>
          <div className="px-2 pb-2 space-y-1">
            {unbound.map((bot) => (
              <AgentRow
                key={bot.agent_id}
                bot={bot}
                isSelected={selectedBotAgentId === bot.agent_id}
                onSelect={handleSelectAgent}
                onOpenSettings={setAgentSettingsBot}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className="rounded-lg border border-dashed border-glass-border px-3 py-6 text-center">
          <p className="text-xs text-text-secondary/70">{t.myBotsEmpty}</p>
          <button
            type="button"
            onClick={onOpenCreateBot}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{t.createBot}</span>
          </button>
        </div>
      )}

      {/* Add Device button */}
      {!isEmpty && (
        <button
          type="button"
          onClick={() => setShowAddDevice(true)}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-glass-border/60 px-3 py-2 text-left text-xs text-text-secondary/60 transition-colors hover:border-neon-cyan/30 hover:text-neon-cyan/80"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{locale === "zh" ? "添加设备" : "Add Device"}</span>
        </button>
      )}

      {/* Add Device modal */}
      {showAddDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowAddDevice(false)}>
          <div className="relative w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setShowAddDevice(false)}
              className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary/60 transition-colors hover:bg-glass-bg hover:text-text-primary"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
            <p className="mb-4 text-sm font-semibold text-text-primary">
              {locale === "zh" ? "添加新设备" : "Add New Device"}
            </p>
            <DaemonInstallCommand
              labels={{
                title: locale === "zh" ? "安装并启动 BotCord Daemon" : "Install & Start BotCord Daemon",
                hint: locale === "zh" ? "在你的设备上运行以下命令以完成连接" : "Run this command on your device to connect it",
                copy: locale === "zh" ? "复制" : "Copy",
                copied: locale === "zh" ? "已复制" : "Copied",
                refresh: locale === "zh" ? "刷新" : "Refresh",
              }}
              onRefresh={() => void onRefreshDaemons()}
            />
          </div>
        </div>
      )}

      {/* Device settings modal */}
      {deviceSettingsId && (
        <DeviceSettingsModal
          daemonId={deviceSettingsId}
          label={settingsDaemon?.label ?? ""}
          status={settingsDaemon?.status ?? "offline"}
          lastSeen={settingsDaemon?.last_seen_at ?? null}
          isRenaming={renamingId === deviceSettingsId}
          isRefreshing={refreshingBots}
          locale={locale}
          onClose={() => setDeviceSettingsId(null)}
          onRename={async (newLabel: string) => {
            await renameDaemon(deviceSettingsId, newLabel);
          }}
          onRefreshDaemons={onRefreshDaemons}
        />
      )}

      {/* Agent settings drawer */}
      {agentSettingsBot && (
        <AgentSettingsDrawer
          agentId={agentSettingsBot.agent_id}
          displayName={agentSettingsBot.display_name}
          bio={null}
          onClose={() => setAgentSettingsBot(null)}
          onSaved={() => setAgentSettingsBot(null)}
        />
      )}
    </div>
  );
}
