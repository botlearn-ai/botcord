"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { composerPopoverGeometry } from "./mobileChat";

/** Portaled above the composer so chat overflow and the software keyboard cannot clip it. */
export default function ComposerPopover({ anchorRef, onClose, matchWidth = false, className = "", children }: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  matchWidth?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      setStyle(composerPopoverGeometry(rect, {
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
      }, matchWidth ? rect.width : 176));
    };
    let frame = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    const observer = new ResizeObserver(update);
    // Keyboard handling resizes the chat root in a later animation frame.
    // The anchor can move without changing size, so watch its layout ancestors too.
    for (let node: HTMLElement | null = anchorRef.current; node && node !== document.body; node = node.parentElement) {
      observer.observe(node);
    }
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleUpdate);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
    };
  }, [anchorRef, matchWidth]);
  useEffect(() => {
    if (matchWidth) return;
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [matchWidth]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !anchorRef.current?.contains(event.target as Node)) closeRef.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeRef.current();
        const anchor = anchorRef.current;
        const target = anchor?.matches("button, textarea") ? anchor : anchor?.querySelector<HTMLElement>("textarea, button");
        target?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [anchorRef]);
  return createPortal(<div ref={panelRef} style={{ ...style, visibility: style ? "visible" : "hidden", transform: "translateY(-100%)" }} className={`liquid-menu fixed z-[900] overflow-y-auto overscroll-contain rounded-xl border border-glass-border bg-deep-black-light shadow-xl ${className}`}>{children}</div>, document.body);
}
