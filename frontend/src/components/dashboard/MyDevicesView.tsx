"use client";

import { useMemo } from "react";
import { ChevronRight, Cpu } from "lucide-react";
import { useShallow } from "zustand/shallow";
import BotAvatar from "./BotAvatar";
import { useDaemonStore } from "@/store/useDaemonStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";

function timeSince(iso: string | null): string {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export default function MyDevicesView() {
  const daemons = useDaemonStore((s) => s.daemons);
  const { ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents })),
  );
  const setSelectedDeviceId = useDashboardUIStore((s) => s.setSelectedDeviceId);

  const botsByDevice = useMemo(() => {
    const grouped = new Map<string, typeof ownedAgents>();
    for (const agent of ownedAgents) {
      if (!agent.daemon_instance_id) continue;
      const list = grouped.get(agent.daemon_instance_id) ?? [];
      list.push(agent);
      grouped.set(agent.daemon_instance_id, list);
    }
    return grouped;
  }, [ownedAgents]);

  const visibleDaemons = daemons.filter((d) => d.status !== "revoked" && d.status !== "removal_pending");

  if (visibleDaemons.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border bg-deep-black-light/50 px-8 py-16 text-center">
        <Cpu className="h-10 w-10 text-text-secondary/50" />
        <p className="mt-3 text-sm font-medium text-text-primary">还没有设备</p>
        <p className="mt-1 text-xs text-text-secondary/70">添加一台设备开始托管你的 Bot</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {visibleDaemons.map((device) => {
        const online = device.status === "online";
        const bots = botsByDevice.get(device.id) ?? [];
        return (
          <button
            key={device.id}
            onClick={() => setSelectedDeviceId(device.id)}
            className="w-full rounded-2xl border border-glass-border bg-deep-black-light p-5 text-left transition-colors hover:border-neon-cyan/40"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-glass-bg/60 text-text-secondary">
                  <Cpu className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-text-primary">
                      {device.label || device.id}
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
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-text-secondary/65">
                    <span className="font-mono">{device.id}</span>
                    <span>上次在线 {timeSince(device.last_seen_at)}</span>
                  </div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-text-secondary/50" />
            </div>

            <div className="mt-4 border-t border-glass-border pt-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-secondary/60">
                托管的 Bots · {bots.length}
              </p>
              {bots.length === 0 ? (
                <p className="text-xs text-text-secondary/50">这台设备还没有托管任何 Bot</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {bots.map((bot) => (
                    <span
                      key={bot.agent_id}
                      className="flex items-center gap-2 rounded-full border border-glass-border bg-glass-bg/60 py-1 pl-1 pr-3"
                    >
                      <BotAvatar agentId={bot.agent_id} avatarUrl={bot.avatar_url} size={24} alt={bot.display_name} />
                      <span className="text-xs text-text-primary">{bot.display_name}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
