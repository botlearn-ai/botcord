/**
 * [INPUT]: ID, optional localized copy labels, Clipboard API
 * [OUTPUT]: Accessible ID copy button with persistent icon and result announcement
 * [POS]: Shared identity control
 * [PROTOCOL]: Keep optional props compatible; contract in COMPONENTS.md
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

interface CopyableIdProps {
  value: string;
  className?: string;
  copyLabel?: string;
  copiedLabel?: string;
  copyFailedLabel?: string;
}

export default function CopyableId({ value, className, copyLabel = "Copy ID", copiedLabel = "ID copied", copyFailedLabel = "Could not copy ID" }: CopyableIdProps) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setResult("copied");
    } catch {
      setResult("failed");
    }
    timer.current = setTimeout(() => setResult(null), 1500);
  };
  const Icon = result === "copied" ? Check : Copy;
  return (
    <span className={`inline-flex min-w-0 max-w-full ${className || ""}`}>
      <button type="button" onClick={handleCopy} aria-label={`${copyLabel}: ${value}`} title={copyLabel}
        className="bc-touch-target inline-flex min-w-0 items-center gap-1.5 rounded font-mono text-xs text-text-secondary transition-colors hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
        <span className="break-all text-left">{value}</span>
        <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <span role="status" className="sr-only">{result === "copied" ? copiedLabel : result === "failed" ? copyFailedLabel : ""}</span>
    </span>
  );
}
