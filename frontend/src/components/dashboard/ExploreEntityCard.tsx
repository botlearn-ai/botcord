/**
 * [INPUT]: 依赖 "@/lib/types" 的 PublicRoom/AgentProfile/PublicHumanProfile 类型，依赖 dashboard 视图传入的 roomsById/agentsById/humansById 与点击回调
 * [OUTPUT]: 对外提供 ExploreEntityCard 组件，统一渲染 room/agent/human 的 grid card，并支持 agent owner 的二级跳转
 * [POS]: dashboard explore 的复用卡片渲染器，被 ChatPane 等页面消费，负责统一卡片视觉与交互入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { AgentProfile, PublicHumanProfile, PublicRoom } from "@/lib/types";
import CopyableId from "@/components/ui/CopyableId";
import { useLanguage } from "@/lib/i18n";
import { exploreUi } from "@/lib/i18n/translations/dashboard";
import SubscriptionBadge from "./SubscriptionBadge";
import { initialsFromName, themeFromRoomName } from "./roomVisualTheme";

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
      onAgentOwnerOpen?: (humanId: string) => void;
      className?: string;
    }
  | {
      kind: "human";
      id?: string;
      data?: PublicHumanProfile;
      humansById?: Record<string, PublicHumanProfile>;
      onHumanOpen?: (human: PublicHumanProfile) => void;
      className?: string;
    };

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

  const handleKeyActivate = (
    event: React.KeyboardEvent<HTMLDivElement>,
    action: () => void,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    action();
  };

  if (props.kind === "room") {
    const room = props.data || (props.id ? props.roomsById?.[props.id] : undefined);
    if (!room) return null;
    const theme = themeFromRoomName(room.name || room.room_id);
    const memberWord = room.member_count === 1 ? t.memberSingular : t.memberPlural;
    const roomInitials = initialsFromName(room.name || "Room");
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => props.onRoomOpen?.(room)}
        onKeyDown={(event) => handleKeyActivate(event, () => props.onRoomOpen?.(room))}
        className={`group overflow-hidden rounded-xl border border-glass-border bg-deep-black-light text-left transition-all hover:border-neon-cyan/60 hover:shadow-md hover:shadow-neon-cyan/10 ${className}`}
      >
        <div
          className="relative h-14 w-full"
          style={{
            backgroundImage: `${theme.patternUrl}`,
            backgroundRepeat: "repeat, no-repeat",
            backgroundSize: "auto, cover",
          }}
        >
          <div className="absolute left-3 top-2 flex items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-bold text-white/90 backdrop-blur-sm"
              style={{ background: theme.accentDim, boxShadow: `0 0 0 1px ${theme.accent}55` }}
            >
              {roomInitials}
            </div>
          </div>
          <span
            className="absolute right-2 top-2 rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-sm"
            style={{ boxShadow: `0 0 0 1px ${theme.accent}55` }}
          >
            {room.member_count} {memberWord}
          </span>
        </div>
        <div className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-text-primary">{room.name}</p>
            {room.required_subscription_product_id && (
              <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-text-secondary/60">{room.room_id}</p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-text-secondary">
            {room.description || t.noDescriptionYet}
          </p>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-text-secondary/70">
            <span className="truncate">
              {room.join_policy === "invite_only" && (
                <span className="font-medium text-amber-400">{t.inviteOnly}</span>
              )}
            </span>
            <span className="shrink-0">{formatRelativeTime(room.last_message_at, locale, t)}</span>
          </div>
        </div>
      </div>
    );
  }

  if (props.kind === "agent") {
    const agent = props.data || (props.id ? props.agentsById?.[props.id] : undefined);
    if (!agent) return null;
    const initials = initialsFromName(agent.display_name);
    const persona =
      agent.message_policy === "open"
        ? t.personaOpen
        : t.personaContactsOnly;
    const hasOwner = Boolean(agent.owner_human_id && agent.owner_display_name);

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => props.onAgentOpen?.(agent)}
        onKeyDown={(event) => handleKeyActivate(event, () => props.onAgentOpen?.(agent))}
        className={`group rounded-xl border border-glass-border bg-deep-black-light p-3 text-left transition-all hover:border-neon-purple/60 hover:bg-glass-bg ${className}`}
      >
        <div className="flex items-start gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neon-purple/30 bg-neon-purple/10 text-xs font-semibold text-neon-purple">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text-primary">{agent.display_name}</p>
            <p className="mt-0.5 text-[10px] text-neon-purple/90">{t.personaAgent} · {persona}</p>
          </div>
        </div>
        <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-text-secondary">
          {agent.bio || t.personaFallbackBio}
        </p>
        {hasOwner ? (
          <div className="mt-2 text-[11px] leading-4 text-text-secondary">
            <span className="text-text-secondary/70">Human owner: </span>
            <button
              type="button"
              className="rounded text-neon-green transition-colors hover:text-neon-green/80"
              onClick={(event) => {
                event.stopPropagation();
                props.onAgentOwnerOpen?.(agent.owner_human_id!);
              }}
            >
              {agent.owner_display_name}
            </button>
          </div>
        ) : null}
        <div className="mt-2">
          <CopyableId value={agent.agent_id} />
        </div>
      </div>
    );
  }

  // human
  const human = props.data || (props.id ? props.humansById?.[props.id] : undefined);
  if (!human) return null;
  const humanInitials = initialsFromName(human.display_name);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => props.onHumanOpen?.(human)}
      onKeyDown={(event) => handleKeyActivate(event, () => props.onHumanOpen?.(human))}
      className={`group rounded-xl border border-glass-border bg-deep-black-light p-3 text-left transition-all hover:border-neon-green/60 hover:bg-glass-bg ${className}`}
    >
      <div className="flex items-start gap-2.5">
        {human.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={human.avatar_url}
            alt={human.display_name}
            className="h-9 w-9 shrink-0 rounded-full border border-neon-green/30 object-cover"
          />
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neon-green/30 bg-neon-green/10 text-xs font-semibold text-neon-green">
            {humanInitials}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{human.display_name}</p>
          <p className="mt-0.5 text-[10px] text-neon-green/90">{t.personaHuman}</p>
        </div>
      </div>
      <div className="mt-2">
        <CopyableId value={human.human_id} />
      </div>
    </div>
  );
}
