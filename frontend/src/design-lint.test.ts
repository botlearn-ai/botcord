/**
 * [INPUT]: 扫描 src/**\/*.{ts,tsx}（排除测试文件、src/lib/email/**、带 "do not edit" 头的生成文件）与 design-lint.baseline.json
 * [OUTPUT]: VI v1.0 设计规范检查：sub-12px 字号、className 任意值里的 hex / rgba、手写 `fixed inset-0` 遮罩、neon-purple
 * [POS]: 防回退护栏。存量违规记在 baseline（文件 → 次数），只减不增
 * [PROTOCOL]: 规则来源 docs/brand/botcord-vi/VI.md §3、§4、§9 与 COMPONENTS.md；改完代码后计数下降时同步调低 baseline。
 *             重新生成 baseline：UPDATE_DESIGN_LINT_BASELINE=1 pnpm vitest run src/design-lint.test.ts（只在确实减少时使用）
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Baseline = Record<string, Record<string, number>>;

interface Rule {
  id: string;
  description: string;
  pattern: RegExp;
  /** Files (relative to src/) where the pattern is a documented exception. */
  allow?: string[];
}

const RULES: Rule[] = [
  {
    id: "text-below-11px",
    description: "界面最小字号 12px（VI §4），用 text-xs",
    pattern: /text-\[(?:8|9|10)px\]/g,
  },
  {
    id: "text-11px",
    description: "text-[11px] 只允许用于未读数字徽章和 dashboard 左侧导航标签（VI §4），其他用 text-xs",
    pattern: /text-\[11px\]/g,
    allow: [
      "components/ui/UnreadBadge.tsx", // 未读数字徽章
      "components/dashboard/sidebar/NavButtons.tsx", // 左侧导航图标标签
      "components/dashboard/DashboardShellSkeleton.tsx", // 左侧导航骨架，与 NavButtons 同尺寸
      "components/dashboard/sidebar/index.tsx", // 左侧导航上的未读徽章
      "components/dashboard/sidebar/MessagesBotScopeDropdown.tsx", // 未读徽章
      "components/dashboard/AccountMenu.tsx", // 未读徽章
    ],
  },
  {
    id: "hex-in-class",
    description: "className 任意值里不写 hex，用 VI 语义类（bg-surface、text-text-secondary…）",
    pattern: /-\[[^\]\s"'`]*#[0-9a-fA-F]{3,8}\b/g,
  },
  {
    id: "rgba-in-class",
    description: "className 任意值里不写 rgb()/rgba()，用语义类加透明度（bg-accent/10）",
    pattern: /-\[[^\]\s"'`]*rgba?\(/g,
  },
  {
    id: "fixed-inset-scrim",
    description: "不要手写 `fixed inset-0` 遮罩，弹窗用 DialogShell（dashboard 外层加 withDashboardOverlayPortal）",
    pattern: /(?<![\w-])fixed(?![\w-])[^"'`\n]*?(?<![\w-])inset-0(?![\w-])|(?<![\w-])inset-0(?![\w-])[^"'`\n]*?(?<![\w-])fixed(?![\w-])/g,
    allow: ["components/ui/DialogShell.tsx", "components/ui/DialogSurface.tsx"],
  },
  {
    id: "neon-purple",
    description: "neon-purple 已不是品牌色（VI §3.1），按语义改用 accent / text-secondary / agent-violet",
    pattern: /neon-purple/g,
  },
];

const SRC = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(SRC, "design-lint.baseline.json");

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

function isExcluded(rel: string, text: string): boolean {
  return rel.startsWith("lib/email/") || /do not edit/i.test(text.slice(0, 300));
}

/** rule id → file → line numbers (one entry per match). */
function scan(): Record<string, Record<string, number[]>> {
  const hits: Record<string, Record<string, number[]>> = Object.fromEntries(RULES.map((r) => [r.id, {}]));
  for (const full of listSourceFiles(SRC)) {
    const rel = path.relative(SRC, full).split(path.sep).join("/");
    const text = readFileSync(full, "utf8");
    if (isExcluded(rel, text)) continue;
    text.split("\n").forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.allow?.includes(rel)) continue;
        const count = line.match(rule.pattern)?.length ?? 0;
        if (count === 0) continue;
        const lines = (hits[rule.id][rel] ??= []);
        for (let i = 0; i < count; i += 1) lines.push(index + 1);
      }
    });
  }
  return hits;
}

const hits = scan();

if (process.env.UPDATE_DESIGN_LINT_BASELINE) {
  const next: Baseline = {};
  for (const rule of RULES) {
    next[rule.id] = Object.fromEntries(
      Object.entries(hits[rule.id])
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, lines]) => [file, lines.length]),
    );
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

describe("design lint (VI v1.0)", () => {
  for (const rule of RULES) {
    it(rule.id, () => {
      const allowed = baseline[rule.id] ?? {};
      const found = hits[rule.id];
      const problems: string[] = [];

      for (const [file, lines] of Object.entries(found)) {
        const limit = allowed[file] ?? 0;
        if (lines.length > limit) {
          problems.push(
            `新增违规 ${file}: ${lines.length} 处（baseline ${limit}）\n` +
              lines.map((line) => `    src/${file}:${line}`).join("\n"),
          );
        }
      }
      for (const [file, limit] of Object.entries(allowed)) {
        const count = found[file]?.length ?? 0;
        if (count < limit) {
          problems.push(
            `已减少 ${file}: 现在 ${count} 处，baseline 记录 ${limit}。` +
              `请把 src/design-lint.baseline.json 里 "${rule.id}" → "${file}" 调低到 ${count}` +
              `${count === 0 ? "（或删除该条）" : ""}，让 baseline 只减不增。`,
          );
        }
      }

      expect(problems, `${rule.description}\n\n${problems.join("\n")}`).toEqual([]);
    });
  }
});
