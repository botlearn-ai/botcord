import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallow } from "zustand/shallow";
const selections = vi.hoisted(() => ({ chat: [] as unknown[] }));
const route = vi.hoisted(() => ({ pathname: "/chats/messages", query: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useSearchParams: () => route.query }));
vi.mock("nextjs-toploader/app", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("./AgentBrowser", () => ({ default: () => <div data-view="AgentBrowser" /> }));
vi.mock("./AgentCardModal", () => ({ default: () => <div data-view="AgentCardModal" /> }));
vi.mock("./AgentGateModal", () => ({ default: () => <div data-view="AgentGateModal" /> }));
vi.mock("./BotDetailDrawer", () => ({ default: () => <div data-view="BotDetailDrawer" /> }));
vi.mock("./DeviceDetailDrawer", () => ({ default: () => <div data-view="DeviceDetailDrawer" /> }));
vi.mock("./PeerBotDetailDrawer", () => ({ default: () => <div data-view="PeerBotDetailDrawer" /> }));
vi.mock("./ContactRequestsInbox", () => ({ default: () => <div data-view="ContactRequestsInbox" /> }));
vi.mock("./DashboardShellSkeleton", () => ({ default: () => <div data-view="DashboardShellSkeleton" /> }));
vi.mock("./HomePanel", () => ({ default: () => <div data-view="HomePanel" /> }));
vi.mock("./MyBotsPanel", () => ({ default: () => <div data-view="MyBotsPanel" /> }));
vi.mock("./HumanCardModal", () => ({ default: () => <div data-view="HumanCardModal" /> }));
vi.mock("./StripeReturnBanner", () => ({ default: () => <div data-view="StripeReturnBanner" /> }));
vi.mock("./UserChatPane", () => ({ default: () => <div data-view="UserChatPane" /> }));
vi.mock("./WalletPanel", () => ({ default: () => <div data-view="WalletPanel" /> }));
vi.mock("./ActivityPanel", () => ({ default: () => <div data-view="ActivityPanel" /> }));
vi.mock("./WorkspaceModeSwitch", () => ({ default: () => <div data-view="WorkspaceModeSwitch" /> }));
vi.mock("./ChatPane", () => ({ default: ({ sidebarTabOverride }: { sidebarTabOverride: string }) => <div data-view={sidebarTabOverride} /> }));
vi.mock("./sidebar", () => ({ default: () => <nav /> }));
vi.mock("@/components/team/TeamWorkspacePage", () => ({ default: () => <div data-view="team" /> }));
vi.mock("@/store/useDashboardSessionStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/useDashboardSessionStore")>();
  const store = actual.useDashboardSessionStore;
  return { ...actual, useDashboardSessionStore: Object.assign((selector: (s: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), store) };
});
vi.mock("@/store/useDashboardUIStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/useDashboardUIStore")>();
  const store = actual.useDashboardUIStore;
  return { ...actual, useDashboardUIStore: Object.assign((selector: (s: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), store) };
});
vi.mock("@/store/useDashboardChatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/useDashboardChatStore")>();
  const store = actual.useDashboardChatStore;
  return { ...actual, useDashboardChatStore: Object.assign((selector: (s: ReturnType<typeof store.getState>) => unknown) => {
    const selected = selector(store.getState());
    selections.chat.push(selected);
    return selected;
  }, store) };
});
import DashboardApp from "./DashboardApp";
import { useDashboardSessionStore as session } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore as ui } from "@/store/useDashboardUIStore";
import { useDashboardChatStore as chat } from "@/store/useDashboardChatStore";
const render = () => renderToStaticMarkup(<DashboardApp />);
beforeEach(() => {
  route.pathname = "/chats/messages";
  session.setState({ ...session.getInitialState(), authResolved: true, sessionMode: "authed-ready", token: "fixture" });
  ui.setState({ ...ui.getInitialState() });
  chat.setState({ ...chat.getInitialState() });
});
describe("immediate primary navigation", () => {
  it.each([
    ["home", "HomePanel"], ["wallet", "WalletPanel"], ["activity", "ActivityPanel"],
    ["bots", "MyBotsPanel"], ["contacts", "contacts"], ["explore", "explore"], ["messages", "messages"],
  ] as const)("renders %s before the URL finishes navigating", (tab, view) => {
    ui.getState().startPrimaryNavigation(tab, `/chats/${tab}`);
    expect(render()).toContain(`data-view="${view}"`);
  });
  it("shows the target main pane on mobile before the old message URL resolves", () => {
    ui.getState().startPrimaryNavigation("wallet", "/chats/wallet");
    expect(render()).toContain('data-dashboard-main="true"');
    expect(render()).not.toContain('max-md:hidden" data-dashboard-main');
  });
  it("still gates authenticated content until bootstrap resolves", () => {
    session.setState({ authResolved: false });
    ui.getState().startPrimaryNavigation("wallet", "/chats/wallet");
    expect(render()).toContain('data-view="DashboardShellSkeleton"');
    expect(render()).not.toContain('data-view="WalletPanel"');
  });
});

describe("shell subscription boundaries", () => {
  it("keeps the shell selection stable through unrelated message and loading updates", () => {
    selections.chat = [];
    render();
    chat.setState({ messages: { unrelated: [] }, messagesLoading: { unrelated: true } });
    render();
    expect(shallow(selections.chat[0], selections.chat[1])).toBe(true);
  });
  it("still observes selected agent card loading changes", () => {
    selections.chat = [];
    render();
    chat.setState({ selectedAgentLoading: true });
    render();
    expect(shallow(selections.chat[0], selections.chat[1])).toBe(false);
  });
});
