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
  it("keeps sending separate from compact thinking feedback", () => {
    expect(render({ send_status: "sending" })).toContain("正在发送");
    const html = render({ send_status: "sent", reply_activity: [{ agent_id: "a", agent_name: "助手 A", status: "waiting" }] });
    expect(html).not.toContain("已发送");
    expect(html).toContain('data-status="thinking"');
    expect(html).not.toContain("等待处理");
    expect(html).not.toContain("正在处理");
    expect(html).not.toContain("你可以继续发送消息");
    expect(html).not.toContain("处理失败");
  });
  it("shows per-agent terminal status without a spinner", () => {
    const html = render({ reply_activity: [
      { agent_id: "a", agent_name: "助手 A", status: "processing" },
      { agent_id: "b", agent_name: "助手 B", status: "completed" },
      { agent_id: "c", agent_name: "助手 C", status: "failed" },
    ] });
    expect(html).toContain("助手 A");
    expect(html).toContain('data-status="thinking"');
    expect(html).not.toContain("助手 B");
    expect(html).not.toContain("已回复");
    expect(html).toContain("助手 C");
    expect(html).toContain("重试");
  });
  it("ends waiting for no_reply, interrupted and unconfirmed outcomes", () => {
    for (const status of ["no_reply", "interrupted", "unconfirmed"] as const) {
      const html = render({ reply_activity: [{ agent_id: "a", agent_name: "A", status }] });
      expect(html).not.toContain("还在等待回复");
      expect(html).not.toContain("正在处理");
    }
  });
  it("keeps retry available only for the sender and hides recalled feedback", () => {
    expect(render({ is_mine: false, send_status: "failed" })).not.toContain("<button");
    expect(render({ send_status: "failed", send_error: "Network unavailable" })).toContain("Network unavailable");
    expect(render({ is_recalled: true })).toBe("");
    expect(renderToStaticMarkup(<TeamMessageFeedback message={base} />)).toBe("");
  });
});

it("explains revoked access without offering an ineffective retry", () => {
  const html = render({ send_status: "failed", send_error: "agent_access_revoked", reply_activity: [] });
  expect(html).toContain("你对该 Agent 的使用授权已被撤销或过期");
  expect(html).not.toContain("agent_access_revoked");
  expect(html).not.toContain("<button");
  expect(render({ send_status: "failed", send_error: "Network unavailable" })).toContain("重试");
});

it("hides success and untracked history, but distinguishes an explicit unresolved run", () => {
  expect(render({ send_status: "sent", reply_activity: [] })).toBe("");
  expect(render({ reply_activity: undefined })).toBe("");
  expect(render({ reply_activity: [{ agent_id: "a", agent_name: "A", status: "unconfirmed", basis: "legacy" }] })).toBe("");
  for (const metadata of [{ basis: "run" as const }, { run_id: "run" }]) {
    const html = render({ reply_activity: [{ agent_id: "a", agent_name: "A", status: "unconfirmed", ...metadata }] });
    expect(html).toContain("已结束，未关联回复");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("还在等待回复");
  }
});

it("shows other members only active work and keeps legacy failures actionable", () => {
  const activity = [
    { agent_id: "a", agent_name: "等待者", status: "waiting" as const, basis: "legacy" as const },
    { agent_id: "b", agent_name: "失败者", status: "failed" as const, error: "delivery_expired", basis: "legacy" as const },
    { agent_id: "c", agent_name: "静默者", status: "no_reply" as const, basis: "run" as const },
  ];
  const other = render({ is_mine: false, reply_activity: activity });
  expect(other).toContain("等待者");
  expect(other).not.toContain("失败者");
  expect(other).not.toContain("静默者");
  expect(other).not.toContain("还在等待回复");
  const own = render({ reply_activity: activity });
  expect(own).toContain("投递超时");
  expect(own).toContain("重试可能重复");
});
