/**
 * [INPUT]: 依赖 VI token（--bc-text 墨色、--bc-brand 主色）与 globals.css 主题块中的 --cord-line-opacity / --cord-node-opacity
 * [OUTPUT]: 对外提供 CordField 辅助图形（节点之间用 logo 同款 S 形连线相连，约每 9 个节点 1 个主色节点；可选 seed / 画布尺寸 / 节点间距生成小号变体）与 CORD_FIELD 原始几何
 * [POS]: 营销页背景与房间封面图形，替代旧的 three.js 粒子网格；浅/深双主题自动跟随 html[data-theme]；分享 OG 图复用 CORD_FIELD
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；生成规则对齐 docs/brand/botcord-vi/scripts/assets.py cord_field()
 */

import { clsx } from "clsx";

interface FieldNode {
  x: number;
  y: number;
  accent: boolean;
}

/** Small deterministic PRNG so server and client render the same field. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Port of the VI asset generator: jittered grid points, each linked to a few
 * right-hand neighbours by a horizontal-tangent cubic (the logo's cord).
 */
function buildField(width: number, height: number, step: number, seed: number) {
  const rnd = mulberry32(seed);
  const uniform = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const cols = Math.floor(width / step) + 2;
  const rows = Math.floor(height / step) + 2;
  const points = new Map<string, [number, number]>();

  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      if (rnd() < 0.55) {
        const jx = uniform(-0.25, 0.25) * step;
        const jy = uniform(-0.25, 0.25) * step;
        points.set(`${i},${j}`, [i * step + jx - step / 2, j * step + jy - step / 2]);
      }
    }
  }

  const cords: string[] = [];
  const neighbours = [[1, 0], [1, -1], [1, 1], [2, -1]] as const;
  points.forEach(([x, y], key) => {
    const [i, j] = key.split(",").map(Number);
    neighbours.forEach(([di, dj]) => {
      const q = points.get(`${i + di},${j + dj}`);
      if (q && rnd() < 0.38) {
        const mx = (x + q[0]) / 2;
        cords.push(
          `M${x.toFixed(1)} ${y.toFixed(1)} C ${mx.toFixed(1)} ${y.toFixed(1)}, ${mx.toFixed(1)} ${q[1].toFixed(1)}, ${q[0].toFixed(1)} ${q[1].toFixed(1)}`,
        );
      }
    });
  });

  const nodes: FieldNode[] = Array.from(points.values()).map(([x, y], k) => ({
    x,
    y,
    accent: k % 9 === 0,
  }));

  return { d: cords.join(" "), nodes };
}

const WIDTH = 1200;
const HEIGHT = 800;
const FIELD = buildField(WIDTH, HEIGHT, 96, 7);

/** Raw geometry for non-DOM renderers (e.g. next/og share images) that cannot read CSS variables. */
export const CORD_FIELD = { width: WIDTH, height: HEIGHT, ...FIELD };

const FIELD_CACHE = new Map<string, ReturnType<typeof buildField>>();

function fieldFor(width: number, height: number, step: number, seed: number) {
  if (width === WIDTH && height === HEIGHT && step === 96 && seed === 7) return FIELD;
  const key = `${width}x${height}/${step}/${seed}`;
  let field = FIELD_CACHE.get(key);
  if (!field) {
    field = buildField(width, height, step, seed);
    FIELD_CACHE.set(key, field);
  }
  return field;
}

interface CordFieldProps {
  className?: string;
  /** Different seeds give different but stable fields, e.g. one per room cover. */
  seed?: number;
  width?: number;
  height?: number;
  /** Grid spacing between nodes, in viewBox units. */
  step?: number;
}

/**
 * Static cord field (VI §5). Ink follows --bc-text, signal nodes use
 * --bc-brand; line/node opacity come from the per-theme --cord-* variables in globals.css so
 * each theme stays inside the 14–22% / 25–40% range.
 */
export default function CordField({ className, seed = 7, width = WIDTH, height = HEIGHT, step = 96 }: CordFieldProps) {
  const field = fieldFor(width, height, step, seed);
  // Node radius tracks the grid so small fields keep the same visual weight.
  const scale = step / 96;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      aria-hidden="true"
      className={clsx("text-[var(--bc-text)]", className)}
    >
      <path
        d={field.d}
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        style={{ strokeOpacity: "var(--cord-line-opacity, 0.16)" }}
        vectorEffect="non-scaling-stroke"
      />
      {field.nodes.map((node) => (
        <circle
          key={`${node.x}-${node.y}`}
          cx={node.x}
          cy={node.y}
          r={(node.accent ? 4 : 3.2) * scale}
          fill={node.accent ? "var(--bc-brand)" : "currentColor"}
          style={node.accent ? undefined : { fillOpacity: "var(--cord-node-opacity, 0.3)" }}
        />
      ))}
    </svg>
  );
}
