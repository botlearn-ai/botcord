"use client";

interface SystemMessageNoticeProps {
  text: string;
  timestamp?: string;
}

export default function SystemMessageNotice({ text, timestamp }: SystemMessageNoticeProps) {
  return (
    <div className="my-3 flex justify-center px-3">
      <div className="max-w-[82%] rounded-full border border-glass-border/60 bg-glass-bg/70 px-3 py-1.5 text-center text-xs leading-relaxed text-text-secondary shadow-sm">
        <span className="break-words">{text || "System update"}</span>
        {timestamp && (
          <span className="ml-2 whitespace-nowrap font-mono text-[10px] text-text-secondary/45">
            {timestamp}
          </span>
        )}
      </div>
    </div>
  );
}
