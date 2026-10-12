/**
 * [INPUT]: 依赖 VI token（--bc-brand）与 clsx 组合外部样式
 * [OUTPUT]: 对外提供 BotCord Node·Cord 图形标：墨色部分跟随 currentColor，信号节点用品牌色
 * [POS]: ui 品牌原语，供 Navbar、Footer、dashboard 侧栏等浅/深双主题表面复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；几何以 docs/brand/botcord-vi/VI.md §2.1 为准
 */

import { clsx } from "clsx";

export const BRAND_CORD_PATH = "M8.5 34 C 24 34, 24 14, 39.5 14";

/**
 * Node·Cord mark (VI v1.0). Drawn inline so the ink follows the surrounding
 * text colour in either theme while the signal node keeps the brand colour.
 * Pass `mono` for single-colour contexts (e.g. on a brand-coloured fill).
 */
export default function BrandMark({ className, mono = false }: { className?: string; mono?: boolean }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={clsx("inline-block shrink-0", className)}
    >
      <path d={BRAND_CORD_PATH} stroke="currentColor" strokeWidth={5.5} strokeLinecap="round" />
      <circle cx={8.5} cy={34} r={7} fill="currentColor" />
      <circle cx={39.5} cy={14} r={7} fill={mono ? "currentColor" : "var(--bc-brand)"} />
    </svg>
  );
}
