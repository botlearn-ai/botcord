import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/users/me/agents/claim/resolve/route";

const { state, createSelectChain, createUpdateChain, createInsertChain } = vi.hoisted(() => {
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

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  count: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock("@/../db/schema", () => ({
  agents: { id: "id", userId: "userId", claimCode: "claimCode", agentId: "agentId" },
  roles: { id: "id", name: "name" },
  userRoles: { userId: "userId", roleId: "roleId" },
}));

vi.mock("@/../db", () => ({
  db: {
    select: vi.fn(() => createSelectChain()),
    update: vi.fn(() => createUpdateChain()),
    insert: vi.fn(() => createInsertChain()),
  },
}));

import { requireAuth } from "@/lib/auth";

describe("POST /api/users/me/agents/claim/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.selectLimits = [];
    state.selectThens = [];
    state.updateReturnings = [];
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      user: null,
      error: { status: 401, message: "Unauthorized" },
    } as any);

    const response = await POST({ json: async () => ({ claim_code: "clm_xxx" }) } as any);
    expect(response).toEqual({ data: { error: "Unauthorized" }, status: 401 });
  });

  it("returns 400 when claim_code missing", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: { id: "u_1", maxAgents: 5, agents: [], roles: ["member"] },
    } as any);

    const response = await POST({ json: async () => ({}) } as any);
    expect(response).toEqual({ data: { error: "claim_code is required" }, status: 400 });
  });

  it("returns 404 when claim_code not found", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: { id: "u_1", maxAgents: 5, agents: [], roles: ["member"] },
    } as any);
    state.selectLimits.push([]);

    const response = await POST({ json: async () => ({ claim_code: "clm_bad" }) } as any);
    expect(response).toEqual({ data: { error: "Invalid claim code" }, status: 404 });
  });

  it("returns 409 when agent already claimed", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: { id: "u_1", maxAgents: 5, agents: [], roles: ["member"] },
    } as any);
    state.selectLimits.push([
      {
        id: 1,
        agentId: "ag_abc",
        displayName: "A",
        userId: "u_2",
      },
    ]);

    const response = await POST({ json: async () => ({ claim_code: "clm_abc" }) } as any);
    expect(response).toEqual({ data: { error: "Agent already claimed" }, status: 409 });
  });

  it("returns 200 when claim succeeds", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: { id: "u_1", maxAgents: 5, agents: [], roles: ["agent_owner"] },
    } as any);
    state.selectLimits.push([
      {
        id: 2,
        agentId: "ag_new",
        displayName: "New",
        userId: null,
      },
    ]);
    state.selectThens.push([{ value: 0 }]);
    state.updateReturnings.push([
      {
        id: 2,
        agentId: "ag_new",
        displayName: "New",
        isDefault: true,
        userId: "u_1",
        claimedAt: new Date("2026-03-20T00:00:00Z"),
        createdAt: new Date("2026-03-19T00:00:00Z"),
      },
    ]);

    const response = await POST({ json: async () => ({ claim_code: "clm_good" }) } as any);
    expect(response.status).toBe(200);
    expect(response.data.agent_id).toBe("ag_new");
  });

  it("returns 409 when atomic update affected 0 rows", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      error: null,
      user: { id: "u_1", maxAgents: 5, agents: [], roles: ["agent_owner"] },
    } as any);
    state.selectLimits.push([
      {
        id: 3,
        agentId: "ag_race",
        displayName: "Race",
        userId: null,
      },
    ]);
    state.selectThens.push([{ value: 0 }]);
    state.updateReturnings.push([]);

    const response = await POST({ json: async () => ({ claim_code: "clm_race" }) } as any);
    expect(response).toEqual({ data: { error: "Agent already claimed" }, status: 409 });
  });
});
