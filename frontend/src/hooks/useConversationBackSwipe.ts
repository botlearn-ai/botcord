"use client";

import { useEffect } from "react";

/** Only conversations own this gesture; list rows use a separate left swipe. */
export function bindConversationBackSwipe(doc: Document, onBack: () => void) {
  let start: { x: number; y: number; at: number; id: number } | null = null;
  let claimed = false;
  const reset = () => { start = null; claimed = false; };
  const onStart = (event: TouchEvent) => {
    reset();
    const target = event.target;
    if (!(target instanceof Element) || event.touches.length !== 1
      || !window.matchMedia("(max-width: 767px)").matches
      || !target.closest('[data-mobile-conversation="true"]')
      || target.closest('input, textarea, [contenteditable], button, a, [role="dialog"], [role="menu"]')
      || doc.querySelector('[aria-modal="true"]')
      || doc.getSelection()?.toString()) return;
    const touch = event.touches[0];
    if (touch.clientX > 24) return;
    start = { x: touch.clientX, y: touch.clientY, at: Date.now(), id: touch.identifier };
  };
  const onMove = (event: TouchEvent) => {
    if (!start) return;
    if (event.touches.length !== 1) { reset(); return; }
    const touch = event.touches[0];
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    if (!claimed && (dy > 12 && dy >= Math.abs(dx) || dx < -12)) { reset(); return; }
    if (dx > 12 && dx > dy * 1.5) claimed = true;
    if (claimed && event.cancelable) event.preventDefault();
  };
  const onEnd = (event: TouchEvent) => {
    if (!start) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start!.id);
    const shouldGoBack = touch && touch.clientX - start.x >= 80
      && touch.clientX - start.x > Math.abs(touch.clientY - start.y) * 2
      && Date.now() - start.at < 900;
    reset();
    if (shouldGoBack) {
      if (event.cancelable) event.preventDefault();
      (doc.activeElement as HTMLElement | null)?.blur?.();
      onBack();
    }
  };
  doc.addEventListener("touchstart", onStart, { passive: true });
  doc.addEventListener("touchmove", onMove, { passive: false });
  doc.addEventListener("touchend", onEnd, { passive: false });
  doc.addEventListener("touchcancel", reset);
  return () => {
    doc.removeEventListener("touchstart", onStart);
    doc.removeEventListener("touchmove", onMove);
    doc.removeEventListener("touchend", onEnd);
    doc.removeEventListener("touchcancel", reset);
  };
}

export function useConversationBackSwipe(onBack: () => void) {
  useEffect(() => bindConversationBackSwipe(document, onBack), [onBack]);
}
