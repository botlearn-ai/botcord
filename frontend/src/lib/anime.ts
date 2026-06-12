"use client";

import { animate, createTimeline, utils } from "animejs";
import type { JSAnimation, Timeline } from "animejs";

type AnimeHandle = JSAnimation | Timeline | null | undefined;
type PanelDirection = "center" | "right" | "left" | "bottom";

interface OverlayPanelMotionOptions {
  direction?: PanelDirection;
  contentSelector?: string;
  onComplete?: () => void;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function cleanupAnime(handle: AnimeHandle): void {
  handle?.revert();
}

export function animateIfMotion(
  target: Parameters<typeof animate>[0],
  params: Parameters<typeof animate>[1],
): JSAnimation | null {
  if (prefersReducedMotion()) return null;
  return animate(target, params);
}

export function createTimelineIfMotion(
  params?: Parameters<typeof createTimeline>[0],
): Timeline | null {
  if (prefersReducedMotion()) return null;
  return createTimeline(params);
}

export const animeStagger = utils.stagger;

export function animatePulse(target: HTMLElement, color = "rgba(0, 240, 255, 0.52)"): JSAnimation | null {
  return animateIfMotion(target, {
    scale: [1, 1.025, 1],
    boxShadow: [
      "0 0 0 rgba(0, 240, 255, 0)",
      `0 0 18px ${color}`,
      "0 0 0 rgba(0, 240, 255, 0)",
    ],
    duration: 520,
    ease: "out(3)",
  });
}

export function animatePop(target: HTMLElement): JSAnimation | null {
  return animateIfMotion(target, {
    opacity: [0, 1],
    scale: [0.88, 1.04, 1],
    translateY: [6, -1, 0],
    duration: 360,
    ease: "out(3)",
  });
}

function panelEnterTransform(direction: PanelDirection): { translateX?: number[]; translateY?: number[]; scale?: number[] } {
  if (direction === "right") return { translateX: [28, 0] };
  if (direction === "left") return { translateX: [-28, 0] };
  if (direction === "bottom") return { translateY: [22, 0] };
  return { translateY: [14, 0], scale: [0.96, 1] };
}

function panelExitTransform(direction: PanelDirection): { translateX?: number; translateY?: number; scale?: number } {
  if (direction === "right") return { translateX: 24 };
  if (direction === "left") return { translateX: -24 };
  if (direction === "bottom") return { translateY: 18 };
  return { translateY: 8, scale: 0.98 };
}

export function animateOverlayPanelEnter(
  overlay: HTMLElement | null,
  panel: HTMLElement | null,
  options: OverlayPanelMotionOptions = {},
): Timeline | null {
  if (!panel) return null;

  const direction = options.direction ?? "center";
  const parts = options.contentSelector
    ? Array.from(panel.querySelectorAll<HTMLElement>(options.contentSelector))
    : [];

  if (overlay) overlay.style.opacity = "0";
  panel.style.opacity = "0";
  parts.forEach((part) => {
    part.style.opacity = "0";
    part.style.transform = "translateY(8px)";
  });

  const timeline = createTimelineIfMotion({ onComplete: options.onComplete });
  if (!timeline) {
    if (overlay) overlay.style.opacity = "1";
    panel.style.opacity = "1";
    panel.style.transform = "translate3d(0, 0, 0) scale(1)";
    parts.forEach((part) => {
      part.style.opacity = "1";
      part.style.transform = "translateY(0)";
    });
    options.onComplete?.();
    return null;
  }

  if (overlay) {
    timeline.add(overlay, {
      opacity: [0, 1],
      duration: 170,
      ease: "linear",
    }, 0);
  }

  timeline.add(panel, {
    opacity: [0, 1],
    ...panelEnterTransform(direction),
    duration: direction === "center" ? 260 : 240,
    ease: "out(3)",
  }, direction === "center" ? 10 : 0);

  if (parts.length) {
    timeline.add(parts, {
      opacity: [0, 1],
      translateY: [8, 0],
      duration: 210,
      delay: animeStagger(18),
      ease: "out(3)",
    }, 70);
  }

  return timeline;
}

export function animateOverlayPanelExit(
  overlay: HTMLElement | null,
  panel: HTMLElement | null,
  options: OverlayPanelMotionOptions = {},
): Timeline | null {
  const direction = options.direction ?? "center";
  const parts = panel && options.contentSelector
    ? Array.from(panel.querySelectorAll<HTMLElement>(options.contentSelector))
    : [];

  const timeline = createTimelineIfMotion({ onComplete: options.onComplete });
  if (!timeline) {
    options.onComplete?.();
    return null;
  }

  if (parts.length) {
    timeline.add(parts, {
      opacity: 0,
      translateY: -4,
      duration: 90,
      delay: animeStagger(8, { reversed: true }),
      ease: "in(2)",
    }, 0);
  }

  if (panel) {
    timeline.add(panel, {
      opacity: 0,
      ...panelExitTransform(direction),
      duration: 150,
      ease: "in(2)",
    }, parts.length ? 30 : 0);
  }

  if (overlay) {
    timeline.add(overlay, {
      opacity: 0,
      duration: 130,
      ease: "linear",
    }, parts.length ? 30 : 0);
  }

  return timeline;
}

export function animateFadeUp(target: Parameters<typeof animate>[0], delay = 0): JSAnimation | null {
  return animateIfMotion(target, {
    opacity: [0, 1],
    translateY: [8, 0],
    duration: 220,
    delay,
    ease: "out(3)",
  });
}
