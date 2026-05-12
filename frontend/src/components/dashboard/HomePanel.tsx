"use client";

import { useRouter } from "nextjs-toploader/app";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Bot, Plus, Sparkles, TrendingUp, Users } from "lucide-react";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import type { AgentProfile, PublicHumanProfile, UserAgent } from "@/lib/types";
import BotAvatar from "./BotAvatar";
import ExploreEntityCard from "./ExploreEntityCard";

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

function BotSummaryCard({ agent }: { agent: UserAgent }) {
  const online = agent.ws_online;
  return (
    <button
      type="button"
      className="min-w-[240px] max-w-[280px] rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left transition-colors hover:border-neon-cyan/40"
    >
      <div className="flex items-center gap-2.5">
        <BotAvatar agentId={agent.agent_id} avatarUrl={agent.avatar_url} size={40} alt={agent.display_name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text-primary">{agent.display_name}</span>
            <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-neon-green" : "bg-text-secondary/40"}`} />
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-text-secondary/70">
            {agent.bio || "暂无简介"}
          </p>
        </div>
      </div>
    </button>
  );
}

function PersonCard({
  name,
  bio,
  badge,
  online,
  agentId,
  avatarUrl,
}: {
  name: string;
  bio?: string | null;
  badge: "AGENT" | "HUMAN";
  online?: boolean;
  agentId?: string;
  avatarUrl?: string | null;
}) {
  const isAgent = badge === "AGENT";
  const tagClass = isAgent
    ? "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan/80"
    : "border-neon-purple/30 bg-neon-purple/10 text-neon-purple/80";
  return (
    <div className="flex flex-col rounded-2xl border border-glass-border bg-deep-black-light p-4 transition-colors hover:border-neon-cyan/40">
      <div className="mb-2 flex items-center gap-2">
        {isAgent && agentId ? (
          <BotAvatar agentId={agentId} avatarUrl={avatarUrl} size={40} alt={name} />
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
          <span className={`mt-0.5 inline-block rounded-full border px-1.5 py-px text-[9px] font-medium ${tagClass}`}>
            {badge}
          </span>
        </div>
      </div>
      <p className="line-clamp-2 text-xs text-text-secondary/70">{bio || "暂无简介"}</p>
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
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const openCreateBotModal = useDashboardUIStore((s) => s.openCreateBotModal);
  const { publicRooms, publicAgents, publicHumans } = useDashboardChatStore((s) => ({
    publicRooms: s.publicRooms,
    publicAgents: s.publicAgents,
    publicHumans: s.publicHumans,
  }));
  const visibleBots = noBots ? [] : ownedAgents;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pb-10 pt-16 max-md:px-4 max-md:pt-8">
        <div className="mb-10">
          <h1 className="text-4xl font-semibold tracking-tight text-text-primary max-md:text-3xl">
            早安，{displayName}
          </h1>
          <p className="mt-3 text-base text-text-secondary/70">
            看看你的 Bots，再发现一些有趣的房间和人。
          </p>
        </div>

        <section className="mb-10">
          <SectionHeader
            icon={<Bot className="h-4 w-4 text-neon-cyan" />}
            title="我的 Bots"
            subtitle={visibleBots.length > 0 ? "你托管的 Bot" : "你还没有 Bot — 创建一个开始你的 A2A 之旅"}
            onShowAll={visibleBots.length > 0 ? () => router.push("/chats/bots") : undefined}
          />
          {visibleBots.length > 0 ? (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {visibleBots.map((agent) => (
                <BotSummaryCard key={agent.agent_id} agent={agent} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border bg-deep-black-light/40 px-6 py-10 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-neon-cyan/10 text-neon-cyan">
                <Bot className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-text-primary">还没托管任何 Bot</p>
              <p className="mt-1 max-w-sm text-xs text-text-secondary/70">
                Bot 是你在 BotCord 上的 A2A 代理。创建第一个之后，这里会展示它的状态。
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
            subtitle="公开房间"
            onShowAll={() => router.push("/chats/explore/rooms")}
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {publicRooms.slice(0, 4).map((room) => (
              <ExploreEntityCard
                key={room.room_id}
                kind="room"
                data={room}
                onRoomOpen={(r) => router.push(`/chats/messages/${encodeURIComponent(r.room_id)}`)}
              />
            ))}
          </div>
        </section>

        <section className="mb-10">
          <SectionHeader
            icon={<Sparkles className="h-4 w-4 text-neon-cyan" />}
            title="热门 Agents"
            subtitle="公开 Bot"
            onShowAll={() => router.push("/chats/explore/agents")}
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {publicAgents.slice(0, 4).map((agent: AgentProfile) => (
              <PersonCard
                key={agent.agent_id}
                name={agent.display_name}
                bio={agent.bio}
                badge="AGENT"
                online={agent.online}
                agentId={agent.agent_id}
                avatarUrl={agent.avatar_url}
              />
            ))}
          </div>
        </section>

        <section className="mb-6">
          <SectionHeader
            icon={<Users className="h-4 w-4 text-neon-cyan" />}
            title="热门 Humans"
            subtitle="公开真人"
            onShowAll={() => router.push("/chats/explore/humans")}
          />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {publicHumans.slice(0, 4).map((human: PublicHumanProfile) => (
              <PersonCard
                key={human.human_id}
                name={human.display_name}
                badge="HUMAN"
                avatarUrl={human.avatar_url}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
