/**
 * [INPUT]: 依赖 "@/lib/types" 的 PublicRoom/AgentProfile 类型，依赖 dashboard 视图传入的 roomsById/agentsById 与点击回调
 * [OUTPUT]: 对外提供 ExploreEntityCard 组件，统一渲染 room/agent 的 grid card（支持 id 或 data 入参）
 * [POS]: dashboard explore 的复用卡片渲染器，被 ChatPane 等页面消费，负责统一卡片视觉与交互入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { AgentProfile, PublicRoom } from "@/lib/types";
import CopyableId from "@/components/ui/CopyableId";
import { useLanguage } from "@/lib/i18n";
import { exploreUi } from "@/lib/i18n/translations/dashboard";
import SubscriptionBadge from "./SubscriptionBadge";

type ExploreEntityCardProps =
  | {
      kind: "room";
      id?: string;
      data?: PublicRoom;
      roomsById?: Record<string, PublicRoom>;
      onRoomOpen?: (room: PublicRoom) => void;
      className?: string;
    }
  | {
      kind: "agent";
      id?: string;
      data?: AgentProfile;
      agentsById?: Record<string, AgentProfile>;
      onAgentOpen?: (agent: AgentProfile) => void;
      className?: string;
    };

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "AI";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function formatRelativeTime(
  ts: string | null,
  locale: "en" | "zh",
  t: (typeof exploreUi)["en"],
): string {
  if (!ts) return t.noRecentActivity;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return t.noRecentActivity;
  const delta = Date.now() - date.getTime();
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return t.justNow;
  if (mins < 60) {
    return locale === "zh"
      ? `${mins}${t.minuteShort}${t.ago}`
      : `${mins}${t.minuteShort} ${t.ago}`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return locale === "zh"
      ? `${hours}${t.hourShort}${t.ago}`
      : `${hours}${t.hourShort} ${t.ago}`;
  }
  const days = Math.floor(hours / 24);
  return locale === "zh"
    ? `${days}${t.dayShort}${t.ago}`
    : `${days}${t.dayShort} ${t.ago}`;
}

export default function ExploreEntityCard(props: ExploreEntityCardProps) {
  const locale = useLanguage();
  const t = exploreUi[locale];
  const className = props.className || "";
  if (props.kind === "room") {
    const room = props.data || (props.id ? props.roomsById?.[props.id] : undefined);
    if (!room) return null;
    return (
      <button
        onClick={() => props.onRoomOpen?.(room)}
        className={`group rounded-2xl border border-glass-border bg-deep-black-light p-5 text-left transition-all hover:border-neon-cyan/60 hover:bg-glass-bg ${className}`}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-base font-semibold text-text-primary">{room.name}</p>
              {room.required_subscription_product_id && (
                <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
              )}
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-text-secondary/60">{room.room_id}</p>
          </div>
          <span className="shrink-0 rounded border border-glass-border px-2 py-1 text-[10px] text-text-secondary">
            {room.member_count} {t.agentsWord}
          </span>
        </div>
        <p className="line-clamp-2 min-h-[36px] text-xs leading-5 text-text-secondary">
          {room.description || t.noDescriptionYet}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 text-[10px] text-text-secondary/80">
          <div className="rounded border border-glass-border/60 px-2 py-1">
            {t.visibility}: {room.visibility}
          </div>
          <div className="rounded border border-glass-border/60 px-2 py-1">
            {t.activity}: {formatRelativeTime(room.last_message_at, locale, t)}
          </div>
        </div>
        <p className="mt-2 line-clamp-1 text-[11px] text-text-secondary/90">
          {room.last_message_preview
            ? `${room.last_sender_name || t.someone}: ${room.last_message_preview}`
            : t.noRecentMessages}
        </p>
      </button>
    );
  }

  const agent = props.data || (props.id ? props.agentsById?.[props.id] : undefined);
  if (!agent) return null;
  const initials = initialsFromName(agent.display_name);
  const persona =
    agent.message_policy === "open"
      ? t.personaOpen
      : t.personaContactsOnly;

  return (
    <button
      onClick={() => props.onAgentOpen?.(agent)}
      className={`group rounded-2xl border border-glass-border bg-deep-black-light p-5 text-left transition-all hover:border-neon-purple/60 hover:bg-glass-bg ${className}`}
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-neon-purple/30 bg-neon-purple/10 font-semibold text-neon-purple">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-text-primary">{agent.display_name}</p>
          <p className="mt-0.5 text-xs text-neon-purple/90">{t.personaAgent}</p>
          <p className="mt-1 text-[11px] text-text-secondary/80">{persona}</p>
        </div>
      </div>
      <p className="line-clamp-3 min-h-[54px] text-xs leading-5 text-text-secondary">
        {agent.bio || t.personaFallbackBio}
      </p>
      <div className="mt-4">
        <CopyableId value={agent.agent_id} />
      </div>
    </button>
  );
}
