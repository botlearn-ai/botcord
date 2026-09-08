import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  userApi: { getMe: vi.fn(async () => ({ id: "me", agents: [] })) },
  humansApi: { getMe: vi.fn(async () => ({ human_id: "hu_me" })) },
}));
vi.mock("@/lib/team-spaces", () => ({
  teamSpacesApi: { list: vi.fn(), members: vi.fn() },
}));
import {
  teamSpacesApi,
  type SpaceMembers,
  type TeamSpace,
} from "@/lib/team-spaces";
import { createTeamSpaceStore } from "./team-space-store";
const personal = {
  id: "p",
  kind: "personal",
  status: "active",
  membership: { status: "active" },
} as TeamSpace;
const org = { ...personal, id: "a", kind: "organization" } as TeamSpace;
const empty: SpaceMembers = { users: [], agents: [] };

describe("Team space loading", () => {
  beforeEach(() => {
    vi.mocked(teamSpacesApi.list)
      .mockReset()
      .mockResolvedValue({ spaces: [personal, org] });
    vi.mocked(teamSpacesApi.members).mockReset().mockResolvedValue(empty);
  });
  it("opens an active organization when entering Team mode", async () => {
    const store = createTeamSpaceStore(true);
    await store.getState().load();
    expect(store.getState().snapshot?.selected.id).toBe("a");
  });
  it("uses the personal snapshot for onboarding when no organizations exist", async () => {
    vi.mocked(teamSpacesApi.list).mockResolvedValue({ spaces: [personal] });
    const store = createTeamSpaceStore(true);
    await store.getState().load();
    expect(store.getState().snapshot?.selected.id).toBe("p");
    expect(store.getState().error).toBeNull();
  });
  it("opens an invitation without requesting member data in Team mode", async () => {
    vi.mocked(teamSpacesApi.list).mockResolvedValue({ spaces: [personal, { ...org, membership: { ...org.membership, status: "invited" } }] });
    const store = createTeamSpaceStore(true);
    await store.getState().load();
    expect(store.getState().snapshot?.selected.id).toBe("a");
    expect(teamSpacesApi.members).not.toHaveBeenCalled();
  });
  it("discards a late response from the previous organization", async () => {
    let finish!: (value: SpaceMembers) => void;
    vi.mocked(teamSpacesApi.members).mockImplementation((id) =>
      id === "a"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(empty),
    );
    const store = createTeamSpaceStore();
    const old = store.getState().load("a");
    await vi.waitFor(() => expect(finish).toBeDefined());
    await store.getState().load("p");
    finish({
      users: [],
      agents: [{ display_name: "Company secret" }],
    } as SpaceMembers);
    await old;
    expect(store.getState().snapshot?.selected.id).toBe("p");
    expect(store.getState().snapshot?.members).toEqual(empty);
  });
  it("clears prior content immediately and fails closed if membership was removed", async () => {
    const store = createTeamSpaceStore();
    await store.getState().load("a");
    vi.mocked(teamSpacesApi.list).mockResolvedValue({ spaces: [personal] });
    const refresh = store.getState().load("a");
    expect(store.getState().snapshot).toBeNull();
    await refresh;
    expect(store.getState().error).toMatchObject({ status: 404 });
    expect(store.getState().snapshot).toBeNull();
  });
  it("shows invitations without requesting member data", async () => {
    vi.mocked(teamSpacesApi.list).mockResolvedValue({
      spaces: [
        { ...org, membership: { ...org.membership, status: "invited" } },
      ],
    });
    const store = createTeamSpaceStore();
    await store.getState().load("a");
    expect(store.getState().snapshot?.selected.membership.status).toBe(
      "invited",
    );
    expect(teamSpacesApi.members).not.toHaveBeenCalled();
  });
  it("does not silently fall back to personal mode for an unknown organization", async () => {
    const store = createTeamSpaceStore();
    await store.getState().load("unknown");
    expect(store.getState().snapshot).toBeNull();
    expect(teamSpacesApi.members).not.toHaveBeenCalled();
  });
});
