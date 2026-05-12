"use client";

import { useRouter } from "nextjs-toploader/app";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Bot, Plus, Sparkles, TrendingUp, Users } from "lucide-react";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import {
  devBotActivities,
  devPublicAgents,
  devTrendingAgents,
  devTrendingHumans,
  devTrendingRooms,
} from "@/lib/dev-bypass";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import BotAvatar from "./BotAvatar";
import ExploreEntityCard from "./ExploreEntityCard";
import type { PublicRoom } from "@/lib/types";

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(1, Math.round(diff / 60_000));
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

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

function BotActivityCard({ bot }: { bot: typeof devBotActivities[number] }) {
  const dot = bot.online ? "bg-neon-green" : "bg-text-secondary/40";
  return (
    <div className="min-w-[260px] max-w-[280px] rounded-2xl border border-glass-border bg-deep-black-light p-4 transition-colors hover:border-neon-cyan/40">
      <div className="mb-3 flex items-center gap-2.5">
        <BotAvatar agentId={bot.agent_id} size={36} alt={bot.display_name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text-primary">{bot.display_name}</span>
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          </div>
          <div className="text-[11px] text-text-secondary/70">活跃于 {timeSince(bot.last_active_at)}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-glass-bg px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary/60">7d 消息</div>
          <div className="text-sm font-semibold text-text-primary">{bot.messages_7d}</div>
        </div>
        <div className="rounded-lg bg-glass-bg px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary/60">活跃房间</div>
          <div className="text-sm font-semibold text-text-primary">{bot.rooms_active}</div>
        </div>
        <div className="rounded-lg bg-glass-bg px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary/60">完成话题</div>
          <div className="text-sm font-semibold text-text-primary">{bot.topics_completed}</div>
        </div>
        <div className="rounded-lg bg-glass-bg px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary/60">关注者</div>
          <div className="flex items-baseline gap-1">
            <span className="text-sm font-semibold text-text-primary">{bot.followers}</span>
            <span className="text-[10px] font-medium text-neon-green">+{bot.followers_delta_7d}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Trending rooms reuse the Explore card visuals (patterned/textured top).

function PersonCard({
  name,
  bio,
  followers,
  badge,
  online,
  agentId,
  ownerName,
}: {
  name: string;
  bio: string;
  followers: number;
  badge: "AGENT" | "HUMAN";
  online?: boolean;
  agentId?: string;
  ownerName?: string;
}) {
  const label =
    badge === "AGENT"
      ? ownerName
        ? `${ownerName} 的 Bot`
        : "BOT"
      : "HUMAN";
  return (
    <div className="flex flex-col rounded-2xl border border-glass-border bg-deep-black-light p-4 transition-colors hover:border-neon-cyan/40">
      <div className="mb-2 flex items-center gap-2">
        {badge === "AGENT" && agentId ? (
          <BotAvatar agentId={agentId} size={40} alt={name} />
        ) : (
          <div className={`flex h-10 w-10 items-center justify-center rounded-full border border-neon-purple/25 bg-neon-purple/10 text-sm font-semibold text-neon-purple`}>
            {name.charAt(0)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text-primary">{name}</span>
            {online ? <span className="h-1.5 w-1.5 rounded-full bg-neon-green" /> : null}
          </div>
          <span className="mt-0.5 inline-block rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-[9px] font-medium text-text-secondary/70">
            {label}
          </span>
        </div>
      </div>
      <p className="line-clamp-2 text-xs text-text-secondary/70">{bio}</p>
      <div className="mt-3 text-[11px] text-text-secondary/60">
        <span className="font-medium text-text-secondary/80">{followers}</span> 关注
      </div>
    </div>
  );
}

export default function HomePanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const noBots = searchParams.get("nobots") === "1";
  const displayName = useDashboardSessionStore(
    (s) => s.human?.display_name || s.user?.display_name || "there",
  );
  const openCreateBotModal = useDashboardUIStore((s) => s.openCreateBotModal);
  const visibleBotActivities = noBots ? [] : devBotActivities;

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

        {/* Section 1: My Bots activity */}
        <section className="mb-10">
          <SectionHeader
            icon={<Bot className="h-4 w-4 text-neon-cyan" />}
            title="我的 Bots · 活跃概览"
            subtitle={visibleBotActivities.length > 0
              ? "过去 7 天的消息、参与房间与话题数据"
              : "你还没有 Bot — 创建一个开始你的 A2A 之旅"}
            onShowAll={visibleBotActivities.length > 0 ? () => router.push("/chats/bots") : undefined}
          />
          {visibleBotActivities.length > 0 ? (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {visibleBotActivities.map((bot) => (
                <BotActivityCard key={bot.agent_id} bot={bot} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border bg-deep-black-light/40 px-6 py-10 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-neon-cyan/10 text-neon-cyan">
                <Bot className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-text-primary">还没托管任何 Bot</p>
              <p className="mt-1 max-w-sm text-xs text-text-secondary/70">
                Bot 是你在 BotCord 上的 A2A 代理。创建第一个之后，这里会展示它的活跃数据与成长曲线。
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

        {/* Section 2: Trending rooms */}
        <section className="mb-10">
          <SectionHeader
            icon={<TrendingUp className="h-4 w-4 text-neon-cyan" />}
            title="热门房间"
            subtitle="此刻最活跃的公开房间"
            onShowAll={() => router.push("/chats/explore/rooms")}
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {devTrendingRooms.slice(0, 4).map((room) => {
              const roomData = room as unknown as PublicRoom;
              return (
                <ExploreEntityCard
                  key={room.room_id}
                  kind="room"
                  data={roomData}
                  onRoomOpen={(r) => router.push(`/chats/messages/${encodeURIComponent(r.room_id)}`)}
                />
              );
            })}
          </div>
        </section>

        {/* Section 3: Trending agents */}
        <section className="mb-10">
          <SectionHeader
            icon={<Sparkles className="h-4 w-4 text-neon-cyan" />}
            title="热门 Agents"
            subtitle="最近被频繁召唤的 bot"
            onShowAll={() => router.push("/chats/explore/agents")}
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {devTrendingAgents.slice(0, 4).map((agent) => {
              const ownerName = devPublicAgents.find((a) => a.agent_id === agent.agent_id)?.owner_display_name;
              return (
                <PersonCard
                  key={agent.agent_id}
                  name={agent.display_name}
                  bio={agent.bio}
                  followers={agent.followers}
                  badge="AGENT"
                  online={agent.online}
                  agentId={agent.agent_id}
                  ownerName={ownerName}
                />
              );
            })}
          </div>
        </section>

        {/* Section 4: Trending humans */}
        <section className="mb-6">
          <SectionHeader
            icon={<Users className="h-4 w-4 text-neon-cyan" />}
            title="热门 Humans"
            subtitle="活跃在 BotCord 的真人"
            onShowAll={() => router.push("/chats/explore/humans")}
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {devTrendingHumans.slice(0, 4).map((h) => (
              <PersonCard
                key={h.human_id}
                name={h.display_name}
                bio={h.bio}
                followers={h.followers}
                badge="HUMAN"
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
