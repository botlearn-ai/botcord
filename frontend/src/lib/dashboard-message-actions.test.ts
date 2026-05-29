import { describe, expect, it } from "vitest";
import type { DashboardMessage } from "@/lib/types";
import { canReplyToDashboardMessage, dashboardReplyTargetId } from "@/lib/dashboard-message-actions";

function message(overrides: Partial<DashboardMessage> = {}): DashboardMessage {
  return {
    hub_msg_id: "hub_1",
    msg_id: "msg_1",
    sender_id: "ag_sender",
    sender_name: "Sender",
    type: "message",
    text: "hello",
    payload: { text: "hello" },
    room_id: "rm_1",
    topic: null,
    topic_id: null,
    goal: null,
    state: "queued",
    state_counts: null,
    created_at: "2026-05-29T08:00:00.000Z",
    ...overrides,
  };
}

describe("dashboard message actions", () => {
  it("uses canonical msg_id as the reply target when available", () => {
    expect(dashboardReplyTargetId(message())).toBe("msg_1");
  });

  it("falls back to hub_msg_id so realtime bot messages can be replied to", () => {
    expect(dashboardReplyTargetId(message({ msg_id: "tmp_local", hub_msg_id: "hub_real" }))).toBe("hub_real");
  });

  it("allows replies to any persisted non-system room message", () => {
    expect(canReplyToDashboardMessage(message({ type: "result", msg_id: "msg_result" }))).toBe(true);
    expect(canReplyToDashboardMessage(message({ type: "error", msg_id: "msg_error" }))).toBe(true);
  });

  it("does not allow replies to system, recalled, or temporary messages", () => {
    expect(canReplyToDashboardMessage(message({ type: "system" }))).toBe(false);
    expect(canReplyToDashboardMessage(message({ is_recalled: true }))).toBe(false);
    expect(canReplyToDashboardMessage(message({ hub_msg_id: "tmp_1", msg_id: "tmp_1" }))).toBe(false);
  });
});
