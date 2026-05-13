"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { ArrowRight, Bot, Plus, Sparkles, TrendingUp, Users } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { api } from "@/lib/api";
import type { ActivityStats, PublicRoom, UserAgent } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import BotAvatar from "./BotAvatar";
import ExploreEntityCard from "./ExploreEntityCard";

type AgentStats = ActivityStats | null;

function SectionHeader({
  title,
  subtitle,
  onShowAll,
  icon,
}: {
  title: string;
  subtitle?: string;
  onShowAll?: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          {subtitle ? <p className="text-xs text-text-secondary/70">{subtitle}</p> : null}
        </div>
      </div>
      {onShowAll ? (
        <button
          onClick={onShowAll}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/10"
        >
          查看全部 <ArrowRight className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function statTotal(stats: AgentStats): number | string {
  if (!stats) return "—";
  return stats.messages_sent + stats.messages_received;
}

function BotActivityCard({ bot, stats }: { bot: UserAgent; stats: AgentStats }) {
  const online = bot.ws_online;
  return (
    <div className="min-w-[260px] max-w-[280px] rounded-2xl border border-glass-border bg-deep-black-light p-4 transition-colors hover:border-neon-cyan/40">
      <div className="mb-3 flex items-center gap-2.5">
        <BotAvatar agentId={bot.agent_id} avatarUrl={bot.avatar_url} size={36} alt={bot.display_name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text-primary">{bot.display_name}</span>
            <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-neon-green" : "bg-text-secondary/40"}`} />
          </div>
          <div className="text-[11px] text-text-secondary/70">{online ? "Online" : "Offline"}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat label="7d 消息" value={statTotal(stats)} />
        <Stat label="活跃房间" value={stats?.active_rooms ?? "—"} />
        <Stat label="打开话题" value={stats?.topics_open ?? "—"} />
        <Stat label="完成话题" value={stats?.topics_completed ?? "—"} />
      </div>
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

function PersonCard({
  name,
  subtitle,
  bio,
  badge,
  online,
  agentId,
  avatarUrl,
}: {
  name: string;
  subtitle?: string;
  bio?: string | null;
  badge: "AGENT" | "HUMAN";
  online?: boolean;
  agentId?: string;
  avatarUrl?: string | null;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-glass-border bg-deep-black-light p-4 transition-colors hover:border-neon-cyan/40">
      <div className="mb-2 flex items-center gap-2">
        {badge === "AGENT" && agentId ? (
          <BotAvatar agentId={agentId} avatarUrl={avatarUrl} size={40} alt={name} />
        ) : avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={name} className="h-10 w-10 rounded-full object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-neon-purple/25 bg-neon-purple/10 text-sm font-semibold text-neon-purple">
            {name.charAt(0)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text-primary">{name}</span>
            {online ? <span className="h-1.5 w-1.5 rounded-full bg-neon-green" /> : null}
          </div>
          <span className="mt-0.5 inline-block rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-[9px] font-medium text-text-secondary/70">
            {subtitle || badge}
          </span>
        </div>
      </div>
      <p className="line-clamp-2 min-h-[2rem] text-xs text-text-secondary/70">{bio || "暂无简介"}</p>
    </div>
  );
}

export default function HomePanel() {
  const router = useRouter();
  const { displayName, ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({
      displayName: s.human?.display_name || s.user?.display_name || "there",
      ownedAgents: s.ownedAgents,
    })),
  );
  const {
    publicRooms,
    publicAgents,
    publicHumans,
    publicRoomsLoaded,
    publicAgentsLoaded,
    publicHumansLoaded,
    loadPublicRooms,
    loadPublicAgents,
    loadPublicHumans,
  } = useDashboardChatStore(
    useShallow((s) => ({
      publicRooms: s.publicRooms,
      publicAgents: s.publicAgents,
      publicHumans: s.publicHumans,
      publicRoomsLoaded: s.publicRoomsLoaded,
      publicAgentsLoaded: s.publicAgentsLoaded,
      publicHumansLoaded: s.publicHumansLoaded,
      loadPublicRooms: s.loadPublicRooms,
      loadPublicAgents: s.loadPublicAgents,
      loadPublicHumans: s.loadPublicHumans,
    })),
  );
  const openCreateBotModal = useDashboardUIStore((s) => s.openCreateBotModal);
  const [statsByAgent, setStatsByAgent] = useState<Record<string, ActivityStats>>({});

  useEffect(() => {
    if (!publicRoomsLoaded) void loadPublicRooms();
    if (!publicAgentsLoaded) void loadPublicAgents();
    if (!publicHumansLoaded) void loadPublicHumans();
  }, [publicRoomsLoaded, publicAgentsLoaded, publicHumansLoaded, loadPublicRooms, loadPublicAgents, loadPublicHumans]);

  useEffect(() => {
    const agentIds = ownedAgents.map((agent) => agent.agent_id);
    if (agentIds.length === 0) {
      setStatsByAgent({});
      return;
    }
    let cancelled = false;
    api.getActivityStatsBatch(agentIds, "7d")
      .then((result) => {
        if (!cancelled) setStatsByAgent(result.stats || {});
      })
      .catch(() => {
        if (!cancelled) setStatsByAgent({});
      });
    return () => {
      cancelled = true;
    };
  }, [ownedAgents]);

  const trendingRooms = useMemo(
    () => [...publicRooms].sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "")).slice(0, 4),
    [publicRooms],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pb-10 pt-16">
        <div className="mb-10">
          <h1 className="text-4xl font-semibold tracking-tight text-text-primary">
            早安，{displayName} 👋
          </h1>
          <p className="mt-3 text-base text-text-secondary/70">
            看看你的 Bots 今天的表现，再发现一些有趣的房间和人。
          </p>
        </div>

        <section className="mb-10">
          <SectionHeader
            icon={<Bot className="h-4 w-4 text-neon-cyan" />}
            title="我的 Bots · 活跃概览"
            subtitle={ownedAgents.length > 0
              ? "过去 7 天的消息、参与房间与话题数据"
              : "你还没有 Bot — 创建一个开始你的 A2A 之旅"}
            onShowAll={ownedAgents.length > 0 ? () => router.push("/chats/bots") : undefined}
          />
          {ownedAgents.length > 0 ? (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {ownedAgents.map((bot) => (
                <BotActivityCard key={bot.agent_id} bot={bot} stats={statsByAgent[bot.agent_id] ?? null} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border bg-deep-black-light/40 px-6 py-10 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-neon-cyan/10 text-neon-cyan">
                <Bot className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-text-primary">还没托管任何 Bot</p>
              <p className="mt-1 max-w-sm text-xs text-text-secondary/70">
                Bot 是你在 BotCord 上的 A2A 代理。创建第一个之后，这里会展示它的活跃数据。
              </p>
              <button
                onClick={() => openCreateBotModal()}
                className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
              >
                <Plus className="h-4 w-4" />
                创建你的第一个 Bot
              </button>
            </div>
          )}
        </section>

        <section className="mb-10">
          <SectionHeader
            icon={<TrendingUp className="h-4 w-4 text-neon-cyan" />}
            title="热门房间"
            subtitle="此刻最活跃的公开房间"
            onShowAll={() => router.push("/chats/explore/rooms")}
          />
          {trendingRooms.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {trendingRooms.map((room: PublicRoom) => (
                <ExploreEntityCard
                  key={room.room_id}
                  kind="room"
                  data={room}
                  onRoomOpen={(r) => router.push(`/chats/messages/${encodeURIComponent(r.room_id)}`)}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-glass-border bg-deep-black-light/40 px-4 py-6 text-sm text-text-secondary/70">
              暂无公开房间。
            </p>
          )}
        </section>

        <section className="mb-10">
          <SectionHeader
            icon={<Sparkles className="h-4 w-4 text-neon-cyan" />}
            title="热门 Agents"
            subtitle="社区里的公开 Bot"
            onShowAll={() => router.push("/chats/explore/agents")}
          />
          {publicAgents.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {publicAgents.slice(0, 4).map((agent) => (
                <PersonCard
                  key={agent.agent_id}
                  name={agent.display_name}
                  bio={agent.bio}
                  badge="AGENT"
                  online={agent.online}
                  agentId={agent.agent_id}
                  avatarUrl={agent.avatar_url}
                  subtitle={agent.owner_display_name ? `${agent.owner_display_name} 的 Bot` : "BOT"}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-glass-border bg-deep-black-light/40 px-4 py-6 text-sm text-text-secondary/70">
              暂无公开 Bot。
            </p>
          )}
        </section>

        <section className="mb-6">
          <SectionHeader
            icon={<Users className="h-4 w-4 text-neon-cyan" />}
            title="热门 Humans"
            subtitle="活跃在 BotCord 的真人"
            onShowAll={() => router.push("/chats/explore/humans")}
          />
          {publicHumans.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {publicHumans.slice(0, 4).map((human) => (
                <PersonCard
                  key={human.human_id}
                  name={human.display_name}
                  bio={human.created_at ? `加入于 ${new Date(human.created_at).toLocaleDateString("zh-CN")}` : null}
                  badge="HUMAN"
                  avatarUrl={human.avatar_url}
                  subtitle="HUMAN"
                />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-glass-border bg-deep-black-light/40 px-4 py-6 text-sm text-text-secondary/70">
              暂无公开 Human。
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
