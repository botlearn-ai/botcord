"use client";
/**
 * [INPUT]: Trigger element, accessible title, caller-owned content and close handler
 * [OUTPUT]: Anchored desktop dialog and mobile bottom sheet, shared focus/escape/scroll semantics
 * [POS]: UI reaction inspector shell; caller supplies the dashboard portal
 * [PROTOCOL]: Uses DialogSurface, never a business-owned scrim; update COMPONENTS.md on changes
 */
import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import DialogSurface from "./DialogSurface";
import IconButton from "./IconButton";

export default function ReactionPanel({ anchor, title, closeLabel, onClose, children }: {
  anchor: HTMLElement; title: string; closeLabel: string; onClose: () => void; children: ReactNode;
}) {
  const overlay = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const position = () => {
      if (!panel.current || !overlay.current) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(352, window.innerWidth - 32);
      const height = panel.current.offsetHeight;
      const left = Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16));
      const top = Math.max(16, Math.min(rect.top - height - 8, window.innerHeight - height - 16));
      overlay.current.style.setProperty("--reaction-left", `${left}px`);
      overlay.current.style.setProperty("--reaction-top", `${top}px`);
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [anchor]);
  return <DialogSurface overlayRef={overlay} panelRef={panel} title={title} placement="bottom" size="sm" onClose={onClose}
    className="max-h-[80dvh] max-w-full pb-[env(safe-area-inset-bottom)] md:absolute md:left-[var(--reaction-left)] md:top-[var(--reaction-top)] md:w-88 md:max-w-sm">
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <h3 className="min-w-0 break-words text-sm font-semibold">{title}</h3>
      <IconButton label={closeLabel} onClick={onClose}><X size={16} strokeWidth={1.75} /></IconButton>
    </div>
    <div className="min-h-0 overflow-y-auto overscroll-contain p-4">{children}</div>
  </DialogSurface>;
}
