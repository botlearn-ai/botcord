"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { initialsFromName, themeFromRoomName } from "@/components/dashboard/roomVisualTheme";
import SectionHeading from "@/components/ui/SectionHeading";
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
    return rooms.sort((a, b) => b.member_count - a.member_count).slice(0, 10);
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

function buildCoverStyle(room: PublicRoom) {
  const theme = themeFromRoomName(room.name || room.room_id);
  return {
    theme,
    style: {
      backgroundImage: `linear-gradient(135deg, ${theme.accentDim}, rgba(10,10,15,0.28)), ${theme.patternUrl}`,
      backgroundRepeat: "no-repeat, repeat",
      backgroundSize: "cover, auto",
    } as const,
  };
}

function roomHref(roomId: string) {
  return `/chats/messages/${encodeURIComponent(roomId)}`;
}

function FeaturedRoomCard({
  room,
  locale,
  strings,
}: {
  room: PublicRoom;
  locale: Locale;
  strings: (typeof t)["en"];
}) {
  const { theme, style } = buildCoverStyle(room);
  const tags = deriveRoomTags(room, locale, strings);
  const memberWord =
    room.member_count === 1 ? strings.memberSingular : strings.memberPlural;

  return (
    <Link href={roomHref(room.room_id)} className="group block h-full">
      <article
        className="flex h-full min-h-[320px] flex-col overflow-hidden rounded-[28px] border border-glass-border bg-deep-black-light/85 transition-all duration-300 hover:-translate-y-1 hover:border-neon-cyan/45"
        style={{ boxShadow: `0 0 0 1px ${theme.accent}14, 0 18px 44px rgba(0, 0, 0, 0.22)` }}
      >
        <div className="relative min-h-[156px] px-5 py-5" style={style}>
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-deep-black/10 to-deep-black/60" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="inline-flex items-center gap-3">
              <div
                className="flex h-11 w-11 items-center justify-center rounded-2xl text-sm font-bold text-white/95 backdrop-blur-sm"
                style={{ background: theme.accentDim, boxShadow: `0 0 0 1px ${theme.accent}66` }}
              >
                {initialsFromName(room.name || "Room")}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-white/75">
                  {strings.featuredLabel}
                </p>
                <p className="mt-1 text-sm text-white/90">
                  {formatCompactCount(room.member_count, locale)} {memberWord}
                </p>
              </div>
            </div>

            <span
              className="rounded-full px-3 py-1 text-[11px] font-medium text-white/90 backdrop-blur-sm"
              style={{ background: "rgba(0,0,0,0.32)", boxShadow: `0 0 0 1px ${theme.accent}55` }}
            >
              {formatRelativeTime(room.last_message_at, locale, strings)}
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-5 py-4">
          <h3 className="text-[1.35rem] font-semibold leading-tight text-text-primary">
            {room.name}
          </h3>
          <p className="mt-2.5 line-clamp-3 max-w-[38rem] text-sm leading-6 text-text-secondary">
            {room.description || room.last_message_preview || strings.noRecentActivity}
          </p>

          <div className="mt-3.5 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <span
                key={`${room.room_id}-${tag}`}
                className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-text-secondary"
              >
                {tag}
              </span>
            ))}
          </div>

          <div className="mt-auto pt-4">
            <div className="rounded-[20px] border border-white/8 bg-white/[0.03] p-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-text-secondary/65">
                {room.last_sender_name || strings.featuredLabel}
              </p>
              <p className="mt-2 line-clamp-2 text-sm leading-[1.35rem] text-text-secondary">
                {room.last_message_preview || room.description || strings.noRecentActivity}
              </p>
            </div>
          </div>
        </div>
      </article>
    </Link>
  );
}

function SpotlightRoomCard({
  room,
  locale,
  strings,
}: {
  room: PublicRoom;
  locale: Locale;
  strings: (typeof t)["en"];
}) {
  const { theme, style } = buildCoverStyle(room);
  const tags = deriveRoomTags(room, locale, strings);
  const memberWord =
    room.member_count === 1 ? strings.memberSingular : strings.memberPlural;

  return (
    <Link href={roomHref(room.room_id)} className="group block h-full">
      <article
        className="flex h-full min-h-[156px] flex-col overflow-hidden rounded-[24px] border border-glass-border bg-deep-black-light/82 transition-all duration-300 hover:-translate-y-1 hover:border-neon-cyan/35"
        style={{ boxShadow: `0 0 0 1px ${theme.accent}12, 0 14px 32px rgba(0, 0, 0, 0.18)` }}
      >
        <div className="relative h-[84px] px-4 py-3.5" style={style}>
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-deep-black/60" />
          <div className="relative flex items-start justify-between gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl text-xs font-bold text-white/90 backdrop-blur-sm"
              style={{ background: theme.accentDim, boxShadow: `0 0 0 1px ${theme.accent}55` }}
            >
              {initialsFromName(room.name || "Room")}
            </div>
            <span
              className="rounded-full bg-black/30 px-2.5 py-1 text-[10px] font-medium text-white/85 backdrop-blur-sm"
              style={{ boxShadow: `0 0 0 1px ${theme.accent}44` }}
            >
              {formatCompactCount(room.member_count, locale)} {memberWord}
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-4 py-3.5">
          <h3 className="truncate text-[1rem] font-semibold text-text-primary">
            {room.name}
          </h3>
          <p className="mt-2 line-clamp-2 text-sm leading-[1.35rem] text-text-secondary">
            {room.description || room.last_message_preview || strings.noRecentActivity}
          </p>

          <div className="mt-auto flex items-center justify-between gap-3 pt-3.5">
            <div className="flex flex-wrap gap-2">
              {tags.slice(0, 2).map((tag) => (
                <span
                  key={`${room.room_id}-${tag}`}
                  className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] text-text-secondary"
                >
                  {tag}
                </span>
              ))}
            </div>
            <span className="shrink-0 text-[10px] text-text-secondary/70">
              {formatRelativeTime(room.last_message_at, locale, strings)}
            </span>
          </div>
        </div>
      </article>
    </Link>
  );
}

function CompactRoomCard({
  room,
  locale,
  strings,
}: {
  room: PublicRoom;
  locale: Locale;
  strings: (typeof t)["en"];
}) {
  const { theme, style } = buildCoverStyle(room);
  const tags = deriveRoomTags(room, locale, strings);
  const memberWord =
    room.member_count === 1 ? strings.memberSingular : strings.memberPlural;

  return (
    <Link href={roomHref(room.room_id)} className="group block h-full">
      <article
        className="flex h-full flex-col overflow-hidden rounded-[22px] border border-glass-border bg-deep-black-light/80 transition-all duration-300 hover:-translate-y-1 hover:border-neon-cyan/30"
        style={{ boxShadow: `0 0 0 1px ${theme.accent}10, 0 12px 28px rgba(0, 0, 0, 0.15)` }}
      >
        <div className="relative h-14 px-3.5 py-2.5" style={style}>
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-deep-black/55" />
          <div className="relative flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2.5">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[11px] font-bold text-white/90"
                style={{ background: theme.accentDim, boxShadow: `0 0 0 1px ${theme.accent}55` }}
              >
                {initialsFromName(room.name || "Room")}
              </div>
              <span className="text-[10px] font-medium text-white/80">
                {formatCompactCount(room.member_count, locale)} {memberWord}
              </span>
            </div>
            <span className="text-[10px] text-white/75">
              {formatRelativeTime(room.last_message_at, locale, strings)}
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-3.5 py-3.5">
          <h3 className="truncate text-sm font-semibold text-text-primary">
            {room.name}
          </h3>
          <p className="mt-2 line-clamp-2 text-[12px] leading-[1.35rem] text-text-secondary">
            {room.description || room.last_message_preview || strings.noRecentActivity}
          </p>

          <div className="mt-auto flex flex-wrap gap-2 pt-2.5">
            {tags.slice(0, 3).map((tag) => (
              <span
                key={`${room.room_id}-${tag}`}
                className="rounded-full border border-white/8 bg-white/[0.04] px-2 py-0.5 text-[10px] text-text-secondary/85"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      </article>
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

  const featuredRoom = rooms[0];
  const spotlightRooms = rooms.slice(1, 3);
  const compactRooms = rooms.slice(3, 9);

  return (
    <section className="px-6 pt-10 pb-24">
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          title={strings.title}
          subtitle={strings.subtitle}
          accentColor="cyan"
        />

        {featuredRoom ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.6 }}
            className="grid gap-4 lg:grid-cols-[minmax(0,1.22fr)_minmax(280px,0.9fr)]"
          >
            <FeaturedRoomCard
              room={featuredRoom}
              locale={locale}
              strings={strings}
            />

            {spotlightRooms.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                {spotlightRooms.map((room, i) => (
                  <motion.div
                    key={room.room_id}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.45, delay: i * 0.08 }}
                  >
                    <SpotlightRoomCard
                      room={room}
                      locale={locale}
                      strings={strings}
                    />
                  </motion.div>
                ))}
              </div>
            ) : null}
          </motion.div>
        ) : null}

        {compactRooms.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.6, delay: 0.08 }}
            className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {compactRooms.map((room, i) => (
              <motion.div
                key={room.room_id}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.04 }}
              >
                <CompactRoomCard room={room} locale={locale} strings={strings} />
              </motion.div>
            ))}
          </motion.div>
        ) : null}

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-8 text-center"
        >
          <Link
            href="/chats/explore/rooms"
            className="inline-flex items-center gap-2 text-sm text-text-secondary transition-colors hover:text-neon-cyan"
          >
            {strings.exploreAll}
            <ArrowRight size={14} />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
