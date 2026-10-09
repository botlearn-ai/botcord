import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
import { RoomAgentChips, RoomReplyHints } from "./TeamRoomAgentAccess";
import type { RoomAgentAccess } from "@/lib/team-access";

const agents: RoomAgentAccess[] = [
  { agent_id: "ag_b", display_name: "Barry", my_capability: "consult", basis: "room", reply_mode: "mention_only", keywords: [] },
  { agent_id: "ag_k", display_name: "Kim", my_capability: "collaborator", basis: "grant", reply_mode: "keyword", keywords: ["部署"] },
  { agent_id: "ag_m", display_name: "Mine", my_capability: "full", basis: "owner", reply_mode: "always", keywords: [] },
];

it("shows each Agent with my capability badge", () => {
  const html = renderToStaticMarkup(<RoomAgentChips agents={agents} />);
  for (const text of ["Barry", "只读", "Kim", "协作", "Mine", "完整"]) expect(html).toContain(text);
});

it("hints only Agents that don't reply to every message", () => {
  const html = renderToStaticMarkup(<RoomReplyHints agents={agents} />);
  expect(html).toContain("Barry 只在被 @ 时回复");
  expect(html).toContain("Kim 只在提到关键词 部署 时回复");
  expect(html).not.toContain("Mine");
  expect(renderToStaticMarkup(<RoomReplyHints agents={[agents[2]]} />)).toBe("");
});
