"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

/** Keep touch pickers inside the visible viewport, including when the keyboard opens. */
export function useMobilePickerStyle(open: boolean): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useEffect(() => {
    if (!open || !window.matchMedia) { setStyle(undefined); return; }
    const media = window.matchMedia("(max-width: 640px) and (pointer: coarse)");
    const viewport = window.visualViewport;
    const update = () => {
      if (!media.matches) { setStyle(undefined); return; }
      const height = viewport?.height ?? window.innerHeight;
      const bottom = Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0));
      setStyle({ position: "fixed", left: 12, right: 12, top: "auto", marginTop: 0,
        bottom: `calc(${bottom + 12}px + env(safe-area-inset-bottom, 0px))`,
        maxHeight: Math.max(80, height - 32), overflowY: "auto", zIndex: 120 });
    };
    update();
    media.addEventListener("change", update);
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [open]);
  return style;
}
