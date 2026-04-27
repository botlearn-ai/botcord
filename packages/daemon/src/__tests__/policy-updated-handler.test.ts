import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = {
  cfg: {
    defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
    routes: [],
    streamBlocks: true,
  } as Record<string, unknown>,
  saved: [] as Array<Record<string, unknown>>,
};

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return {
    ...actual,
    loadConfig: () => JSON.parse(JSON.stringify(mockState.cfg)) as Record<string, unknown>,
    saveConfig: (next: Record<string, unknown>) => {
      mockState.cfg = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
      mockState.saved.push(JSON.parse(JSON.stringify(next)) as Record<string, unknown>);
    },
  };
});

const { createProvisioner } = await import("../provision.js");
const { CONTROL_FRAME_TYPES } = await import("@botcord/protocol-core");
import type { GatewayRoute, GatewayRuntimeSnapshot } from "../gateway/index.js";
import type { PolicyResolverLike } from "../gateway/policy-resolver.js";

beforeEach(() => {
  mockState.cfg = {
    defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
    routes: [],
    streamBlocks: true,
  };
  mockState.saved = [];
});

function makeFakeGateway(): unknown {
  const snap: GatewayRuntimeSnapshot = { channels: {}, turns: {} };
  return {
    addChannel: vi.fn(async () => {}),
    removeChannel: vi.fn(async () => {}),
    upsertManagedRoute: vi.fn(),
    removeManagedRoute: vi.fn(),
    replaceManagedRoutes: vi.fn(),
    listManagedRoutes: () => [] as GatewayRoute[],
    snapshot: () => snap,
  };
}

function makeFakeResolver(): PolicyResolverLike & {
  invalidate: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
} {
  return {
    resolve: vi.fn(async () => ({ mode: "always", keywords: [] })),
    invalidate: vi.fn(),
    put: vi.fn(),
  };
}

describe("policy_updated control-frame handler", () => {
  it("invalidates the resolver cache for the agent when payload has no policy", async () => {
    const gw = makeFakeGateway();
    const resolver = makeFakeResolver();
    const provisioner = createProvisioner({
      gateway: gw as Parameters<typeof createProvisioner>[0]["gateway"],
      policyResolver: resolver,
    });
    const ack = await provisioner({
      id: "f1",
      type: CONTROL_FRAME_TYPES.POLICY_UPDATED,
      params: { agent_id: "ag_a" },
    });
    expect(ack.ok).toBe(true);
    expect(resolver.invalidate).toHaveBeenCalledWith("ag_a", undefined);
    expect(resolver.put).not.toHaveBeenCalled();
  });

  it("invalidates only the per-room slot when room_id is present", async () => {
    const resolver = makeFakeResolver();
    const provisioner = createProvisioner({
      gateway: makeFakeGateway() as Parameters<typeof createProvisioner>[0]["gateway"],
      policyResolver: resolver,
    });
    await provisioner({
      id: "f2",
      type: CONTROL_FRAME_TYPES.POLICY_UPDATED,
      params: { agent_id: "ag_a", room_id: "rm_1" },
    });
    expect(resolver.invalidate).toHaveBeenCalledWith("ag_a", "rm_1");
  });

  it("calls put() with the embedded policy when payload carries one", async () => {
    const resolver = makeFakeResolver();
    const provisioner = createProvisioner({
      gateway: makeFakeGateway() as Parameters<typeof createProvisioner>[0]["gateway"],
      policyResolver: resolver,
    });
    const ack = await provisioner({
      id: "f3",
      type: CONTROL_FRAME_TYPES.POLICY_UPDATED,
      params: {
        agent_id: "ag_a",
        policy: { mode: "keyword", keywords: ["foo", "bar"], muted_until: 123 },
      },
    });
    expect(ack.ok).toBe(true);
    expect(resolver.put).toHaveBeenCalledWith("ag_a", null, {
      mode: "keyword",
      keywords: ["foo", "bar"],
      muted_until: 123,
    });
    expect(resolver.invalidate).not.toHaveBeenCalled();
  });

  it("rejects payloads missing agent_id with bad_params", async () => {
    const resolver = makeFakeResolver();
    const provisioner = createProvisioner({
      gateway: makeFakeGateway() as Parameters<typeof createProvisioner>[0]["gateway"],
      policyResolver: resolver,
    });
    const ack = await provisioner({
      id: "f4",
      type: CONTROL_FRAME_TYPES.POLICY_UPDATED,
      params: {},
    });
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe("bad_params");
  });

  it("succeeds quietly when no resolver is wired", async () => {
    const provisioner = createProvisioner({
      gateway: makeFakeGateway() as Parameters<typeof createProvisioner>[0]["gateway"],
    });
    const ack = await provisioner({
      id: "f5",
      type: CONTROL_FRAME_TYPES.POLICY_UPDATED,
      params: { agent_id: "ag_a" },
    });
    expect(ack.ok).toBe(true);
  });
});
