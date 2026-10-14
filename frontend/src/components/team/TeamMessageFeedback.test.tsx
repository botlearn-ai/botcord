import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardMessage } from "@/lib/types";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("@/lib/room-message-send", () => ({ sendDashboardRoomMessage: vi.fn() }));
import TeamMessageFeedback, { TeamMessageFeedbackContext } from "./TeamMessageFeedback";
const base = { hub_msg_id: "h_1", msg_id: "m_1", sender_kind: "human", is_mine: true, created_at: new Date().toISOString() } as DashboardMessage;
const render = (patch: Partial<DashboardMessage>) => renderToStaticMarkup(<TeamMessageFeedbackContext.Provider value><TeamMessageFeedback message={{ ...base, ...patch }} /></TeamMessageFeedbackContext.Provider>);
describe("team message feedback", () => {
  it("keeps sending independent of avatar reactions", () => {
    expect(render({ send_status: "sending" })).toContain("正在发送");
    expect(render({ send_status: "sent", reply_activity: [] })).toBe("");
    const html = render({ reply_activity: [{ agent_id: "a", agent_name: "A", status: "processing", response_state: "processing" }] });
    expect(html).toContain('data-status="thinking"');
    expect(html).not.toContain("等待处理");
    expect(html).not.toContain("你可以继续发送消息");
  });
  it("retains completed and ignored reactions for all members and agent messages", () => {
    const html = render({ is_mine: false, sender_kind: "agent", reply_activity: [
      { agent_id: "a", agent_name: "A", status: "completed", response_state: "completed" },
      { agent_id: "b", agent_name: "B", status: "no_reply", response_state: "ignored" },
    ] });
    expect(html).toContain('data-response-state="completed"');
    expect(html).toContain('data-response-state="ignored"');
    expect(html).not.toContain("data-response-retry");
  });
  it("never fabricates a decision for legacy silence", () => {
    const html = render({ reply_activity: [{ agent_id: "a", agent_name: "A", status: "no_reply", basis: "legacy" }] });
    expect(html).toContain('data-response-state="unknown"');
    expect(html).not.toContain('data-response-state="ignored"');
  });
  it("restricts retry to the sender and hides recalled feedback", () => {
    expect(render({ is_mine: false, send_status: "failed" })).not.toContain("data-response-retry");
    expect(render({ send_status: "failed", send_error: "Network unavailable" })).toContain("Network unavailable");
    expect(render({ is_recalled: true })).toBe("");
    expect(renderToStaticMarkup(<TeamMessageFeedback message={base} />)).toBe("");
  });
  it("explains revoked access without offering a retry", () => {
    const html = render({ send_status: "failed", send_error: "agent_access_revoked" });
    expect(html).toContain("你对该 Agent 的使用授权已被撤销或过期");
    expect(html).not.toContain("data-response-retry");
  });
});
