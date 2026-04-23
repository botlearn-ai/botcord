import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => {
  const state = {
    selectResults: [] as unknown[][],
    insertPayloads: [] as unknown[],
    updatePayloads: [] as unknown[],
  };

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => state.selectResults.shift() ?? []),
      })),
    })),
  }));

  const update = vi.fn(() => ({
    set: vi.fn((payload: unknown) => {
      state.updatePayloads.push(payload);
      return {
        where: vi.fn(async () => undefined),
      };
    }),
  }));

  const insert = vi.fn(() => {
    const callIndex = state.insertPayloads.length;
    return {
      values: vi.fn((payload: unknown) => {
        state.insertPayloads.push(payload);

        if (callIndex === 0) {
          return {
            returning: vi.fn(async () => [{ id: (payload as { id: string }).id }]),
          };
        }

        return Promise.resolve();
      }),
    };
  });

  return { state, select, update, insert };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/../db", () => ({
  db: {
    select: mockDb.select,
    update: mockDb.update,
    insert: mockDb.insert,
  },
}));

import { findOrCreateUser } from "@/lib/auth";

describe("findOrCreateUser", () => {
  beforeEach(() => {
    mockDb.state.selectResults.length = 0;
    mockDb.state.insertPayloads.length = 0;
    mockDb.state.updatePayloads.length = 0;
    mockDb.select.mockClear();
    mockDb.update.mockClear();
    mockDb.insert.mockClear();
  });

  it("inserts an explicit user row instead of relying on database defaults", async () => {
    mockDb.state.selectResults.push([], [{ id: "member-role-id" }]);

    const userId = await findOrCreateUser({
      id: "supabase-user-id",
      email: "asoisox@gmail.com",
      user_metadata: {
        full_name: "Asoiso Lee",
        avatar_url: "https://example.com/avatar.png",
      },
    });

    expect(mockDb.insert).toHaveBeenCalledTimes(2);

    const insertedUser = mockDb.state.insertPayloads[0] as {
      id: string;
      displayName: string;
      email: string | null;
      avatarUrl: string | null;
      status: string;
      supabaseUserId: string;
      maxAgents: number;
      createdAt: Date;
      updatedAt: Date;
      lastLoginAt: Date;
      betaAccess: boolean;
      betaAdmin: boolean;
    };

    expect(userId).toBe(insertedUser.id);
    expect(insertedUser).toMatchObject({
      displayName: "Asoiso Lee",
      email: "asoisox@gmail.com",
      avatarUrl: "https://example.com/avatar.png",
      status: "active",
      supabaseUserId: "supabase-user-id",
      maxAgents: 10,
      betaAccess: false,
      betaAdmin: false,
    });
    expect(insertedUser.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(insertedUser.createdAt).toBeInstanceOf(Date);
    expect(insertedUser.updatedAt).toBeInstanceOf(Date);
    expect(insertedUser.lastLoginAt).toBeInstanceOf(Date);
    expect(insertedUser.createdAt).toEqual(insertedUser.updatedAt);
    expect(insertedUser.updatedAt).toEqual(insertedUser.lastLoginAt);
    expect(mockDb.state.insertPayloads[1]).toEqual({
      userId: insertedUser.id,
      roleId: "member-role-id",
    });
  });

  it("updates last login for an existing user", async () => {
    mockDb.state.selectResults.push([{ id: "existing-user-id" }]);

    const userId = await findOrCreateUser({
      id: "supabase-user-id",
      email: "asoisox@gmail.com",
    });

    expect(userId).toBe("existing-user-id");
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.state.updatePayloads[0]).toMatchObject({
      lastLoginAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });
});
