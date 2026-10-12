"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

let openDialogCount = 0;
let originalBodyOverflow = "";

// Portal DOM order differs from visual order (global confirmations sit above the
// dashboard host). Compare ancestor z-index chains before falling back to DOM order.
function topModal(): Element | undefined {
  const key = (element: Element) => {
    const values: number[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const value = getComputedStyle(node).zIndex;
      if (value && value !== "auto" && Number.isFinite(Number(value))) values.unshift(Number(value));
    }
    return values;
  };
  return [...document.querySelectorAll('[aria-modal="true"]')].sort((a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const diff = (x[i] ?? 0) - (y[i] ?? 0); if (diff) return diff; }
    return 0;
  }).at(-1);
}

/** Shared modal ownership for animated Shell and externally animated Surface. */
export function useDialogInteractions(panelRef: RefObject<HTMLDivElement | null>, onClose: () => void, blocked = false, modal = true) {
  const closeRef = useRef(onClose);
  const blockedRef = useRef(blocked);
  closeRef.current = onClose;
  blockedRef.current = blocked;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (modal && openDialogCount++ === 0) { originalBodyOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
    const panel = panelRef.current;
    if (modal && topModal() === panel && !panel?.contains(document.activeElement)) panel?.focus({ preventScroll: true });
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const current = panelRef.current;
      const nativeModal = document.querySelector("dialog[open]");
      if (!current || (nativeModal && !current.contains(nativeModal))) return;
      const modals = [...document.querySelectorAll('[aria-modal="true"]')];
      if (modal ? topModal() !== current : modals.length > 0) return;
      if (event.key === "Escape") { event.preventDefault(); if (!blockedRef.current) closeRef.current(); }
      if (modal && event.key === "Tab") {
        const controls = [...current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((node) => !node.hidden && !node.closest('[hidden], [aria-hidden="true"], [inert]'));
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); current.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === current)) { event.preventDefault(); first.focus(); }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (modal && --openDialogCount === 0) document.body.style.overflow = originalBodyOverflow;
      if (modal && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [panelRef, modal]);
}
