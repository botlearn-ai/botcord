"use client";

import { useId, useState } from "react";
import { BADGE_TONE_CLASS, type AccessBadgeInfo } from "@/lib/team-access";

/**
 * Capability badge with its plain-language meaning: shown as a tooltip on
 * hover and toggled inline on tap (mobile has no hover).
 */
export default function AccessBadge({
  info,
  prefix,
  className = "",
}: {
  info: AccessBadgeInfo;
  prefix?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className={`inline-flex max-w-full flex-col items-start ${className}`}>
      <button
        type="button"
        title={info.explanation}
        aria-expanded={open}
        aria-describedby={id}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 focus-visible:outline-2 focus-visible:outline-neon-cyan ${BADGE_TONE_CLASS[info.tone]}`}
      >
        {prefix ? `${prefix}${info.label}` : info.label}
      </button>
      <span
        id={id}
        role="note"
        className={open ? "mt-1 block text-[11px] leading-4 text-text-secondary" : "sr-only"}
      >
        {info.explanation}
      </span>
    </span>
  );
}
