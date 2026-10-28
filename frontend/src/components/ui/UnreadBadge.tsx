"use client";

/**
 * [INPUT]: Unread count, size, accessible label and optional clear animation.
 * [OUTPUT]: Theme-aware counter with a decorative, reduced-motion-safe burst.
 * [POS]: Shared unread indicator for conversation and Team lists.
 * [PROTOCOL]: Keep mounted with count=0 when using burstOnClear.
 */

import { useEffect, useRef, useState } from "react";
import { animatePop, cleanupAnime } from "@/lib/anime";
import styles from "./UnreadBadge.module.css";

export function formatUnreadCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * Theme-aware unread counter shared by personal and Team lists. Uses the
 * accent token (and its on-accent text color) so it follows light/dark themes.
 * `sm` is the compact variant for navigation icons.
 */
export default function UnreadBadge({
  count,
  size = "md",
  className = "",
  label,
  burstOnClear = false,
}: {
  count: number;
  size?: "md" | "sm";
  className?: string;
  label?: string;
  /** Keep mounted at count=0 to play a one-shot read confirmation. */
  burstOnClear?: boolean;
}) {
  const [burst, setBurst] = useState(false);
  const previousCount = useRef(count);
  useEffect(() => {
    const clearing = previousCount.current > 0 && count <= 0;
    previousCount.current = count;
    if (!burstOnClear || !clearing || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setBurst(false);
      return;
    }
    setBurst(true);
    const timer = setTimeout(() => setBurst(false), 220);
    return () => clearTimeout(timer);
  }, [count, burstOnClear]);
  const badgeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const badge = badgeRef.current;
    if (!badge || count <= 0) return;
    const animation = animatePop(badge);
    return () => cleanupAnime(animation);
  }, [count]);

  const sizing =
    size === "sm"
      ? "h-4 min-w-[16px] px-1 text-[11px]"
      : "h-5 min-w-[20px] px-1.5 text-xs";
  if (count <= 0) return burst ? (
    <span aria-hidden="true" data-unread-burst="true" className={`relative flex shrink-0 items-center justify-center text-accent ${sizing} ${styles.burst} ${className}`}>
      <span className={styles.ring} />
      {[0, 1, 2, 3].map((index) => <span key={index} className={styles.particle} />)}
    </span>
  ) : null;
  return (
    <span
      ref={badgeRef}
      aria-label={label}
      className={`flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold leading-none text-on-accent tabular-nums ${sizing} ${className}`}
    >
      {formatUnreadCount(count)}
    </span>
  );
}
