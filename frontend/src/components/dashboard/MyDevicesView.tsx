"use client";

import { useMemo } from "react";
import { ChevronRight, Cpu } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import BotAvatar from "./BotAvatar";

function timeSince(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(1, Math.round(diff / 60_000));
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export default function MyDevicesView() {
  const daemons = useDaemonStore((s) => s.daemons);
  const { ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents })),
  );
  const setSelectedDeviceId = useDashboardUIStore((s) => s.setSelectedDeviceId);

  // Group owned bots by their device (daemon_instance_id).
  const botsByDevice = useMemo(() => {
    const m = new Map<string, typeof ownedAgents>();
    for (const a of ownedAgents) {
      if (!a.daemon_instance_id) continue;
      const arr = m.get(a.daemon_instance_id) ?? [];
      arr.push(a);
      m.set(a.daemon_instance_id, arr);
    }
    return m;
  }, [ownedAgents]);

  const visibleDaemons = daemons.filter((d) => d.status !== "revoked" && d.status !== "removal_pending");

  return (
    <div>
      {visibleDaemons.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border bg-deep-black-light/50 px-8 py-16 text-center">
          <Cpu className="h-10 w-10 text-text-secondary/50" />
          <p className="mt-3 text-sm font-medium text-text-primary">还没有设备</p>
          <p className="mt-1 text-xs text-text-secondary/70">添加一台设备开始托管你的 Bot</p>
        </div>
      ) : (
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
                        <span>·</span>
                        <span>上次在线 {timeSince(device.last_seen_at)}</span>
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-secondary/50" />
                </div>

                <div className="mt-4 border-t border-glass-border pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-text-secondary/60">
                      托管的 Bots · {bots.length}
                    </p>
                  </div>
                  {bots.length === 0 ? (
                    <p className="text-xs text-text-secondary/50">这台设备还没有托管任何 Bot</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {bots.map((bot) => (
                        <div
                          key={bot.agent_id}
                          className="flex items-center gap-2 rounded-full border border-glass-border bg-glass-bg/60 py-1 pl-1 pr-3 transition-colors hover:border-neon-cyan/30"
                        >
                          <BotAvatar agentId={bot.agent_id} size={24} alt={bot.display_name} />
                          <span className="text-xs text-text-primary">{bot.display_name}</span>
                          {bot.is_default ? (
                            <span className="rounded-full border border-neon-purple/30 bg-neon-purple/10 px-1.5 py-px text-[9px] text-neon-purple">
                              默认
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
