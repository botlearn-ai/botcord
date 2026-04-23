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

// FNV-1a 32-bit — stable, short, good spread for short strings.
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

type RoomTheme = {
  patternUrl: string;
  accent: string;
  accentDim: string;
};

const PATTERN_KINDS = ["dots", "grid", "diagonal", "triangles", "waves", "hex"] as const;

function buildPattern(kind: (typeof PATTERN_KINDS)[number], seed: number, color: string): string {
  // Quantize seed-driven params so tiles stay readable.
  const size = 24 + (seed % 20);
  const stroke = (((seed >> 5) % 100) / 100) * 0.6 + 0.4; // 0.4 – 1.0
  const rotate = (seed >> 11) % 360;
  const enc = (s: string) => encodeURIComponent(s).replace(/'/g, "%27").replace(/"/g, "%22");

  let inner = "";
  switch (kind) {
    case "dots": {
      const r = 1 + (seed % 3);
      inner = `<circle cx='${size / 2}' cy='${size / 2}' r='${r}' fill='${color}' fill-opacity='${stroke}'/>`;
      break;
    }
    case "grid": {
      inner = `<path d='M ${size} 0 L 0 0 0 ${size}' stroke='${color}' stroke-width='1' stroke-opacity='${stroke}' fill='none'/>`;
      break;
    }
    case "diagonal": {
      inner = `<path d='M-2,2 l4,-4 M0,${size} l${size},-${size} M${size - 2},${size + 2} l4,-4' stroke='${color}' stroke-width='1.2' stroke-opacity='${stroke}'/>`;
      break;
    }
    case "triangles": {
      const h = size * 0.866;
      inner = `<path d='M0 ${h} L${size / 2} 0 L${size} ${h} Z' fill='none' stroke='${color}' stroke-opacity='${stroke}'/>`;
      break;
    }
    case "waves": {
      const a = 3 + (seed % 4);
      inner = `<path d='M0 ${size / 2} Q ${size / 4} ${size / 2 - a}, ${size / 2} ${size / 2} T ${size} ${size / 2}' stroke='${color}' stroke-opacity='${stroke}' fill='none'/>`;
      break;
    }
    case "hex": {
      const r = size / 3;
      const cx = size / 2;
      const cy = size / 2;
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i;
        return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
      }).join(" ");
      inner = `<polygon points='${pts}' fill='none' stroke='${color}' stroke-opacity='${stroke}'/>`;
      break;
    }
  }

  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>` +
    `<g transform='rotate(${rotate} ${size / 2} ${size / 2})'>${inner}</g>` +
    `</svg>`;
  return `url("data:image/svg+xml;utf8,${enc(svg)}")`;
}

function themeFromName(name: string): RoomTheme {
  const seed = hashString(name || "room");
  const hue1 = seed % 360;
  const hue2 = (hue1 + 40 + ((seed >> 8) % 80)) % 360;
  const kind = PATTERN_KINDS[(seed >> 3) % PATTERN_KINDS.length];
  const angle = (seed >> 17) % 360;

  void angle;
  const patternUrl = buildPattern(kind, seed, `hsl(${hue1} 90% 80%)`);
  return {
    patternUrl,
    accent: `hsl(${hue1} 85% 70%)`,
    accentDim: `hsl(${hue1} 70% 60% / 0.35)`,
  };
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
    const theme = themeFromName(room.name || room.room_id);
    const memberWord = room.member_count === 1 ? t.memberSingular : t.memberPlural;
    const roomInitials = initialsFromName(room.name || "Room");
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => props.onRoomOpen?.(room)}
        onKeyDown={(event) => handleKeyActivate(event, () => props.onRoomOpen?.(room))}
        className={`group overflow-hidden rounded-2xl border border-glass-border bg-deep-black-light text-left transition-all hover:border-neon-cyan/60 hover:shadow-lg hover:shadow-neon-cyan/10 ${className}`}
      >
        <div
          className="relative h-24 w-full"
          style={{
            backgroundImage: `${theme.patternUrl}`,
            backgroundRepeat: "repeat, no-repeat",
            backgroundSize: "auto, cover",
          }}
        >
          <div className="absolute left-4 top-4 flex items-center gap-2">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white/90 backdrop-blur-sm"
              style={{ background: theme.accentDim, boxShadow: `0 0 0 1px ${theme.accent}55` }}
            >
              {roomInitials}
            </div>
          </div>
          <span
            className="absolute right-3 top-3 rounded-full bg-black/40 px-2 py-1 text-[10px] font-medium text-white/90 backdrop-blur-sm"
            style={{ boxShadow: `0 0 0 1px ${theme.accent}55` }}
          >
            {room.member_count} {memberWord}
          </span>
        </div>
        <div className="p-5 pt-3">
          <div className="mb-2 min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-base font-semibold text-text-primary">{room.name}</p>
              {room.required_subscription_product_id && (
                <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
              )}
            </div>
            <p className="mt-0.5 truncate font-mono text-[11px] text-text-secondary/60">{room.room_id}</p>
          </div>
          <p className="line-clamp-2 min-h-[36px] text-xs leading-5 text-text-secondary">
            {room.description || t.noDescriptionYet}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-text-secondary/80">
            <div className="rounded border border-glass-border/60 px-2 py-1">
              {room.join_policy === "invite_only" ? (
                <span className="font-medium text-amber-400">{t.inviteOnly}</span>
              ) : (
                <>{t.visibility}: {room.visibility}</>
              )}
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
        </div>
      </div>
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
    <div
      role="button"
      tabIndex={0}
      onClick={() => props.onAgentOpen?.(agent)}
      onKeyDown={(event) => handleKeyActivate(event, () => props.onAgentOpen?.(agent))}
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
    </div>
  );
}
