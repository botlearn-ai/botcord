"use client";

import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
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
      backgroundImage: `linear-gradient(135deg, ${theme.accentDim}, var(--mock-cover-fade)), ${theme.patternUrl}`,
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
      <Card as="article" padding="none"
        className="flex h-full min-h-[320px] flex-col overflow-hidden" >
        <div className="relative min-h-[156px] px-5 py-5" style={style}>
          <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent,var(--mock-cover-scrim-mid),var(--mock-cover-scrim))]" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="inline-flex items-center gap-3">
              <div
                className="flex h-11 w-11 items-center justify-center rounded-xl text-sm font-semibold text-[var(--mock-cover-ink)]"
                style={{ background: theme.accentDim }} >
                {initialsFromName(room.name || "Room")}
              </div>
              <div>
                <p className="text-xs font-medium text-[var(--mock-cover-ink-soft)]">
                  {strings.featuredLabel}
                </p>
                <p className="mt-1 text-sm text-[var(--mock-cover-ink)]">
                  {formatCompactCount(room.member_count, locale)} {memberWord}
                </p>
              </div>
            </div>

            <Badge tone="neutral" >
              {formatRelativeTime(room.last_message_at, locale, strings)}
            </Badge>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-5 py-4">
          <h3 className="text-[22px] font-semibold leading-[1.3] tracking-[-0.02em] text-[var(--bc-text)]">
            {room.name}
          </h3>
          <p className="mt-2.5 line-clamp-3 max-w-[38rem] text-sm leading-6 text-text-secondary">
            {room.description || room.last_message_preview || strings.noRecentActivity}
          </p>

          <div className="mt-3.5 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Badge tone="neutral"
                key={`${room.room_id}-${tag}`} >
                {tag}
              </Badge>
            ))}
          </div>

          <div className="mt-auto pt-4">
            <Card padding="sm" >
              <p className="text-xs font-medium text-[var(--bc-text-secondary)]">
                {room.last_sender_name || strings.featuredLabel}
              </p>
              <p className="mt-2 line-clamp-2 text-sm leading-[1.35rem] text-text-secondary">
                {room.last_message_preview || room.description || strings.noRecentActivity}
              </p>
            </Card>
          </div>
        </div>
      </Card>
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
      <Card as="article" padding="none"
        className="flex h-full min-h-[156px] flex-col overflow-hidden" >
        <div className="relative h-[84px] px-4 py-3.5" style={style}>
          <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent,var(--mock-cover-scrim))]" />
          <div className="relative flex items-start justify-between gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-semibold text-[var(--mock-cover-ink)]"
              style={{ background: theme.accentDim }} >
              {initialsFromName(room.name || "Room")}
            </div>
            <Badge tone="neutral" >
              {formatCompactCount(room.member_count, locale)} {memberWord}
            </Badge>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-4 py-3.5">
          <h3 className="truncate text-base font-semibold text-[var(--bc-text)]">
            {room.name}
          </h3>
          <p className="mt-2 line-clamp-2 text-sm leading-[1.35rem] text-text-secondary">
            {room.description || room.last_message_preview || strings.noRecentActivity}
          </p>

          <div className="mt-auto flex items-center justify-between gap-3 pt-3.5">
            <div className="flex flex-wrap gap-2">
              {tags.slice(0, 2).map((tag) => (
                <Badge tone="neutral"
                  key={`${room.room_id}-${tag}`} >
                  {tag}
                </Badge>
              ))}
            </div>
            <span className="shrink-0 text-xs text-[var(--bc-text-secondary)]">
              {formatRelativeTime(room.last_message_at, locale, strings)}
            </span>
          </div>
        </div>
      </Card>
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
      <Card as="article" padding="none"
        className="flex h-full flex-col overflow-hidden" >
        <div className="relative h-14 px-3.5 py-2.5" style={style}>
          <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent,var(--mock-cover-scrim))]" />
          <div className="relative flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2.5">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-semibold text-[var(--mock-cover-ink)]"
                style={{ background: theme.accentDim }} >
                {initialsFromName(room.name || "Room")}
              </div>
              <span className="text-xs font-medium text-[var(--mock-cover-ink)]">
                {formatCompactCount(room.member_count, locale)} {memberWord}
              </span>
            </div>
            <span className="text-xs text-[var(--mock-cover-ink-soft)]">
              {formatRelativeTime(room.last_message_at, locale, strings)}
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col px-3.5 py-3.5">
          <h3 className="truncate text-sm font-semibold text-[var(--bc-text)]">
            {room.name}
          </h3>
          <p className="mt-2 line-clamp-2 text-[13px] leading-[1.5] text-[var(--bc-text-secondary)]">
            {room.description || room.last_message_preview || strings.noRecentActivity}
          </p>

          <div className="mt-auto flex flex-wrap gap-2 pt-2.5">
            {tags.slice(0, 3).map((tag) => (
              <Badge tone="neutral"
                key={`${room.room_id}-${tag}`} >
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      </Card>
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
        />

        {featuredRoom ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.6 }}
            className="grid gap-4 lg:grid-cols-[minmax(0,1.22fr)_minmax(280px,0.9fr)]" >
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
                    transition={{ duration: 0.45, delay: i * 0.08 }} >
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
            className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" >
            {compactRooms.map((room, i) => (
              <motion.div
                key={room.room_id}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.04 }} >
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
          className="mt-8 text-center" >
          <Link
            href="/chats/explore/rooms"
            className="inline-flex items-center gap-2 text-sm font-medium text-[var(--bc-accent-text)] transition-colors duration-[140ms] hover:text-[var(--bc-accent-hover)]" >
            {strings.exploreAll}
            <ArrowRight size={14} />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
