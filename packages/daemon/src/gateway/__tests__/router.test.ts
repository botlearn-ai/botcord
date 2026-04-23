import { describe, expect, it } from "vitest";
import { matchesRoute, resolveRoute } from "../router.js";
import type { GatewayInboundMessage, GatewayRoute, RouteMatch } from "../types.js";

function makeMessage(
  overrides: Partial<GatewayInboundMessage> & {
    conversation?: Partial<GatewayInboundMessage["conversation"]>;
    sender?: Partial<GatewayInboundMessage["sender"]>;
  } = {},
): GatewayInboundMessage {
  const { conversation, sender, ...rest } = overrides;
  return {
    id: "m_1",
    channel: "botcord",
    accountId: "acc_a",
    conversation: {
      id: "rm_1",
      kind: "group",
      ...(conversation ?? {}),
    },
    sender: {
      id: "ag_sender",
      kind: "agent",
      ...(sender ?? {}),
    },
    text: "hello",
    raw: {},
    receivedAt: 0,
    ...rest,
  };
}

function makeRoute(overrides: Partial<GatewayRoute> = {}): GatewayRoute {
  return {
    runtime: "claude-code",
    cwd: "/tmp",
    ...overrides,
  };
}

const defaultRoute: GatewayRoute = makeRoute({ runtime: "default-runtime", cwd: "/default" });

describe("resolveRoute", () => {
  it("returns defaultRoute when routes is empty", () => {
    const msg = makeMessage();
    expect(resolveRoute(msg, { defaultRoute, routes: [] })).toBe(defaultRoute);
  });

  it("returns defaultRoute when routes is undefined", () => {
    const msg = makeMessage();
    expect(resolveRoute(msg, { defaultRoute })).toBe(defaultRoute);
  });

  it("picks a route with no match (matches everything) over default", () => {
    const route = makeRoute({ runtime: "catchall" });
    const msg = makeMessage();
    expect(resolveRoute(msg, { defaultRoute, routes: [route] })).toBe(route);
  });

  it("returns the first matching route when multiple could match", () => {
    const first = makeRoute({ runtime: "first", match: { channel: "botcord" } });
    const second = makeRoute({ runtime: "second", match: { channel: "botcord" } });
    const msg = makeMessage();
    expect(resolveRoute(msg, { defaultRoute, routes: [first, second] })).toBe(first);
  });

  it("falls back to defaultRoute when no route matches", () => {
    const route = makeRoute({ runtime: "other", match: { channel: "telegram" } });
    const msg = makeMessage({ channel: "botcord" });
    expect(resolveRoute(msg, { defaultRoute, routes: [route] })).toBe(defaultRoute);
  });

  it("skips non-matching routes and picks the next one that matches", () => {
    const skip = makeRoute({ runtime: "skip", match: { channel: "telegram" } });
    const hit = makeRoute({ runtime: "hit", match: { channel: "botcord" } });
    const msg = makeMessage({ channel: "botcord" });
    expect(resolveRoute(msg, { defaultRoute, routes: [skip, hit] })).toBe(hit);
  });

  describe("managedRoutes", () => {
    it("user cfg.routes match wins over managed for same accountId", () => {
      const user = makeRoute({ runtime: "user", match: { accountId: "ag_1" } });
      const managed = makeRoute({ runtime: "managed", match: { accountId: "ag_1" } });
      const msg = makeMessage({ accountId: "ag_1" });
      expect(resolveRoute(msg, { defaultRoute, routes: [user] }, [managed])).toBe(user);
    });

    it("no user match + managed match → managed wins", () => {
      const managed = makeRoute({ runtime: "managed", match: { accountId: "ag_1" } });
      const msg = makeMessage({ accountId: "ag_1" });
      expect(resolveRoute(msg, { defaultRoute, routes: [] }, [managed])).toBe(managed);
    });

    it("no user match + no managed match → defaultRoute wins", () => {
      const user = makeRoute({ runtime: "user", match: { accountId: "ag_2" } });
      const managed = makeRoute({ runtime: "managed", match: { accountId: "ag_3" } });
      const msg = makeMessage({ accountId: "ag_1" });
      expect(resolveRoute(msg, { defaultRoute, routes: [user] }, [managed])).toBe(defaultRoute);
    });

    it("no user routes defined + managed match → managed wins", () => {
      const managed = makeRoute({ runtime: "managed", match: { accountId: "ag_1" } });
      const msg = makeMessage({ accountId: "ag_1" });
      expect(resolveRoute(msg, { defaultRoute }, [managed])).toBe(managed);
    });

    it("managed routes undefined behaves like no managed routes", () => {
      const msg = makeMessage();
      expect(resolveRoute(msg, { defaultRoute }, undefined)).toBe(defaultRoute);
    });

    it("first matching managed route wins when multiple match", () => {
      const first = makeRoute({ runtime: "mfirst", match: { accountId: "ag_1" } });
      const second = makeRoute({ runtime: "msecond", match: { accountId: "ag_1" } });
      const msg = makeMessage({ accountId: "ag_1" });
      expect(resolveRoute(msg, { defaultRoute, routes: [] }, [first, second])).toBe(first);
    });
  });
});

describe("matchesRoute", () => {
  it("returns true when match is undefined", () => {
    expect(matchesRoute(makeMessage(), undefined)).toBe(true);
  });

  it("returns true when match is an empty object", () => {
    expect(matchesRoute(makeMessage(), {})).toBe(true);
  });

  describe("channel", () => {
    it("matches when equal", () => {
      expect(matchesRoute(makeMessage({ channel: "botcord" }), { channel: "botcord" })).toBe(true);
    });
    it("rejects when different", () => {
      expect(matchesRoute(makeMessage({ channel: "botcord" }), { channel: "telegram" })).toBe(
        false,
      );
    });
  });

  describe("accountId", () => {
    it("matches when equal", () => {
      expect(matchesRoute(makeMessage({ accountId: "acc_a" }), { accountId: "acc_a" })).toBe(true);
    });
    it("rejects when different", () => {
      expect(matchesRoute(makeMessage({ accountId: "acc_a" }), { accountId: "acc_b" })).toBe(
        false,
      );
    });
  });

  describe("conversationId", () => {
    it("matches when equal", () => {
      const msg = makeMessage({ conversation: { id: "rm_42", kind: "group" } });
      expect(matchesRoute(msg, { conversationId: "rm_42" })).toBe(true);
    });
    it("rejects when different", () => {
      const msg = makeMessage({ conversation: { id: "rm_42", kind: "group" } });
      expect(matchesRoute(msg, { conversationId: "rm_99" })).toBe(false);
    });
  });

  describe("conversationPrefix", () => {
    it("matches when prefix applies", () => {
      const msg = makeMessage({ conversation: { id: "rm_dm_abc", kind: "direct" } });
      expect(matchesRoute(msg, { conversationPrefix: "rm_dm_" })).toBe(true);
    });
    it("rejects when prefix does not apply", () => {
      const msg = makeMessage({ conversation: { id: "rm_abc", kind: "group" } });
      expect(matchesRoute(msg, { conversationPrefix: "rm_dm_" })).toBe(false);
    });
  });

  describe("conversationKind", () => {
    it("matches direct", () => {
      const msg = makeMessage({ conversation: { id: "rm_1", kind: "direct" } });
      expect(matchesRoute(msg, { conversationKind: "direct" })).toBe(true);
    });
    it("matches group", () => {
      const msg = makeMessage({ conversation: { id: "rm_1", kind: "group" } });
      expect(matchesRoute(msg, { conversationKind: "group" })).toBe(true);
    });
    it("rejects when kind differs", () => {
      const msg = makeMessage({ conversation: { id: "rm_1", kind: "group" } });
      expect(matchesRoute(msg, { conversationKind: "direct" })).toBe(false);
    });
  });

  describe("senderId", () => {
    it("matches when equal", () => {
      const msg = makeMessage({ sender: { id: "ag_alice", kind: "agent" } });
      expect(matchesRoute(msg, { senderId: "ag_alice" })).toBe(true);
    });
    it("rejects when different", () => {
      const msg = makeMessage({ sender: { id: "ag_alice", kind: "agent" } });
      expect(matchesRoute(msg, { senderId: "ag_bob" })).toBe(false);
    });
  });

  describe("mentioned", () => {
    it("matches when both true", () => {
      expect(matchesRoute(makeMessage({ mentioned: true }), { mentioned: true })).toBe(true);
    });
    it("matches when both false", () => {
      expect(matchesRoute(makeMessage({ mentioned: false }), { mentioned: false })).toBe(true);
    });
    it("treats undefined on message as false when match.mentioned is false", () => {
      expect(matchesRoute(makeMessage(), { mentioned: false })).toBe(true);
    });
    it("rejects when match.mentioned is true and message.mentioned is undefined", () => {
      expect(matchesRoute(makeMessage(), { mentioned: true })).toBe(false);
    });
    it("rejects when match.mentioned is true and message.mentioned is false", () => {
      expect(matchesRoute(makeMessage({ mentioned: false }), { mentioned: true })).toBe(false);
    });
    it("rejects when match.mentioned is false and message.mentioned is true", () => {
      expect(matchesRoute(makeMessage({ mentioned: true }), { mentioned: false })).toBe(false);
    });
  });

  describe("AND semantics", () => {
    it("matches only when both fields match", () => {
      const match: RouteMatch = { channel: "botcord", conversationKind: "direct" };
      const good = makeMessage({
        channel: "botcord",
        conversation: { id: "rm_dm_1", kind: "direct" },
      });
      expect(matchesRoute(good, match)).toBe(true);
    });
    it("rejects when first field matches but second does not", () => {
      const match: RouteMatch = { channel: "botcord", conversationKind: "direct" };
      const bad = makeMessage({
        channel: "botcord",
        conversation: { id: "rm_1", kind: "group" },
      });
      expect(matchesRoute(bad, match)).toBe(false);
    });
    it("rejects when second field matches but first does not", () => {
      const match: RouteMatch = { channel: "botcord", conversationKind: "direct" };
      const bad = makeMessage({
        channel: "telegram",
        conversation: { id: "rm_dm_1", kind: "direct" },
      });
      expect(matchesRoute(bad, match)).toBe(false);
    });
  });
});
