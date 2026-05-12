"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Plus } from "lucide-react";
import { useShallow } from "zustand/shallow";
import BotAvatar from "./BotAvatar";
import BotDetailDrawer from "./BotDetailDrawer";
import DeviceDetailDrawer from "./DeviceDetailDrawer";
import MyDevicesView from "./MyDevicesView";
import DaemonInstallCommand from "@/components/daemon/DaemonInstallCommand";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import type { DashboardRoom, UserAgent } from "@/lib/types";

const SUB_TABS = [
  { key: "bots" as const, label: "我的 Bots" },
  { key: "devices" as const, label: "我的设备" },
];

function timeSince(iso: string | null): string {
  if (!iso) return "暂无活动";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function buildBotStats(agent: UserAgent, rooms: DashboardRoom[]) {
  const botRooms = rooms.filter((room) => room._originAgent?.agent_id === agent.agent_id || room.owner_id === agent.agent_id);
  return {
    rooms: botRooms.length,
    activeRooms: botRooms.filter((room) => room.last_message_at).length,
    unread: botRooms.reduce((sum, room) => sum + (room.unread_count ?? 0), 0),
    lastActiveAt: botRooms
      .map((room) => room.last_message_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null,
  };
}

export default function MyBotsPanel() {
  const [showAddDevice, setShowAddDevice] = useState(false);
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const overview = useDashboardChatStore((s) => s.overview);
  const refreshDaemons = useDaemonStore((s) => s.refresh);
  const { myBotsTab, selectedBotAgentId, setMyBotsTab, openCreateBotModal, setSelectedDeviceId, setBotDetailAgentId } = useDashboardUIStore(
    useShallow((s) => ({
      myBotsTab: s.myBotsTab,
      selectedBotAgentId: s.selectedBotAgentId,
      setMyBotsTab: s.setMyBotsTab,
      openCreateBotModal: s.openCreateBotModal,
      setSelectedDeviceId: s.setSelectedDeviceId,
      setBotDetailAgentId: s.setBotDetailAgentId,
    })),
  );

  useEffect(() => {
    if (selectedBotAgentId && ownedAgents.some((agent) => agent.agent_id === selectedBotAgentId)) {
      setMyBotsTab("bots");
      setBotDetailAgentId(selectedBotAgentId);
    }
  }, [ownedAgents, selectedBotAgentId, setBotDetailAgentId, setMyBotsTab]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8 max-md:px-4">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-text-primary">我的 Bots</h1>
          <p className="mt-1 text-sm text-text-secondary/70">
            {myBotsTab === "bots"
              ? "查看你托管的 Bot 状态与真实会话活动"
              : "管理运行 Bot 的本地设备 · 一台设备可以托管多个 Bot"}
          </p>
        </div>

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
            <button onClick={() => openCreateBotModal()} className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20">
              <Plus className="h-4 w-4" />
              创建 Bot
            </button>
          ) : (
            <button onClick={() => setShowAddDevice(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20">
              <Plus className="h-4 w-4" />
              添加设备
            </button>
          )}
        </div>

        {myBotsTab === "bots" ? (
          <BotsView ownedAgents={ownedAgents} rooms={overview?.rooms ?? []} openCreateBotModal={openCreateBotModal} />
        ) : (
          <MyDevicesView />
        )}
      </div>

      {showAddDevice ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onClick={() => setShowAddDevice(false)}>
          <div className="relative w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => setShowAddDevice(false)} className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary/60 transition-colors hover:bg-glass-bg hover:text-text-primary">
              ×
            </button>
            <DaemonInstallCommand
              labels={{
                title: "安装并启动 BotCord Daemon",
                hint: "在你的设备上运行以下命令以完成连接",
                copy: "复制",
                copied: "已复制",
                refresh: "刷新",
              }}
              onRefresh={() => void refreshDaemons({ quiet: true })}
            />
          </div>
        </div>
      ) : null}

      <DeviceDetailDrawer />
      <BotDetailDrawer />
    </div>
  );
}

function BotsView({ ownedAgents, rooms, openCreateBotModal }: {
  ownedAgents: UserAgent[];
  rooms: DashboardRoom[];
  openCreateBotModal: () => void;
}) {
  const setBotDetailAgentId = useDashboardUIStore((s) => s.setBotDetailAgentId);
  const statsById = useMemo(() => {
    return new Map(ownedAgents.map((agent) => [agent.agent_id, buildBotStats(agent, rooms)]));
  }, [ownedAgents, rooms]);

  if (ownedAgents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border bg-deep-black-light/50 px-8 py-16 text-center">
        <Bot className="h-10 w-10 text-text-secondary/50" />
        <p className="mt-3 text-sm font-medium text-text-primary">你还没有 Bot</p>
        <p className="mt-1 text-xs text-text-secondary/70">创建第一个 Bot 开始你的 A2A 之旅</p>
        <button onClick={() => openCreateBotModal()} className="mt-6 inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20">
          <Plus className="h-4 w-4" />
          创建 Bot
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {ownedAgents.map((agent) => {
        const stats = statsById.get(agent.agent_id) ?? buildBotStats(agent, rooms);
        return (
          <button key={agent.agent_id} onClick={() => setBotDetailAgentId(agent.agent_id)} className="rounded-2xl border border-glass-border bg-deep-black-light p-5 text-left transition-colors hover:border-neon-cyan/40">
            <div className="mb-4 flex items-start gap-3">
              <BotAvatar agentId={agent.agent_id} avatarUrl={agent.avatar_url} size={48} alt={agent.display_name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-text-primary">{agent.display_name}</h2>
                  <span className={`flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] ${agent.ws_online ? "border-neon-green/40 bg-neon-green/10 text-neon-green" : "border-glass-border bg-glass-bg text-text-secondary/70"}`}>
                    <span className={`h-1 w-1 rounded-full ${agent.ws_online ? "bg-neon-green" : "bg-text-secondary/40"}`} />
                    {agent.ws_online ? "Online" : "Offline"}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-text-secondary/70">{agent.bio || "暂无简介"}</p>
                <div className="mt-2 truncate font-mono text-[11px] text-text-secondary/55">{agent.agent_id}</div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 border-t border-glass-border pt-3">
              <Stat label="会话" value={stats.rooms} />
              <Stat label="活跃" value={stats.activeRooms} />
              <Stat label="未读" value={stats.unread} />
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-glass-border pt-2 text-[11px] text-text-secondary/55">
              <span>活跃于 {timeSince(stats.lastActiveAt)}</span>
              <span>点击查看详情 →</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg bg-glass-bg px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-text-secondary/60">{label}</div>
      <div className="text-sm font-semibold text-text-primary">{value}</div>
    </div>
  );
}
