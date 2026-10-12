"use client";
import EmptyState from "@/components/ui/EmptyState";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";

import Button from "@/components/ui/Button";
import IconButton from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Input";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CirclePlay, Clock, Loader2, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
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
  session_policy?: ScheduleSessionPolicy;
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
type ScheduleMode = "every" | "daily" | "weekly";
type ScheduleSessionPolicy = "fresh_per_run" | "reuse_per_schedule";
const DEFAULT_SESSION_POLICY: ScheduleSessionPolicy = "fresh_per_run";
const LEGACY_SESSION_POLICY: ScheduleSessionPolicy = "reuse_per_schedule";
const SESSION_POLICY_OPTIONS: Array<{ value: ScheduleSessionPolicy; label: string }> = [
  { value: "fresh_per_run", label: "新建对话" },
  { value: "reuse_per_schedule", label: "沿用对话" },
];

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

function sessionPolicyLabel(policy?: ScheduleSessionPolicy): string {
  const value = policy ?? LEGACY_SESSION_POLICY;
  return SESSION_POLICY_OPTIONS.find((item) => item.value === value)?.label ?? "沿用对话";
}

function statusClass(status?: string): string {
  if (status === "dispatched") return "border-success/20 bg-success-soft text-success";
  if (status === "offline") return "border-warning/20 bg-warning-soft text-warning";
  if (status === "failed") return "border-danger/20 bg-danger-soft text-danger";
  return "border-glass-border bg-glass-bg/60 text-text-secondary";
}

// Secondary history requests must not hold the schedule list or each other hostage.
export async function loadScheduleRunSummaries(
  agentId: string,
  rows: AgentSchedule[],
  onRuns: (scheduleId: string, runs: AgentScheduleRun[]) => void,
  isCurrent: () => boolean,
) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
    while (next < rows.length && isCurrent()) {
      const row = rows[next++];
      try {
        const result = await userApi.listAgentScheduleRuns(agentId, row.id);
        if (isCurrent()) onRuns(row.id, (result.runs || []) as AgentScheduleRun[]);
      } catch {
        // Keep any previously visible summary when one history request fails.
      }
    }
  }));
}

export default function AgentSchedulesTab({ agentId }: AgentSchedulesTabProps) {
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [runsBySchedule, setRunsBySchedule] = useState<Record<string, AgentScheduleRun[]>>({});
  const [loading, setLoading] = useState(true);
  const loadSequence = useRef(0);
  const activeAgent = useRef<string | null>(agentId);
  const [saving, setSaving] = useState(false);
  const [runningScheduleId, setRunningScheduleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [name, setName] = useState("botcord-auto");
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("every");
  const [everyMinutes, setEveryMinutes] = useState(30);
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([0]);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [sessionPolicy, setSessionPolicy] = useState<ScheduleSessionPolicy>(DEFAULT_SESSION_POLICY);

  const canSaveForm = useMemo(
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
    if (activeAgent.current !== agentId) return;
    const sequence = ++loadSequence.current;
    const isCurrent = () => loadSequence.current === sequence;
    setLoading(true);
    setError(null);
    try {
      const data = await userApi.listAgentSchedules(agentId);
      if (!isCurrent()) return;
      const rows = (data.schedules || []) as AgentSchedule[];
      setSchedules(rows);
      void loadScheduleRunSummaries(agentId, rows, (id, runs) => {
        setRunsBySchedule((previous) => ({ ...previous, [id]: runs }));
      }, isCurrent);
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : "读取任务失败");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useLayoutEffect(() => {
    activeAgent.current = agentId;
    resetForm();
    setSchedules([]);
    setRunsBySchedule({});
    void load();
    return () => { activeAgent.current = null; loadSequence.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  function resetForm() {
    setEditingScheduleId(null);
    setName("botcord-auto");
    setScheduleMode("every");
    setEveryMinutes(30);
    setTime("09:00");
    setWeekdays([0]);
    setMessage(DEFAULT_MESSAGE);
    setSessionPolicy(DEFAULT_SESSION_POLICY);
  }

  function buildScheduleBody() {
    const timezone = timezoneValue();
    return {
      name: name.trim(),
      schedule:
        scheduleMode === "every"
          ? { kind: "every" as const, every_ms: everyMinutes * 60 * 1000 }
          : scheduleMode === "daily"
            ? { kind: "calendar" as const, frequency: "daily" as const, time, timezone }
            : { kind: "calendar" as const, frequency: "weekly" as const, time, timezone, weekdays },
      payload: { kind: "agent_turn" as const, message: message.trim() },
      session_policy: sessionPolicy,
    };
  }

  function startEdit(schedule: AgentSchedule) {
    setEditingScheduleId(schedule.id);
    setName(schedule.name);
    setMessage(schedule.payload.message);
    setSessionPolicy(schedule.session_policy ?? LEGACY_SESSION_POLICY);
    if (schedule.schedule.kind === "every") {
      setScheduleMode("every");
      setEveryMinutes(Math.max(5, Math.round(schedule.schedule.every_ms / 60000)));
      return;
    }
    setTime(schedule.schedule.time);
    if (schedule.schedule.frequency === "daily") {
      setScheduleMode("daily");
      return;
    }
    setScheduleMode("weekly");
    setWeekdays(schedule.schedule.weekdays.length > 0 ? schedule.schedule.weekdays : [0]);
  }

  async function saveSchedule() {
    if (!canSaveForm) return;
    setSaving(true);
    setError(null);
    try {
      const body = buildScheduleBody();
      if (editingScheduleId) {
        await userApi.updateAgentSchedule(agentId, editingScheduleId, body);
      } else {
        await userApi.createAgentSchedule(agentId, { ...body, enabled: true });
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : (editingScheduleId ? "保存失败" : "创建失败"));
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
      if (editingScheduleId === scheduleId) {
        resetForm();
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setSaving(false);
    }
  }

  async function runSchedule(scheduleId: string) {
    setRunningScheduleId(scheduleId);
    setError(null);
    try {
      await userApi.runAgentSchedule(agentId, scheduleId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "运行失败");
    } finally {
      setRunningScheduleId(null);
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
          <h3 className="text-sm font-semibold text-text-primary">定时任务</h3>
          <p className="text-xs text-text-secondary">按设定时间执行任务。</p>
        </div>
        <Button variant="secondary"
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="w-9"
          title="刷新"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      {error ? (
        <Alert tone="danger" >
          {error}
        </Alert>
      ) : null}

      {schedules.length === 0 && !loading ? (
        <EmptyState compact bordered title={<>还没有定时任务</>} />
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => {
            const lastRun = runsBySchedule[schedule.id]?.[0];
            const isRunningThisSchedule = runningScheduleId === schedule.id;
            return (
              <Card as="section" padding="none" key={schedule.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-text-secondary" />
                      <h4 className="truncate text-sm font-semibold text-text-primary">{schedule.name}</h4>
                      <span className={`rounded border px-1.5 py-0.5 text-xs ${schedule.enabled ? "border-success/20 text-success" : "border-glass-border text-text-secondary"}`}>
                        {schedule.enabled ? "启用" : "暂停"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {scheduleLabel(schedule.schedule)} · {sessionPolicyLabel(schedule.session_policy)} · 下次 {formatTime(schedule.next_fire_at)}
                    </p>
                    <p className="mt-2 line-clamp-2 text-xs text-text-secondary">{schedule.payload.message}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton label="编辑"
                      type="button"
                      onClick={() => startEdit(schedule)}
                      disabled={saving}
                      className="w-8"
                      title="编辑"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                    <Button variant="secondary"
                      type="button"
                      onClick={() => void patchSchedule(schedule.id, { enabled: !schedule.enabled })}
                      disabled={saving}
                      className="w-8"
                      title={schedule.enabled ? "暂停" : "恢复"}
                    >
                      {schedule.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="secondary"
                      type="button"
                      onClick={() => void runSchedule(schedule.id)}
                      disabled={saving || isRunningThisSchedule}
                      className="w-8"
                      title={isRunningThisSchedule ? "执行中" : "立即执行"}
                    >
                      {isRunningThisSchedule ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CirclePlay className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <IconButton label="删除" danger
                      type="button"
                      onClick={() => void deleteSchedule(schedule.id)}
                      disabled={saving}
                      className="w-8"
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                </div>
                {lastRun ? (
                  <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${statusClass(lastRun.status)}`}>
                    最近执行：{lastRun.status} · {formatTime(lastRun.completed_at || lastRun.scheduled_for)}
                    {lastRun.error ? ` · ${lastRun.error}` : ""}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <Card as="section" padding="none" className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            {editingScheduleId ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {editingScheduleId ? "编辑任务" : "新建任务"}
          </div>
          {editingScheduleId ? (
            <Button variant="secondary"
              type="button"
              onClick={resetForm}
              disabled={saving}

            >
              <X className="h-3.5 w-3.5" />
              取消
            </Button>
          ) : null}
        </div>
        <div className="grid gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}

            placeholder="名称"
          />
          <div className="grid grid-cols-3 gap-2">
            {(["every", "daily", "weekly"] as const).map((mode) => (
              <Button aria-pressed={scheduleMode === mode} variant="row"
                key={mode}
                type="button"
                onClick={() => setScheduleMode(mode)}

              >
                {mode === "every" ? "固定间隔" : mode === "daily" ? "每天" : "每周"}
              </Button>
            ))}
          </div>
          {scheduleMode === "every" ? (
            <label className="grid gap-1 text-xs text-text-secondary">
              间隔分钟
              <Input
                type="number"
                min={5}
                step={5}
                value={everyMinutes}
                onChange={(e) => setEveryMinutes(Number(e.target.value))}

              />
            </label>
          ) : (
            <div className="grid gap-3">
              <label className="grid gap-1 text-xs text-text-secondary">
                执行时间
                <Input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}

                />
              </label>
              {scheduleMode === "weekly" ? (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                  {WEEKDAYS.map((day) => (
                    <Button aria-pressed={weekdays.includes(day.value)} variant="row"
                      key={day.value}
                      type="button"
                      onClick={() => toggleWeekday(day.value)}

                    >
                      {day.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
          <div className="grid gap-1">
            <div className="text-xs text-text-secondary">对话方式</div>
            <div className="grid grid-cols-2 gap-2">
              {SESSION_POLICY_OPTIONS.map((option) => (
                <Button aria-pressed={sessionPolicy === option.value} variant="row"
                  key={option.value}
                  type="button"
                  onClick={() => setSessionPolicy(option.value)}

                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}

          />
          <Button variant="primary"
            type="button"
            onClick={() => void saveSchedule()}
            disabled={!canSaveForm}

          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : editingScheduleId ? (
              <Pencil className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {editingScheduleId ? "保存" : "创建"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
