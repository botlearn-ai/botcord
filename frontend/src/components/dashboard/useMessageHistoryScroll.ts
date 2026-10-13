"use client";

import { useEffect, type RefObject } from "react";

/** Native chronological scrolling: pulling down reveals earlier messages. */
export function observeMessageHistoryScroll(container: HTMLElement, load: () => void) {
  let previousTop = Math.max(0, container.scrollTop);
  let touch: { x: number; y: number } | null = null;
  const onScroll = () => {
    const top = Math.max(0, container.scrollTop);
    if (top < previousTop && top < 100) load();
    previousTop = top;
  };
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0 && container.scrollTop < 100) load();
  };
  const onTouchStart = (event: TouchEvent) => {
    touch = event.touches.length === 1
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
      : null;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!touch || event.touches.length !== 1) { touch = null; return; }
    const dy = event.touches[0].clientY - touch.y;
    const dx = Math.abs(event.touches[0].clientX - touch.x);
    // Also works when the page is empty/short and cannot emit a scroll event.
    if (dy > 40 && dy > dx && container.scrollTop <= 0) {
      touch = null;
      load();
    }
  };
  const onTouchEnd = () => { touch = null; };
  container.addEventListener("scroll", onScroll, { passive: true });
  container.addEventListener("wheel", onWheel, { passive: true });
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: true });
  container.addEventListener("touchend", onTouchEnd);
  container.addEventListener("touchcancel", onTouchEnd);
  return () => {
    container.removeEventListener("scroll", onScroll);
    container.removeEventListener("wheel", onWheel);
    container.removeEventListener("touchstart", onTouchStart);
    container.removeEventListener("touchmove", onTouchMove);
    container.removeEventListener("touchend", onTouchEnd);
    container.removeEventListener("touchcancel", onTouchEnd);
  };
}

export function useMessageHistoryScroll(ref: RefObject<HTMLDivElement | null>, load: () => void) {
  useEffect(() => {
    if (ref.current) return observeMessageHistoryScroll(ref.current, load);
  }, [ref, load]);
}
