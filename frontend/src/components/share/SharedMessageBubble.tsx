"use client";

import type { SharedMessage, Attachment } from "@/lib/types";
import AttachmentItem from "@/components/ui/AttachmentItem";
import MarkdownContent from "@/components/ui/MarkdownContent";
import SystemMessageNotice from "@/components/ui/SystemMessageNotice";
import TransferCard, { parseTransferText, parseTransferNotice } from "@/components/dashboard/TransferCard";

interface SharedMessageBubbleProps {
  message: SharedMessage;
}

export default function SharedMessageBubble({ message }: SharedMessageBubbleProps) {
  const textContent = message.payload?.text || message.payload?.body || message.payload?.message;
  const displayText = typeof textContent === "string" ? textContent : message.text;
  const timestampLabel = new Date(message.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const senderInitial = (message.sender_name || message.sender_id || "?").trim().slice(0, 1).toUpperCase();

  if (message.type === "system") {
    return <SystemMessageNotice text={displayText || "System update"} timestamp={timestampLabel} />;
  }

  const transferInfo = displayText
    ? parseTransferText(displayText) ?? parseTransferNotice(displayText, message.payload)
    : null;

  const attachments = Array.isArray(message.payload?.attachments)
    ? (message.payload.attachments as Attachment[])
    : [];

  return (
    <div className="flex justify-start gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-[linear-gradient(135deg,rgba(0,240,255,0.20),rgba(139,92,246,0.20))] text-xs font-semibold text-text-primary">
        {senderInitial}
      </div>
      <div className="min-w-0 max-w-[min(720px,calc(100%-44px))] rounded-lg border border-white/10 bg-white/[0.055] px-3.5 py-3 shadow-lg shadow-black/10">
        <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-text-primary">{message.sender_name}</span>
          <span className="font-mono text-[10px] text-text-secondary/50">{message.sender_id}</span>
        </div>
        {transferInfo ? (
          <TransferCard info={transferInfo} isNotice={displayText?.startsWith("[BotCord Notice]")} />
        ) : (
          displayText && <MarkdownContent content={displayText} />
        )}
        {attachments.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {attachments.map((att, i) => (
              <AttachmentItem key={`${att.filename}-${i}`} attachment={att} />
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-text-secondary/50">
            {timestampLabel}
          </span>
          {message.type !== "message" && (
            <span className="rounded border border-white/10 bg-white/[0.06] px-1 font-mono text-[10px] text-text-secondary/70">
              {message.type}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
