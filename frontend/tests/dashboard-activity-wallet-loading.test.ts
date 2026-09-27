import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));

vi.mock("@/lib/api", () => ({ api: {
  getActivityFeed: vi.fn(), getActivityStats: vi.fn(), getWallet: vi.fn(),
  getWalletLedger: vi.fn(), getWithdrawals: vi.fn(),
} }));
vi.mock("@/store/useDashboardSessionStore", async () => {
  const { create } = await import("zustand");
  return { useDashboardSessionStore: create(() => ({
    token: "session-a", activeIdentity: { type: "agent", id: "bot-a" },
    activeAgentId: "bot-a", viewMode: "agent", human: null, ownedAgents: [],
  })) };
});

// Render the current client snapshot in node; Zustand SSR normally uses its initial snapshot.
vi.mock("@/store/useDashboardActivityStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/useDashboardActivityStore")>();
  const store = actual.useDashboardActivityStore;
  return { ...actual, useDashboardActivityStore: Object.assign(
    (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()),
    store,
  ) };
});

import { api } from "@/lib/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ActivityPanel from "@/components/dashboard/ActivityPanel";
import { useDashboardActivityStore as activity } from "@/store/useDashboardActivityStore";
import { useDashboardWalletStore as wallet } from "@/store/useDashboardWalletStore";
import { useDashboardSessionStore as session } from "@/store/useDashboardSessionStore";
import type { ActivityFeedResponse, ActivityStats, WalletSummary } from "@/lib/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const feed: ActivityFeedResponse = { items: [{ type: "message_received", preview: "ready message", timestamp: null, agent_id: "bot-a", agent_name: "Agent", room_id: "room-a", room_name: "Room", count: 1, meta: null }], has_more: true };
const balance = (amount: string) => ({ total_balance_minor: amount, available_balance_minor: amount, asset_code: "COIN" }) as WalletSummary;

beforeEach(() => {
  vi.resetAllMocks();
  session.setState({ token: "session-a", activeIdentity: { type: "agent", id: "bot-a" }, activeAgentId: "bot-a", viewMode: "agent", human: null, ownedAgents: [] });
  activity.getState().reset();
  wallet.getState().resetWalletState();
});

describe("independent activity readiness", () => {
  it("shows feed while stats are still pending, and deduplicates concurrent reads", async () => {
    const stats = deferred<ActivityStats>();
    vi.mocked(api.getActivityStats).mockReturnValue(stats.promise);
    vi.mocked(api.getActivityFeed).mockResolvedValue(feed);
    const firstStats = activity.getState().loadStats("today");
    expect(activity.getState().loadStats("today")).toBe(firstStats);
    const firstFeed = activity.getState().loadFeed();
    expect(activity.getState().loadFeed()).toBe(firstFeed);
    await firstFeed;
    expect(activity.getState()).toMatchObject({ feed: feed.items, loaded: true, loading: false, statsByPeriod: {} });
    expect(renderToStaticMarkup(createElement(ActivityPanel))).toContain("ready message");
    expect(api.getActivityStats).toHaveBeenCalledTimes(1);
    stats.reject(new Error("stats unavailable"));
    await firstStats;
    expect(activity.getState().feed).toEqual(feed.items);
    expect(activity.getState().error).toBeNull();
  });

  it("preserves readable cached rows during refresh and a failed refresh", async () => {
    vi.mocked(api.getActivityFeed).mockResolvedValueOnce(feed);
    await activity.getState().loadFeed();
    const refresh = deferred<ActivityFeedResponse>();
    vi.mocked(api.getActivityFeed).mockReturnValue(refresh.promise);
    const pending = activity.getState().loadFeed();
    expect(activity.getState().feed).toEqual(feed.items);
    refresh.reject(new Error("offline"));
    await pending;
    expect(activity.getState().feed).toEqual(feed.items);
    expect(renderToStaticMarkup(createElement(ActivityPanel))).toContain("ready message");
  });

  it("clears previous identity immediately and ignores its late response", async () => {
    const old = deferred<ActivityFeedResponse>();
    vi.mocked(api.getActivityFeed).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ items: [], has_more: false });
    const pending = activity.getState().loadFeed();
    session.setState({ activeIdentity: { type: "agent", id: "bot-b" }, activeAgentId: "bot-b" });
    expect(activity.getState().loaded).toBe(false);
    await activity.getState().loadFeed();
    old.resolve(feed);
    await pending;
    expect(activity.getState().feed).toEqual([]);
    expect(activity.getState().loaded).toBe(true);
  });

  it("keeps late statistics for their own period without overwriting the selected period", async () => {
    const today = deferred<ActivityStats>();
    vi.mocked(api.getActivityStats).mockReturnValueOnce(today.promise).mockResolvedValueOnce({ messages_sent: 7 } as ActivityStats);
    const pending = activity.getState().loadStats("today");
    await activity.getState().loadStats("7d");
    today.resolve({ messages_sent: 1 } as ActivityStats);
    await pending;
    expect(activity.getState().statsByPeriod["7d"]?.messages_sent).toBe(7);
    expect(activity.getState().statsByPeriod.today?.messages_sent).toBe(1);
  });
});

describe("wallet read readiness and isolation", () => {
  it("keeps the same viewer's balance available on a tab revisit", () => {
    const viewer = { type: "agent" as const, id: "bot-a" };
    wallet.getState().setWalletViewer(viewer);
    wallet.setState({ wallet: balance("200") });
    wallet.getState().setWalletViewer({ ...viewer });
    expect(wallet.getState().wallet).toEqual(balance("200"));
  });

  it("records an empty merged ledger as loaded instead of reloading on every revisit", async () => {
    await wallet.getState().loadMergedLedger();
    expect(wallet.getState().mergedLedgerLoaded).toBe(true);
    expect(wallet.getState().mergedLedger).toEqual([]);
  });

  it("prevents duplicate next-page reads while retaining a fresh refresh path", async () => {
    const response = deferred<Awaited<ReturnType<typeof api.getWalletLedger>>>();
    vi.mocked(api.getWalletLedger).mockReturnValue(response.promise);
    const first = wallet.getState().loadWalletLedger(true);
    await wallet.getState().loadWalletLedger(true);
    expect(api.getWalletLedger).toHaveBeenCalledTimes(1);
    response.resolve({ entries: [], has_more: false, next_cursor: null });
    await first;
    expect(wallet.getState().walletLoading).toBe(false);
  });

  it("publishes a ready bot balance before slower accounts without declaring totals ready", async () => {
    session.setState({ ownedAgents: [{ agent_id: "fast", display_name: "Fast" }, { agent_id: "slow", display_name: "Slow" }] as never });
    const slow = deferred<WalletSummary>();
    vi.mocked(api.getWallet).mockImplementation((viewer) => viewer?.id === "fast" ? Promise.resolve(balance("100")) : slow.promise);
    const pending = wallet.getState().loadAllWallets();
    await Promise.resolve();
    expect(wallet.getState().botWallets.fast).toEqual(balance("100"));
    expect(wallet.getState().walletsLoaded).toBe(false);
    slow.resolve(balance("200"));
    await pending;
    expect(wallet.getState().walletsLoaded).toBe(true);
  });

  it("clears loading and stale balances synchronously on token rotation", async () => {
    session.setState({ ownedAgents: [{ agent_id: "fast", display_name: "Fast" }] as never });
    const old = deferred<WalletSummary>();
    vi.mocked(api.getWallet).mockReturnValueOnce(old.promise).mockResolvedValueOnce(balance("300"));
    wallet.setState({ botWallets: { fast: balance("100") }, walletsLoaded: true });
    const pending = wallet.getState().loadAllWallets();
    session.setState({ token: "session-b" });
    expect(wallet.getState()).toMatchObject({ botWallets: {}, walletsLoading: false, walletsLoaded: false });
    await wallet.getState().loadAllWallets();
    old.resolve(balance("100"));
    await pending;
    expect(wallet.getState().botWallets.fast).toEqual(balance("300"));
  });

  it("clears a pending spinner if the account list becomes empty", async () => {
    wallet.setState({ walletsLoading: true, botWallets: { old: balance("100") } });
    await wallet.getState().loadAllWallets();
    expect(wallet.getState()).toMatchObject({ walletsLoading: false, botWallets: {}, walletsLoaded: true });
  });

  it("does not repopulate balances after logout/reset", async () => {
    session.setState({ ownedAgents: [{ agent_id: "fast", display_name: "Fast" }] as never });
    const response = deferred<WalletSummary>();
    vi.mocked(api.getWallet).mockReturnValue(response.promise);
    const pending = wallet.getState().loadAllWallets();
    wallet.getState().resetWalletState();
    response.resolve(balance("100"));
    await pending;
    expect(wallet.getState().botWallets).toEqual({});
    expect(wallet.getState().walletsLoaded).toBe(false);
  });

  it("ignores previous viewer's late wallet response", async () => {
    const old = deferred<WalletSummary>();
    vi.mocked(api.getWallet).mockReturnValueOnce(old.promise).mockResolvedValueOnce(balance("200"));
    wallet.getState().setWalletViewer({ type: "agent", id: "old" });
    const pending = wallet.getState().loadWallet();
    wallet.getState().setWalletViewer({ type: "agent", id: "new" });
    await wallet.getState().loadWallet();
    old.resolve(balance("100"));
    await pending;
    expect(wallet.getState().wallet).toEqual(balance("200"));
  });

  it("lets a post-mutation refresh supersede an older balance read", async () => {
    session.setState({ ownedAgents: [{ agent_id: "fast", display_name: "Fast" }] as never });
    const old = deferred<WalletSummary>();
    vi.mocked(api.getWallet).mockReturnValueOnce(old.promise).mockResolvedValueOnce(balance("300"));
    const pending = wallet.getState().loadAllWallets();
    await wallet.getState().loadAllWallets();
    old.resolve(balance("100"));
    await pending;
    expect(wallet.getState().botWallets.fast).toEqual(balance("300"));
  });
});
