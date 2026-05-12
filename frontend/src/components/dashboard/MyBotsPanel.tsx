"use client";

import { useRouter } from "nextjs-toploader/app";
import { Bot, MessageCircle, Plus, Settings2 } from "lucide-react";
import BotAvatar from "./BotAvatar";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { devBotActivities } from "@/lib/dev-bypass";
import { useShallow } from "zustand/shallow";

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(1, Math.round(diff / 60_000));
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export default function MyBotsPanel() {
  const router = useRouter();
  const { ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents })),
  );
  const openCreateBotModal = useDashboardUIStore((s) => s.openCreateBotModal);

  // Merge in mock activity stats (matched by agent_id; fallback to neutral defaults).
  const statsById = new Map(devBotActivities.map((s) => [s.agent_id, s]));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">我的 Bots</h1>
            <p className="mt-1 text-sm text-text-secondary/70">
              管理你托管的 Bot · 与它们的对话请到「消息」标签
            </p>
          </div>
          <button
            onClick={() => openCreateBotModal()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            <Plus className="h-4 w-4" />
            创建 Bot
          </button>
        </div>

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
                <div
                  key={agent.agent_id}
                  className="rounded-2xl border border-glass-border bg-deep-black-light p-5 transition-colors hover:border-neon-cyan/40"
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

                  <div className="mt-4 flex gap-2 border-t border-glass-border pt-3">
                    <button
                      onClick={() => router.push(`/chats/messages/__user-chat__`)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:border-neon-cyan/40 hover:bg-neon-cyan/10 hover:text-neon-cyan"
                    >
                      <MessageCircle className="h-3.5 w-3.5" />
                      打开对话
                    </button>
                    <button
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-xs font-medium text-text-secondary/80 transition-colors hover:border-glass-border hover:text-text-primary"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      设置
                    </button>
                    {stats ? (
                      <span className="hidden items-center text-[11px] text-text-secondary/60 md:flex">
                        活跃于 {timeSince(stats.last_active_at)}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
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
