// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RoomList from "./RoomList";
import type { DashboardRoom, DashboardMessage } from "@/lib/types";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useConversationPreferencesStore } from "@/store/useConversationPreferencesStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { api } from "@/lib/api";
const push = vi.hoisted(() => vi.fn());
vi.mock("nextjs-toploader/app", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/anime", () => ({ animateIfMotion: () => null, animatePop: () => null, cleanupAnime: () => {} }));
let root: Root;
let host: HTMLDivElement;
const room = (id: string, date: string | null): DashboardRoom => ({
  room_id: id, name: id, description: "", owner_id: "ag_test", visibility: "private", member_count: 3,
  my_role: "member", rule: null, has_unread: true, unread_count: 2,
  last_message_at: date, last_message_preview: `summary ${id}`, last_sender_name: "Alice",
});
const message = (date: string): DashboardMessage => ({
  hub_msg_id: date, msg_id: date, sender_id: "ag_a", sender_name: "Bob", type: "message", text: "cached latest",
  payload: {}, room_id: "old", topic: null, topic_id: null, goal: null, state: "sent", state_counts: null, created_at: date,
});
const rooms = [room("old", "2026-08-01T00:00:00Z"), room("new", "2026-10-13T09:00:00Z"), room("empty", null)];
const rows = () => Array.from(host.querySelectorAll('[data-room-list-row]'));
const order = () => rows().map((row) => row.getAttribute("aria-label"));
const render = async (items = rooms) => act(() => root.render(<RoomList rooms={items} />));
const action = async (id: string, label: string) => {
  const wrapper = rows().find((row) => row.getAttribute("aria-label") === `Open room ${id}`)!.parentElement!.parentElement!;
  await act(() => wrapper.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
  const button = Array.from(wrapper.querySelectorAll("button")).find((node) => node.textContent === label)!;
  await act(() => button.click());
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useDashboardSessionStore.setState({ activeAgentId: "ag_test", human: null, humanRooms: [], ownedAgents: [] });
  useDashboardChatStore.setState({ messages: {}, overview: null, publicAgents: [] });
  useConversationPreferencesStore.setState({ accounts: {} });
  useDashboardUnreadStore.getState().resetUnreadState();
  vi.spyOn(useDashboardChatStore.getState(), "prefetchRoomMessages").mockResolvedValue(undefined);
  vi.spyOn(api, "markRoomRead").mockResolvedValue({ room_id: "old", last_viewed_at: "2026-10-13T10:00:00Z" });
  push.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it("orders by latest message, and uses the same source for date, sender and preview", async () => {
  await render();
  expect(order()).toEqual(["Open room new", "Open room old", "Open room empty"]);
  await act(() => useDashboardChatStore.setState({ messages: { old: [message("2026-10-13T10:00:00Z"), message("2026-07-01T00:00:00Z")] } }));
  expect(order()[0]).toBe("Open room old");
  expect(rows()[0].textContent).toContain("Bob: cached latest");
  expect(rows()[0].textContent).not.toContain("summary old");
  expect(rows()[0].textContent).not.toContain("8/1");
});
it("pins above recent rooms, unpins back into chronological order, and persists per account", async () => {
  await render(); await action("old", "Pin");
  expect(order()[0]).toBe("Open room old");
  const saved = JSON.parse(localStorage.getItem("botcord-conversation-preferences")!);
  expect(saved.state.accounts["agent:ag_test"].pinned).toEqual(["old"]);
  await action("old", "Unpin"); expect(order()[0]).toBe("Open room new");
  await action("old", "Pin");
  await act(() => useDashboardSessionStore.setState({ activeAgentId: "ag_other" }));
  expect(order()[0]).toBe("Open room new");
});
it("hides without deleting and restores on a newer message", async () => {
  await render(); await action("old", "Hide");
  expect(order()).not.toContain("Open room old");
  await render(); expect(order()).not.toContain("Open room old");
  await act(() => useDashboardChatStore.setState({ messages: { old: [message("2026-10-13T10:00:00Z")] } }));
  expect(order()[0]).toBe("Open room old");
  expect(useConversationPreferencesStore.getState().accounts["agent:ag_test"].hidden).toEqual({});
});
it("marks a room read through the API and updates the unread badge", async () => {
  await render(); await action("old", "Mark read");
  expect(api.markRoomRead).toHaveBeenCalledWith("old");
  expect(useDashboardUnreadStore.getState().isRoomUnread("old", true)).toBe(false);
});
it("keeps unread state on request failure", async () => {
  vi.mocked(api.markRoomRead).mockRejectedValueOnce(new Error("offline"));
  await render(); await action("old", "Mark read");
  expect(useDashboardUnreadStore.getState().isRoomUnread("old", true)).toBe(true);
});
