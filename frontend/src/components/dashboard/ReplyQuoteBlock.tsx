"use client";

import { CornerUpLeft } from "lucide-react";
import type { ReplyPreview } from "@/lib/types";

interface ReplyQuoteBlockProps {
  preview: ReplyPreview;
  onJump?: (msgId: string) => void;
  className?: string;
}

/** Compact "replying to ..." quote block rendered above the actual message body.
 *  Renders a tombstone when the target was removed. Single-layer only — we do
 *  not render quote-of-quote chains. */
export default function ReplyQuoteBlock({ preview, onJump, className }: ReplyQuoteBlockProps) {
  const handleClick = () => {
    if (preview.deleted) return;
    onJump?.(preview.msg_id);
  };

  const senderLabel = preview.sender_display_name || preview.sender_id || "Unknown";
  const baseClass =
    "mb-1.5 flex items-start gap-1.5 rounded-md border-l-2 border-neon-cyan/40 bg-glass-bg/60 pl-2 py-1 pr-2 text-xs";
  const interactive = preview.deleted
    ? "opacity-60"
    : "cursor-pointer transition-colors hover:bg-glass-bg hover:border-neon-cyan/70";

  return (
    <div
      role={preview.deleted ? undefined : "button"}
      tabIndex={preview.deleted ? -1 : 0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (preview.deleted) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      className={`${baseClass} ${interactive} ${className ?? ""}`}
      aria-label={preview.deleted ? "Replied message (deleted)" : `Replying to ${senderLabel}`}
    >
      <CornerUpLeft className="mt-0.5 h-3 w-3 shrink-0 text-neon-cyan/70" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-neon-cyan/90">
          {preview.deleted ? "（消息已删除）" : senderLabel}
        </div>
        {!preview.deleted && preview.text_preview && (
          <div className="truncate text-[11px] text-text-secondary/80">
            {preview.text_preview}
          </div>
        )}
      </div>
    </div>
  );
}
