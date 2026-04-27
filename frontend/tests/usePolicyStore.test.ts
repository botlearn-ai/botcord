import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usePolicyStore,
  type AgentPolicy,
  type RoomPolicyResponse,
} from "@/store/usePolicyStore";

const baseGlobal: AgentPolicy = {
  contact_policy: "contacts_only",
  allow_agent_sender: true,
  allow_human_sender: true,
  room_invite_policy: "contacts_only",
  default_attention: "always",
  attention_keywords: [],
};

const baseRoom: RoomPolicyResponse = {
  effective: {
    mode: "always",
    keywords: [],
    muted_until: null,
    source: "global",
  },
  override: null,
  inherits_global: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

describe("usePolicyStore", () => {
  beforeEach(() => {
    usePolicyStore.setState({
      globalByAgent: {},
      globalLoading: {},
      roomEffectiveByKey: {},
      roomLoading: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loadGlobal fetches and stores agent policy", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(baseGlobal));

    const result = await usePolicyStore.getState().loadGlobal("ag_alice");

    expect(result).toEqual(baseGlobal);
    expect(usePolicyStore.getState().globalByAgent["ag_alice"]).toEqual(baseGlobal);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/agents/ag_alice/policy",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("patchGlobal PATCHes and updates state with server response", async () => {
    usePolicyStore.setState({ globalByAgent: { ag_alice: baseGlobal } });
    const updated: AgentPolicy = { ...baseGlobal, contact_policy: "open" };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(updated));

    const result = await usePolicyStore
      .getState()
      .patchGlobal("ag_alice", { contact_policy: "open" });

    expect(result).toEqual(updated);
    expect(usePolicyStore.getState().globalByAgent["ag_alice"]).toEqual(updated);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse((init?.body as string) ?? "{}")).toEqual({
      contact_policy: "open",
    });
  });

  it("patchGlobal rolls back on failure", async () => {
    usePolicyStore.setState({ globalByAgent: { ag_alice: baseGlobal } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "boom" }, 400),
    );

    await expect(
      usePolicyStore
        .getState()
        .patchGlobal("ag_alice", { contact_policy: "open" }),
    ).rejects.toThrow("boom");

    expect(usePolicyStore.getState().globalByAgent["ag_alice"]).toEqual(baseGlobal);
  });

  it("loadRoomPolicy stores effective response keyed by agent+room", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(baseRoom));

    await usePolicyStore.getState().loadRoomPolicy("ag_alice", "rm_x");

    expect(
      usePolicyStore.getState().roomEffectiveByKey["ag_alice:rm_x"],
    ).toEqual(baseRoom);
  });

  it("deleteRoomOverride removes the cached entry", async () => {
    usePolicyStore.setState({
      roomEffectiveByKey: { "ag_alice:rm_x": baseRoom },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(noContent());

    await usePolicyStore.getState().deleteRoomOverride("ag_alice", "rm_x");

    expect(
      usePolicyStore.getState().roomEffectiveByKey["ag_alice:rm_x"],
    ).toBeUndefined();
  });

  it("invalidate clears the targeted room key", () => {
    usePolicyStore.setState({
      globalByAgent: { ag_alice: baseGlobal },
      roomEffectiveByKey: {
        "ag_alice:rm_x": baseRoom,
        "ag_alice:rm_y": baseRoom,
        "ag_bob:rm_x": baseRoom,
      },
    });

    usePolicyStore.getState().invalidate("ag_alice", "rm_x");
    const after = usePolicyStore.getState();
    expect(after.roomEffectiveByKey["ag_alice:rm_x"]).toBeUndefined();
    expect(after.roomEffectiveByKey["ag_alice:rm_y"]).toEqual(baseRoom);
    expect(after.globalByAgent["ag_alice"]).toEqual(baseGlobal);
  });

  it("invalidate without roomId clears all entries for the agent", () => {
    usePolicyStore.setState({
      globalByAgent: { ag_alice: baseGlobal, ag_bob: baseGlobal },
      roomEffectiveByKey: {
        "ag_alice:rm_x": baseRoom,
        "ag_bob:rm_x": baseRoom,
      },
    });

    usePolicyStore.getState().invalidate("ag_alice");
    const after = usePolicyStore.getState();
    expect(after.globalByAgent["ag_alice"]).toBeUndefined();
    expect(after.globalByAgent["ag_bob"]).toEqual(baseGlobal);
    expect(after.roomEffectiveByKey["ag_alice:rm_x"]).toBeUndefined();
    expect(after.roomEffectiveByKey["ag_bob:rm_x"]).toEqual(baseRoom);
  });
});
