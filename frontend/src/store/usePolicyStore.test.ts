import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "@/lib/api";
import { usePolicyStore, type AgentPolicy } from "./usePolicyStore";

const policy: AgentPolicy = {
  contact_policy: "open", allow_agent_sender: true, allow_human_sender: true,
  room_invite_policy: "open", default_attention: "always", attention_keywords: [],
};
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.resetAllMocks();
  usePolicyStore.setState({ globalByAgent: {}, globalLoading: {} });
});

describe("policy loading", () => {
  it("shares one pending request across drawers for the same agent", async () => {
    const pending = deferredResponse();
    const fetch = vi.mocked(apiFetch).mockReturnValue(pending.promise);
    const first = usePolicyStore.getState().loadGlobal("ag_1");
    const second = usePolicyStore.getState().loadGlobal("ag_1");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(usePolicyStore.getState().globalLoading.ag_1).toBe(true);
    pending.resolve(response(policy));
    expect(await first).toEqual(policy);
    expect(await second).toEqual(policy);
    expect(usePolicyStore.getState().globalLoading.ag_1).toBeUndefined();
  });
  it("keeps cached policy available during refresh failure", async () => {
    usePolicyStore.setState({ globalByAgent: { ag_1: policy } });
    const pending = deferredResponse();
    vi.mocked(apiFetch).mockReturnValue(pending.promise);
    const request = usePolicyStore.getState().loadGlobal("ag_1");
    expect(usePolicyStore.getState().globalByAgent.ag_1).toBe(policy);
    pending.resolve(response({ detail: "temporarily unavailable" }, 503));
    await expect(request).rejects.toThrow("temporarily unavailable");
    expect(usePolicyStore.getState().globalByAgent.ag_1).toBe(policy);
    expect(usePolicyStore.getState().globalLoading.ag_1).toBeUndefined();
  });
  it("allows explicit retry after a failed shared request", async () => {
    const fetch = vi.mocked(apiFetch)
      .mockResolvedValueOnce(response({ detail: "offline" }, 503))
      .mockResolvedValueOnce(response(policy));
    await expect(usePolicyStore.getState().loadGlobal("ag_1")).rejects.toThrow("offline");
    await expect(usePolicyStore.getState().loadGlobal("ag_1")).resolves.toEqual(policy);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not overwrite a saved policy with an older background read", async () => {
    const pending = deferredResponse();
    const saved = { ...policy, contact_policy: "closed" as const };
    usePolicyStore.setState({ globalByAgent: { ag_1: policy } });
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response(saved));
    const request = usePolicyStore.getState().loadGlobal("ag_1");
    await usePolicyStore.getState().patchGlobal("ag_1", { contact_policy: "closed" });
    pending.resolve(response(policy));
    await request;
    expect(usePolicyStore.getState().globalByAgent.ag_1).toEqual(saved);
  });
  it("loads different agents independently", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const fetch = vi.mocked(apiFetch).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = usePolicyStore.getState().loadGlobal("ag_1");
    const b = usePolicyStore.getState().loadGlobal("ag_2");
    expect(fetch).toHaveBeenCalledTimes(2);
    second.resolve(response({ ...policy, contact_policy: "closed" }));
    await b;
    expect(usePolicyStore.getState().globalLoading.ag_1).toBe(true);
    first.resolve(response(policy));
    await a;
    expect(usePolicyStore.getState().globalByAgent.ag_1.contact_policy).toBe("open");
    expect(usePolicyStore.getState().globalByAgent.ag_2.contact_policy).toBe("closed");
  });
});
