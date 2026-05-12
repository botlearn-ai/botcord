"use client";

import { useEffect, useMemo, useState } from "react";
import { CirclePlay, Clock, Loader2, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { userApi } from "@/lib/api";

interface AgentSchedulesTabProps {
  agentId: string;
}

interface AgentSchedule {
  id: string;
  name: string;
  enabled: boolean;
  schedule:
    | { kind: "every"; every_ms: number }
    | { kind: "calendar"; frequency: "daily"; time: string; timezone: string }
    | { kind: "calendar"; frequency: "weekly"; time: string; timezone: string; weekdays: number[] };
  payload: { kind: "agent_turn"; message: string };
  created_by: string;
  next_fire_at?: string | null;
  last_fire_at?: string | null;
}

interface AgentScheduleRun {
  id: string;
  status: string;
  error?: string | null;
  scheduled_for: string;
  completed_at?: string | null;
}

const DEFAULT_MESSAGE = "【BotCord 自主任务】执行本轮工作目标。";
const WEEKDAYS = [
  { value: 0, label: "周一" },
  { value: 1, label: "周二" },
  { value: 2, label: "周三" },
  { value: 3, label: "周四" },
  { value: 4, label: "周五" },
  { value: 5, label: "周六" },
  { value: 6, label: "周日" },
];
const TIME_PATTERN = /^\d{2}:\d{2}$/;

function formatTime(value?: string | null): string {
  if (!value) return "未安排";
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function intervalLabel(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours} 小时`;
  return `${hours.toFixed(1)} 小时`;
}

function timezoneValue(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function scheduleLabel(schedule: AgentSchedule["schedule"]): string {
  if (schedule.kind === "every") return `每 ${intervalLabel(schedule.every_ms)}`;
  if (schedule.frequency === "daily") return `每天 ${schedule.time}`;
  const labels = schedule.weekdays
    .map((day) => WEEKDAYS.find((item) => item.value === day)?.label)
    .filter(Boolean)
    .join("、");
  return `${labels || "每周"} ${schedule.time}`;
}

function statusClass(status?: string): string {
  if (status === "dispatched") return "border-green-400/20 bg-green-400/10 text-green-300";
  if (status === "offline") return "border-yellow-400/20 bg-yellow-400/10 text-yellow-300";
  if (status === "failed") return "border-red-400/20 bg-red-400/10 text-red-300";
  return "border-glass-border bg-glass-bg/60 text-text-secondary";
}

export default function AgentSchedulesTab({ agentId }: AgentSchedulesTabProps) {
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [runsBySchedule, setRunsBySchedule] = useState<Record<string, AgentScheduleRun[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("botcord-auto");
  const [scheduleMode, setScheduleMode] = useState<"every" | "daily" | "weekly">("every");
  const [everyMinutes, setEveryMinutes] = useState(30);
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([0]);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);

  const canCreate = useMemo(
    () =>
      name.trim().length > 0 &&
      message.trim().length > 0 &&
      !saving &&
      ((scheduleMode === "every" && everyMinutes >= 5) ||
        (scheduleMode === "daily" && TIME_PATTERN.test(time)) ||
        (scheduleMode === "weekly" && TIME_PATTERN.test(time) && weekdays.length > 0)),
    [everyMinutes, message, name, saving, scheduleMode, time, weekdays.length],
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await userApi.listAgentSchedules(agentId);
      const rows = (data.schedules || []) as AgentSchedule[];
      setSchedules(rows);
      const runPairs = await Promise.all(
        rows.map(async (row) => {
          try {
            const res = await userApi.listAgentScheduleRuns(agentId, row.id);
            return [row.id, (res.runs || []) as AgentScheduleRun[]] as const;
          } catch {
            return [row.id, []] as const;
          }
        }),
      );
      setRunsBySchedule(Object.fromEntries(runPairs));
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取 schedule 失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function createSchedule() {
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    try {
      const timezone = timezoneValue();
      await userApi.createAgentSchedule(agentId, {
        name: name.trim(),
        enabled: true,
        schedule:
          scheduleMode === "every"
            ? { kind: "every", every_ms: everyMinutes * 60 * 1000 }
            : scheduleMode === "daily"
              ? { kind: "calendar", frequency: "daily", time, timezone }
              : { kind: "calendar", frequency: "weekly", time, timezone, weekdays },
        payload: { kind: "agent_turn", message: message.trim() },
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSaving(false);
    }
  }

  async function patchSchedule(scheduleId: string, body: Parameters<typeof userApi.updateAgentSchedule>[2]) {
    setSaving(true);
    setError(null);
    try {
      await userApi.updateAgentSchedule(agentId, scheduleId, body);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteSchedule(scheduleId: string) {
    setSaving(true);
    setError(null);
    try {
      await userApi.deleteAgentSchedule(agentId, scheduleId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setSaving(false);
    }
  }

  async function runSchedule(scheduleId: string) {
    setSaving(true);
    setError(null);
    try {
      await userApi.runAgentSchedule(agentId, scheduleId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "运行失败");
    } finally {
      setSaving(false);
    }
  }

  function toggleWeekday(day: number) {
    setWeekdays((current) =>
      current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort((a, b) => a - b),
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">自主执行</h3>
          <p className="text-xs text-text-secondary">配置 Agent 定期主动推进目标。</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-glass-border bg-glass-bg text-text-secondary hover:text-text-primary disabled:opacity-60"
          title="刷新"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : null}

      <section className="rounded-xl border border-glass-border bg-glass-bg/40 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">
          <Plus className="h-4 w-4" />
          新建 schedule
        </div>
        <div className="grid gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
            placeholder="名称"
          />
          <div className="grid grid-cols-3 gap-2">
            {(["every", "daily", "weekly"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setScheduleMode(mode)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  scheduleMode === mode
                    ? "border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan"
                    : "border-glass-border bg-deep-black/40 text-text-secondary hover:text-text-primary"
                }`}
              >
                {mode === "every" ? "间隔" : mode === "daily" ? "每天" : "每周"}
              </button>
            ))}
          </div>
          {scheduleMode === "every" ? (
            <label className="grid gap-1 text-xs text-text-secondary">
              间隔分钟
              <input
                type="number"
                min={5}
                step={5}
                value={everyMinutes}
                onChange={(e) => setEveryMinutes(Number(e.target.value))}
                className="rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
              />
            </label>
          ) : (
            <div className="grid gap-3">
              <label className="grid gap-1 text-xs text-text-secondary">
                时间
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
                />
              </label>
              {scheduleMode === "weekly" ? (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                  {WEEKDAYS.map((day) => (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => toggleWeekday(day.value)}
                      className={`rounded-lg border px-2 py-2 text-xs ${
                        weekdays.includes(day.value)
                          ? "border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan"
                          : "border-glass-border bg-deep-black/40 text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            className="resize-none rounded-lg border border-glass-border bg-deep-black/40 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
          />
          <button
            type="button"
            onClick={() => void createSchedule()}
            disabled={!canCreate}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-semibold text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            创建
          </button>
        </div>
      </section>

      {schedules.length === 0 && !loading ? (
        <div className="rounded-xl border border-glass-border bg-glass-bg/40 px-4 py-8 text-center text-sm text-text-secondary">
          暂无 schedule
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => {
            const lastRun = runsBySchedule[schedule.id]?.[0];
            return (
              <section key={schedule.id} className="rounded-xl border border-glass-border bg-glass-bg/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-text-secondary" />
                      <h4 className="truncate text-sm font-semibold text-text-primary">{schedule.name}</h4>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${schedule.enabled ? "border-green-400/20 text-green-300" : "border-glass-border text-text-secondary"}`}>
                        {schedule.enabled ? "启用" : "暂停"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {scheduleLabel(schedule.schedule)} · 下次 {formatTime(schedule.next_fire_at)}
                    </p>
                    <p className="mt-2 line-clamp-2 text-xs text-text-secondary">{schedule.payload.message}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void patchSchedule(schedule.id, { enabled: !schedule.enabled })}
                      disabled={saving}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-glass-border bg-deep-black/40 text-text-secondary hover:text-text-primary disabled:opacity-60"
                      title={schedule.enabled ? "暂停" : "恢复"}
                    >
                      {schedule.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runSchedule(schedule.id)}
                      disabled={saving}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-glass-border bg-deep-black/40 text-text-secondary hover:text-text-primary disabled:opacity-60"
                      title="立即运行"
                    >
                      <CirclePlay className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteSchedule(schedule.id)}
                      disabled={saving}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-400/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-60"
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {lastRun ? (
                  <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${statusClass(lastRun.status)}`}>
                    最近运行：{lastRun.status} · {formatTime(lastRun.completed_at || lastRun.scheduled_for)}
                    {lastRun.error ? ` · ${lastRun.error}` : ""}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
