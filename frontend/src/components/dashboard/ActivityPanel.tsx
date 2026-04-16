"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { ActivityStats, ActivityFeedItem } from "@/lib/types";
import { useLanguage } from "@/lib/i18n";
import { sidebar } from "@/lib/i18n/translations/dashboard";

type Period = "today" | "7d" | "30d";

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  tone = "cyan",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "cyan" | "green" | "red" | "purple";
}) {
  const toneMap = {
    cyan: "text-neon-cyan",
    green: "text-neon-green",
    red: "text-red-400",
    purple: "text-neon-purple",
  };
  return (
    <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
        {label}
      </p>
      <p className={`font-mono text-lg font-semibold ${toneMap[tone]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-text-secondary">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feed item icon + description
// ---------------------------------------------------------------------------

const EVENT_CONFIG: Record<string, { icon: string; color: string }> = {
  message_sent: { icon: "\u2197", color: "text-neon-cyan" },
  message_received: { icon: "\u2199", color: "text-neon-green" },
  message_failed: { icon: "\u2715", color: "text-red-400" },
  topic_created: { icon: "+", color: "text-neon-purple" },
  topic_completed: { icon: "\u2713", color: "text-neon-green" },
  topic_failed: { icon: "\u2715", color: "text-red-400" },
  topic_expired: { icon: "\u23F1", color: "text-yellow-400" },
};

function feedTitle(item: ActivityFeedItem, zh: boolean): string {
  const name = item.agent_name ?? item.agent_id ?? "?";
  const topicTitle = item.meta?.topic_title;
  const count = item.count;

  switch (item.type) {
    case "message_sent":
      if (count > 1)
        return zh
          ? `\u7ED9 ${name} \u53D1\u9001\u4E86 ${count} \u6761\u6D88\u606F`
          : `Sent ${count} messages to ${name}`;
      return zh
        ? `\u7ED9 ${name} \u53D1\u9001\u4E86\u6D88\u606F`
        : `Sent a message to ${name}`;
    case "message_received":
      if (count > 1)
        return zh
          ? `\u6536\u5230 ${name} \u7684 ${count} \u6761\u6D88\u606F`
          : `Received ${count} messages from ${name}`;
      return zh
        ? `\u6536\u5230 ${name} \u7684\u6D88\u606F`
        : `Received a message from ${name}`;
    case "message_failed":
      return zh
        ? `\u53D1\u9001\u7ED9 ${name} \u7684\u6D88\u606F\u5931\u8D25\u4E86`
        : `Message to ${name} failed`;
    case "topic_created":
      return zh
        ? `\u53D1\u8D77\u4E86\u5BF9\u8BDD\u300C${topicTitle}\u300D`
        : `Started topic \u201C${topicTitle}\u201D`;
    case "topic_completed":
      return zh
        ? `\u5BF9\u8BDD\u300C${topicTitle}\u300D\u5DF2\u5B8C\u6210`
        : `Topic \u201C${topicTitle}\u201D completed`;
    case "topic_failed":
      return zh
        ? `\u5BF9\u8BDD\u300C${topicTitle}\u300D\u5931\u8D25\u4E86`
        : `Topic \u201C${topicTitle}\u201D failed`;
    case "topic_expired":
      return zh
        ? `\u5BF9\u8BDD\u300C${topicTitle}\u300D\u5DF2\u8FC7\u671F`
        : `Topic \u201C${topicTitle}\u201D expired`;
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Time ago
// ---------------------------------------------------------------------------

function timeAgo(iso: string | null, zh: boolean): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return zh ? "\u521A\u521A" : "just now";
  if (mins < 60) return zh ? `${mins} \u5206\u949F\u524D` : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return zh ? `${hrs} \u5C0F\u65F6\u524D` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return zh ? `${days} \u5929\u524D` : `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Feed item component
// ---------------------------------------------------------------------------

function FeedItem({ item, zh }: { item: ActivityFeedItem; zh: boolean }) {
  const ev = EVENT_CONFIG[item.type] ?? EVENT_CONFIG.message_sent;
  const subtitle = item.room_name
    ? zh
      ? `\u5728 ${item.room_name}`
      : `in ${item.room_name}`
    : null;

  return (
    <div className="flex gap-3 rounded-xl border border-glass-border bg-glass-bg p-3 transition-colors hover:border-glass-border/80">
      {/* Icon */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-glass-bg text-sm font-bold ${ev.color}`}
      >
        {ev.icon}
      </div>
      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-primary">{feedTitle(item, zh)}</p>
        {item.preview && (
          <p className="mt-0.5 truncate text-[11px] text-text-secondary">
            \u300C{item.preview}\u300D
          </p>
        )}
        <div className="mt-1 flex items-center gap-3 text-[10px] text-text-secondary">
          {subtitle && <span>{subtitle}</span>}
          {item.type === "message_failed" && item.meta?.error && (
            <span className="text-red-400/70">{item.meta.error}</span>
          )}
          {(item.type === "topic_completed" ||
            item.type === "topic_created") &&
            item.count > 0 && (
              <span>
                {item.count} {zh ? "\u6761\u6D88\u606F" : "msgs"}
              </span>
            )}
        </div>
      </div>
      {/* Timestamp */}
      <span className="shrink-0 pt-0.5 text-[10px] text-text-secondary">
        {timeAgo(item.timestamp, zh)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function ActivityPanel() {
  const locale = useLanguage();
  const zh = locale === "zh";
  const t = sidebar[locale];

  const [period, setPeriod] = useState<Period>("today");
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [feed, setFeed] = useState<ActivityFeedItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(
    async (p: Period) => {
      setLoading(true);
      setError(null);
      try {
        const [statsRes, feedRes] = await Promise.all([
          api.getActivityStats(p),
          api.getActivityFeed({ period: p, limit: 30 }),
        ]);
        setStats(statsRes);
        setFeed(feedRes.items);
        setHasMore(feedRes.has_more);
      } catch (err: any) {
        setError(err?.message ?? "Failed to load");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadData(period);
  }, [period, loadData]);

  const periodLabels: Record<Period, string> = {
    today: zh ? "\u4ECA\u65E5" : "Today",
    "7d": zh ? "\u8FD17\u5929" : "7 Days",
    "30d": zh ? "\u8FD130\u5929" : "30 Days",
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-deep-black">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-glass-border px-6 py-4">
        <h1 className="text-base font-semibold text-text-primary">
          {t.activity}
        </h1>
        <div className="flex gap-1 rounded-lg border border-glass-border bg-glass-bg p-0.5">
          {(["today", "7d", "30d"] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                period === p
                  ? "bg-neon-cyan/15 text-neon-cyan"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {periodLabels[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => loadData(period)}
              className="rounded-lg border border-glass-border px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              {zh ? "\u91CD\u8BD5" : "Retry"}
            </button>
          </div>
        ) : loading && !stats ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-glass-border border-t-neon-cyan" />
          </div>
        ) : (
          <>
            {/* Stats */}
            {stats && (
              <div className="grid grid-cols-3 gap-3">
                <StatCard
                  label={zh ? "\u5BF9\u8BDD" : "Conversations"}
                  value={stats.messages_sent + stats.messages_received}
                  sub={`${stats.messages_sent} ${zh ? "\u53D1\u9001" : "sent"} / ${stats.messages_received} ${zh ? "\u63A5\u6536" : "recv"}`}
                />
                <StatCard
                  label={zh ? "\u8FDB\u884C\u4E2D" : "In Progress"}
                  value={stats.topics_open}
                  sub={`${stats.topics_completed} ${zh ? "\u5DF2\u5B8C\u6210" : "done"}`}
                  tone="purple"
                />
                <StatCard
                  label={zh ? "\u6D3B\u8DC3\u7FA4\u7EC4" : "Active Groups"}
                  value={stats.active_rooms}
                  tone="green"
                />
              </div>
            )}

            {/* Feed */}
            <div>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">
                {zh ? "\u6700\u8FD1\u52A8\u6001" : "Recent Activity"}
              </h2>
              {feed.length === 0 ? (
                <div className="rounded-xl border border-glass-border bg-glass-bg p-8 text-center">
                  <p className="text-xs text-text-secondary">
                    {zh ? "\u6682\u65E0\u52A8\u6001" : "No activity yet"}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {feed.map((item, i) => (
                    <FeedItem
                      key={`${item.type}-${item.timestamp}-${i}`}
                      item={item}
                      zh={zh}
                    />
                  ))}
                  {hasMore && (
                    <p className="pt-2 text-center text-[10px] text-text-secondary">
                      {zh
                        ? "\u6EDA\u52A8\u67E5\u770B\u66F4\u591A\u2026"
                        : "Scroll for more\u2026"}
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
