"use client";

import { useEffect } from "react";
import { Bot, Plus } from "lucide-react";
import { useShallow } from "zustand/shallow";
import BotAvatar from "./BotAvatar";
import MyDevicesView from "./MyDevicesView";
import DeviceDetailDrawer from "./DeviceDetailDrawer";
import BotDetailDrawer from "./BotDetailDrawer";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import type { DaemonInstance } from "@/store/useDaemonStore";
import { DEV_BYPASS_AUTH, devBotActivities, devDaemons } from "@/lib/dev-bypass";

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(1, Math.round(diff / 60_000));
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

const SUB_TABS = [
  { key: "bots" as const, label: "我的 Bots" },
  { key: "devices" as const, label: "我的设备" },
];

export default function MyBotsPanel() {
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

  // Seed mock daemons into the daemon store the first time My Bots panel
  // mounts under dev bypass. Real auth flows fetch from /api/daemon/instances.
  useEffect(() => {
    if (!DEV_BYPASS_AUTH) return;
    const current = useDaemonStore.getState().daemons;
    if (current.length === 0) {
      useDaemonStore.setState({ daemons: devDaemons as DaemonInstance[] });
    }
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-text-primary">我的 Bots</h1>
          <p className="mt-1 text-sm text-text-secondary/70">
            {myBotsTab === "bots"
              ? "查看你托管的每只 Bot 的状态与活跃情况"
              : "管理运行 Bot 的本地设备 · 一台设备可以托管多个 Bot"}
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
              onClick={() => openCreateBotModal()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              <Plus className="h-4 w-4" />
              创建 Bot
            </button>
          ) : (
            <button
              onClick={() => alert("Add device (TODO — connect to AddDeviceModal)")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              <Plus className="h-4 w-4" />
              添加设备
            </button>
          )}
        </div>

        {myBotsTab === "bots" ? <BotsView ownedAgents={ownedAgents} openCreateBotModal={openCreateBotModal} /> : <MyDevicesView />}
      </div>
      <DeviceDetailDrawer />
      <BotDetailDrawer />
    </div>
  );
}

function BotsView({
  ownedAgents,
  openCreateBotModal,
}: {
  ownedAgents: ReturnType<typeof useDashboardSessionStore.getState>["ownedAgents"];
  openCreateBotModal: () => void;
}) {
  const setBotDetailAgentId = useDashboardUIStore((s) => s.setBotDetailAgentId);
  // Merge in mock activity stats (matched by agent_id; fallback to neutral defaults).
  const statsById = new Map(devBotActivities.map((s) => [s.agent_id, s]));

  return (
    <>
      {ownedAgents.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border bg-deep-black-light/50 px-8 py-16 text-center">
          <Bot className="h-10 w-10 text-text-secondary/50" />
          <p className="mt-3 text-sm font-medium text-text-primary">你还没有 Bot</p>
          <p className="mt-1 text-xs text-text-secondary/70">创建第一个 Bot 开始你的 A2A 之旅</p>
          <button
            onClick={() => openCreateBotModal()}
            className="mt-6 inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            <Plus className="h-4 w-4" />
            创建 Bot
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {ownedAgents.map((agent) => {
            const stats = statsById.get(agent.agent_id);
            const online = stats?.online ?? agent.ws_online;
            return (
              <button
                key={agent.agent_id}
                onClick={() => setBotDetailAgentId(agent.agent_id)}
                className="rounded-2xl border border-glass-border bg-deep-black-light p-5 text-left transition-colors hover:border-neon-cyan/40"
              >
                <div className="mb-4 flex items-start gap-3">
                  <BotAvatar agentId={agent.agent_id} size={48} alt={agent.display_name} />
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
                          默认
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-text-secondary/70">
                      {agent.bio || "暂无简介"}
                    </p>
                    <div className="mt-2 font-mono text-[11px] text-text-secondary/55">
                      {agent.agent_id}
                    </div>
                  </div>
                </div>

                {stats ? (
                  <div className="grid grid-cols-4 gap-2 border-t border-glass-border pt-3">
                    <Stat label="7d 消息" value={stats.messages_7d} />
                    <Stat label="活跃房间" value={stats.rooms_active} />
                    <Stat label="完成话题" value={stats.topics_completed} />
                    <Stat
                      label="关注者"
                      value={stats.followers}
                      delta={`+${stats.followers_delta_7d}`}
                    />
                  </div>
                ) : null}

                {stats ? (
                  <div className="mt-3 flex items-center justify-between border-t border-glass-border pt-2 text-[11px] text-text-secondary/55">
                    <span>活跃于 {timeSince(stats.last_active_at)}</span>
                    <span>点击查看详情 →</span>
                  </div>
                ) : (
                  <div className="mt-3 flex justify-end border-t border-glass-border pt-2 text-[11px] text-text-secondary/55">
                    点击查看详情 →
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
