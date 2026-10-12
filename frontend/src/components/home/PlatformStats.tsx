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

function formatValue(value: number | null) {
  return value !== null ? value.toLocaleString() : "—";
}

function StatColumn({
  label,
  value,
  compact = false,
  withDivider = false,
}: {
  label: string;
  value: number | null;
  compact?: boolean;
  withDivider?: boolean;
}) {
  return (
    <div
      className={[
        "relative min-w-0 text-left",
        compact ? "space-y-0.5" : "space-y-1",
        withDivider ? "sm:border-l sm:border-[var(--bc-border)] sm:pl-4" : "",
      ].join(" ")}
    >
      <p
        className={[
          "tabular-nums font-semibold tracking-[-0.02em] text-[var(--bc-text)]",
          compact ? "text-lg" : "text-[28px] leading-[1.2]",
        ].join(" ")}
      >
        {formatValue(value)}
      </p>
      <p className="text-xs font-medium leading-[1.45] text-[var(--bc-text-secondary)]">
        {label}
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
      },
      {
        label: t.publicRooms,
        value: stats?.public_rooms ?? null,
      },
      {
        label: t.privateRooms,
        value: privateRooms,
      },
      {
        label: t.messagesSent,
        value: stats?.total_messages ?? null,
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
            className="rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface)] px-4 py-4 shadow-[var(--bc-shadow-sm)] sm:px-5 sm:py-5"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2">
                <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--bc-text)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--bc-brand)]" />
                  {t.networkLive}
                </span>
                <p className="max-w-xl text-left text-xs text-[var(--bc-text-secondary)]">
                  {t.title}
                </p>
              </div>

              <div className="hidden items-center gap-2 rounded-full border border-[var(--bc-border)] bg-[var(--bc-surface-sunken)] px-3 py-1 text-xs text-[var(--bc-text-secondary)] sm:flex">
                <span>{t.currentTime}</span>
                <span className="font-mono tabular-nums text-[var(--bc-text)]" suppressHydrationWarning>{formattedTime}</span>
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-4 sm:gap-0">
              {statItems.map((item, index) => (
                <StatColumn
                  key={item.label}
                  label={item.label}
                  value={item.value}
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
            <div className="rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface-raised)] p-3 shadow-[var(--bc-shadow-lg)] sm:p-3.5">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-0">
                {statItems.map((item, index) => (
                  <StatColumn
                    key={`dock-${item.label}`}
                    label={item.label}
                    value={item.value}
                      compact
                    withDivider={index > 0}
                  />
                ))}
              </div>

              <div className="mt-3 flex items-end justify-between border-t border-[var(--bc-border)] pt-2.5 text-[var(--bc-text-secondary)]">
                <span className="inline-flex h-2 w-2 rounded-full bg-[var(--bc-brand)]" />

                <div className="text-right">
                  <p className="text-xs text-[var(--bc-text-tertiary)]">
                    {timeZone || t.currentTime}
                  </p>
                  <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-[var(--bc-text)]" suppressHydrationWarning>
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
