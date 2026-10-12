/**
 * [INPUT]: 依赖 VI 颜色语义类（bg-surface-sunken、border-accent…，见 styles/botcord-tailwind.css）与 clsx
 * [OUTPUT]: 对外提供 Tabs 标签条：segmented / underline 两种变体，sm / md 两种尺寸，左右方向键与 Home / End 切换并跳过 disabled
 * [POS]: ui 交互原语（批次 2）；只渲染 tablist，面板内容由调用方按 value 渲染
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；样式规则以 VI.md §3、§8、§9 为准
 */
"use client";

import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { clsx } from "clsx";

export type TabsVariant = "segmented" | "underline";
export type TabsSize = "sm" | "md";

export interface TabItem {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  items: TabItem[];
  ariaLabel: string;
  variant?: TabsVariant;
  size?: TabsSize;
  className?: string;
}

const LIST: Record<TabsVariant, string> = {
  segmented: "inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5",
  underline: "flex items-center gap-4 border-b border-border",
};

const SIZE: Record<TabsVariant, Record<TabsSize, string>> = {
  segmented: { sm: "h-7 px-2.5 text-xs", md: "h-8 px-3 text-sm" },
  underline: { sm: "h-8 text-xs", md: "h-10 text-sm" },
};

function tabClass(variant: TabsVariant, selected: boolean) {
  if (variant === "segmented") {
    return selected
      ? "rounded-md bg-surface text-text-primary shadow-[var(--bc-shadow-sm)]"
      : "rounded-md text-text-secondary hover:text-text-primary";
  }
  return clsx(
    "-mb-px border-b-2",
    selected ? "border-accent text-text-primary" : "border-transparent text-text-secondary hover:text-text-primary",
  );
}

export default function Tabs({
  value,
  onValueChange,
  items,
  ariaLabel,
  variant = "segmented",
  size = "md",
  className,
}: TabsProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Roving tabindex: the selected tab (or the first enabled one) is the single tab stop.
  const focusIndex = Math.max(
    items.findIndex((item) => item.value === value && !item.disabled),
    items.findIndex((item) => !item.disabled),
  );

  function move(from: number, step: 1 | -1) {
    for (let offset = 1; offset <= items.length; offset += 1) {
      const index = (from + step * offset + items.length) % items.length;
      if (!items[index].disabled) return index;
    }
    return -1;
  }

  function select(index: number) {
    if (index < 0) return;
    tabRefs.current[index]?.focus();
    if (items[index].value !== value) onValueChange(items[index].value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1;
    if (event.key === "ArrowRight") next = move(index, 1);
    else if (event.key === "ArrowLeft") next = move(index, -1);
    else if (event.key === "Home") next = move(-1, 1);
    else if (event.key === "End") next = move(items.length, -1);
    else return;
    event.preventDefault();
    select(next);
  }

  return (
    <div role="tablist" aria-label={ariaLabel} aria-orientation="horizontal" className={clsx("max-w-full overflow-x-auto", LIST[variant], className)}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => { tabRefs.current[index] = node; }}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={item.disabled}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={clsx(
              "bc-touch-target inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium",
              "transition-colors duration-[var(--bc-duration-fast)] motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/60",
              "disabled:cursor-not-allowed disabled:opacity-50",
              SIZE[variant][size],
              tabClass(variant, selected),
            )}
          >
            {item.icon ? <span aria-hidden className="inline-flex shrink-0">{item.icon}</span> : null}
            {item.label}
            {item.badge != null ? <span className="inline-flex shrink-0">{item.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
