"use client";

/**
 * [INPUT]: agentId + capability rating API
 * [OUTPUT]: AgentCapabilityCard — per-layer scores and a radar chart overlaying L0/L1 dimensions
 * [POS]: Bot detail drawer Overview tab
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useState } from "react";
import { userApi } from "@/lib/api";
import type {
  AgentCapability,
  CapabilityDimension,
  CapabilityDimensionKey,
  CapabilityLayerKey,
} from "@/lib/agent-capability";
import { useLanguage } from "@/lib/i18n";

const COPY = {
  en: {
    title: "Capability rating",
    layers: { l0: "L0 Declared", l1: "L1 Observed" } as Record<CapabilityLayerKey, string>,
    dims: {
      model: "Model",
      skills: "Skills",
      profile: "Profile",
      response_rate: "Reply rate",
      latency: "Speed",
      delivery: "Delivery",
      activity: "Activity",
    } as Record<CapabilityDimensionKey, string>,
    notProbed: "Not probed",
    lowSample: "Not enough data",
    skillsCount: (n: number) => `${n} skills`,
    days: (n: number, total: number) => `${n}/${total} days`,
    window: (n: number) => `Last ${n} days`,
    loadFailed: "Failed to load rating",
  },
  zh: {
    title: "能力评级",
    layers: { l0: "L0 声明", l1: "L1 实测" } as Record<CapabilityLayerKey, string>,
    dims: {
      model: "模型基座",
      skills: "技能储备",
      profile: "资料完整",
      response_rate: "响应率",
      latency: "响应速度",
      delivery: "投递可靠",
      activity: "活跃度",
    } as Record<CapabilityDimensionKey, string>,
    notProbed: "未探测",
    lowSample: "样本不足",
    skillsCount: (n: number) => `${n} 个技能`,
    days: (n: number, total: number) => `${n}/${total} 天`,
    window: (n: number) => `近 ${n} 天`,
    loadFailed: "评级加载失败",
  },
} as const;

type Copy = (typeof COPY)[keyof typeof COPY];

const LAYER_COLORS: Record<CapabilityLayerKey, string> = {
  l0: "var(--color-neon-purple)",
  l1: "var(--color-neon-cyan)",
};

const SIZE = 240;
const CENTER = SIZE / 2;
const RADIUS = 78;
const RINGS = [25, 50, 75, 100];
// Horizontal room for side labels that extend past the square plot area.
const LABEL_PAD = 50;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatValue(dim: CapabilityDimension, windowDays: number, copy: Copy): string {
  const v = dim.value;
  switch (dim.key) {
    case "model":
      return typeof v === "string" ? v : "";
    case "skills":
      return typeof v === "number" ? copy.skillsCount(v) : "";
    case "profile":
      return v && typeof v === "object"
        ? `${Object.values(v as Record<string, boolean>).filter(Boolean).length}/${Object.keys(v).length}`
        : "";
    case "response_rate":
    case "delivery":
      return typeof v === "number" ? `${Math.round(v * 100)}% · n=${dim.sample}` : "";
    case "latency":
      return typeof v === "number" ? `p50 ${formatDuration(v)}` : "";
    case "activity":
      return typeof v === "number" ? copy.days(v, windowDays) : "";
  }
}

function point(index: number, total: number, score: number): [number, number] {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  const r = (RADIUS * score) / 100;
  return [CENTER + r * Math.cos(angle), CENTER + r * Math.sin(angle)];
}

function Radar({
  axes,
  copy,
}: {
  axes: { layer: CapabilityLayerKey; dim: CapabilityDimension }[];
  copy: Copy;
}) {
  const total = axes.length;
  const ring = (score: number) =>
    axes.map((_, i) => point(i, total, score).join(",")).join(" ");
  // One polygon per layer: its own axes carry scores, other layers' axes collapse
  // to the center, so the overlay reads as colored sectors of a single shape.
  const layerPolygon = (layer: CapabilityLayerKey) =>
    axes
      .map((axis, i) => point(i, total, axis.layer === layer ? axis.dim.score ?? 0 : 0).join(","))
      .join(" ");

  return (
    <svg
      viewBox={`${-LABEL_PAD} 0 ${SIZE + LABEL_PAD * 2} ${SIZE}`}
      className="mx-auto h-auto w-full max-w-[340px]"
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
      {(["l0", "l1"] as const).map((layer) => (
        <polygon
          key={layer}
          points={layerPolygon(layer)}
          fill={LAYER_COLORS[layer]}
          fillOpacity={0.22}
          stroke={LAYER_COLORS[layer]}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      ))}
      {axes.map((axis, i) => {
        const [x, y] = point(i, total, 128);
        const anchor = Math.abs(x - CENTER) < 4 ? "middle" : x > CENTER ? "start" : "end";
        return (
          <text
            key={axis.dim.key}
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-text-secondary text-[10px]"
          >
            {copy.dims[axis.dim.key]}
            <tspan className="fill-text-primary font-semibold"> {axis.dim.score ?? "—"}</tspan>
          </text>
        );
      })}
    </svg>
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

  const axes = data.layers.flatMap((layer) => layer.dimensions.map((dim) => ({ layer: layer.key, dim })));

  return (
    <section className="liquid-card rounded-2xl border border-glass-border p-4">
      <h3 className="mb-3 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
        <span>{copy.title}</span>
        <span className="font-normal normal-case tracking-normal text-text-secondary/50">
          {copy.window(data.window_days)}
        </span>
      </h3>

      <div className="grid grid-cols-2 gap-2">
        {data.layers.map((layer) => (
          <div key={layer.key} className="liquid-tool-surface rounded-lg px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] text-text-secondary/70">
              <span className="h-2 w-2 rounded-full" style={{ background: LAYER_COLORS[layer.key] }} />
              {copy.layers[layer.key]}
            </div>
            <div className="text-lg font-semibold text-text-primary">{layer.score ?? "—"}</div>
          </div>
        ))}
      </div>

      <div className="text-text-secondary">
        <Radar axes={axes} copy={copy} />
      </div>

      <ul className="space-y-1">
        {axes.map(({ layer, dim }) => (
          <li key={dim.key} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="flex items-center gap-1.5 text-text-secondary/80">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: LAYER_COLORS[layer] }} />
              {copy.dims[dim.key]}
            </span>
            <span className="truncate text-text-secondary/60">
              {dim.score === null
                ? layer === "l0"
                  ? copy.notProbed
                  : copy.lowSample
                : formatValue(dim, data.window_days, copy)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
