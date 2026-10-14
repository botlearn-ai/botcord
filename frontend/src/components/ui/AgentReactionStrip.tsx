"use client";
/**
 * [INPUT]: Ordered avatar items with accessible labels and one animation owner
 * [OUTPUT]: Up to eight avatars plus overflow; touch row opens all, keyboard controls individual avatars
 * [POS]: Shared compact reaction toolbar, independent of API and locale
 * [PROTOCOL]: Keep responsive hit targets and overflow behavior aligned with COMPONENTS.md
 */
import { useEffect, useRef, useState } from "react";
import AgentResponseAvatar from "./AgentResponseAvatar";
import Tooltip from "./Tooltip";
import type { AgentResponseAvatarProps } from "./AgentResponseAvatar";
export interface ReactionItem extends AgentResponseAvatarProps { label: string }
export interface AgentReactionStripProps {
  items: ReactionItem[]; label: string; moreLabel: (count: number) => string;
  align?: "start" | "end";
  onSelect: (id: string | null, anchor: HTMLElement) => void;
}
export default function AgentReactionStrip({ items, label, moreLabel, onSelect, align = "start" }: AgentReactionStripProps) {
  const row = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(9);
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    if (!row.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setCapacity(Math.max(2, Math.min(9, Math.floor(entry.contentRect.width / 36)))));
    observer.observe(row.current);
    return () => observer.disconnect();
  }, []);
  const count = Math.min(8, items.length > capacity ? capacity - 1 : capacity);
  const visible = items.slice(0, count), hidden = items.slice(count);
  const warning = hidden.some((a) => a.state === "failed" || a.state === "interrupted");
  const first = visible.some((a) => a.id === focused) ? focused : visible[0]?.id;
  const overflow = <span className="relative inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-surface-sunken text-xs font-medium text-text-secondary">+{hidden.length}{warning && <span aria-hidden="true" className="absolute right-0 top-0 size-2 rounded-full bg-warning" />}</span>;
  return <div ref={row} className="w-full min-w-20" style={{ containerType: "inline-size" }}>
    <div className={`hidden items-center gap-1 md:flex ${align === "end" ? "justify-end" : ""}`} role="toolbar" aria-label={label} onKeyDown={(e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (current + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      e.preventDefault(); buttons[next]?.focus();
    }}>
      {visible.map((a) => <Tooltip key={a.id} content={a.label}><button type="button" aria-label={a.label} aria-haspopup="dialog"
        tabIndex={a.id === first ? 0 : -1} onFocus={() => setFocused(a.id)}
        className="inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        onClick={(e) => onSelect(a.id, e.currentTarget)}><AgentResponseAvatar {...a} /></button></Tooltip>)}
      {hidden.length > 0 && <button type="button" aria-label={moreLabel(hidden.length)} aria-haspopup="dialog" tabIndex={-1}
        className="inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        onClick={(e) => onSelect(null, e.currentTarget)}>{overflow}</button>}
    </div>
    <button type="button" aria-label={label} aria-haspopup="dialog" className={`flex min-h-11 w-full items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:hidden ${align === "end" ? "justify-end" : ""}`}
      onClick={(e) => onSelect(null, e.currentTarget)}>
      {visible.map((a) => <AgentResponseAvatar key={a.id} {...a} />)}{hidden.length > 0 && overflow}
    </button>
  </div>;
}
