import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile, PublicHumanProfile } from "@/lib/types";
const mocks = vi.hoisted(() => ({ agent: vi.fn(), human: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { getAgentCard: mocks.agent, getPublicHuman: mocks.human }, humansApi: {},
  getActiveAgentId: vi.fn(() => null), setActiveAgentId: vi.fn(),
  getStoredActiveIdentity: vi.fn(() => null), setStoredActiveIdentity: vi.fn(),
}));
import { useDashboardChatStore as chat } from "./useDashboardChatStore";
import { useHumanProfileCardStore as humans } from "./useHumanProfileCardStore";
import { useDashboardSessionStore as session } from "./useDashboardSessionStore";
import { useDashboardUIStore as ui } from "./useDashboardUIStore";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const agent = (id: string, name = id) => ({ profile: { agent_id: id, display_name: name } as AgentProfile, conversations: null });
const human = (id: string, name = id): PublicHumanProfile => ({ human_id: id, display_name: name, avatar_url: null, created_at: null });
const owner = (id: string) => ({ humanId: id, displayName: id });
beforeEach(() => {
  vi.resetAllMocks();
  chat.getState().resetChatState();
  humans.getState().reset();
  ui.setState(ui.getInitialState());
  session.setState({ ...session.getInitialState(), token: "fixture", human: { human_id: "hu_self", display_name: "Self", avatar_url: null, email: null }, activeIdentity: { type: "human", id: "hu_self" } });
  mocks.agent.mockImplementation(async (id: string) => agent(id));
  mocks.human.mockImplementation(async (id: string) => human(id));
});

describe("Agent profile cards", () => {
  it("renders cached profile immediately on reopen and updates it in the background", async () => {
    await chat.getState().selectAgent("ag_a");
    chat.getState().closeAgentCardState();
    const refresh = deferred<ReturnType<typeof agent>>();
    mocks.agent.mockReturnValueOnce(refresh.promise);
    const load = chat.getState().selectAgent("ag_a");
    expect(chat.getState().selectedAgentProfile?.agent_id).toBe("ag_a");
    expect(chat.getState().selectedAgentLoading).toBe(false);
    refresh.resolve(agent("ag_a", "Updated"));
    await load;
    expect(chat.getState().selectedAgentProfile?.display_name).toBe("Updated");
  });
  it("shares same-target requests and does not let a slower earlier selection replace a newer one", async () => {
    const slow = deferred<ReturnType<typeof agent>>();
    mocks.agent.mockReturnValueOnce(slow.promise);
    const first = chat.getState().selectAgent("ag_a");
    const duplicate = chat.getState().selectAgent("ag_a");
    expect(mocks.agent).toHaveBeenCalledTimes(1);
    await chat.getState().selectAgent("ag_b");
    slow.resolve(agent("ag_a"));
    await Promise.all([first, duplicate]);
    expect(chat.getState().selectedAgentId).toBe("ag_b");
    expect(chat.getState().selectedAgentProfile?.agent_id).toBe("ag_b");
  });
  it("keeps a cached profile usable if revalidation fails", async () => {
    await chat.getState().selectAgent("ag_a");
    mocks.agent.mockRejectedValueOnce(new Error("offline"));
    await chat.getState().selectAgent("ag_a");
    expect(chat.getState().selectedAgentProfile?.agent_id).toBe("ag_a");
    expect(chat.getState().selectedAgentError).toBeNull();
    expect(chat.getState().selectedAgentLoading).toBe(false);
  });
  it("does not apply a pending request after the card closes", async () => {
    const slow = deferred<ReturnType<typeof agent>>();
    mocks.agent.mockReturnValueOnce(slow.promise);
    const load = chat.getState().selectAgent("ag_a");
    ui.getState().closeAgentCard();
    chat.getState().closeAgentCardState();
    slow.resolve(agent("ag_a"));
    await load;
    expect(chat.getState().selectedAgentProfile).toBeNull();
    expect(chat.getState().selectedAgentLoading).toBe(false);
    expect(ui.getState().agentCardOpen).toBe(false);
  });
  it("invalidates pending and cached private results on reset", async () => {
    await chat.getState().selectAgent("ag_cached");
    const slow = deferred<ReturnType<typeof agent>>();
    mocks.agent.mockReturnValueOnce(slow.promise);
    const load = chat.getState().selectAgent("ag_a");
    chat.getState().resetChatState();
    slow.resolve(agent("ag_a"));
    await load;
    expect(chat.getState().selectedAgentProfile).toBeNull();
    const next = chat.getState().selectAgent("ag_cached");
    expect(chat.getState().selectedAgentProfile).toBeNull();
    expect(chat.getState().selectedAgentLoading).toBe(true);
    await next;
  });
  it("clears private content on identity switch and rejects old responses", async () => {
    await chat.getState().selectAgent("ag_cached");
    const slow = deferred<ReturnType<typeof agent>>();
    mocks.agent.mockReturnValueOnce(slow.promise);
    const load = chat.getState().selectAgent("ag_a");
    session.setState({ activeIdentity: { type: "agent", id: "ag_viewer" } });
    expect(chat.getState().selectedAgentProfile).toBeNull();
    expect(ui.getState().agentCardOpen).toBe(false);
    slow.resolve(agent("ag_a"));
    await load;
    expect(chat.getState().selectedAgentProfile).toBeNull();
  });
  it.each([401, 403, 404, 410])("drops a cached profile when refresh returns %s", async (status) => {
    await chat.getState().selectAgent("ag_a");
    mocks.agent.mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status }));
    await chat.getState().selectAgent("ag_a");
    expect(chat.getState().selectedAgentProfile).toBeNull();
    expect(chat.getState().selectedAgentError).toBe("Unavailable");
    const next = chat.getState().selectAgent("ag_a");
    expect(chat.getState().selectedAgentLoading).toBe(true);
    await next;
  });
  it("reports an uncached failure without a permanent spinner", async () => {
    mocks.agent.mockRejectedValueOnce(new Error("offline"));
    await chat.getState().selectAgent("ag_a");
    expect(chat.getState().selectedAgentError).toBe("offline");
    expect(chat.getState().selectedAgentLoading).toBe(false);
  });
});

describe("Human profile cards", () => {
  it("opens cached profile and contact status immediately while refreshing", async () => {
    mocks.human.mockResolvedValueOnce({ ...human("hu_a"), contact_status: "contact" });
    await humans.getState().open(owner("hu_a"));
    humans.getState().setCard(null);
    const refresh = deferred<PublicHumanProfile>();
    mocks.human.mockReturnValueOnce(refresh.promise);
    const load = humans.getState().open(owner("hu_a"));
    expect(humans.getState().card).toMatchObject({ human: { human_id: "hu_a" }, loading: false, status: "exists" });
    refresh.resolve(human("hu_a", "Updated"));
    await load;
    expect(humans.getState().card?.human?.display_name).toBe("Updated");
  });
  it("deduplicates same-target requests and fences responses after switching humans", async () => {
    const slow = deferred<PublicHumanProfile>();
    mocks.human.mockReturnValueOnce(slow.promise);
    const first = humans.getState().open(owner("hu_a"));
    const second = humans.getState().open(owner("hu_a"));
    expect(mocks.human).toHaveBeenCalledTimes(1);
    await humans.getState().open(owner("hu_b"));
    slow.resolve(human("hu_a"));
    await Promise.all([first, second]);
    expect(humans.getState().card?.human?.human_id).toBe("hu_b");
  });
  it("does not reopen a closed human card when its response arrives", async () => {
    const slow = deferred<PublicHumanProfile>();
    mocks.human.mockReturnValueOnce(slow.promise);
    const load = humans.getState().open(owner("hu_a"));
    humans.getState().setCard(null);
    slow.resolve(human("hu_a"));
    await load;
    expect(humans.getState().card).toBeNull();
  });
  it("preserves cached data on refresh error and fences it across identity changes", async () => {
    await humans.getState().open(owner("hu_a"));
    mocks.human.mockRejectedValueOnce(new Error("offline"));
    await humans.getState().open(owner("hu_a"));
    expect(humans.getState().card).toMatchObject({ human: { human_id: "hu_a" }, loading: false, error: null });
    session.setState({ activeIdentity: { type: "human", id: "hu_other" } });
    expect(humans.getState().card).toBeNull();
    const load = humans.getState().open(owner("hu_a"));
    expect(humans.getState().card?.loading).toBe(true);
    await load;
  });
  it.each([401, 403, 404, 410])("drops cached human details and actions when refresh returns %s", async (status) => {
    mocks.human.mockResolvedValueOnce({ ...human("hu_a"), avatar_url: "https://example.com/avatar.png", contact_status: "contact" });
    await humans.getState().open(owner("hu_a"));
    mocks.human.mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status }));
    await humans.getState().open(owner("hu_a"));
    expect(humans.getState().card).toMatchObject({ human: { human_id: "hu_a", avatar_url: null }, status: "idle", error: "Unavailable" });
    const next = humans.getState().open(owner("hu_a"));
    expect(humans.getState().card?.loading).toBe(true);
    await next;
  });
  it.each(["sent", "pending", "exists"] as const)("invalidates cached contact actions after a mutation sets %s, including older pending reads", async (status) => {
    await humans.getState().open(owner("hu_a"));
    const oldRefresh = deferred<PublicHumanProfile>();
    mocks.human.mockReturnValueOnce(oldRefresh.promise);
    const refresh = humans.getState().open(owner("hu_a"));
    expect(humans.getState().card?.loading).toBe(false);
    humans.getState().setCard((card) => card && { ...card, status });
    oldRefresh.resolve(human("hu_a", "Older response"));
    await refresh;
    expect(humans.getState().card?.status).toBe(status);
    humans.getState().setCard(null);
    const newRead = deferred<PublicHumanProfile>();
    mocks.human.mockReturnValueOnce(newRead.promise);
    const reopen = humans.getState().open(owner("hu_a"));
    // The old read completed, but its pre-mutation relation must not have
    // repopulated the cache: reopening waits for a fresh contact status.
    expect(humans.getState().card?.loading).toBe(true);
    expect(humans.getState().card?.human?.display_name).not.toBe("Older response");
    expect(mocks.human).toHaveBeenCalledTimes(3);
    newRead.resolve({ ...human("hu_a"), contact_status: "pending" });
    await reopen;
    expect(humans.getState().card?.status).toBe("pending");
  });
  it("does not let a pre-mutation refresh failure hide a successful contact request", async () => {
    await humans.getState().open(owner("hu_a"));
    const oldRefresh = deferred<PublicHumanProfile>();
    mocks.human.mockReturnValueOnce(oldRefresh.promise);
    const refresh = humans.getState().open(owner("hu_a"));
    humans.getState().setCard((card) => card && { ...card, status: "sent" });
    oldRefresh.reject(new Error("offline"));
    await refresh;
    expect(humans.getState().card).toMatchObject({ status: "sent", loading: false, error: null });
  });
  it("does not overwrite a newly submitted contact request with stale profile status", async () => {
    const slow = deferred<PublicHumanProfile>();
    mocks.human.mockReturnValueOnce(slow.promise);
    const load = humans.getState().open(owner("hu_a"));
    humans.getState().setCard((card) => card && { ...card, status: "sent", sending: false });
    slow.resolve(human("hu_a"));
    await load;
    expect(humans.getState().card?.status).toBe("sent");
  });
});
