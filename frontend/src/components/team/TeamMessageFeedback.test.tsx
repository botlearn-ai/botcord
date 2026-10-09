import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardMessage } from "@/lib/types";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("@/lib/room-message-send", () => ({ sendDashboardRoomMessage: vi.fn() }));
import TeamMessageFeedback, { TeamMessageFeedbackContext } from "./TeamMessageFeedback";
const base = { hub_msg_id: "h_1", msg_id: "m_1", sender_kind: "human", is_mine: true, created_at: new Date(Date.now() - 16000).toISOString() } as DashboardMessage;
const render = (patch: Partial<DashboardMessage>) => renderToStaticMarkup(<TeamMessageFeedbackContext.Provider value><TeamMessageFeedback message={{ ...base, ...patch }} /></TeamMessageFeedbackContext.Provider>);
describe("team message feedback", () => {
  it("distinguishes transport from AI progress and does not fake work", () => {
    expect(render({ send_status: "sending" })).toContain("正在发送");
    const html = render({ send_status: "sent", reply_activity: [{ agent_id: "a", agent_name: "助手 A", status: "waiting" }] });
    expect(html).toContain("已发送");
    expect(html).toContain("等待响应");
    expect(html).not.toContain("正在处理");
    expect(html).toContain("你可以继续发送消息");
    expect(html).not.toContain("处理失败");
  });
  it("shows per-agent status and removes completed progress", () => {
    const html = render({ reply_activity: [
      { agent_id: "a", agent_name: "助手 A", status: "processing" },
      { agent_id: "b", agent_name: "助手 B", status: "completed" },
      { agent_id: "c", agent_name: "助手 C", status: "failed" },
    ] });
    expect(html).toContain("助手 A");
    expect(html).toContain("正在处理");
    expect(html).not.toContain("助手 B");
    expect(html).toContain("助手 C");
    expect(html).toContain("重试");
  });
  it("keeps retry available only for the sender and hides recalled feedback", () => {
    expect(render({ is_mine: false, send_status: "failed" })).not.toContain("<button");
    expect(render({ send_status: "failed", send_error: "Network unavailable" })).toContain("Network unavailable");
    expect(render({ is_recalled: true })).toBe("");
    expect(renderToStaticMarkup(<TeamMessageFeedback message={base} />)).toBe("");
  });
});
