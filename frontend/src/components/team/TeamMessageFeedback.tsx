"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import type { DashboardMessage } from "@/lib/types";
import { emitJumpToMessage } from "@/components/dashboard/messageNavigation";
import { sendDashboardRoomMessage } from "@/lib/room-message-send";

export const TeamMessageFeedbackContext = createContext(false);

export default function TeamMessageFeedback({ message }: { message: DashboardMessage }) {
  const enabled = useContext(TeamMessageFeedbackContext);
  if (!enabled || message.is_recalled || message.sender_kind !== "human") return null;
  return <MessageFeedback message={message} />;
}

export function MessageFeedback({ message }: { message: DashboardMessage }) {
  const zh = useLanguage() === "zh";
  const [now, setNow] = useState(Date.now);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retried, setRetried] = useState(false);
  const activity = message.reply_activity ?? [];
  const pending = activity.some((a) => a.status === "waiting" || a.status === "processing");
  const sending = message.send_status === "sending" || (message.hub_msg_id.startsWith("tmp_") && message.state !== "failed");
  const failedSend = message.send_status === "failed" || (message.hub_msg_id.startsWith("tmp_") && message.state === "failed");
  const waitingForStatus = !sending && !failedSend && message.reply_activity === undefined && !!message.is_mine;
  const longWait = now - Date.parse(message.created_at) >= 15000;
  useEffect(() => {
    if ((!pending && !waitingForStatus) || longWait) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, 15000 - (Date.now() - Date.parse(message.created_at))));
    return () => window.clearTimeout(timer);
  }, [pending, waitingForStatus, longWait, message.created_at]);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const failedAgents = activity.filter((a) => ["failed", "interrupted", "unconfirmed"].includes(a.status)).map((a) => a.agent_id);
      await sendDashboardRoomMessage(failedSend ? message : {
        ...message,
        hub_msg_id: `tmp_${crypto.randomUUID()}`,
        msg_id: `tmp_${crypto.randomUUID()}`,
        created_at: new Date().toISOString(),
        reply_activity: undefined,
        // Retry only failed recipients in a group; successful agents are not pinged again.
        mentions: failedAgents,
      });
      setRetried(true);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : (zh ? "重试失败" : "Retry failed"));
    } finally {
      setRetrying(false);
    }
  };
  const canRetry = message.is_mine && (failedSend || activity.some((a) => ["failed", "interrupted", "unconfirmed"].includes(a.status)));
  return (
    <div className="mt-1 space-y-1 text-xs text-text-secondary" aria-live="polite" aria-atomic="true">
      {message.is_mine && <div className="flex items-center gap-1">
        {sending && <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin motion-reduce:animate-none" />}
        {sending ? (zh ? "正在发送…" : "Sending…") : failedSend ? (zh ? "发送失败" : "Send failed") : (zh ? "已发送" : "Sent")}
      </div>}
      {waitingForStatus && <div>{zh ? "正在确认 AI 接收状态…" : "Checking AI delivery…"}</div>}
      {activity.map((agent) => <div key={agent.agent_id} className="flex items-center gap-1.5">
        {agent.avatar_url ? <img src={agent.avatar_url} alt="" className="h-4 w-4 rounded-full" /> : <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center rounded-full bg-neon-cyan/10 text-[10px] text-neon-cyan">{agent.agent_name.slice(0, 1)}</span>}
        <span className="max-w-32 truncate" title={agent.agent_name}>{agent.agent_name}</span>
        <span className={agent.status === "failed" ? "text-red-400" : ""}>
          {agent.status === "failed" ? (agent.error === "delivery_expired" ? (zh ? "消息投递已过期，请重试" : "Delivery expired. Please retry") : (zh ? "处理失败，请重试" : "Processing failed. Please retry")) : agent.status === "processing" ? (zh ? "正在处理…" : "Working…")
          : agent.status === "completed" ? (zh ? "已回复" : "Replied")
          : agent.status === "no_reply" ? (zh ? "已处理 · 无需回复" : "Handled · No reply needed")
          : agent.status === "interrupted" ? (zh ? "处理已中断" : "Processing interrupted")
          : agent.status === "unconfirmed" ? (zh ? "回复状态未确认" : "Reply status unconfirmed")
          : (zh ? "等待处理…" : "Waiting for handling…")}
        </span>
        {agent.status === "completed" && agent.reply_msg_id && <button type="button" className="text-neon-cyan hover:underline" onClick={() => emitJumpToMessage({ msgId: agent.reply_msg_id!, roomId: message.room_id ?? undefined })}>{zh ? "查看回复" : "View reply"}</button>}
        {agent.status === "processing" && <span aria-hidden="true" className="motion-safe:animate-pulse text-neon-cyan">•••</span>}
      </div>)}
      {(pending || waitingForStatus) && longWait && <div>{zh ? "还在等待回复，你可以继续发送消息" : "Still waiting for a reply. You can send another message."}</div>}
      {failedSend && message.send_error && <div className="text-red-400">{message.send_error}</div>}
      {canRetry && !retried && <button type="button" disabled={retrying || sending} onClick={() => void retry()} className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50"><RotateCcw aria-hidden="true" className="h-3 w-3" />{retrying ? (zh ? "正在重试…" : "Retrying…") : (zh ? "重试" : "Retry")}</button>}
      {retried && !failedSend && <div>{zh ? "已重新发送" : "Sent again"}</div>}
      {retryError && <div role="alert" className="text-red-400">{retryError}</div>}
    </div>
  );
}
