"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { api } from "@/lib/api";
import type { ActivityStats } from "@/lib/types";
import BotAvatar from "./BotAvatar";
import { BotEmptyHero } from "./HomePanel";
import MyDevicesView from "./MyDevicesView";
import AddDeviceDialog from "./AddDeviceDialog";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import { useLanguage } from "@/lib/i18n";
import { myBotsPanel as myBotsPanelI18n } from "@/lib/i18n/translations/dashboard";

export default function MyBotsPanel() {
  const t = myBotsPanelI18n[useLanguage()];
  const SUB_TABS = [
    { key: "bots" as const, label: t.botsTabLabel },
    { key: "devices" as const, label: t.devicesTabLabel },
  ];
  const [showAddDevice, setShowAddDevice] = useState(false);
  const { ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents })),
  );
  const { myBotsTab, setMyBotsTab, openCreateBotModal, setSelectedDeviceId } = useDashboardUIStore(
    useShallow((s) => ({
      myBotsTab: s.myBotsTab,
      setMyBotsTab: s.setMyBotsTab,
      openCreateBotModal: s.openCreateBotModal,
      setSelectedDeviceId: s.setSelectedDeviceId,
    })),
  );

  useEffect(() => {
    void useDaemonStore.getState().refresh();
  }, []);

  function handleCreateBot() {
    openCreateBotModal();
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-text-primary">{t.pageTitle}</h1>
          <p className="mt-1 text-sm text-text-secondary/70">
            {myBotsTab === "bots" ? t.botsSubtitle : t.devicesSubtitle}
          </p>
        </div>

        {/* Sub-tab pill control + matching create action on the right. */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center gap-1 rounded-full border border-glass-border bg-glass-bg/60 p-1">
            {SUB_TABS.map((tab) => {
              const active = myBotsTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => {
                    setMyBotsTab(tab.key);
                    setSelectedDeviceId(null);
                  }}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    active ? "bg-text-primary text-deep-black" : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          {myBotsTab === "bots" ? (
            <button
              onClick={handleCreateBot}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              <Plus className="h-4 w-4" />
              {t.createBot}
            </button>
          ) : (
            <button
              onClick={() => setShowAddDevice(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              <Plus className="h-4 w-4" />
              {t.addDevice}
            </button>
          )}
        </div>

        {myBotsTab === "bots" ? (
          <BotsView
            ownedAgents={ownedAgents}
            onCreateBot={handleCreateBot}
          />
        ) : (
          <MyDevicesView />
        )}
      </div>
      {showAddDevice ? <AddDeviceDialog onClose={() => setShowAddDevice(false)} /> : null}
    </div>
  );
}

function BotsView({
  ownedAgents,
  onCreateBot,
}: {
  ownedAgents: ReturnType<typeof useDashboardSessionStore.getState>["ownedAgents"];
  onCreateBot: () => void;
}) {
  const t = myBotsPanelI18n[useLanguage()];
  const setBotDetailAgentId = useDashboardUIStore((s) => s.setBotDetailAgentId);
  const [statsById, setStatsById] = useState<Record<string, ActivityStats>>({});

  useEffect(() => {
    const agentIds = ownedAgents.map((agent) => agent.agent_id);
    if (agentIds.length === 0) {
      setStatsById({});
      return;
    }
    let cancelled = false;
    api.getActivityStatsBatch(agentIds, "7d")
      .then((result) => {
        if (!cancelled) setStatsById(result.stats || {});
      })
      .catch(() => {
        if (!cancelled) setStatsById({});
      });
    return () => {
      cancelled = true;
    };
  }, [ownedAgents]);

  return (
    <>
      {ownedAgents.length === 0 ? (
        <BotEmptyHero onCreateBot={onCreateBot} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {ownedAgents.map((agent) => {
            const stats = statsById[agent.agent_id] ?? null;
            const online = agent.ws_online;
            return (
              <button
                key={agent.agent_id}
                onClick={() => setBotDetailAgentId(agent.agent_id)}
                className="rounded-2xl border border-glass-border bg-deep-black-light p-5 text-left transition-colors hover:border-neon-cyan/40"
              >
                <div className="mb-4 flex items-start gap-3">
                  <BotAvatar agentId={agent.agent_id} avatarUrl={agent.avatar_url} size={48} alt={agent.display_name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-base font-semibold text-text-primary">
                        {agent.display_name}
                      </h2>
                      <span
                        className={`flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] ${
                          online
                            ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                            : "border-glass-border bg-glass-bg text-text-secondary/70"
                        }`}
                      >
                        <span className={`h-1 w-1 rounded-full ${online ? "bg-neon-green" : "bg-text-secondary/40"}`} />
                        {online ? "Online" : "Offline"}
                      </span>
                      {agent.is_default ? (
                        <span className="rounded-full border border-neon-purple/30 bg-neon-purple/10 px-1.5 py-px text-[10px] text-neon-purple">
                          {t.defaultBadge}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-text-secondary/70">
                      {agent.bio || t.noBio}
                    </p>
                    <div className="mt-2 font-mono text-[11px] text-text-secondary/55">
                      {agent.agent_id}
                    </div>
                  </div>
                </div>

                {stats ? (
                  <div className="grid grid-cols-4 gap-2 border-t border-glass-border pt-3">
                    <Stat label={t.stats7dMessages} value={stats.messages_sent + stats.messages_received} />
                    <Stat label={t.statsActiveRooms} value={stats.active_rooms} />
                    <Stat label={t.statsOpenTopics} value={stats.topics_open} />
                    <Stat label={t.statsCompletedTopics} value={stats.topics_completed} />
                  </div>
                ) : null}

                {stats ? (
                  <div className="mt-3 flex items-center justify-between border-t border-glass-border pt-2 text-[11px] text-text-secondary/55">
                    <span>{t.sentReceived(stats.messages_sent, stats.messages_received)}</span>
                    <span>{t.viewDetails}</span>
                  </div>
                ) : (
                  <div className="mt-3 flex justify-end border-t border-glass-border pt-2 text-[11px] text-text-secondary/55">
                    {t.viewDetails}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, delta }: { label: string; value: number | string; delta?: string }) {
  return (
    <div className="rounded-lg bg-glass-bg px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-text-secondary/60">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-sm font-semibold text-text-primary">{value}</span>
        {delta ? <span className="text-[10px] font-medium text-neon-green">{delta}</span> : null}
      </div>
    </div>
  );
}
