"use client";

import { useEffect, useRef } from "react";
import { animatePop, cleanupAnime } from "@/lib/anime";

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
}: {
  count: number;
  size?: "md" | "sm";
  className?: string;
  label?: string;
}) {
  const badgeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const badge = badgeRef.current;
    if (!badge) return;
    const animation = animatePop(badge);
    return () => cleanupAnime(animation);
  }, [count]);

  const sizing =
    size === "sm"
      ? "h-4 min-w-[16px] px-1 text-[9px]"
      : "h-5 min-w-[20px] px-1.5 text-[10px]";
  return (
    <span
      ref={badgeRef}
      aria-label={label}
      className={`flex shrink-0 items-center justify-center rounded-full bg-neon-cyan font-bold leading-none text-[var(--color-on-accent)] tabular-nums shadow-[0_0_10px_rgba(34,211,238,0.55)] ${sizing} ${className}`}
    >
      {formatUnreadCount(count)}
    </span>
  );
}
