/**
 * [INPUT]: 依赖 BrandMark 的 BRAND_CORD_PATH、VI 颜色语义类（fill-brand、fill-warning、stroke-success…）、styles/ui-motion.css 的 bc-cord-* 动画与 clsx
 * [OUTPUT]: 对外提供 NodeCordStatus 与 NodeCordState 类型：Node·Cord 图形的 static / sending / thinking / delivered / waiting / offline 六种状态
 * [POS]: ui 身份与状态原语；墨色跟随 currentColor，信号节点用品牌色；static 用于钱包、签名等严肃场景
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；状态与几何以 docs/brand/botcord-vi/index.html §8、VI.md §2.1 / §8 为准
 */

import { clsx } from "clsx";
import { BRAND_CORD_PATH } from "./BrandMark";

export type NodeCordState = "static" | "sending" | "thinking" | "delivered" | "waiting" | "offline";

export interface NodeCordStatusProps {
  state: NodeCordState;
  /** Pixel size of the square mark. */
  size?: number;
  className?: string;
}

// Geometry from VI §2.1: two nodes (r 7) joined by the cord (stroke 5.5).
const N1 = { cx: 8.5, cy: 34 };
const N2 = { cx: 39.5, cy: 14 };
const R = 7;
const STROKE = 5.5;

/**
 * State animations use CSS (not SMIL) so `prefers-reduced-motion` can switch
 * them off; with reduced motion only the colour of each state remains.
 */
export default function NodeCordStatus({ state, size = 24, className }: NodeCordStatusProps) {
  const offline = state === "offline";
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      role="img"
      aria-label={state}
      data-state={state}
      className={clsx("inline-block shrink-0 overflow-visible", className)}
    >
      <g className={offline ? "text-text-tertiary" : undefined}>
        <path d={BRAND_CORD_PATH} stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
        <circle {...N1} r={R} fill="currentColor" />
        {offline ? (
          <circle {...N2} r={R - 1.2} stroke="currentColor" strokeWidth={2.4} className="fill-surface" />
        ) : null}
      </g>

      {state === "static" || state === "sending" || state === "delivered" ? (
        <circle {...N2} r={R} className="fill-brand" />
      ) : null}
      {state === "thinking" ? <circle {...N2} r={R} className="bc-cord-breathe fill-brand" /> : null}
      {state === "waiting" ? (
        <>
          <circle {...N2} r={R} className="fill-warning" />
          <circle {...N2} r={R + 3} strokeWidth={2} className="bc-cord-blink stroke-warning" />
        </>
      ) : null}
      {state === "sending" ? <circle r={2.6} className="bc-cord-courier fill-brand" /> : null}
      {state === "delivered" ? <circle {...N2} r={R} strokeWidth={1.5} className="bc-cord-ripple stroke-success" /> : null}
    </svg>
  );
}
