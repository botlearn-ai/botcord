/**
 * [INPUT]: 依赖 lucide MoreHorizontal 图标、VI 颜色语义类与指针事件；操作项（label / onClick / className 色块）由调用方传入
 * [OUTPUT]: 对外提供 SwipeableRow：触屏横向左滑露出整高操作色块，纵向手势保持原生滚动；附"更多"按钮与 Esc 作为非触屏替代
 * [POS]: ui 手势原语；会话列表等行内快捷操作统一从这里出（自 dashboard/SwipeableConversationRow 迁入）
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md
 */

"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

interface Action { label: string; onClick: () => void; disabled?: boolean; className: string }
interface Props {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: Action[];
  label: string;
}

/** Horizontal touch drag reveals actions; vertical gestures remain native scrolling. */
export default function SwipeableRow({ children, open, onOpenChange, actions, label }: Props) {
  const width = actions.length * 72;
  const [drag, setDrag] = useState<number | null>(null);
  const gesture = useRef<{ x: number; y: number; offset: number; claimed: boolean } | null>(null);
  const suppressClickUntil = useRef(0);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!row.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, onOpenChange]);

  if (!actions.length) return <div className="mx-2 my-1">{children}</div>;

  return (
    <div ref={row} className="relative mx-2 my-1 overflow-hidden rounded-xl" data-swipe-open={open}
      onKeyDown={(event) => { if (event.key === "Escape") onOpenChange(false); }}>
      <div className="absolute inset-y-0 right-0 flex" style={{ visibility: open || drag !== null ? "visible" : "hidden" }}>
        {actions.map((action) => (
          <button key={action.label} type="button" tabIndex={open ? 0 : -1} disabled={action.disabled}
            className={`w-[72px] px-1 text-xs font-medium disabled:opacity-50 ${action.className}`}
            onClick={() => { action.onClick(); onOpenChange(false); }}>
            {action.label}
          </button>
        ))}
      </div>
      <div className="relative motion-safe:transition-transform motion-safe:duration-200"
        style={{ transform: `translateX(${drag ?? (open ? -width : 0)}px)`, touchAction: "pan-y", transitionDuration: drag === null ? undefined : "0ms" }}
        onPointerDown={(event) => {
          if (event.pointerType !== "touch" || !event.isPrimary || (event.target as Element).closest("button, a")) return;
          gesture.current = { x: event.clientX, y: event.clientY, offset: open ? -width : 0, claimed: false };
        }}
        onPointerMove={(event) => {
          const start = gesture.current;
          if (!start) return;
          const dx = event.clientX - start.x;
          const dy = Math.abs(event.clientY - start.y);
          if (!start.claimed && dy > 8 && dy >= Math.abs(dx)) { gesture.current = null; return; }
          if (!start.claimed && Math.abs(dx) > 8 && Math.abs(dx) > dy * 1.5) {
            start.claimed = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          if (start.claimed) setDrag(Math.max(-width, Math.min(0, start.offset + dx)));
        }}
        onPointerUp={(event) => {
          const start = gesture.current;
          if (start?.claimed) {
            suppressClickUntil.current = Date.now() + 400;
            const dx = event.clientX - start.x;
            onOpenChange(open ? dx < 48 : dx < -48);
          }
          gesture.current = null;
          setDrag(null);
        }}
        onPointerCancel={() => { gesture.current = null; setDrag(null); }}
        onClickCapture={(event) => {
          if (Date.now() < suppressClickUntil.current) {
            event.preventDefault(); event.stopPropagation();
            return;
          }
          if (open) {
            event.preventDefault(); event.stopPropagation();
            onOpenChange(false);
          }
        }}>
        {children}
        <button type="button" aria-label={label} aria-expanded={open}
          className="absolute bottom-1 right-2 flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-focus-ring"
          onClick={() => onOpenChange(!open)}>
          <MoreHorizontal size={16} />
        </button>
      </div>
    </div>
  );
}
