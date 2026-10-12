"use client";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";

import { type AccessBadgeInfo } from "@/lib/team-access";
import { useId, useState } from "react";

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
    <span
      className={`inline-flex max-w-full flex-col items-start ${className}`}
    >
      <Button
        variant="inline"
        size="sm"
        type="button"
        title={info.explanation}
        aria-expanded={open}
        aria-describedby={id}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="shrink-0"
      >
        <Badge
          tone={
            info.tone === "full"
              ? "danger"
              : info.tone === "consult"
                ? "success"
                : info.tone === "none"
                  ? "neutral"
                  : "accent"
          }
        >
          {prefix ? `${prefix}${info.label}` : info.label}
        </Badge>
      </Button>
      <span
        id={id}
        role="note"
        className={
          open ? "mt-1 block text-xs leading-4 text-text-secondary" : "sr-only"
        }
      >
        {info.explanation}
      </span>
    </span>
  );
}
