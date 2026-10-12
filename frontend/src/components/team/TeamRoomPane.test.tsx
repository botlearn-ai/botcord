import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { RoomAgentAccess } from "@/lib/team-access";
const mocks = vi.hoisted(() => ({ agents: [] as RoomAgentAccess[] }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("@/store/useDashboardUIStore", () => ({ useDashboardUIStore: () => false }));
vi.mock("@/components/dashboard/RoomHeader", () => ({ default: () => null }));
vi.mock("@/components/dashboard/MessageList", () => ({ default: () => null }));
vi.mock("@/components/dashboard/RoomHumanComposer", () => ({ default: () => <textarea aria-label="Message" /> }));
vi.mock("./TeamRoomAgentAccess", () => ({
  useRoomAgentAccess: () => mocks.agents,
  RoomAgentChips: () => null,
  RoomReplyHints: () => null,
}));
import TeamRoomPane from "./TeamRoomPane";
const render = (isDirect = true) => renderToStaticMarkup(<TeamRoomPane spaceId="s1" roomId="r1" title="Agent" allowHumanSend isDirect={isDirect} onBack={() => {}} onOpenMembers={() => {}} />);
it("replaces the denied Agent DM composer with a path to request access", () => {
  mocks.agents = [{ agent_id: "ag_a", display_name: "A", my_capability: "deny", basis: "none", reply_mode: "always", keywords: [] }];
  const html = render();
  expect(html).not.toContain("textarea");
  expect(html).toContain("active access");
  expect(html).toContain("/chats/team?space=s1&amp;view=agents");
  expect(render(false)).toContain("textarea");
});
it("keeps the composer for authorized Agent DMs and human DMs", () => {
  mocks.agents = [];
  expect(render()).toContain("textarea");
  mocks.agents = [{ agent_id: "ag_a", display_name: "A", my_capability: "consult", basis: "grant", reply_mode: "always", keywords: [] }];
  expect(render()).toContain("textarea");
});
