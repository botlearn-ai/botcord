import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getPublicRooms: vi.fn(), getPublicAgents: vi.fn(), getPublicHumans: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: apiMocks, humansApi: {}, userApi: {},
  getActiveAgentId: vi.fn(() => null), setActiveAgentId: vi.fn(),
  getStoredActiveIdentity: vi.fn(() => null), setStoredActiveIdentity: vi.fn(),
}));
import { useDashboardChatStore as chat } from "./useDashboardChatStore";
import { useDashboardSessionStore as session } from "./useDashboardSessionStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  chat.getState().logout();
  session.setState({ token: "fixture", activeIdentity: { type: "human", id: "hu_one" } });
  vi.clearAllMocks();
});

for (const kind of ["Rooms", "Agents", "Humans"] as const) {
  const responseKey = kind.toLowerCase();
  const api = apiMocks[`getPublic${kind}`];
  const load = (query: string) => chat.getState()[`loadPublic${kind}`](query);
  const query = () => chat.getState()[`public${kind}Query`];
  const loading = () => chat.getState()[`public${kind}Loading`];
  const values = () => chat.getState()[`public${kind}`];
  const result = (id: string) => ({ [responseKey]: [{ room_id: id, agent_id: id, human_id: id }] });

  describe(`public ${kind} loading`, () => {
    it("shares simultaneous normalized queries and records successful provenance", async () => {
      const response = deferred<ReturnType<typeof result>>();
      api.mockReturnValue(response.promise);
      const first = load(" alpha ");
      const second = load("alpha");
      expect(api).toHaveBeenCalledTimes(1);
      expect(query()).toBeNull();
      response.resolve(result("first"));
      await Promise.all([first, second]);
      expect(query()).toBe("alpha");
      expect(loading()).toBe(false);
    });
    it("retains cached results and provenance during refresh and failure", async () => {
      api.mockResolvedValueOnce(result("cached"));
      await load("alpha");
      const cached = values();
      const response = deferred<ReturnType<typeof result>>();
      api.mockReturnValueOnce(response.promise);
      const refresh = load("beta");
      expect(values()).toBe(cached);
      expect(query()).toBe("alpha");
      expect(loading()).toBe(true);
      response.reject(new Error("offline"));
      await refresh;
      expect(values()).toBe(cached);
      expect(query()).toBe("alpha");
      expect(loading()).toBe(false);
    });
    it("does not let a slower previous query overwrite newer results", async () => {
      const old = deferred<ReturnType<typeof result>>();
      api.mockReturnValueOnce(old.promise).mockResolvedValueOnce(result("new"));
      const first = load("old");
      await load("new");
      const latest = values();
      old.resolve(result("old"));
      await first;
      expect(values()).toBe(latest);
      expect(query()).toBe("new");
    });
    it("invalidates pending requests on logout, even when a new request has the same query", async () => {
      const old = deferred<ReturnType<typeof result>>();
      api.mockReturnValueOnce(old.promise).mockResolvedValueOnce(result("new"));
      const first = load("");
      chat.getState().logout();
      await load("");
      const latest = values();
      old.resolve(result("old"));
      await first;
      expect(api).toHaveBeenCalledTimes(2);
      expect(values()).toBe(latest);
      expect(query()).toBe("");
    });
    it("does not coalesce requests across identities or accept the old response", async () => {
      const old = deferred<ReturnType<typeof result>>();
      api.mockReturnValueOnce(old.promise).mockResolvedValueOnce(result("new"));
      const first = load("");
      session.setState({ activeIdentity: { type: "human", id: "hu_two" } });
      await load("");
      const latest = values();
      old.resolve(result("old"));
      await first;
      expect(api).toHaveBeenCalledTimes(2);
      expect(values()).toBe(latest);
    });
    it("treats a successful empty result as loaded for the exact query", async () => {
      api.mockResolvedValueOnce({ [responseKey]: [] });
      await load("empty");
      expect(query()).toBe("empty");
      expect(values()).toEqual([]);
      expect(loading()).toBe(false);
    });
  });
}
