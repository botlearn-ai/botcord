/**
 * [INPUT]: 依赖房间名或稳定 id 作为 seed，供 room 类视觉容器生成可重复的纹理主题
 * [OUTPUT]: 对外提供 initialsFromName 与 themeFromRoomName，统一公开群卡片和分享预览的视觉语义
 * [POS]: dashboard 房间视觉基建层，避免 Explore 卡片与分享弹窗重复维护纹理/强调色算法
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

export type RoomVisualTheme = {
  patternUrl: string;
  accent: string;
  accentDim: string;
};

const PATTERN_KINDS = ["dots", "grid", "diagonal", "triangles", "waves", "hex"] as const;

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "AI";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

// FNV-1a 32-bit — stable, short, good spread for short strings.
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function buildPattern(kind: (typeof PATTERN_KINDS)[number], seed: number, color: string): string {
  const size = 24 + (seed % 20);
  const stroke = (((seed >> 5) % 100) / 100) * 0.6 + 0.4;
  const rotate = (seed >> 11) % 360;
  const enc = (s: string) => encodeURIComponent(s).replace(/'/g, "%27").replace(/"/g, "%22");

  let inner = "";
  switch (kind) {
    case "dots": {
      const r = 1 + (seed % 3);
      inner = [
        `<circle cx='0' cy='0' r='${r}' fill='${color}' fill-opacity='${stroke}'/>`,
        `<circle cx='${size}' cy='0' r='${r}' fill='${color}' fill-opacity='${stroke}'/>`,
        `<circle cx='0' cy='${size}' r='${r}' fill='${color}' fill-opacity='${stroke}'/>`,
        `<circle cx='${size}' cy='${size}' r='${r}' fill='${color}' fill-opacity='${stroke}'/>`,
        `<circle cx='${size / 2}' cy='${size / 2}' r='${r}' fill='${color}' fill-opacity='${stroke}'/>`,
      ].join("");
      break;
    }
    case "grid": {
      inner = `<path d='M ${size} 0 L 0 0 0 ${size}' stroke='${color}' stroke-width='1' stroke-opacity='${stroke}' fill='none'/>`;
      break;
    }
    case "diagonal": {
      inner = `<path d='M-2,2 l4,-4 M0,${size} l${size},-${size} M${size - 2},${size + 2} l4,-4' stroke='${color}' stroke-width='1.2' stroke-opacity='${stroke}'/>`;
      break;
    }
    case "triangles": {
      const h = size * 0.866;
      inner = `<path d='M0 ${h} L${size / 2} 0 L${size} ${h} Z' fill='none' stroke='${color}' stroke-opacity='${stroke}'/>`;
      break;
    }
    case "waves": {
      const a = 3 + (seed % 4);
      inner = `<path d='M0 ${size / 2} Q ${size / 4} ${size / 2 - a}, ${size / 2} ${size / 2} T ${size} ${size / 2}' stroke='${color}' stroke-opacity='${stroke}' fill='none'/>`;
      break;
    }
    case "hex": {
      const r = size / 3;
      const cx = size / 2;
      const cy = size / 2;
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i;
        return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
      }).join(" ");
      inner = `<polygon points='${pts}' fill='none' stroke='${color}' stroke-opacity='${stroke}'/>`;
      break;
    }
  }

  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>` +
    `<g transform='rotate(${rotate} ${size / 2} ${size / 2})'>${inner}</g>` +
    `</svg>`;
  return `url("data:image/svg+xml;utf8,${enc(svg)}")`;
}

export function themeFromRoomName(name: string): RoomVisualTheme {
  const seed = hashString(name || "room");
  const hue = seed % 360;
  const kind = PATTERN_KINDS[(seed >> 3) % PATTERN_KINDS.length];

  return {
    patternUrl: buildPattern(kind, seed, `hsl(${hue} 90% 80%)`),
    accent: `hsl(${hue} 85% 70%)`,
    accentDim: `hsl(${hue} 70% 60% / 0.35)`,
  };
}
