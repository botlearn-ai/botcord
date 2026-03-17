import type { DashboardMessage, Attachment } from "../../lib/types";
import { useDashboard } from "./DashboardApp";
import AttachmentItem from "../ui/AttachmentItem";
import CopyableId from "../ui/CopyableId";

interface MessageBubbleProps {
  message: DashboardMessage;
  isOwn: boolean;
}

const stateConfig: Record<string, { label: string; color: string; icon: string }> = {
  queued:    { label: "Queued",    color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", icon: "⏳" },
  delivered: { label: "Delivered", color: "text-blue-400 bg-blue-400/10 border-blue-400/30",     icon: "✓" },
  acked:     { label: "Acked",    color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30", icon: "✓✓" },
  done:      { label: "Done",     color: "text-green-400 bg-green-400/10 border-green-400/30",   icon: "✔" },
  failed:    { label: "Failed",   color: "text-red-400 bg-red-400/10 border-red-400/30",         icon: "✗" },
};

function StateCountsBadges({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const order = ["done", "acked", "delivered", "queued", "failed"];
  const entries = order
    .filter((s) => counts[s] && counts[s] > 0)
    .map((s) => ({ state: s, count: counts[s] }));

  return (
    <span className="inline-flex items-center gap-1">
      {entries.map(({ state, count }) => {
        const sc = stateConfig[state];
        if (!sc) return null;
        return (
          <span
            key={state}
            className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[10px] font-medium ${sc.color}`}
          >
            <span className="text-[8px]">{sc.icon}</span>
            {count}/{total} {sc.label}
          </span>
        );
      })}
    </span>
  );
}

export default function MessageBubble({ message, isOwn }: MessageBubbleProps) {
  const { selectAgent } = useDashboard();
  const textContent = message.payload?.text || message.payload?.body || message.payload?.message;
  const displayText = typeof textContent === "string" ? textContent : message.text;

  const attachments = Array.isArray(message.payload?.attachments)
    ? (message.payload.attachments as Attachment[])
    : [];

  const sc = stateConfig[message.state];

  return (
    <div className={`flex ${isOwn ? "justify-end" : "justify-start"} mb-2`}>
      <div
        className={`max-w-[70%] rounded-xl px-3 py-2 ${
          isOwn
            ? "border border-neon-cyan/30 bg-neon-cyan/5"
            : "border border-glass-border bg-glass-bg"
        }`}
      >
        {!isOwn && (
          <button
            onClick={(e) => { e.stopPropagation(); selectAgent(message.sender_id); }}
            className="mb-0.5 flex items-center gap-1.5 rounded px-1 -ml-1 transition-colors hover:bg-glass-bg"
          >
            <span className="text-xs font-medium text-neon-purple hover:underline">{message.sender_name}</span>
            <CopyableId value={message.sender_id} />
          </button>
        )}

        {/* Goal badge */}
        {message.goal && (
          <div className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-neon-purple/20 bg-neon-purple/5 px-2 py-1.5">
            <span className="mt-px text-xs text-neon-purple/70">🎯</span>
            <span className="text-xs leading-relaxed text-neon-purple/90">{message.goal}</span>
          </div>
        )}

        <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{displayText}</p>

        {attachments.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {attachments.map((att, i) => (
              <AttachmentItem key={`${att.filename}-${i}`} attachment={att} />
            ))}
          </div>
        )}

        {/* Footer: time + type + state */}
        <div className={`mt-1 flex items-center gap-1.5 ${isOwn ? "justify-end" : ""}`}>
          <span className="font-mono text-[10px] text-text-secondary/50">
            {new Date(message.created_at).toLocaleTimeString()}
          </span>
          {message.type !== "message" && (
            <span className="rounded bg-glass-bg px-1 font-mono text-[10px] text-text-secondary/70">
              {message.type}
            </span>
          )}
          {message.state_counts && Object.keys(message.state_counts).length > 0 ? (
            <StateCountsBadges counts={message.state_counts} />
          ) : sc ? (
            <span className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[10px] font-medium ${sc.color}`}>
              <span className="text-[8px]">{sc.icon}</span>
              {sc.label}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
