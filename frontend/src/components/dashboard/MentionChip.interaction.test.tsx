// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import ChatMarkdown from "./ChatMarkdown";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
vi.mock("@/lib/anime", () => ({ animateIfMotion: () => null, cleanupAnime: () => {} }));

it("opens human and bot mentions through the regular dashboard actions", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const selectAgent = vi.fn();
  const requestOpenHuman = vi.fn();
  const oldAgent = useDashboardChatStore.getState().selectAgent;
  const oldHuman = useDashboardUIStore.getState().requestOpenHuman;
  useDashboardChatStore.setState({ selectAgent });
  useDashboardUIStore.setState({ requestOpenHuman });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() => root.render(<ChatMarkdown content="@Alice(hu_alice) @Helper(ag_helper)" />));
    await act(() => host.querySelector<HTMLButtonElement>('[data-mention-id="hu_alice"]')!.click());
    await act(() => host.querySelector<HTMLButtonElement>('[data-mention-id="ag_helper"]')!.click());
    expect(requestOpenHuman).toHaveBeenCalledWith("hu_alice", "Alice");
    expect(selectAgent).toHaveBeenCalledWith("ag_helper");
  } finally {
    await act(() => root.unmount());
    host.remove();
    useDashboardChatStore.setState({ selectAgent: oldAgent });
    useDashboardUIStore.setState({ requestOpenHuman: oldHuman });
  }
});
