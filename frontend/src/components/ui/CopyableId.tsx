"use client";

import { useState } from "react";

interface CopyableIdProps {
  value: string;
  className?: string;
}

export default function CopyableId({ value, className }: CopyableIdProps) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      className={`group inline-flex items-center gap-1 font-mono text-[10px] text-text-secondary/50 hover:text-text-secondary transition-colors ${className || ""}`}
      title="Click to copy"
    >
      {value}
      <span className="text-[9px] opacity-0 group-hover:opacity-100 transition-opacity">
        {copied ? "Copied!" : "Copy"}
      </span>
    </button>
  );
}
