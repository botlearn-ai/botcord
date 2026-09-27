import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("nextjs-toploader/app", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("./ExploreEntityCard", () => ({ default: ({ id, data }: { id?: string; data?: { agent_id?: string; human_id?: string } }) => <button>{id ?? data?.agent_id ?? data?.human_id}</button> }));
vi.mock("./BotAvatar", () => ({ default: () => <span /> }));
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

import ChatPane from "./ChatPane";
import ContactsPanel from "./sidebar/ContactsPanel";
import ContactsDetailPane from "./ContactsDetailPane";
import PublicRoomList from "./PublicRoomList";
import PublicAgentList from "./PublicAgentList";
import { useDashboardSessionStore as session } from "@/store/useDashboardSessionStore";
import { useDashboardChatStore as chat } from "@/store/useDashboardChatStore";
import { useDashboardUIStore as ui } from "@/store/useDashboardUIStore";
import type { DashboardOverview, HumanRoomSummary, PublicRoom } from "@/lib/types";

const overview: DashboardOverview = { agent: null, viewer: { type: "human", id: "hu_fixture", display_name: "Fixture" }, rooms: [], contacts: [], pending_requests: 0 };
const room = { room_id: "rm_cached", name: "Cached group", member_count: 3, owner_type: "human", owner_id: "hu_fixture", description: "", members_preview: [] } as unknown as HumanRoomSummary;
const publicRoom = { ...room, last_message_at: null } as unknown as PublicRoom;
const agent = { agent_id: "ag_cached", display_name: "Cached agent", online: false, bio: "", message_policy: "open" } as ReturnType<typeof chat.getState>["publicAgents"][number];
beforeEach(() => {
  session.setState({ ...session.getInitialState(), authResolved: true, sessionMode: "authed-ready" });
  chat.setState({ ...chat.getInitialState() });
  ui.setState({ ...ui.getInitialState(), sidebarTab: "explore", exploreView: "rooms" });
});

describe("Explore first readable paint", () => {
  it("does not report an empty directory before the first request completes", () => {
    const html = renderToStaticMarkup(<ChatPane />);
    expect(html).not.toContain("No rooms");
    expect(html).toContain("dashboard-skeleton-block");
  });
  it.each([false, true])("renders matching cached rooms before effects, refreshing=%s", (refreshing) => {
    chat.setState({ publicRooms: [publicRoom], publicRoomsQuery: "", publicRoomsLoading: refreshing });
    expect(renderToStaticMarkup(<ChatPane />)).toContain("rm_cached");
  });
  it("does not expose previous search results on a new visit", () => {
    chat.setState({ publicRooms: [publicRoom], publicRoomsQuery: "previous search" });
    expect(renderToStaticMarkup(<ChatPane />)).not.toContain("rm_cached");
  });
  it("renders a known empty cached result during revalidation", () => {
    chat.setState({ publicRooms: [], publicRoomsQuery: "", publicRoomsLoading: true });
    expect(renderToStaticMarkup(<ChatPane />)).toContain("No rooms");
  });
  it("renders cached agents when switching directory tabs", () => {
    ui.setState({ exploreView: "agents" });
    chat.setState({ publicAgents: [agent], publicAgentsQuery: "", publicAgentsLoading: true });
    expect(renderToStaticMarkup(<ChatPane />)).toContain("ag_cached");
  });
});

describe("Contacts partial loading", () => {
  it("makes owned bots usable before overview arrives", () => {
    session.setState({ ownedAgents: [{ agent_id: "ag_owned", display_name: "Arrived owned bot", ws_online: true } as ReturnType<typeof session.getState>["ownedAgents"][number]] });
    expect(renderToStaticMarkup(<ContactsPanel />)).toContain("Arrived owned bot");
  });
  it("makes arrived groups usable while overview remains pending", () => {
    session.setState({ humanRooms: [room] });
    const html = renderToStaticMarkup(<ContactsPanel />);
    expect(html).toContain("Cached group");
    expect(html).not.toContain("No human contacts yet");
  });
  it("keeps human groups available even when overview contains an empty room list", () => {
    session.setState({ humanRooms: [room] });
    chat.setState({ overview });
    ui.setState({ selectedContactKey: { type: "group", id: room.room_id } });
    expect(renderToStaticMarkup(<ContactsPanel />)).toContain("Cached group");
    expect(renderToStaticMarkup(<ContactsDetailPane />)).toContain("Cached group");
  });
});

describe("Public sidebar refresh", () => {
  it("keeps rooms readable during refresh", () => {
    chat.setState({ publicRooms: [publicRoom], publicRoomsLoading: true });
    expect(renderToStaticMarkup(<PublicRoomList />)).toContain("Cached group");
  });
  it("keeps agents readable during refresh", () => {
    chat.setState({ publicAgents: [agent], publicAgentsLoading: true });
    expect(renderToStaticMarkup(<PublicAgentList />)).toContain("Cached agent");
  });
});
