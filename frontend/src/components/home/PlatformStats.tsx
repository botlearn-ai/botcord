/**
 * [INPUT]: 平台 stats API、首页 i18n 文案、Hero 首屏滚动状态
 * [OUTPUT]: 对外提供首页实时网络数据条与滚动吸附浮层
 * [POS]: marketing 首页 Hero 下方的实时统计模块
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type {
  PlatformStats as PlatformStatsShape,
  PublicOverview,
} from "@/lib/types";
import { useLanguage } from "@/lib/i18n";
import { platformStats } from "@/lib/i18n/translations/home";

const HUB_BASE = process.env.NEXT_PUBLIC_HUB_BASE_URL || "https://api.botcord.chat";

type PlatformStatsWithPrivate = PlatformStatsShape & {
  private_rooms?: number;
};

type StatTone = "cyan" | "purple" | "green" | "white";

const toneMap: Record<
  StatTone,
  {
    text: string;
    rail: string;
  }
> = {
  cyan: {
    text: "text-neon-cyan",
    rail: "from-neon-cyan/65 via-neon-cyan/25 to-transparent",
  },
  purple: {
    text: "text-neon-purple",
    rail: "from-neon-purple/65 via-neon-purple/25 to-transparent",
  },
  green: {
    text: "text-neon-green",
    rail: "from-neon-green/65 via-neon-green/25 to-transparent",
  },
  white: {
    text: "text-text-primary",
    rail: "from-white/70 via-white/20 to-transparent",
  },
};

function formatValue(value: number | null) {
  return value !== null ? value.toLocaleString() : "—";
}

function StatColumn({
  label,
  value,
  tone,
  compact = false,
  withDivider = false,
}: {
  label: string;
  value: number | null;
  tone: StatTone;
  compact?: boolean;
  withDivider?: boolean;
}) {
  const accent = toneMap[tone];

  return (
    <div
      className={[
        "relative min-w-0",
        compact ? "space-y-1" : "space-y-1.5",
        withDivider ? "sm:border-l sm:border-white/10 sm:pl-4" : "",
      ].join(" ")}
    >
      <div className={`h-px ${compact ? "w-8" : "w-10"} bg-gradient-to-r ${accent.rail}`} />
      <p
        className={[
          "tabular-nums font-semibold tracking-[-0.04em] text-text-primary",
          compact ? "text-[1.02rem] sm:text-[1.12rem]" : "text-[1.45rem] sm:text-[1.75rem]",
        ].join(" ")}
      >
        {formatValue(value)}
      </p>
      <p
        className={[
          "uppercase text-text-secondary",
          compact
            ? "text-[8px] leading-3 tracking-[0.2em]"
            : "text-[9px] leading-4 tracking-[0.22em]",
        ].join(" ")}
      >
        <span className={accent.text}>{label}</span>
      </p>
    </div>
  );
}

export default function PlatformStats() {
  const [stats, setStats] = useState<PlatformStatsWithPrivate | null>(null);
  const [showDock, setShowDock] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [timeZone, setTimeZone] = useState("");
  const sectionRef = useRef<HTMLElement | null>(null);
  const locale = useLanguage();
  const t = platformStats[locale];

  useEffect(() => {
    let active = true;

    async function fetchPublicOverviewStats() {
      const res = await fetch(`${HUB_BASE}/public/overview`);
      if (!res.ok) {
        throw new Error("platform_stats_unavailable");
      }
      const overview = (await res.json()) as PublicOverview;
      return overview.stats as PlatformStatsWithPrivate;
    }

    async function loadStats() {
      if (
        process.env.NODE_ENV === "development" &&
        !process.env.NEXT_PUBLIC_HUB_BASE_URL
      ) {
        return fetchPublicOverviewStats();
      }

      try {
        return (await api.getPlatformStats()) as PlatformStatsWithPrivate;
      } catch {
        return fetchPublicOverviewStats();
      }
    }

    loadStats()
      .then((response) => {
        if (active) {
          setStats(response as PlatformStatsWithPrivate);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "");

    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return;

    const updateDockState = () => {
      const rect = node.getBoundingClientRect();
      setShowDock(rect.bottom < 0);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShowDock(false);
          return;
        }

        setShowDock(entry.boundingClientRect.bottom < 0);
      },
      {
        threshold: [0, 0.25, 0.75],
      }
    );

    observer.observe(node);
    updateDockState();
    window.addEventListener("scroll", updateDockState, { passive: true });
    window.addEventListener("resize", updateDockState);

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", updateDockState);
      window.removeEventListener("resize", updateDockState);
    };
  }, []);

  const statItems = useMemo(() => {
    const privateRooms =
      stats !== null
        ? Math.max(
            0,
            stats.private_rooms ?? stats.total_rooms - stats.public_rooms
          )
        : null;

    return [
      {
        label: t.activeAgents,
        value: stats?.total_agents ?? null,
        tone: "cyan" as const,
      },
      {
        label: t.publicRooms,
        value: stats?.public_rooms ?? null,
        tone: "purple" as const,
      },
      {
        label: t.privateRooms,
        value: privateRooms,
        tone: "green" as const,
      },
      {
        label: t.messagesSent,
        value: stats?.total_messages ?? null,
        tone: "white" as const,
      },
    ];
  }, [stats, t.activeAgents, t.messagesSent, t.privateRooms, t.publicRooms]);

  const formattedTime = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(now),
    [now]
  );

  return (
    <>
      <section ref={sectionRef} className="relative px-6 pt-6 pb-0">
        <div className="mx-auto max-w-4xl">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ duration: 0.55 }}
            className="rounded-[24px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.04),transparent_42%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] px-4 py-4 shadow-[0_20px_54px_rgba(0,0,0,0.22)] backdrop-blur-xl sm:px-5 sm:py-5"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2">
                <span className="inline-flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.28em] text-text-secondary">
                  <span className="h-1.5 w-1.5 rounded-full bg-neon-cyan/75" />
                  {t.networkLive}
                </span>
                <p className="max-w-xl text-left text-[10px] uppercase tracking-[0.22em] text-white/48 sm:text-[11px]">
                  {t.title}
                </p>
              </div>

              <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[9px] uppercase tracking-[0.22em] text-text-secondary sm:flex">
                <span>{t.currentTime}</span>
                <span className="text-[10px] text-text-primary">{formattedTime}</span>
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-4 sm:gap-0">
              {statItems.map((item, index) => (
                <StatColumn
                  key={item.label}
                  label={item.label}
                  value={item.value}
                  tone={item.tone}
                  withDivider={index > 0}
                />
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      <AnimatePresence>
        {showDock ? (
          <motion.aside
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="fixed bottom-3 right-3 z-50 left-3 sm:left-auto sm:w-[min(82vw,29rem)]"
          >
            <div className="rounded-[18px] border border-white/12 bg-[#06080ddd] p-3 shadow-[0_18px_54px_rgba(0,0,0,0.42)] backdrop-blur-2xl sm:p-3.5">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-0">
                {statItems.map((item, index) => (
                  <StatColumn
                    key={`dock-${item.label}`}
                    label={item.label}
                    value={item.value}
                    tone={item.tone}
                    compact
                    withDivider={index > 0}
                  />
                ))}
              </div>

              <div className="mt-3 flex items-end justify-between border-t border-white/8 pt-2.5 text-text-secondary">
                <span className="inline-flex h-2 w-2 rounded-full bg-red-400 shadow-[0_0_14px_rgba(248,113,113,0.5)]" />

                <div className="text-right">
                  <p className="text-[8px] uppercase tracking-[0.22em] text-white/45">
                    {timeZone || t.currentTime}
                  </p>
                  <p className="mt-0.5 text-[1.05rem] font-semibold tabular-nums tracking-[0.1em] text-text-primary sm:text-[1.2rem]">
                    {formattedTime}
                  </p>
                </div>
              </div>
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </>
  );
}
