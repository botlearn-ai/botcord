/**
 * [INPUT]: 依赖 @radix-ui/react-tooltip、VI 颜色语义类（bg-text-primary / text-bg 随主题反转）、styles/ui-motion-interactive.css 的 .bc-popover 与 clsx
 * [OUTPUT]: 对外提供 Tooltip：<Tooltip content side? align? delay?>{trigger}</Tooltip>，深色气泡 12px、rounded-lg
 * [POS]: ui 交互原语（批次 2）；替换原先导出 Radix 原件的 Tooltip，图标按钮等的悬停说明统一从这里出
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；样式规则以 VI.md §3、§8、§9 为准
 */
"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import { clsx } from "clsx";

export interface TooltipProps {
  content: ReactNode;
  /** Trigger element; must accept a ref and DOM props (rendered via asChild). */
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Open delay in ms. */
  delay?: number;
  /** Applied to the bubble. */
  className?: string;
}

export default function Tooltip({ content, children, side = "top", align = "center", delay = 300, className }: TooltipProps) {
  if (content == null || content === false || content === "") return children;
  return (
    <TooltipPrimitive.Provider delayDuration={delay} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            // text-primary flips with the theme, so the bubble is dark on light and light on dark.
            className={clsx(
              "bc-popover z-[80] max-w-xs rounded-lg bg-text-primary px-2.5 py-1.5 text-xs leading-snug text-bg",
              "shadow-[var(--bc-shadow-md)]",
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
