"use client";

import type { ReactNode } from "react";

interface SystemMessageNoticeProps {
  text?: string;
  timestamp?: string;
  children?: ReactNode;
}

export default function SystemMessageNotice({ text, timestamp, children }: SystemMessageNoticeProps) {
  return (
    <div className="my-3 flex justify-center px-3">
      <div className="liquid-card max-w-[82%] rounded-full px-3 py-1.5 text-center text-xs leading-relaxed text-text-secondary">
        <span className="break-words">{children ?? text ?? "System update"}</span>
        {timestamp && (
          <span className="ml-2 whitespace-nowrap font-mono text-[10px] text-text-secondary/45">
            {timestamp}
          </span>
        )}
      </div>
    </div>
  );
}
