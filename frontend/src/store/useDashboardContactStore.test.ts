import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ received: vi.fn(), sent: vi.fn(), approvals: vi.fn(), send: vi.fn(), accept: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: {},
  humansApi: {
    listReceivedContactRequests: mocks.received,
    listSentContactRequests: mocks.sent,
    listPendingApprovals: mocks.approvals,
    sendContactRequest: mocks.send,
    acceptContactRequest: mocks.accept,
  },
  getActiveAgentId: vi.fn(() => null), setActiveAgentId: vi.fn(),
  getStoredActiveIdentity: vi.fn(() => null), setStoredActiveIdentity: vi.fn(),
}));
import { loadPendingContactApprovals, useDashboardContactStore as contacts } from "./useDashboardContactStore";
import { useDashboardSessionStore as session } from "./useDashboardSessionStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const receivedRequest = { id: "cr_received", from_participant_id: "hu_peer", to_participant_id: "hu_me", state: "pending", created_at: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  contacts.getState().resetContactState();
  session.setState({ ...session.getInitialState(), token: "fixture", activeIdentity: { type: "human", id: "hu_me" }, viewMode: "human", human: { human_id: "hu_me" } as NonNullable<ReturnType<typeof session.getState>["human"]> });
  mocks.received.mockResolvedValue({ requests: [] });
  mocks.sent.mockResolvedValue({ requests: [] });
  mocks.approvals.mockResolvedValue({ approvals: [] });
});

describe("Contact request progressive loading", () => {
  it("publishes received requests while sent and approvals remain pending", async () => {
    const sent = deferred<{ requests: [] }>();
    const approvals = deferred<{ approvals: [] }>();
    mocks.received.mockResolvedValue({ requests: [receivedRequest] });
    mocks.sent.mockReturnValue(sent.promise);
    mocks.approvals.mockReturnValue(approvals.promise);
    const load = contacts.getState().loadContactRequests();
    await vi.waitFor(() => expect(contacts.getState().contactRequestsReceived).toHaveLength(1));
    expect(contacts.getState().contactRequestsLoading).toBe(true);
    sent.resolve({ requests: [] });
    approvals.resolve({ approvals: [] });
    await load;
    expect(contacts.getState().contactRequestsLoading).toBe(false);
  });
  it("preserves successful received results when another source fails", async () => {
    mocks.received.mockResolvedValue({ requests: [receivedRequest] });
    mocks.sent.mockRejectedValue(new Error("Sent unavailable"));
    await contacts.getState().loadContactRequests();
    expect(contacts.getState().contactRequestsReceived).toHaveLength(1);
    expect(contacts.getState().contactRequestsLoading).toBe(false);
  });
  it("shares concurrent inbox/sidebar requests including pending approvals", async () => {
    const approvals = deferred<{ approvals: [] }>();
    mocks.approvals.mockReturnValue(approvals.promise);
    const first = contacts.getState().loadContactRequests();
    const second = contacts.getState().loadContactRequests();
    const inbox = loadPendingContactApprovals();
    expect(mocks.received).toHaveBeenCalledTimes(1);
    expect(mocks.sent).toHaveBeenCalledTimes(1);
    expect(mocks.approvals).toHaveBeenCalledTimes(1);
    approvals.resolve({ approvals: [] });
    await Promise.all([first, second, inbox]);
  });
  it("ignores late results after resetting contact state", async () => {
    const received = deferred<{ requests: typeof receivedRequest[] }>();
    mocks.received.mockReturnValue(received.promise);
    const load = contacts.getState().loadContactRequests();
    contacts.getState().resetContactState();
    received.resolve({ requests: [receivedRequest] });
    await load;
    expect(contacts.getState().contactRequestsReceived).toEqual([]);
    expect(contacts.getState().contactRequestsLoading).toBe(false);
  });
  it("clears already-loaded private data synchronously when the identity changes", async () => {
    mocks.received.mockResolvedValue({ requests: [receivedRequest] });
    mocks.sent.mockResolvedValue({ requests: [receivedRequest] });
    await contacts.getState().loadContactRequests();
    contacts.setState({ contactRequestsBotApprovalCount: 3, processingContactRequestId: "cr_received", processingContactRequestAction: "accept", sendingContactRequestAgentId: "ag_peer" });
    expect(contacts.getState().contactRequestsReceived).toHaveLength(1);
    session.setState({ activeIdentity: { type: "human", id: "hu_new" }, human: { human_id: "hu_new" } as NonNullable<ReturnType<typeof session.getState>["human"]> });
    expect(contacts.getState()).toMatchObject({
      contactRequestsReceived: [], contactRequestsSent: [], pendingFriendRequests: [],
      contactRequestsBotApprovalCount: 0, contactRequestsLoading: false,
      processingContactRequestId: null, processingContactRequestAction: null,
      sendingContactRequestAgentId: null,
    });
  });
  it("releases pending request flags on credential rotation while retaining this actor's cache", async () => {
    mocks.received.mockResolvedValue({ requests: [receivedRequest] });
    await contacts.getState().loadContactRequests();
    const old = deferred<{ requests: typeof receivedRequest[] }>();
    mocks.received.mockReturnValueOnce(old.promise);
    const previous = contacts.getState().loadContactRequests();
    expect(contacts.getState().contactRequestsLoading).toBe(true);
    session.setState({ token: "refreshed-fixture" });
    expect(contacts.getState().contactRequestsLoading).toBe(false);
    expect(contacts.getState().contactRequestsReceived[0].id).toBe("cr_received");
    old.resolve({ requests: [{ ...receivedRequest, id: "cr_stale" }] });
    await previous;
    expect(contacts.getState().contactRequestsReceived[0].id).toBe("cr_received");
    await contacts.getState().loadContactRequests();
    expect(contacts.getState().contactRequestsLoading).toBe(false);
  });
  it("ignores a previous actor's send completion after switching identity", async () => {
    const sent = deferred<void>();
    mocks.send.mockReturnValueOnce(sent.promise);
    const send = contacts.getState().sendContactRequest("ag_peer");
    session.setState({ activeIdentity: { type: "human", id: "hu_new" }, human: { human_id: "hu_new" } as NonNullable<ReturnType<typeof session.getState>["human"]> });
    sent.resolve();
    await send;
    expect(contacts.getState().pendingFriendRequests).toEqual([]);
    expect(contacts.getState().sendingContactRequestAgentId).toBeNull();
    expect(mocks.received).not.toHaveBeenCalled();
  });
  it("does not clear a new actor's action when the previous actor's response finishes", async () => {
    const accepted = deferred<void>();
    mocks.accept.mockReturnValueOnce(accepted.promise);
    const respond = contacts.getState().respondContactRequest("cr_old", "accept");
    session.setState({ activeIdentity: { type: "human", id: "hu_new" }, human: { human_id: "hu_new" } as NonNullable<ReturnType<typeof session.getState>["human"]> });
    contacts.setState({ processingContactRequestId: "cr_new", processingContactRequestAction: "reject" });
    accepted.resolve();
    await respond;
    expect(contacts.getState().processingContactRequestId).toBe("cr_new");
    expect(mocks.received).not.toHaveBeenCalled();
  });
  it("keeps human requests loading when only the selected bot changes", async () => {
    const received = deferred<{ requests: typeof receivedRequest[] }>();
    mocks.received.mockReturnValueOnce(received.promise);
    const load = contacts.getState().loadContactRequests();
    session.setState({ activeAgentId: "ag_selected" });
    received.resolve({ requests: [receivedRequest] });
    await load;
    expect(contacts.getState().contactRequestsReceived[0].id).toBe("cr_received");
    expect(contacts.getState().contactRequestsLoading).toBe(false);
  });
  it("starts independent requests after identity changes and rejects the old identity response", async () => {
    const old = deferred<{ requests: typeof receivedRequest[] }>();
    const current = deferred<{ requests: typeof receivedRequest[] }>();
    mocks.received.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const previous = contacts.getState().loadContactRequests();
    session.setState({ activeIdentity: { type: "human", id: "hu_new" }, human: { human_id: "hu_new" } as NonNullable<ReturnType<typeof session.getState>["human"]> });
    const next = contacts.getState().loadContactRequests();
    expect(mocks.received).toHaveBeenCalledTimes(2);
    old.resolve({ requests: [receivedRequest] });
    await previous;
    expect(contacts.getState().contactRequestsReceived).toEqual([]);
    expect(contacts.getState().contactRequestsLoading).toBe(true);
    current.resolve({ requests: [{ ...receivedRequest, id: "cr_new" }] });
    await next;
    expect(contacts.getState().contactRequestsReceived[0].id).toBe("cr_new");
    expect(contacts.getState().contactRequestsLoading).toBe(false);
  });
});
