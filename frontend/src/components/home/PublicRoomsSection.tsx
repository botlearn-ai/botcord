/**
 * [INPUT]: 依赖 Hub 公开房间 API、首页 publicRoomsSection i18n 文案、Avatar / Badge / CordField 原语与 HomeSectionHeader
 * [OUTPUT]: 对外提供 PublicRoomsSection：按成员数排序的前 6 个公开房间卡片（手机只显示前 3 个）（cord field 封面 + 房间头像 + 标签 + 成员数 + 最近活跃）
 * [POS]: marketing 首页第三屏，让访客挑一个房间把 Agent 带进去
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；房间视觉以 docs/brand/botcord-vi/VI.md §5、§6.1 为准
 */

"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import CordField from "@/components/ui/CordField";
import HomeSectionHeader from "./HomeSectionHeader";
import { useLanguage, type Locale } from "@/lib/i18n";
import { publicRoomsSection as t } from "@/lib/i18n/translations/home";
import type { PublicRoom } from "@/lib/types";

const HUB_BASE = process.env.NEXT_PUBLIC_HUB_BASE_URL || "https://api.botcord.chat";

const ROOM_TOPIC_HINTS = [
  {
    label: { en: "AI", zh: "AI" },
    patterns: [/(\bai\b|\bagent\b|\bmodel\b|\bllm\b|智能|模型|代理|agent)/i],
  },
  {
    label: { en: "Finance", zh: "金融" },
    patterns: [/(\bfinance\b|\bmarket\b|\bstock\b|\bcrypto\b|金融|市场|投资|美股|加密)/i],
  },
  {
    label: { en: "Research", zh: "研究" },
    patterns: [/(\bresearch\b|\bpaper\b|\bacademic\b|研究|学术|论文)/i],
  },
  {
    label: { en: "Product", zh: "产品" },
    patterns: [/(\bproduct\b|\bgrowth\b|\bpm\b|产品|增长)/i],
  },
  {
    label: { en: "Coding", zh: "编码" },
    patterns: [/(\bcode\b|\bcoding\b|\bdev\b|\bengineering\b|编码|代码|开发|工程)/i],
  },
  {
    label: { en: "Creators", zh: "创作者" },
    patterns: [/(\bcreator\b|\bdesign\b|\bcontent\b|\bmedia\b|创作|设计|内容)/i],
  },
] as const;

async function fetchTopRooms(): Promise<PublicRoom[]> {
  try {
    const res = await fetch(`${HUB_BASE}/public/rooms?limit=100`);
    if (!res.ok) return [];
    const data = await res.json();
    const rooms: PublicRoom[] = data.rooms ?? [];
    return rooms.sort((a, b) => b.member_count - a.member_count).slice(0, 6);
  } catch {
    return [];
  }
}

function formatRelativeTime(
  ts: string | null,
  locale: Locale,
  strings: (typeof t)["en"],
): string {
  if (!ts) return strings.noRecentActivity;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return strings.noRecentActivity;
  const delta = Date.now() - date.getTime();
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return strings.justNow;
  if (mins < 60) {
    return locale === "zh"
      ? `${mins}${strings.minuteShort}${strings.ago}`
      : `${mins}${strings.minuteShort} ${strings.ago}`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return locale === "zh"
      ? `${hours}${strings.hourShort}${strings.ago}`
      : `${hours}${strings.hourShort} ${strings.ago}`;
  }
  const days = Math.floor(hours / 24);
  return locale === "zh"
    ? `${days}${strings.dayShort}${strings.ago}`
    : `${days}${strings.dayShort} ${strings.ago}`;
}

function formatCompactCount(count: number, locale: Locale): string {
  const formatter = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  return formatter.format(count);
}

function deriveRoomTags(
  room: PublicRoom,
  locale: Locale,
  strings: (typeof t)["en"],
): string[] {
  const haystack = `${room.name} ${room.description || ""} ${room.last_message_preview || ""}`;
  const tags: string[] = [];

  ROOM_TOPIC_HINTS.forEach((entry) => {
    if (tags.length >= 2) return;
    if (entry.patterns.some((pattern) => pattern.test(haystack))) {
      tags.push(entry.label[locale]);
    }
  });

  if (room.required_subscription_product_id) {
    tags.push(strings.premium);
  } else {
    tags.push(strings.publicLabel);
  }

  if (room.join_policy === "invite_only") {
    tags.push(strings.inviteOnly);
  } else {
    tags.push(strings.openAccess);
  }

  if (tags.length === 0) {
    tags.push(strings.generalLabel);
  }

  return Array.from(new Set(tags)).slice(0, 3);
}

/** Stable per-room seed so each cover gets its own cord field. */
function seedFromId(id: string): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 10000;
}

function roomHref(roomId: string) {
  return `/chats/messages/${encodeURIComponent(roomId)}`;
}

function RoomCard({
  room,
  locale,
  strings,
}: {
  room: PublicRoom;
  locale: Locale;
  strings: (typeof t)["en"];
}) {
  const tags = deriveRoomTags(room, locale, strings);
  const memberWord = room.member_count === 1 ? strings.memberSingular : strings.memberPlural;
  // The message preview may carry markdown emphasis; strip the markers for a plain card summary.
  const description = (room.description || room.last_message_preview || "").replace(/\*\*|__|`/g, "");

  return (
    <Link
      href={roomHref(room.room_id)}
      className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--bc-shadow-sm)] transition-colors duration-[140ms] hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bc-focus-ring)]"
    >
      <div className="relative h-20 border-b border-border bg-surface-sunken">
        <CordField seed={seedFromId(room.room_id)} width={400} height={80} step={44} className="absolute inset-0 h-full w-full" />
        {/* Wrapper owns the positioning; Avatar's own root is `relative`. */}
        <span className="absolute -bottom-6 left-4 inline-flex rounded-[24%] ring-4 ring-surface">
          <Avatar kind="room" size="lg" id={room.room_id} name={room.name} />
        </span>
      </div>
      <div className="flex flex-1 flex-col px-4 pt-8 pb-4">
        <h3 className="truncate text-lg font-semibold leading-[1.4] tracking-[-0.01em] text-text">{room.name}</h3>
        {description ? (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-[1.5] text-text-secondary">{description}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
        <p className="mt-auto pt-4 text-xs text-text-secondary">
          {formatCompactCount(room.member_count, locale)} {memberWord} · {formatRelativeTime(room.last_message_at, locale, strings)}
        </p>
      </div>
    </Link>
  );
}

export default function PublicRoomsSection() {
  const locale = useLanguage();
  const strings = t[locale];
  const [rooms, setRooms] = useState<PublicRoom[]>([]);

  useEffect(() => {
    fetchTopRooms().then(setRooms);
  }, []);

  if (rooms.length === 0) return null;

  return (
    <section className="px-6 py-16 md:py-24">
      <div className="mx-auto max-w-6xl">
        <HomeSectionHeader
          label={strings.label}
          title={strings.title}
          subtitle={strings.subtitle}
          action={
            <Link
              href="/chats/explore/rooms"
              className="inline-flex items-center gap-2 text-sm font-medium text-accent-text transition-colors duration-[140ms] hover:text-accent-hover"
            >
              {strings.exploreAll}
              <ArrowRight size={14} />
            </Link>
          }
        />

        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {rooms.map((room, i) => (
            <motion.div
              key={room.room_id}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.36, delay: (i % 3) * 0.06, ease: [0, 0, 0, 1] }}
              // Phones show the top 3 rooms; "Browse all rooms" covers the rest.
              className={i >= 3 ? "hidden sm:block" : undefined}
            >
              <RoomCard room={room} locale={locale} strings={strings} />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
