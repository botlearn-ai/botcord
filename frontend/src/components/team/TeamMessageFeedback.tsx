"use client";
import { chatPane } from "@/lib/i18n/translations/dashboard";
import Alert from "@/components/ui/Alert";
import AgentMessageReactions from "./AgentMessageReactions";
import { needsResponseRetry } from "@/lib/message-response-activity";
import Button from "@/components/ui/Button";

import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useLanguage } from "@/lib/i18n";
import { sendDashboardRoomMessage } from "@/lib/room-message-send";
import type { DashboardMessage } from "@/lib/types";
import { Loader2, RotateCcw } from "lucide-react";
import { createContext, useContext, useRef, useState } from "react";

export const TeamMessageFeedbackContext = createContext(false);

export default function TeamMessageFeedback({
  message,
}: {
  message: DashboardMessage;
}) {
  const enabled = useContext(TeamMessageFeedbackContext);
  if (!enabled || message.is_recalled)
    return null;
  return <MessageFeedback message={message} />;
}

export function MessageFeedback({ message }: { message: DashboardMessage }) {
  const zh = useLanguage() === "zh";
  const [retrying, setRetrying] = useState(false);
  const retryInFlight = useRef(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retried, setRetried] = useState(false);
  const activity = message.reply_activity ?? [];
  const accessRevoked = message.send_error === "agent_access_revoked";
  const errorText = (error: string) => error === "agent_access_revoked"
    ? chatPane[zh ? "zh" : "en"].agentAccessRevoked
    : error;
  const sending =
    message.send_status === "sending" ||
    (message.hub_msg_id.startsWith("tmp_") && message.state !== "failed");
  const failedSend =
    message.send_status === "failed" ||
    (message.hub_msg_id.startsWith("tmp_") && message.state === "failed");
  const visibleActivity = activity;

  const retry = async () => {
    if (retryInFlight.current || accessRevoked || !message.is_mine) return;
    const latest = (useDashboardChatStore.getState().messages[message.room_id ?? ""] ?? [])
      .find((m) => m.hub_msg_id === message.hub_msg_id || m.msg_id === message.msg_id) ?? message;
    if (latest.is_recalled || latest.send_error === "agent_access_revoked") return;
    const retrySend = latest.send_status === "failed" ||
      (latest.hub_msg_id.startsWith("tmp_") && latest.state === "failed");
    const targets = (latest.reply_activity ?? [])
      .filter(needsResponseRetry).map((a) => a.agent_id);
    if (!retrySend && targets.length === 0) return;
    retryInFlight.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      if (retrySend) {
        // Retry an ambiguous HTTP send with the same persistent request key.
        await sendDashboardRoomMessage(latest);
      } else {
        // Explicit execution retries are new requests. On network failure, the
        // new bubble owns subsequent retries; never mint more keys here.
        const id = `tmp_${crypto.randomUUID()}`;
        setRetried(true);
        await sendDashboardRoomMessage({
          ...latest, hub_msg_id: id, msg_id: id, send_request_id: id,
          created_at: new Date().toISOString(), reply_activity: undefined,
          send_status: "sending", send_error: undefined, state: "queued",
          mentions: targets,
        });
      }
    } catch (error) {
      setRetryError(error instanceof Error ? errorText(error.message) : zh ? "重试失败" : "Retry failed");
    } finally {
      retryInFlight.current = false;
      setRetrying(false);
    }
  };
  const canRetry =
    message.is_mine && !accessRevoked &&
    (failedSend ||
      activity.some(needsResponseRetry));
  const retryControls = <>
      {canRetry && !retried && (<>
        <div>{zh ? "上次可能已送达或已执行，重试可能重复。" : "The previous attempt may have arrived or run. Retrying may repeat it."}</div>
        <Button
          variant="inline"
          size="sm"
          data-response-retry
          type="button"
          disabled={retrying || sending}
          onClick={() => void retry()}
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          {retrying ? (zh ? "正在重试…" : "Retrying…") : zh ? "重试" : "Retry"}
        </Button>
      </>)}
      {retried && !failedSend && <div>{zh ? "已重新发送" : "Sent again"}</div>}
      {retryError && <Alert tone="danger">{retryError}</Alert>}
  </>;
  if (!visibleActivity.length && !(message.is_mine && (sending || failedSend)) && !retryError) return null;
  return (
    <div
      className="mt-1 space-y-1 text-xs text-text-secondary"
      aria-live="polite"
      aria-atomic="true"
    >
      {message.is_mine && (sending || failedSend) && (
        <div className="flex items-center gap-1">
          {sending && (
            <Loader2
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          )}
          {sending
            ? zh
              ? "正在发送…"
              : "Sending…"
            : failedSend
              ? zh
                ? "发送失败，可能已送达"
                : "Send failed; delivery is uncertain"
              : zh
                ? "已发送"
                : "Sent"}
        </div>
      )}
      <AgentMessageReactions activity={visibleActivity} messageId={message.msg_id} align={message.is_mine ? "end" : "start"} actions={!failedSend && (canRetry || retried || retryError) ? retryControls : undefined} />
      {message.is_mine && failedSend && message.send_error && (
        <div className="text-danger">{errorText(message.send_error)}</div>
      )}
      {failedSend && retryControls}
    </div>
  );
}
