"use client";

import Avatar from "@/components/ui/Avatar";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import type { SharedMessage, Attachment } from "@/lib/types";
import AttachmentItem from "@/components/ui/AttachmentItem";
import MarkdownContent from "@/components/ui/MarkdownContent";
import SystemMessageNotice from "@/components/ui/SystemMessageNotice";
import TransferCard, { parseTransferText, parseTransferNotice } from "@/components/dashboard/TransferCard";
import { useLanguage } from "@/lib/i18n";
import { isDashboardMessageRecalled, recalledMessageLabel } from "@/lib/message-recall";
import { formatMessageTimestamp } from "@/lib/message-time";

interface SharedMessageBubbleProps {
  message: SharedMessage;
}

export default function SharedMessageBubble({ message }: SharedMessageBubbleProps) {
  const locale = useLanguage();
  const textContent = message.payload?.text || message.payload?.body || message.payload?.message;
  const displayText = typeof textContent === "string" ? textContent : message.text;
  const isRecalled = isDashboardMessageRecalled(message);
  const timestampLabel = formatMessageTimestamp(message.created_at);
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
      <Avatar kind={message.sender_id.startsWith("hu_") ? "human" : "agent"} id={message.sender_id} name={message.sender_name} size="sm" className="mt-1" />
      <Card padding="md" className="min-w-0 max-w-[min(720px,calc(100%-44px))]">
        <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-text-primary">{message.sender_name}</span>
          <span className="font-mono text-xs text-text-secondary">{message.sender_id}</span>
        </div>
        {isRecalled ? (
          <p className="text-sm italic text-text-secondary">{recalledMessageLabel(locale)}</p>
        ) : transferInfo ? (
          <TransferCard info={transferInfo} isNotice={displayText?.startsWith("[BotCord Notice]")} />
        ) : (
          displayText && <MarkdownContent content={displayText} />
        )}
        {!isRecalled && attachments.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {attachments.map((att, i) => (
              <AttachmentItem key={`${att.filename}-${i}`} attachment={att} />
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="font-mono text-xs text-text-secondary">
            {timestampLabel}
          </span>
          {message.type !== "message" && (
            <Badge tone="neutral" >
              {message.type}
            </Badge>
          )}
        </div>
      </Card>
    </div>
  );
}
