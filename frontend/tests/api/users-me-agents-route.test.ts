import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/users/me/agents/route";

const {
  state,
  createSelectChain,
  createUpdateChain,
  createInsertChain,
} = vi.hoisted(() => {
  const state = {
    selectLimits: [] as any[],
    selectThens: [] as any[],
    updateReturnings: [] as any[],
  };

  const createSelectChain = () => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => Promise.resolve(state.selectLimits.shift() ?? [])),
      then: (resolve: any) => resolve(state.selectThens.shift() ?? []),
    };
    return chain;
  };

  const createUpdateChain = () => {
    const chain: any = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockImplementation(() => Promise.resolve(state.updateReturnings.shift() ?? [])),
    };
    return chain;
  };

  const createInsertChain = () => {
    const chain: any = {
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
    };
    return chain;
  };

  return { state, createSelectChain, createUpdateChain, createInsertChain };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data, options) => ({ data, status: options?.status || 200 })),
  },
}));

vi.mock("@/lib/auth", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/bind-ticket", () => ({
  verifyBindTicket: vi.fn(() => ({ ok: true })),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/../db/schema", () => ({
  agents: { id: "id", agentId: "agentId", userId: "userId" },
  userRoles: { userId: "userId", roleId: "roleId" },
  roles: { id: "id", name: "name" },
}));

vi.mock("@/../db", () => ({
  db: {
    select: vi.fn(() => createSelectChain()),
    update: vi.fn(() => createUpdateChain()),
    insert: vi.fn(() => createInsertChain()),
  },
}));

import { requireAuth } from "@/lib/auth";

describe("POST /api/users/me/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.selectLimits = [];
    state.selectThens = [];
    state.updateReturnings = [];
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({}),
    } as any);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      user: null,
      error: { status: 401, message: "Unauthorized" },
    } as any);

    const response = await POST({ json: async () => ({}) } as any);
    expect(response).toEqual({ data: { error: "Unauthorized" }, status: 401 });
  });

  it("returns 409 when agent already claimed by same user", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: {
        id: "u_1",
        maxAgents: 1,
        agents: [{ agentId: "ag_abc" }],
        roles: ["member"],
      },
    } as any);
    state.selectLimits.push([
      {
        id: 10,
        agentId: "ag_abc",
        displayName: "A",
        isDefault: true,
        userId: "u_1",
        claimedAt: new Date("2026-03-19T00:00:00Z"),
        createdAt: new Date("2026-03-18T00:00:00Z"),
      },
    ]);

    const response = await POST({
      json: async () => ({ agent_id: "ag_abc", display_name: "A", agent_token: "tok" }),
    } as any);

    expect(response).toEqual({ data: { error: "Agent already claimed" }, status: 409 });
  });

  it("returns 409 when agent claimed by another user", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: { id: "u_1", maxAgents: 5, agents: [], roles: ["member"] },
    } as any);
    state.selectLimits.push([
      {
        id: 11,
        agentId: "ag_abc",
        displayName: "A",
        isDefault: false,
        userId: "u_2",
        claimedAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const response = await POST({
      json: async () => ({ agent_id: "ag_abc", display_name: "A", agent_token: "tok" }),
    } as any);

    expect(response).toEqual({ data: { error: "Agent already claimed" }, status: 409 });
  });

  it("returns 201 when fresh claim succeeds", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: { id: "u_1", maxAgents: 5, agents: [], roles: ["agent_owner"] },
    } as any);
    state.selectLimits.push([
      {
        id: 12,
        agentId: "ag_new",
        displayName: "Old",
        isDefault: false,
        userId: null,
        claimedAt: null,
        createdAt: new Date("2026-03-18T00:00:00Z"),
      },
    ]);
    state.selectThens.push([{ value: 0 }]);
    state.updateReturnings.push([
      {
        id: 12,
        agentId: "ag_new",
        displayName: "New Name",
        isDefault: true,
        userId: "u_1",
        claimedAt: new Date("2026-03-19T00:00:00Z"),
        createdAt: new Date("2026-03-18T00:00:00Z"),
      },
    ]);

    const response = await POST({
      json: async () => ({ agent_id: "ag_new", display_name: "New Name", agent_token: "tok" }),
    } as any);

    expect(response.status).toBe(201);
    expect(response.data.agent_id).toBe("ag_new");
    expect(response.data.is_default).toBe(true);
  });

  it("returns 409 when atomic claim update affected 0 rows (claimed by other during race)", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: { id: "u_1", maxAgents: 5, agents: [], roles: ["agent_owner"] },
    } as any);
    // existing at read-check: unclaimed
    state.selectLimits.push([
      {
        id: 20,
        agentId: "ag_race",
        displayName: "Race",
        isDefault: false,
        userId: null,
        claimedAt: null,
        createdAt: new Date("2026-03-18T00:00:00Z"),
      },
    ]);
    // owned count
    state.selectThens.push([{ value: 0 }]);
    // atomic update lost race
    state.updateReturnings.push([]);
    // re-read latest owner
    state.selectLimits.push([
      {
        id: 20,
        agentId: "ag_race",
        displayName: "Race",
        isDefault: false,
        userId: "u_2",
        claimedAt: new Date("2026-03-19T00:00:00Z"),
        createdAt: new Date("2026-03-18T00:00:00Z"),
      },
    ]);

    const response = await POST({
      json: async () => ({ agent_id: "ag_race", display_name: "Race", agent_token: "tok" }),
    } as any);

    expect(response).toEqual({ data: { error: "Agent already claimed" }, status: 409 });
  });

  it("inserts local stub when agent exists in hub but not mirrored locally", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: { id: "u_1", maxAgents: 5, agents: [], roles: ["agent_owner"] },
    } as any);
    // first select missing -> insert -> second select found
    state.selectLimits.push([]);
    state.selectLimits.push([
      {
        id: 30,
        agentId: "ag_missing_local",
        displayName: "Agent ag_ing",
        isDefault: false,
        userId: null,
        claimedAt: null,
        createdAt: new Date("2026-03-18T00:00:00Z"),
      },
    ]);
    state.selectThens.push([{ value: 0 }]);
    state.updateReturnings.push([
      {
        id: 30,
        agentId: "ag_missing_local",
        displayName: "Recovered Agent",
        isDefault: true,
        userId: "u_1",
        claimedAt: new Date("2026-03-19T00:00:00Z"),
        createdAt: new Date("2026-03-18T00:00:00Z"),
      },
    ]);

    const response = await POST({
      json: async () => ({
        agent_id: "ag_missing_local",
        display_name: "Recovered Agent",
        agent_token: "tok",
      }),
    } as any);

    expect(response.status).toBe(201);
    expect(response.data.agent_id).toBe("ag_missing_local");
  });
});
