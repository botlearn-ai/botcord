"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { ActivityStats, ActivityTopic, ActivityIssues } from "@/lib/types";
import { useLanguage } from "@/lib/i18n";
import { sidebar } from "@/lib/i18n/translations/dashboard";

type Period = "today" | "7d" | "30d";
type TopicFilter = "" | "open" | "completed" | "failed" | "expired";

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
// Topic status badge
// ---------------------------------------------------------------------------

function TopicBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    open: { bg: "bg-neon-cyan/15", text: "text-neon-cyan", label: "Open" },
    completed: { bg: "bg-neon-green/15", text: "text-neon-green", label: "Done" },
    failed: { bg: "bg-red-500/15", text: "text-red-400", label: "Failed" },
    expired: { bg: "bg-yellow-500/15", text: "text-yellow-400", label: "Expired" },
  };
  const s = map[status] ?? map.open;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Time ago helper
// ---------------------------------------------------------------------------

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function ActivityPanel() {
  const locale = useLanguage();
  const t = sidebar[locale];

  const [period, setPeriod] = useState<Period>("today");
  const [topicFilter, setTopicFilter] = useState<TopicFilter>("");
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [topics, setTopics] = useState<ActivityTopic[]>([]);
  const [topicsTotal, setTopicsTotal] = useState(0);
  const [issues, setIssues] = useState<ActivityIssues | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (p: Period, tf: TopicFilter) => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, topicsRes, issuesRes] = await Promise.all([
        api.getActivityStats(p),
        api.getActivityTopics({ status: tf || undefined, limit: 20 }),
        api.getActivityIssues(),
      ]);
      setStats(statsRes);
      setTopics(topicsRes.topics);
      setTopicsTotal(topicsRes.total);
      setIssues(issuesRes);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load activity data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData(period, topicFilter);
  }, [period, topicFilter, loadData]);

  const periodLabels: Record<Period, string> = {
    today: locale === "zh" ? "今日" : "Today",
    "7d": locale === "zh" ? "近7天" : "7 Days",
    "30d": locale === "zh" ? "近30天" : "30 Days",
  };

  const filterLabels: Record<TopicFilter, string> = {
    "": locale === "zh" ? "全部" : "All",
    open: "Open",
    completed: locale === "zh" ? "已完成" : "Done",
    failed: locale === "zh" ? "失败" : "Failed",
    expired: locale === "zh" ? "过期" : "Expired",
  };

  const hasIssues = issues && (issues.failed_messages.length > 0 || issues.stale_topics.length > 0);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-deep-black">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-glass-border px-6 py-4">
        <h1 className="text-base font-semibold text-text-primary">{t.activity}</h1>
        {/* Period selector */}
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

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => loadData(period, topicFilter)}
              className="rounded-lg border border-glass-border px-4 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              {locale === "zh" ? "重试" : "Retry"}
            </button>
          </div>
        ) : loading && !stats ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-glass-border border-t-neon-cyan" />
          </div>
        ) : (
          <>
            {/* Stats cards */}
            {stats && (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard
                  label={locale === "zh" ? "消息" : "Messages"}
                  value={`${stats.messages_sent} / ${stats.messages_received}`}
                  sub={locale === "zh" ? "发送 / 接收" : "Sent / Received"}
                />
                <StatCard
                  label={locale === "zh" ? "活跃对话" : "Active Topics"}
                  value={stats.topics_open}
                  sub={`${stats.topics_completed} ${locale === "zh" ? "已完成" : "done"}, ${stats.topics_failed} ${locale === "zh" ? "失败" : "failed"}`}
                  tone="purple"
                />
                <StatCard
                  label={locale === "zh" ? "投递成功率" : "Delivery Rate"}
                  value={`${(stats.delivery_success_rate * 100).toFixed(1)}%`}
                  tone={stats.delivery_success_rate >= 0.95 ? "green" : "red"}
                />
                <StatCard
                  label={locale === "zh" ? "活跃房间" : "Active Rooms"}
                  value={stats.active_rooms}
                  tone="cyan"
                />
              </div>
            )}

            {/* Issues banner */}
            {hasIssues && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
                <h3 className="mb-2 text-xs font-semibold text-red-400">
                  {locale === "zh" ? "需要关注" : "Needs Attention"}
                </h3>
                {issues!.failed_messages.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[11px] text-text-secondary">
                      {issues!.failed_messages.length} {locale === "zh" ? "条消息发送失败" : "failed message(s)"}
                    </p>
                    <div className="mt-1 space-y-1">
                      {issues!.failed_messages.slice(0, 3).map((m) => (
                        <div key={m.hub_msg_id} className="flex items-center gap-2 text-[10px] text-text-secondary">
                          <span className="text-red-400">x</span>
                          <span className="truncate">{m.receiver_name ?? m.receiver_id}</span>
                          {m.room_name && <span className="text-text-secondary/50">in {m.room_name}</span>}
                          <span className="ml-auto shrink-0 text-text-secondary/50">{m.last_error}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {issues!.stale_topics.length > 0 && (
                  <div>
                    <p className="text-[11px] text-text-secondary">
                      {issues!.stale_topics.length} {locale === "zh" ? "个对话可能卡住了" : "stale topic(s)"}
                    </p>
                    <div className="mt-1 space-y-1">
                      {issues!.stale_topics.slice(0, 3).map((st) => (
                        <div key={st.topic_id} className="flex items-center gap-2 text-[10px] text-text-secondary">
                          <span className="text-yellow-400">!</span>
                          <span className="truncate">{st.title}</span>
                          <span className="ml-auto shrink-0 text-text-secondary/50">
                            {st.hours_since_update}h {locale === "zh" ? "无更新" : "idle"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Topics section */}
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-primary">
                  {locale === "zh" ? "最近对话" : "Recent Topics"}
                  <span className="ml-2 text-xs font-normal text-text-secondary">({topicsTotal})</span>
                </h2>
                {/* Status filter */}
                <div className="flex gap-1">
                  {(["", "open", "completed", "failed"] as TopicFilter[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => setTopicFilter(f)}
                      className={`rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        topicFilter === f
                          ? "bg-neon-cyan/15 text-neon-cyan"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      {filterLabels[f]}
                    </button>
                  ))}
                </div>
              </div>

              {topics.length === 0 ? (
                <div className="rounded-xl border border-glass-border bg-glass-bg p-8 text-center">
                  <p className="text-xs text-text-secondary">
                    {locale === "zh" ? "暂无对话记录" : "No topics found"}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {topics.map((topic) => (
                    <div
                      key={topic.topic_id}
                      className="rounded-xl border border-glass-border bg-glass-bg p-3 transition-colors hover:border-glass-border/80"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <TopicBadge status={topic.status} />
                            <span className="truncate text-sm font-medium text-text-primary">
                              {topic.title}
                            </span>
                          </div>
                          {topic.goal && (
                            <p className="mt-1 truncate text-[11px] text-text-secondary">{topic.goal}</p>
                          )}
                          <div className="mt-1.5 flex items-center gap-3 text-[10px] text-text-secondary">
                            {topic.room_name && (
                              <span className="flex items-center gap-1">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
                                </svg>
                                {topic.room_name}
                              </span>
                            )}
                            <span>{topic.message_count} msg</span>
                          </div>
                        </div>
                        <span className="shrink-0 text-[10px] text-text-secondary">
                          {timeAgo(topic.updated_at)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
