import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("nextjs-toploader/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("../RoomZeroState", () => ({ default: () => <div data-empty-onboarding /> }));
vi.mock("../RoomList", () => ({
  default: ({ rooms, loading }: { rooms: { room_id: string }[]; loading?: boolean }) =>
    loading ? <div data-loading-rooms /> : <div>{rooms.map((room) => <span key={room.room_id}>{room.room_id}</span>)}</div>,
}));
// SSR normally reads Zustand's initial state. Read current state here so each
// render exercises a real combination of independently arriving store data.
vi.mock("@/store/useDashboardSessionStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/useDashboardSessionStore")>();
  const store = actual.useDashboardSessionStore;
  return { ...actual, useDashboardSessionStore: Object.assign((selector: (s: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), store) };
});
vi.mock("@/store/useDashboardChatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/useDashboardChatStore")>();
  const store = actual.useDashboardChatStore;
  return { ...actual, useDashboardChatStore: Object.assign((selector: (s: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), store) };
});
vi.mock("@/store/useDashboardUIStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/useDashboardUIStore")>();
  const store = actual.useDashboardUIStore;
  return { ...actual, useDashboardUIStore: Object.assign((selector: (s: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), store) };
});
import MessagesPanel from "./MessagesPanel";
import { ownedAgentRoomToDashboardRoom } from "@/lib/messages-merge";
import { useDashboardSessionStore as session } from "@/store/useDashboardSessionStore";
import { useDashboardChatStore as chat } from "@/store/useDashboardChatStore";
import { useDashboardUIStore as ui } from "@/store/useDashboardUIStore";
import type { DashboardOverview, HumanAgentRoomSummary } from "@/lib/types";
const overview: DashboardOverview = { agent: null, viewer: { type: "human", id: "hu_fixture", display_name: "Fixture" }, rooms: [], contacts: [], pending_requests: 0 };
const room: HumanAgentRoomSummary = {
  room_id: "rm_fixture", name: "Fixture", description: null, owner_id: "ag_fixture",
  visibility: "private", member_count: 2, rule: null,
  last_message_preview: null, last_message_at: null, last_sender_name: null,
  bots: [{ agent_id: "ag_fixture", display_name: "Fixture bot", role: "owner" }],
};
const render = () => renderToStaticMarkup(<MessagesPanel isGuest={false} onCreateRoom={() => {}} onAddFriend={() => {}} />);
beforeEach(() => {
  session.setState({ ...session.getInitialState(), sessionMode: "authed-ready", token: "fixture", activeIdentity: { type: "human", id: "hu_fixture" } });
  chat.setState({ ...chat.getInitialState(), overviewRefreshing: true });
  ui.setState({ ...ui.getInitialState(), sidebarTab: "messages", messagesFilter: "self-all" });
});
describe("Messages initial loading", () => {
  it("shows a loading list rather than onboarding before initial requests finish", () => {
    expect(render()).toContain("data-loading-rooms");
    expect(render()).not.toContain("data-empty-onboarding");
  });
  it("also waits for initial data for a human without an active bot", () => {
    session.setState({ sessionMode: "authed-no-agent" });
    expect(render()).toContain("data-loading-rooms");
  });
  it("shows human rooms immediately while overview and bot rooms are pending", () => {
    session.setState({ humanRooms: [{ ...room, description: "", owner_type: "human", my_role: "owner", join_policy: "invite", allow_human_send: true, default_send: true, default_invite: true, max_members: null, slow_mode_seconds: null, required_subscription_product_id: null, created_at: null }] });
    expect(render()).toContain("rm_fixture");
    expect(render()).not.toContain("data-loading-rooms");
  });
  it("shows bot rooms immediately when they arrive before overview", () => {
    ui.setState({ messagesFilter: "bots-all" });
    // Only presence matters to the bot filter; real profile fields are unused.
    session.setState({ ownedAgents: [{ agent_id: "ag_fixture" }] as ReturnType<typeof session.getState>["ownedAgents"] });
    chat.setState({ ownedAgentRooms: [room], ownedAgentRoomsLoaded: true });
    expect(render()).toContain("rm_fixture");
    expect(render()).not.toContain("data-loading-rooms");
  });
  it("does not show onboarding when overview is empty but bot rooms are pending", () => {
    chat.setState({ overview, overviewRefreshing: false });
    expect(render()).toContain("data-loading-rooms");
  });
  it("shows onboarding once both sources have resolved empty", () => {
    chat.setState({ overview, overviewRefreshing: false, ownedAgentRoomsLoaded: true });
    expect(render()).toContain("data-empty-onboarding");
    expect(render()).not.toContain("data-loading-rooms");
  });
  it("keeps available overview rows visible during background refresh", () => {
    chat.setState({ overview: { ...overview, rooms: [{ ...ownedAgentRoomToDashboardRoom(room), _originAgent: undefined }] }, overviewRefreshing: true });
    expect(render()).toContain("rm_fixture");
    expect(render()).not.toContain("data-loading-rooms");
  });
  it("does not wait for authenticated requests for a guest", () => {
    session.setState({ sessionMode: "guest", token: null, activeIdentity: null });
    expect(render()).not.toContain("data-loading-rooms");
  });
  it("does not keep a skeleton forever after overview fails", () => {
    chat.setState({ overviewErrored: true, overviewRefreshing: false, ownedAgentRoomsLoaded: true });
    expect(render()).not.toContain("data-loading-rooms");
  });
  it("does not wait for human-only data in an agent identity", () => {
    session.setState({ activeIdentity: { type: "agent", id: "ag_fixture" } });
    chat.setState({ overview, overviewRefreshing: false });
    expect(render()).toContain("data-empty-onboarding");
  });
});
