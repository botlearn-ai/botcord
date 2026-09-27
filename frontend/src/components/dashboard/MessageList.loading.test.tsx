import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  loading: false,
  error: null as string | null,
  messages: undefined as unknown[] | undefined,
  load: vi.fn(),
  effects: [] as Array<{ run: () => unknown; dependencies: readonly unknown[] | undefined }>,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (run: () => unknown, dependencies?: readonly unknown[]) => {
    fixture.effects.push({ run, dependencies });
  },
}));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("@/store/useDashboardChatStore", async (original) => {
  const actual = await original<typeof import("@/store/useDashboardChatStore")>();
  const store = actual.useDashboardChatStore;
  return {
    ...actual,
    useDashboardChatStore: Object.assign((selector: (state: ReturnType<typeof store.getState>) => unknown) => selector({
      ...store.getState(),
      messages: fixture.messages ? { room: fixture.messages } : {},
      messagesLoading: { room: fixture.loading },
      messagesErrors: fixture.error ? { room: fixture.error } : {},
      loadRoomMessages: fixture.load,
    } as ReturnType<typeof store.getState>), store),
  };
});
vi.mock("@/store/useDashboardUIStore", async (original) => {
  const actual = await original<typeof import("@/store/useDashboardUIStore")>();
  const store = actual.useDashboardUIStore;
  return {
    ...actual,
    useDashboardUIStore: Object.assign(
      (selector: (state: ReturnType<typeof store.getState>) => unknown) =>
        selector({ ...store.getState(), openedRoomId: "room" }),
      store,
    ),
  };
});
import MessageList from "./MessageList";

function renderAndRunInitialLoad() {
  fixture.effects = [];
  const html = renderToStaticMarkup(<MessageList />);
  const initialLoad = fixture.effects.find(({ dependencies }) => dependencies?.includes(fixture.load));
  expect(initialLoad).toBeDefined();
  initialLoad!.run();
  return html;
}

beforeEach(() => {
  fixture.load.mockReset();
  fixture.loading = false;
  fixture.error = null;
  fixture.messages = undefined;
});

it("does not automatically restart failed initial requests on subsequent renders", () => {
  renderAndRunInitialLoad();
  expect(fixture.load).toHaveBeenCalledTimes(1);
  fixture.loading = true;
  renderAndRunInitialLoad();
  fixture.loading = false;
  fixture.error = "Network unavailable";
  const html = renderAndRunInitialLoad();
  renderAndRunInitialLoad();
  expect(fixture.load).toHaveBeenCalledTimes(1);
  expect(html).toContain("Network unavailable");
  expect(html).toContain("Retry");
  expect(html).toContain('role="alert"');
});

it("starts a new initial load once the previous error is cleared", () => {
  fixture.error = "Network unavailable";
  renderAndRunInitialLoad();
  expect(fixture.load).not.toHaveBeenCalled();
  fixture.error = null;
  renderAndRunInitialLoad();
  expect(fixture.load).toHaveBeenCalledWith("room");
});

it("does not refetch a cached empty room", () => {
  fixture.messages = [];
  renderAndRunInitialLoad();
  expect(fixture.load).not.toHaveBeenCalled();
});
