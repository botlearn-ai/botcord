"use client";

import { animate, createTimeline, utils } from "animejs";
import type { JSAnimation, Timeline } from "animejs";

type AnimeHandle = JSAnimation | Timeline | null | undefined;

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
