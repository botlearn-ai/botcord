import type { DashboardMessage, RoomReplyActivity } from "./types";

export type ResponseState = NonNullable<RoomReplyActivity["response_state"]>;
export function responseState(activity: RoomReplyActivity): ResponseState {
  if (activity.response_state) return activity.response_state;
  // Older no_reply conflated policy skips with a decision made after processing.
  if (activity.status === "no_reply") return "unknown";
  if (activity.basis === "legacy" && activity.status !== "failed") return "unknown";
  return activity.status;
}
const ORDER: Record<ResponseState, number> = {
  replying: 0, processing: 1, queued: 2, waiting: 3, failed: 4, interrupted: 5,
  unconfirmed: 6, completed: 7, no_reply: 8, ignored: 9, unknown: 10,
};
export function sortedResponses(activity: RoomReplyActivity[]): RoomReplyActivity[] {
  return [...activity].sort((a, b) => ORDER[responseState(a)] - ORDER[responseState(b)] || a.agent_id.localeCompare(b.agent_id));
}
export const needsResponseRetry = (a: RoomReplyActivity) => ["failed", "interrupted"].includes(responseState(a));
export function responseAnimation(messages: DashboardMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.is_recalled) continue;
    const active = sortedResponses(message.reply_activity ?? []).find((a) => ["processing", "replying"].includes(responseState(a)));
    if (active) return `${message.msg_id}:${active.agent_id}`;
  }
  return null;
}
export const responseLabels: Record<ResponseState, [string, string]> = {
  queued: ["排队中", "Queued"], waiting: ["已接收，未开始", "Received, not started"],
  processing: ["思考中", "Thinking"], replying: ["回复中", "Replying"],
  completed: ["已回复", "Replied"], no_reply: ["已处理，无需回复", "Handled, no reply needed"],
  ignored: ["按策略忽略", "Skipped by policy"], failed: ["处理或发送失败", "Processing or send failed"],
  interrupted: ["已中断", "Interrupted"], unconfirmed: ["结果未确认", "Result unconfirmed"],
  unknown: ["处理记录不足", "Insufficient records"],
};
const reasons: Record<string, [string, string]> = {
  attention_policy: ["按回复策略跳过", "Skipped by response policy"], agent_decision: ["Agent 决定无需回复", "Agent chose not to reply"],
  lease_expired: ["执行租约超时", "Execution lease expired"], run_missing: ["缺少有效执行记录", "Valid execution record unavailable"],
  inconsistent_run: ["执行记录不一致", "Execution records are inconsistent"], missing_decision: ["未记录明确结果", "No explicit result recorded"],
  runtime_error: ["运行时出错", "Runtime error"], runtime_timeout: ["执行超时", "Execution timed out"],
  reply_send_failed: ["回复发送失败", "Reply send failed"], queue_overflow: ["执行队列已满", "Execution queue full"],
  batch_trimmed: ["未纳入本次执行", "Excluded from this batch"], superseded: ["被新的执行取代", "Superseded by a new execution"],
  cancelled: ["执行已取消", "Execution cancelled"], auth_unavailable: ["认证不可用", "Authentication unavailable"],
  not_executed: ["排队后未执行", "Not executed after queueing"], invalid_decision: ["回复决定格式无效", "Invalid response decision"],
  response_reporting_failed: ["状态上报失败", "Status report failed"],
};
export function responseReason(reason: string | null | undefined, zh: boolean): string | null {
  return reason && reasons[reason] ? reasons[reason][zh ? 0 : 1] : null;
}
