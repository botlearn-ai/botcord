"use client";

import type { KeyboardEvent } from "react";
import type { DashboardMessage, Attachment } from "@/lib/types";
import { useLanguage } from '@/lib/i18n';
import { messageBubble } from '@/lib/i18n/translations/dashboard';
import AttachmentItem from "@/components/ui/AttachmentItem";
import CopyableId from "@/components/ui/CopyableId";
import MarkdownContent from "@/components/ui/MarkdownContent";
import TransferCard, { parseTransferText, parseTransferNotice } from "@/components/dashboard/TransferCard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";

interface MessageBubbleProps {
  message: DashboardMessage;
  isOwn: boolean;
}

const stateColors: Record<string, { color: string; icon: string }> = {
  queued:    { color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", icon: "⏳" },
  delivered: { color: "text-blue-400 bg-blue-400/10 border-blue-400/30",     icon: "✓" },
  acked:     { color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30", icon: "✓✓" },
  done:      { color: "text-green-400 bg-green-400/10 border-green-400/30",   icon: "✔" },
  failed:    { color: "text-red-400 bg-red-400/10 border-red-400/30",         icon: "✗" },
};

const showMessageStatus = (() => {
  const raw = process.env.SHOW_MESSAGE_STATUS ?? process.env.NEXT_PUBLIC_SHOW_MESSAGE_STATUS;
  if (!raw) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
})();

function useStateConfig() {
  const locale = useLanguage();
  const t = messageBubble[locale];
  const labels: Record<string, string> = {
    queued: t.queued,
    delivered: t.delivered,
    acked: t.acked,
    done: t.done,
    failed: t.failed,
  };
  const config: Record<string, { label: string; color: string; icon: string }> = {};
  for (const [key, val] of Object.entries(stateColors)) {
    config[key] = { label: labels[key] || key, ...val };
  }
  return config;
}

function StateCountsBadges({ counts }: { counts: Record<string, number> }) {
  const stateConfig = useStateConfig();
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
  const selectAgent = useDashboardChatStore((state) => state.selectAgent);
  const stateConfig = useStateConfig();
  const textContent = message.payload?.text || message.payload?.body || message.payload?.message;
  const displayText = typeof textContent === "string" ? textContent : message.text;

  const transferInfo = displayText
    ? parseTransferText(displayText) ?? parseTransferNotice(displayText, message.payload)
    : null;

  const attachments = Array.isArray(message.payload?.attachments)
    ? (message.payload.attachments as Attachment[])
    : [];

  const sc = stateConfig[message.state];
  const handleSelectSender = () => {
    selectAgent(message.sender_id);
  };

  const handleSelectSenderByKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSelectSender();
    }
  };

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
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); handleSelectSender(); }}
            onKeyDown={handleSelectSenderByKey}
            className="mb-0.5 flex items-center gap-1.5 rounded px-1 -ml-1 transition-colors hover:bg-glass-bg"
          >
            <span className="text-xs font-medium text-neon-purple hover:underline">{message.sender_name}</span>
            <CopyableId value={message.sender_id} />
          </div>
        )}

        {/* Goal badge */}
        {message.goal && (
          <div className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-neon-purple/20 bg-neon-purple/5 px-2 py-1.5">
            <span className="mt-px text-xs text-neon-purple/70">🎯</span>
            <span className="text-xs leading-relaxed text-neon-purple/90">{message.goal}</span>
          </div>
        )}

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
          {showMessageStatus && (
            <>
              {message.state_counts && Object.keys(message.state_counts).length > 0 ? (
                <StateCountsBadges counts={message.state_counts} />
              ) : sc ? (
                <span className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[10px] font-medium ${sc.color}`}>
                  <span className="text-[8px]">{sc.icon}</span>
                  {sc.label}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
