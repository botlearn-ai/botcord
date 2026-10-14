"use client";

import { useEffect, useRef } from "react";
import type { MouseEvent, PointerEvent } from "react";

/** A stationary touch opens actions; scrolling, cancellation and multitouch do not. */
export function useTouchLongPress(onLongPress: (target: HTMLElement) => void) {
  const callback = useRef(onLongPress);
  callback.current = onLongPress;
  const gesture = useRef<{ x: number; y: number; id: number; target: HTMLElement } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consumed = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    gesture.current = null;
  };
  useEffect(() => {
    window.addEventListener("scroll", cancel, true);
    return () => { cancel(); window.removeEventListener("scroll", cancel, true); };
  }, []);
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      cancel();
      consumed.current = false;
      if (event.pointerType !== "touch" || event.isPrimary === false) return;
      const target = event.target as HTMLElement;
      if (!target.closest("[data-sender-avatar]") && target.closest("button, a, input, textarea, [role=button]")) return;
      gesture.current = { x: event.clientX, y: event.clientY, id: event.pointerId, target };
      timer.current = setTimeout(() => {
        if (!gesture.current) return;
        consumed.current = true;
        callback.current(gesture.current.target);
        cancel();
      }, 500);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const start = gesture.current;
      if (start && (start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!consumed.current) return;
      consumed.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      if (gesture.current || consumed.current) event.preventDefault();
    },
  };
}
