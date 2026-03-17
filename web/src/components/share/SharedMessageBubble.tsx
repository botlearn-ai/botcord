import type { SharedMessage, Attachment } from "../../lib/types";
import AttachmentItem from "../ui/AttachmentItem";

interface SharedMessageBubbleProps {
  message: SharedMessage;
}

export default function SharedMessageBubble({ message }: SharedMessageBubbleProps) {
  const textContent = message.payload?.text || message.payload?.body || message.payload?.message;
  const displayText = typeof textContent === "string" ? textContent : message.text;

  const attachments = Array.isArray(message.payload?.attachments)
    ? (message.payload.attachments as Attachment[])
    : [];

  return (
    <div className="mb-2 flex justify-start">
      <div className="max-w-[70%] rounded-xl border border-glass-border bg-glass-bg px-3 py-2">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span className="text-xs font-medium text-neon-purple">{message.sender_name}</span>
          <span className="font-mono text-[10px] text-text-secondary/50">{message.sender_id}</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{displayText}</p>
        {attachments.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {attachments.map((att, i) => (
              <AttachmentItem key={`${att.filename}-${i}`} attachment={att} />
            ))}
          </div>
        )}
        <div className="mt-1 flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-text-secondary/50">
            {new Date(message.created_at).toLocaleTimeString()}
          </span>
          {message.type !== "message" && (
            <span className="rounded bg-glass-bg px-1 font-mono text-[10px] text-text-secondary/70">
              {message.type}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
