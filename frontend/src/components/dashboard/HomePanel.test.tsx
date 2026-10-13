// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import HomePanel from "./HomePanel";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import type { AgentProfile } from "@/lib/types";

vi.mock("nextjs-toploader/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));

function agent(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    agent_id: "ag_x", display_name: "Bot", bio: null, message_policy: "open", created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useDaemonStore.setState({ daemons: [], refresh: vi.fn(async () => {}) });
  useDashboardSessionStore.setState({ ownedAgents: [], user: null });
  useDashboardChatStore.setState({
    publicRooms: [], publicHumans: [], publicRoomsLoaded: true, publicHumansLoaded: true, publicAgentsLoaded: true,
    publicAgents: [
      agent({ agent_id: "ag_a", owner_human_id: "hu_a", owner_display_name: "pr4-59df86-owner", owner_avatar_url: "https://example.com/a.png" }),
      agent({ agent_id: "ag_b", owner_human_id: "hu_b", owner_display_name: "RT Danny" }),
      agent({ agent_id: "ag_c" }),
    ],
  });
});

it("shows the owner name with a mini avatar instead of the \"'s Bot\" label", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<HomePanel />));
  const badges = [...host.querySelectorAll<HTMLElement>("[data-tone='neutral']")];
  const [withImage, withInitial, noOwner] = badges;

  expect(withImage.textContent).toBe("pr4-59df86-owner");
  expect(withImage.title).toBe("pr4-59df86-owner's Bot");
  expect(withImage.querySelector("[data-kind='human'] img")?.getAttribute("src")).toBe("https://example.com/a.png");

  expect(withInitial.textContent).toBe("RRT Danny");
  expect(withInitial.querySelector("[data-kind='human'] [role='img']")?.textContent).toBe("R");

  expect(noOwner.textContent).toBe("BOT");
  expect(noOwner.querySelector("[data-kind='human']")).toBeNull();
  expect(host.textContent).not.toContain("'s Bot");
  act(() => root.unmount());
});
