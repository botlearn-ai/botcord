"use client";

/**
 * [INPUT]: agentId + capability rating API
 * [OUTPUT]: AgentCapabilityCard — six general axes with one radar polygon per evidence layer (L0 declared, L1 observed)
 * [POS]: Bot detail drawer Overview tab
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useState } from "react";
import { userApi } from "@/lib/api";
import type {
  AgentCapability,
  CapabilityAxis,
  CapabilityAxisKey,
  CapabilityEvidence,
  CapabilityLayerKey,
} from "@/lib/agent-capability";
import { useLanguage } from "@/lib/i18n";

type Obj = Record<string, unknown>;

const COPY = {
  en: {
    title: "Capability rating",
    layers: { l0: "L0 Declared", l1: "L1 Observed" } as Record<CapabilityLayerKey, string>,
    axes: {
      efficacy: "Efficacy",
      latency: "Latency",
      reliability: "Reliability",
      cost: "Cost",
      autonomy: "Autonomy",
      assurance: "Assurance",
    } as Record<CapabilityAxisKey, string>,
    noData: "No data",
    window: (n: number) => `Last ${n} days`,
    loadFailed: "Failed to load rating",
    skills: (n: number) => `${n} skills`,
    completion: "done",
    reply: "reply",
    profile: "profile",
    ageDays: (n: number) => `${n}d old`,
    delivery: "delivery",
    schedules: "schedules",
    activeDays: (n: number, total: number) => `active ${n}/${total}d`,
    perRun: "tokens/run",
    scheduleCount: (n: number) => `${n} schedules`,
    proactive: "self-initiated",
    guarded: "guarded",
    blocks: "blocked",
    recalled: "recalled",
  },
  zh: {
    title: "能力评级",
    layers: { l0: "L0 声明", l1: "L1 实测" } as Record<CapabilityLayerKey, string>,
    axes: {
      efficacy: "效能",
      latency: "响应",
      reliability: "可靠",
      cost: "成本",
      autonomy: "自主",
      assurance: "保障",
    } as Record<CapabilityAxisKey, string>,
    noData: "无数据",
    window: (n: number) => `近 ${n} 天`,
    loadFailed: "评级加载失败",
    skills: (n: number) => `${n} 个技能`,
    completion: "完成率",
    reply: "回复率",
    profile: "资料",
    ageDays: (n: number) => `注册 ${n} 天`,
    delivery: "投递",
    schedules: "定时成功",
    activeDays: (n: number, total: number) => `活跃 ${n}/${total} 天`,
    perRun: "tokens/次",
    scheduleCount: (n: number) => `${n} 个定时任务`,
    proactive: "主动发起",
    guarded: "防护",
    blocks: "被拉黑",
    recalled: "被撤回",
  },
} as const;

type Copy = (typeof COPY)[keyof typeof COPY];

const LAYERS: CapabilityLayerKey[] = ["l0", "l1"];

const LAYER_STYLE: Record<CapabilityLayerKey, { color: string; dash?: string }> = {
  l0: { color: "var(--color-neon-purple)", dash: "4 3" },
  l1: { color: "var(--color-neon-cyan)" },
};

const SIZE = 240;
const CENTER = SIZE / 2;
const RADIUS = 80;
const RINGS = [25, 50, 75, 100];
// Horizontal room for side labels that extend past the square plot area.
const LABEL_PAD = 40;

const pct = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100)}%` : null);

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

function join(parts: (string | null | false | undefined)[]): string {
  return parts.filter(Boolean).join(" · ");
}

function describe(
  axis: CapabilityAxisKey,
  layer: CapabilityLayerKey,
  ev: CapabilityEvidence,
  windowDays: number,
  copy: Copy,
): string {
  if (ev.score === null) return copy.noData;
  const v = ev.value;
  const o = (v && typeof v === "object" ? v : {}) as Obj;
  const n = ev.sample != null ? `n=${ev.sample}` : null;
  if (layer === "l0") {
    switch (axis) {
      case "efficacy":
        return join([o.model as string, typeof o.skills === "number" && copy.skills(o.skills)]);
      case "latency":
      case "cost":
        return typeof v === "string" ? v : "";
      case "reliability":
        return join([`${copy.profile} ${o.profile}/${o.profile_total}`, copy.ageDays(o.age_days as number)]);
      case "autonomy":
        return copy.scheduleCount(v as number);
      case "assurance":
        return `${copy.guarded} ${o.guarded}/${o.total}`;
    }
  }
  switch (axis) {
    case "efficacy":
      return join([`${copy.completion} ${pct(v)}`, n]);
    case "latency":
      return join([
        `${copy.reply} ${pct(o.reply_rate)}`,
        typeof o.median_seconds === "number" && `p50 ${formatDuration(o.median_seconds)}`,
      ]);
    case "reliability":
      return join([
        o.delivery_rate != null && `${copy.delivery} ${pct(o.delivery_rate)}`,
        o.schedule_success_rate != null && `${copy.schedules} ${pct(o.schedule_success_rate)}`,
        copy.activeDays(o.active_days as number, windowDays),
      ]);
    case "cost":
      return join([`p50 ${formatTokens(v as number)} ${copy.perRun}`, n]);
    case "autonomy":
      return join([`${copy.proactive} ${pct(v)}`, n]);
    case "assurance":
      return join([`${copy.blocks} ${o.blocks}`, `${copy.recalled} ${o.recalled}`]);
  }
}

function point(index: number, total: number, score: number): [number, number] {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  const r = (RADIUS * score) / 100;
  return [CENTER + r * Math.cos(angle), CENTER + r * Math.sin(angle)];
}

function Radar({ axes, copy }: { axes: CapabilityAxis[]; copy: Copy }) {
  const total = axes.length;
  const ring = (score: number) => axes.map((_, i) => point(i, total, score).join(",")).join(" ");

  return (
    <svg
      viewBox={`${-LABEL_PAD} 0 ${SIZE + LABEL_PAD * 2} ${SIZE}`}
      className="mx-auto h-auto w-full max-w-[320px]"
      role="img"
      aria-label={copy.title}
    >
      {RINGS.map((r) => (
        <polygon key={r} points={ring(r)} fill="none" stroke="currentColor" strokeOpacity={0.12} />
      ))}
      {axes.map((_, i) => {
        const [x, y] = point(i, total, 100);
        return <line key={i} x1={CENTER} y1={CENTER} x2={x} y2={y} stroke="currentColor" strokeOpacity={0.12} />;
      })}
      {LAYERS.map((layer) => {
        const { color, dash } = LAYER_STYLE[layer];
        // Axes without evidence are skipped rather than pulled to the center,
        // which would draw spikes through the origin.
        const points = axes.flatMap((axis, i) => {
          const score = axis.layers[layer].score;
          return score === null ? [] : [point(i, total, score)];
        });
        const shape = {
          points: points.map((p) => p.join(",")).join(" "),
          stroke: color,
          strokeWidth: 1.5,
          strokeDasharray: dash,
          strokeLinejoin: "round" as const,
        };
        return (
          <g key={layer}>
            {points.length >= 3 ? (
              <polygon {...shape} fill={color} fillOpacity={0.16} />
            ) : points.length === 2 ? (
              <polyline {...shape} fill="none" />
            ) : null}
            {points.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={2.2} fill={color} />
            ))}
          </g>
        );
      })}
      {axes.map((axis, i) => {
        const [x, y] = point(i, total, 122);
        const anchor = Math.abs(x - CENTER) < 4 ? "middle" : x > CENTER ? "start" : "end";
        return (
          <text
            key={axis.key}
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-text-secondary text-[11px] font-medium"
          >
            {copy.axes[axis.key]}
          </text>
        );
      })}
    </svg>
  );
}

function ScoreBadge({ layer, score }: { layer: CapabilityLayerKey; score: number | null }) {
  return (
    <span
      className="inline-flex w-8 justify-center rounded border px-1 py-px text-[10px] font-semibold tabular-nums"
      style={{
        color: LAYER_STYLE[layer].color,
        borderColor: `color-mix(in srgb, ${LAYER_STYLE[layer].color} 35%, transparent)`,
      }}
    >
      {score ?? "—"}
    </span>
  );
}

export default function AgentCapabilityCard({ agentId }: { agentId: string }) {
  const locale = useLanguage();
  const copy = COPY[locale];
  const [data, setData] = useState<AgentCapability | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    userApi
      .getAgentCapability(agentId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (failed) {
    return (
      <section className="liquid-card rounded-2xl border border-glass-border p-4">
        <p className="text-xs text-text-secondary/55">{copy.loadFailed}</p>
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="liquid-card rounded-2xl border border-glass-border p-4">
      <h3 className="mb-3 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
        <span>{copy.title}</span>
        <span className="font-normal normal-case tracking-normal text-text-secondary/50">
          {copy.window(data.window_days)}
        </span>
      </h3>

      <div className="grid grid-cols-2 gap-2">
        {LAYERS.map((layer) => (
          <div key={layer} className="liquid-tool-surface rounded-lg px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] text-text-secondary/70">
              <svg width="14" height="4" aria-hidden>
                <line
                  x1="0"
                  y1="2"
                  x2="14"
                  y2="2"
                  stroke={LAYER_STYLE[layer].color}
                  strokeWidth="2"
                  strokeDasharray={LAYER_STYLE[layer].dash}
                />
              </svg>
              {copy.layers[layer]}
            </div>
            <div className="text-lg font-semibold text-text-primary">{data.layer_scores[layer] ?? "—"}</div>
          </div>
        ))}
      </div>

      <div className="text-text-secondary">
        <Radar axes={data.axes} copy={copy} />
      </div>

      <ul className="space-y-2">
        {data.axes.map((axis) => (
          <li key={axis.key} className="text-[11px]">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-medium text-text-primary/85">{copy.axes[axis.key]}</span>
              {LAYERS.map((layer) => (
                <ScoreBadge key={layer} layer={layer} score={axis.layers[layer].score} />
              ))}
            </div>
            <div className="mt-0.5 space-y-px text-[10px] text-text-secondary/55">
              {LAYERS.map((layer) => (
                <p key={layer} className="truncate">
                  <span className="mr-1 font-mono">{layer.toUpperCase()}</span>
                  {describe(axis.key, layer, axis.layers[layer], data.window_days, copy)}
                </p>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
