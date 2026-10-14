/** Durable input response facts. Delivery ACKs are tracked separately. */
export type MessageResponseState =
  | "queued" | "waiting" | "processing" | "ignored" | "no_reply" | "replying"
  | "completed" | "failed" | "interrupted" | "unconfirmed";

export type ResponseReason =
  | "attention_policy" | "agent_decision" | "queue_overflow" | "batch_trimmed"
  | "superseded" | "cancelled" | "runtime_error" | "runtime_timeout"
  | "reply_send_failed" | "missing_decision" | "auth_unavailable" | "not_executed" | "invalid_decision" | "response_reporting_failed";

export interface ResponseRunUpdate {
  run_id: string;
  room_id: string;
  action: "queue" | "register" | "start" | "ignore" | "no_reply" | "replying" | "heartbeat" | "finish";
  message_ids?: string[];
  outcome?: "unconfirmed" | "failed" | "interrupted";
  reason?: ResponseReason;
  /** Queue cleanup must not replace a running execution's real outcome. */
  only_if_queued?: boolean;
}
