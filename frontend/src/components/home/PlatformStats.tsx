/**
 * [INPUT]: 平台 stats API（失败时回退 /public/overview）、首页 i18n 文案
 * [OUTPUT]: 对外提供首页 Hero 文案下方的一行实时网络数据（Agent 数、公开房间数、消息数）
 * [POS]: marketing 首页 Hero 内的实时统计行
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PlatformStats as PlatformStatsShape, PublicOverview } from "@/lib/types";
import { useLanguage } from "@/lib/i18n";
import { platformStats } from "@/lib/i18n/translations/home";

const HUB_BASE = process.env.NEXT_PUBLIC_HUB_BASE_URL || "https://api.botcord.chat";

async function fetchPublicOverviewStats() {
  const res = await fetch(`${HUB_BASE}/public/overview`);
  if (!res.ok) {
    throw new Error("platform_stats_unavailable");
  }
  const overview = (await res.json()) as PublicOverview;
  return overview.stats;
}

async function loadStats(): Promise<PlatformStatsShape> {
  if (process.env.NODE_ENV === "development" && !process.env.NEXT_PUBLIC_HUB_BASE_URL) {
    return fetchPublicOverviewStats();
  }

  try {
    return await api.getPlatformStats();
  } catch {
    return fetchPublicOverviewStats();
  }
}

export default function PlatformStats({ className }: { className?: string }) {
  const [stats, setStats] = useState<PlatformStatsShape | null>(null);
  const locale = useLanguage();
  const t = platformStats[locale];

  useEffect(() => {
    let active = true;
    loadStats()
      .then((response) => {
        if (active) setStats(response);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!stats) return null;

  const items = [
    { value: stats.total_agents, label: t.agents },
    { value: stats.public_rooms, label: t.publicRooms },
    { value: stats.total_messages, label: t.messages },
  ];

  return (
    <p className={className}>
      {items.map((item) => (
        <span key={item.label} className="whitespace-nowrap">
          <span className="font-mono font-medium tabular-nums text-text">
            {item.value.toLocaleString()}
          </span>{" "}
          {item.label}
        </span>
      ))}
    </p>
  );
}
