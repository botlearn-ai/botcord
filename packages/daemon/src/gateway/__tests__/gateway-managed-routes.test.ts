import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gateway } from "../gateway.js";
import { resolveRoute } from "../router.js";
import type {
  ChannelAdapter,
  ChannelSendContext,
  ChannelSendResult,
  ChannelStartContext,
  ChannelStopContext,
  GatewayChannelConfig,
  GatewayInboundMessage,
  GatewayRoute,
} from "../types.js";
import type { GatewayLogger } from "../log.js";

function silentLogger(): GatewayLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

class StubChannel implements ChannelAdapter {
  readonly type = "stub";
  constructor(public readonly id: string, public readonly accountId: string) {}
  async start(ctx: ChannelStartContext): Promise<void> {
    await new Promise<void>((resolve) => {
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async stop(_ctx: ChannelStopContext): Promise<void> {}
  async send(_ctx: ChannelSendContext): Promise<ChannelSendResult> {
    return {};
  }
}

function makeMessage(overrides: Partial<GatewayInboundMessage> = {}): GatewayInboundMessage {
  return {
    id: "m_1",
    channel: "botcord",
    accountId: "ag_1",
    conversation: { id: "rm_1", kind: "group" },
    sender: { id: "ag_sender", kind: "agent" },
    text: "hi",
    raw: {},
    receivedAt: 0,
    ...overrides,
  };
}

function makeRoute(overrides: Partial<GatewayRoute> = {}): GatewayRoute {
  return { runtime: "claude-code", cwd: "/tmp", ...overrides };
}

describe("Gateway managed-route API", () => {
  const defaultRoute: GatewayRoute = makeRoute({ runtime: "default", cwd: "/default" });
  let dirs: string[] = [];
  let gateway: Gateway | null = null;

  beforeEach(() => {
    dirs = [];
    gateway = null;
  });

  afterEach(async () => {
    if (gateway) await gateway.stop("test");
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function makeGateway(
    channels: GatewayChannelConfig[] = [],
    userRoutes: GatewayRoute[] = [],
  ): Promise<Gateway> {
    const dir = await mkdtemp(path.join(tmpdir(), "gw-mr-"));
    dirs.push(dir);
    const gw = new Gateway({
      config: { channels, defaultRoute, routes: userRoutes },
      sessionStorePath: path.join(dir, "sessions.json"),
      createChannel: (cfg) => new StubChannel(cfg.id, cfg.accountId),
      log: silentLogger(),
    });
    gateway = gw;
    return gw;
  }

  it("upsertManagedRoute adds a route and listManagedRoutes reflects it", async () => {
    const gw = await makeGateway();
    const route = makeRoute({ runtime: "r1", cwd: "/ws/ag_1", match: { accountId: "ag_1" } });
    gw.upsertManagedRoute("ag_1", route);
    expect(gw.listManagedRoutes()).toEqual([route]);
  });

  it("upsertManagedRoute on existing accountId replaces (no duplicate)", async () => {
    const gw = await makeGateway();
    const first = makeRoute({ runtime: "r1", match: { accountId: "ag_1" } });
    const second = makeRoute({ runtime: "r2", match: { accountId: "ag_1" } });
    gw.upsertManagedRoute("ag_1", first);
    gw.upsertManagedRoute("ag_1", second);
    expect(gw.listManagedRoutes()).toEqual([second]);
  });

  it("removeManagedRoute drops the entry; cfg.routes with same accountId untouched", async () => {
    const user = makeRoute({ runtime: "user", match: { accountId: "ag_1" } });
    const gw = await makeGateway([], [user]);
    gw.upsertManagedRoute("ag_1", makeRoute({ runtime: "managed", match: { accountId: "ag_1" } }));
    gw.removeManagedRoute("ag_1");
    expect(gw.listManagedRoutes()).toEqual([]);

    const msg = makeMessage({ accountId: "ag_1" });
    expect(resolveRoute(msg, { defaultRoute, routes: [user] }, gw.listManagedRoutes())).toBe(user);
  });

  it("removeManagedRoute on unknown accountId is a no-op", async () => {
    const gw = await makeGateway();
    expect(() => gw.removeManagedRoute("ag_missing")).not.toThrow();
    expect(gw.listManagedRoutes()).toEqual([]);
  });

  it("replaceManagedRoutes(new Map()) wipes synthesized without touching cfg.routes", async () => {
    const user = makeRoute({ runtime: "user", match: { accountId: "ag_2" } });
    const gw = await makeGateway([], [user]);
    gw.upsertManagedRoute("ag_1", makeRoute({ runtime: "m1" }));
    gw.upsertManagedRoute("ag_9", makeRoute({ runtime: "m2" }));
    gw.replaceManagedRoutes(new Map());
    expect(gw.listManagedRoutes()).toEqual([]);

    const msg = makeMessage({ accountId: "ag_2" });
    expect(resolveRoute(msg, { defaultRoute, routes: [user] }, gw.listManagedRoutes())).toBe(user);
  });

  it("replaceManagedRoutes swaps contents atomically", async () => {
    const gw = await makeGateway();
    gw.upsertManagedRoute("ag_old", makeRoute({ runtime: "old" }));
    const next = new Map<string, GatewayRoute>();
    const newRoute = makeRoute({ runtime: "new", match: { accountId: "ag_new" } });
    next.set("ag_new", newRoute);
    gw.replaceManagedRoutes(next);
    expect(gw.listManagedRoutes()).toEqual([newRoute]);
  });

  it("replaceManagedRoutes decouples from the caller's Map", async () => {
    const gw = await makeGateway();
    const src = new Map<string, GatewayRoute>();
    src.set("ag_1", makeRoute({ runtime: "m1" }));
    gw.replaceManagedRoutes(src);
    src.clear();
    expect(gw.listManagedRoutes()).toHaveLength(1);
  });

  it("ctor logs (not silently drops) seed managed routes missing accountId", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gw-mr-bad-"));
    dirs.push(dir);
    const warnCalls: unknown[][] = [];
    const log: GatewayLogger = {
      info: () => {},
      warn: (...args: unknown[]) => warnCalls.push(args),
      error: () => {},
      debug: () => {},
    };
    const gw = new Gateway({
      config: {
        channels: [],
        defaultRoute,
        routes: [],
        managedRoutes: [
          { match: { accountId: "ag_ok" }, runtime: "r", cwd: "/w/ok" },
          // match.accountId missing — must not crash, must log
          { match: {}, runtime: "r", cwd: "/w/bad" },
          // match undefined — same
          { runtime: "r", cwd: "/w/bad2" },
        ],
      },
      sessionStorePath: path.join(dir, "sessions.json"),
      createChannel: (cfg) => new StubChannel(cfg.id, cfg.accountId),
      log,
    });
    gateway = gw;
    expect(gw.listManagedRoutes()).toHaveLength(1);
    expect(warnCalls.length).toBe(2);
  });
});
