/**
 * [INPUT]: Message anchor, available actions and close callback; VI surface, text and border semantic tokens
 * [OUTPUT]: Portaled icon-grid context menu with an arrow, viewport collision handling and keyboard navigation
 * [POS]: Shared touch message action surface; used by dashboard and /design
 * [PROTOCOL]: Keep COMPONENTS.md, gallery and interaction tests in sync
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

export interface MessageAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export default function MessageActionPopover({ anchorRef, actions, label, onClose }: {
  anchorRef: RefObject<HTMLElement | null>;
  actions: MessageAction[];
  label: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number; arrow: number; above: boolean; columns: number } | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const vx = viewport?.offsetLeft ?? 0;
      const vy = viewport?.offsetTop ?? 0;
      const vw = viewport?.width ?? window.innerWidth;
      const vh = viewport?.height ?? window.innerHeight;
      const width = Math.min(Math.min(actions.length, 5) * 72 + 16, vw - 24);
      const columns = Math.max(1, Math.min(actions.length, 5, Math.floor((width - 16) / 64)));
      const maxHeight = Math.max(44, vh - 40);
      const height = Math.min(panel.getBoundingClientRect().height || Math.ceil(actions.length / columns) * 80 + 16, maxHeight);
      const center = (rect.left + rect.right) / 2;
      const left = Math.max(vx + 12, Math.min(center - width / 2, vx + vw - width - 12));
      const above = rect.top - vy >= height + 20 || rect.top - vy > vy + vh - rect.bottom;
      const top = Math.max(vy + 12, Math.min(above ? rect.top - height - 10 : rect.bottom + 10, vy + vh - height - 12));
      const next = { left, top, width, maxHeight, columns, above, arrow: Math.max(20, Math.min(center - left, width - 20)) };
      setPosition((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    };
    update();
    const observer = new ResizeObserver(update);
    if (panelRef.current) observer.observe(panelRef.current);
    if (anchorRef.current) observer.observe(anchorRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [anchorRef, actions.length]);

  useEffect(() => {
    const anchor = anchorRef.current;
    panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) closeRef.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      if (document.activeElement === document.body || panelRef.current?.contains(document.activeElement)) anchor?.focus({ preventScroll: true });
    };
  }, [anchorRef]);

  if (actions.length === 0) return null;

  return createPortal(
    <div ref={panelRef} role="menu" aria-label={label}
      className="fixed z-[900] rounded-xl border border-border bg-surface-raised text-text-primary shadow-md"
      style={{ left: position?.left, top: position?.top, width: position?.width ?? 300, visibility: position ? "visible" : "hidden" }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: position?.columns ?? 1, ArrowUp: -(position?.columns ?? 1) } as Record<string, number>)[event.key];
        if (step !== undefined || event.key === "Home" || event.key === "End") {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : ((index + step) % buttons.length + buttons.length) % buttons.length;
          buttons[next]?.focus();
        } else if (event.key === "Tab") closeRef.current();
      }}>
      <div className="grid overflow-y-auto overscroll-contain p-2" style={{ gridTemplateColumns: `repeat(${position?.columns ?? Math.min(actions.length, 5)}, minmax(0, 1fr))`, maxHeight: position?.maxHeight }}>
        {actions.map((action, index) => <button key={action.id} type="button" role="menuitem" data-message-action-item disabled={action.disabled}
          className={`flex min-h-20 min-w-0 flex-col items-center justify-center gap-2 px-1 py-3 type-caption outline-none hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring disabled:opacity-50 ${index >= (position?.columns ?? 5) ? "border-t border-border" : ""}`}
          onClick={() => { onClose(); action.onSelect(); }}>
          <span aria-hidden className="flex size-6 items-center justify-center [&>svg]:size-6">{action.icon}</span>
          <span className="text-center">{action.label}</span>
        </button>)}
      </div>
      <span aria-hidden className={`pointer-events-none absolute size-3 rotate-45 rounded-sm border-border bg-surface-raised ${position?.above ? "border-b border-r" : "border-l border-t"}`}
        style={{ left: (position?.arrow ?? 24) - 6, ...(position?.above ? { bottom: -5 } : { top: -5 }) }} />
    </div>, document.body,
  );
}
