import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/users/me/agents/bind/route";

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

vi.mock("@/lib/bind-ticket", () => ({
  parseBindTicket: vi.fn(() => ({ ok: true, payload: { uid: "u_1" } })),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  count: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock("@/../db/schema", () => ({
  agents: { id: "id", agentId: "agentId", userId: "userId" },
  users: { id: "id", maxAgents: "maxAgents" },
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

describe("POST /api/users/me/agents/bind", () => {
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

  it("returns 409 when atomic bind update affected 0 rows (claimed by other during race)", async () => {
    // user lookup
    state.selectLimits.push([{ id: "u_1", maxAgents: 5 }]);
    // existing at read-check
    state.selectLimits.push([
      {
        id: 40,
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
    // atomic update no rows
    state.updateReturnings.push([]);
    // latest owner after race
    state.selectLimits.push([
      {
        id: 40,
        agentId: "ag_race",
        displayName: "Race",
        isDefault: false,
        userId: "u_2",
        claimedAt: new Date("2026-03-19T00:00:00Z"),
        createdAt: new Date("2026-03-18T00:00:00Z"),
      },
    ]);

    const response = await POST({
      json: async () => ({
        agent_id: "ag_race",
        display_name: "Race",
        agent_token: "tok",
        bind_ticket: "bt",
      }),
    } as any);

    expect(response).toEqual({ data: { error: "Agent already claimed" }, status: 409 });
  });

  it("returns 409 when agent already claimed by same user", async () => {
    // user lookup
    state.selectLimits.push([{ id: "u_1", maxAgents: 5 }]);
    // existing already claimed by same user
    state.selectLimits.push([
      {
        id: 41,
        agentId: "ag_claimed",
        displayName: "Claimed",
        isDefault: true,
        userId: "u_1",
        claimedAt: new Date("2026-03-19T00:00:00Z"),
        createdAt: new Date("2026-03-18T00:00:00Z"),
      },
    ]);

    const response = await POST({
      json: async () => ({
        agent_id: "ag_claimed",
        display_name: "Claimed",
        agent_token: "tok",
        bind_ticket: "bt",
      }),
    } as any);

    expect(response).toEqual({ data: { error: "Agent already claimed" }, status: 409 });
  });
});
