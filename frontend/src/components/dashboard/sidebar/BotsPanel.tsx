"use client";

import EmptyState from "@/components/ui/EmptyState";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import IconButton from "@/components/ui/IconButton";
import { startTransition, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { sidebar } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import { Bot, Plus, Settings2 } from "lucide-react";
import DeviceSettingsModal from "./DeviceSettingsModal";
import AgentSettingsDrawer from "@/components/dashboard/AgentSettingsDrawer";
import AddDeviceDialog from "@/components/dashboard/AddDeviceDialog";
import type { UserAgent } from "@/lib/types";

interface AgentRowProps {
  bot: UserAgent;
  isSelected: boolean;
  locale: "en" | "zh";
  onSelect: (agentId: string) => void;
  onOpenSettings: (bot: UserAgent) => void;
}

function AgentRow({ bot, isSelected, locale, onSelect, onOpenSettings }: AgentRowProps) {
  const settingsLabel = locale === "zh" ? "设置" : "Settings";

  return (
    <div className="group relative">
      <Button variant="row" aria-pressed={isSelected}
        onClick={() => onSelect(bot.agent_id)}
        className={`flex w-full items-center gap-2.5 `}
      >
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-glass-bg">
          {bot.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={bot.avatar_url}
              alt={bot.display_name || bot.agent_id}
              className="h-full w-full object-cover"
            />
          ) : (
            <Bot className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {bot.display_name || bot.agent_id}
          </span>
          <span className="block truncate font-mono text-xs text-text-secondary">
            {bot.agent_id}
          </span>
        </span>
        {bot.ws_online && (
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-neon-green" />
        )}
      </Button>
      <IconButton size="sm" label={`${bot.display_name || bot.agent_id} ${settingsLabel}`} aria-pressed={isSelected}
        type="button"
        title={settingsLabel}
        aria-label={`${bot.display_name || bot.agent_id} ${settingsLabel}`}
        onClick={(e) => { e.stopPropagation(); onOpenSettings(bot); }}
        className={`absolute right-2 top-1/2 inline-flex items-center justify-center `}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </IconButton>
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
  const { selectedBotAgentId, closeMobileSidebar, setSelectedBotAgentId } = useDashboardUIStore(useShallow((s) => ({
    selectedBotAgentId: s.selectedBotAgentId,
    closeMobileSidebar: s.closeMobileSidebar,
    setSelectedBotAgentId: s.setSelectedBotAgentId,
  })));
  const daemons = useDaemonStore((s) => s.daemons);
  const renameDaemon = useDaemonStore((s) => s.rename);
  const renamingId = useDaemonStore((s) => s.renamingId);
  const removeDevice = useDaemonStore((s) => s.removeDevice);
  const removingId = useDaemonStore((s) => s.removingId);
  const refreshDaemons = useDaemonStore((s) => s.refresh);
  const collectingDiagnosticsId = useDaemonStore((s) => s.collectingDiagnosticsId);
  const diagnosticResults = useDaemonStore((s) => s.diagnosticResults);
  const diagnosticErrors = useDaemonStore((s) => s.diagnosticErrors);
  const collectDiagnostics = useDaemonStore((s) => s.collectDiagnostics);

  const [showAddDevice, setShowAddDevice] = useState(false);
  const [deviceSettingsId, setDeviceSettingsId] = useState<string | null>(null);
  const [agentSettingsBot, setAgentSettingsBot] = useState<UserAgent | null>(null);

  const handleSelectAgent = (agentId: string) => {
    setSelectedBotAgentId(agentId);
    closeMobileSidebar();
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

  // Devices in `removal_pending` have already had their bots detached. Skip
  // their device card so My Bots doesn't render an empty group; the bots
  // surface under "No Device" via the unbound list instead. We still keep
  // the device with hosted agents (i.e., the rare case where detach failed
  // mid-flight) so the user can retry.
  const removalPendingIds = new Set(
    daemons.filter((d) => d.status === "removal_pending").map((d) => d.id),
  );
  const allDaemonIds = new Set([
    ...daemons
      .filter((d) => !(removalPendingIds.has(d.id) && !byDaemon.has(d.id)))
      .map((d) => d.id),
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
          <Card padding="none" key={did} className="">
            <div className="flex items-center gap-2 px-3 py-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0H3" />
              </svg>
              <Button variant="row"
                type="button"
                onClick={() => setDeviceSettingsId(did)}
                className="min-w-0 flex-1 truncate"
              >
                {label}
              </Button>
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${isOnline ? "bg-neon-green" : "bg-text-secondary/30"}`} />
              <IconButton size="sm" label={locale === "zh" ? "设备设置" : "Device settings"}
                type="button"
                title={locale === "zh" ? "设备设置" : "Device settings"}
                onClick={() => setDeviceSettingsId(did)}
                className="flex flex-shrink-0 items-center justify-center"
              >
                <Settings2 className="h-3 w-3" />
              </IconButton>
              <IconButton size="sm" label={locale === "zh" ? "在此设备创建 Agent" : "Create agent on this device"}
                type="button"
                title={locale === "zh" ? "在此设备创建 Agent" : "Create agent on this device"}
                onClick={() => onCreateBotForDaemon(did)}
                className="flex flex-shrink-0 items-center justify-center"
              >
                <Plus className="h-3 w-3" />
              </IconButton>
            </div>
            {daemonAgents.length > 0 ? (
              <div className="px-2 pb-2 space-y-1">
                {daemonAgents.map((bot) => (
                  <AgentRow
                    key={bot.agent_id}
                    bot={bot}
                    isSelected={selectedBotAgentId === bot.agent_id}
                    locale={locale}
                    onSelect={handleSelectAgent}
                    onOpenSettings={setAgentSettingsBot}
                  />
                ))}
              </div>
            ) : (
              <p className="px-3 pb-2.5 text-xs text-text-secondary">
                {locale === "zh" ? "暂无 Agent" : "No agents yet"}
              </p>
            )}
          </Card>
        );
      })}

      {/* Unbound agents */}
      {unbound.length > 0 && (
        <Card padding="none" className="">
          <div className="flex items-center gap-2 px-3 py-2">
            <Bot className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary" />
            <span className="flex-1 text-xs font-semibold text-text-secondary">
              {locale === "zh" ? "未关联设备" : "No Device"}
            </span>
          </div>
          <div className="px-2 pb-2 space-y-1">
            {unbound.map((bot) => (
              <AgentRow
                key={bot.agent_id}
                bot={bot}
                isSelected={selectedBotAgentId === bot.agent_id}
                locale={locale}
                onSelect={handleSelectAgent}
                onOpenSettings={setAgentSettingsBot}
              />
            ))}
          </div>
        </Card>
      )}

      {/* Empty state */}
      {isEmpty && (
        <EmptyState compact bordered title={<>{t.myBotsEmpty}</>} action={<><Button variant="secondary" size="sm"
            type="button"
            onClick={onOpenCreateBot}
            className="mt-4 inline-flex items-center gap-2"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{t.createBot}</span>
          </Button></>} />
      )}

      {/* Add Device button */}
      {!isEmpty && (
        <Button variant="row"
          type="button"
          onClick={() => setShowAddDevice(true)}
          className="flex w-full items-center gap-2"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{locale === "zh" ? "添加设备" : "Add Device"}</span>
        </Button>
      )}

      {/* Add Device modal */}
      {showAddDevice ? <AddDeviceDialog onClose={() => setShowAddDevice(false)} /> : null}

      {/* Device settings modal */}
      {deviceSettingsId && (
        <DeviceSettingsModal
          daemonId={deviceSettingsId}
          label={settingsDaemon?.label ?? ""}
          status={settingsDaemon?.status ?? "offline"}
          lastSeen={settingsDaemon?.last_seen_at ?? null}
          daemonVersion={settingsDaemon?.daemon_version ?? null}
          hostedAgentCount={(byDaemon.get(deviceSettingsId) ?? []).length}
          isRenaming={renamingId === deviceSettingsId}
          isRefreshing={refreshingBots}
          isRemoving={removingId === deviceSettingsId}
          isCollectingDiagnostics={collectingDiagnosticsId === deviceSettingsId}
          diagnosticResult={diagnosticResults[deviceSettingsId]}
          diagnosticError={diagnosticErrors[deviceSettingsId]}
          locale={locale}
          onClose={() => setDeviceSettingsId(null)}
          onRename={async (newLabel: string) => {
            await renameDaemon(deviceSettingsId, newLabel);
          }}
          onRefreshDaemons={onRefreshDaemons}
          onCollectDiagnostics={async () => {
            await collectDiagnostics(deviceSettingsId);
          }}
          onRemove={async (forgetIfOffline) => {
            await removeDevice(deviceSettingsId, { forgetIfOffline });
            await refreshDaemons({ quiet: true });
            setDeviceSettingsId(null);
          }}
        />
      )}

      {/* Agent settings drawer */}
      {agentSettingsBot && (
        <AgentSettingsDrawer
          agentId={agentSettingsBot.agent_id}
          displayName={agentSettingsBot.display_name}
          bio={agentSettingsBot.bio ?? null}
          avatarUrl={agentSettingsBot.avatar_url ?? null}
          hostingKind={agentSettingsBot.hosting_kind ?? null}
          daemonInstanceId={agentSettingsBot.daemon_instance_id ?? null}
          runtime={agentSettingsBot.runtime ?? null}
          runtimeModel={agentSettingsBot.runtime_model ?? null}
          reasoningEffort={agentSettingsBot.reasoning_effort ?? null}
          thinking={agentSettingsBot.thinking ?? null}
          onClose={() => setAgentSettingsBot(null)}
          onSaved={() => setAgentSettingsBot(null)}
        />
      )}
    </div>
  );
}
