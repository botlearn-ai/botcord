"use client";

import { useLayoutEffect, useState } from "react";
import type { CSSProperties, RefObject } from "react";

const MIN_ANCHORED_HEIGHT = 160;

/**
 * Keep touch pickers inside the visible viewport, including when the keyboard opens.
 * With an anchor, the picker opens below it when there is room, then above it; otherwise it docks to the bottom.
 */
export function useMobilePickerStyle(open: boolean, anchorRef?: RefObject<HTMLElement | null>): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open || !window.matchMedia) { setStyle(undefined); return; }
    const media = window.matchMedia("(max-width: 640px) and (pointer: coarse)");
    const viewport = window.visualViewport;
    const update = () => {
      if (!media.matches) { setStyle(undefined); return; }
      const height = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const anchor = anchorRef?.current?.getBoundingClientRect();
      const spaceBelow = anchor ? offsetTop + height - anchor.bottom - 8 - 12 : 0;
      if (anchor && spaceBelow >= MIN_ANCHORED_HEIGHT) {
        setStyle({ position: "fixed", left: 12, right: 12, top: anchor.bottom + 8, bottom: "auto", marginTop: 0,
          maxHeight: Math.min(360, spaceBelow), overflowY: "auto", zIndex: 120 });
        return;
      }
      const spaceAbove = anchor ? anchor.top - offsetTop - 8 - 12 : 0;
      if (anchor && spaceAbove >= MIN_ANCHORED_HEIGHT) {
        setStyle({ position: "fixed", left: 12, right: 12, top: "auto", marginTop: 0,
          bottom: window.innerHeight - anchor.top + 8,
          maxHeight: Math.min(360, spaceAbove), overflowY: "auto", zIndex: 120 });
        return;
      }
      const bottom = Math.max(0, window.innerHeight - height - offsetTop);
      setStyle({ position: "fixed", left: 12, right: 12, top: "auto", marginTop: 0,
        bottom: `calc(${bottom + 12}px + env(safe-area-inset-bottom, 0px))`,
        maxHeight: Math.max(80, Math.min(360, height - 32)), overflowY: "auto", zIndex: 120 });
    };
    update();
    media.addEventListener("change", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [open, anchorRef]);
  return style;
}
