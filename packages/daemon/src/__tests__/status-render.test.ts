import { describe, expect, it } from "vitest";
import type { GatewayRuntimeSnapshot } from "../gateway/index.js";
import { renderStatus, STALE_THRESHOLD_MS } from "../status-render.js";

function snapshot(
  overrides: Partial<GatewayRuntimeSnapshot> = {},
): GatewayRuntimeSnapshot {
  return {
    channels: overrides.channels ?? {},
    turns: overrides.turns ?? {},
  };
}

describe("renderStatus", () => {
  it("prints 'stopped' when no pid is present", () => {
    const out = renderStatus({ pid: null, alive: false });
    expect(out).toContain("stopped");
  });

  it("prints pid + agent + config when only PID state is known (no snapshot)", () => {
    const out = renderStatus(
      {
        pid: 1234,
        alive: true,
        agentId: "ag_xyz",
        configPath: "/tmp/config.json",
      },
      1_700_000_000_000,
    );
    expect(out).toMatch(/pid 1234 \(alive\)/);
    expect(out).toContain("ag_xyz");
    expect(out).toContain("/tmp/config.json");
    expect(out).toContain("snapshot: unavailable");
  });

  it("renders channel and turn rows from a snapshot", () => {
    const now = 1_700_000_000_000;
    const snap = snapshot({
      channels: {
        ag_123: {
          channel: "ag_123",
          accountId: "ag_123",
          running: true,
          connected: true,
          reconnectAttempts: 0,
          restartPending: false,
          lastError: null,
        },
      },
      turns: {
        "botcord:ag_123:rm_oc_abc": {
          key: "botcord:ag_123:rm_oc_abc",
          channel: "ag_123",
          accountId: "ag_123",
          conversationId: "rm_oc_abc",
          runtime: "claude-code",
          cwd: "/work",
          startedAt: now - 12_000,
        },
      },
    });
    const out = renderStatus(
      { pid: 1, alive: true, snapshot: snap, snapshotAgeMs: 100 },
      now,
    );
    expect(out).toContain("Channels:");
    expect(out).toContain("ag_123");
    expect(out).toContain("In-flight turns:");
    expect(out).toContain("rm_oc_abc");
    expect(out).toContain("claude-code");
    expect(out).toMatch(/12s ago/);
    expect(out).not.toContain("⚠ stale");
  });

  it("renders multi-agent headers ('agents:') when bound to more than one", () => {
    const out = renderStatus({
      pid: 42,
      alive: true,
      agents: ["ag_one", "ag_two"],
      configPath: "/tmp/c.json",
    });
    expect(out).toContain("agents: ag_one, ag_two");
    expect(out).not.toContain("agent:  ag_one");
  });

  it("renders single-agent header ('agent:  …') when bound to exactly one", () => {
    const out = renderStatus({
      pid: 42,
      alive: true,
      agents: ["ag_solo"],
      configPath: "/tmp/c.json",
    });
    expect(out).toContain("agent:  ag_solo");
  });

  it("surfaces ⚠ stale when snapshotAgeMs exceeds the threshold", () => {
    const out = renderStatus(
      {
        pid: 42,
        alive: true,
        snapshot: snapshot(),
        snapshotAgeMs: STALE_THRESHOLD_MS + 5_000,
      },
      1_700_000_000_000,
    );
    expect(out).toContain("⚠ stale");
  });

  it("tags agents as '(discovered)' when sourced from credential discovery", () => {
    const out = renderStatus({
      pid: 42,
      alive: true,
      agents: ["ag_found"],
      agentsSource: "credentials",
    });
    expect(out).toContain("ag_found (discovered)");
  });

  it("falls back to an explicit empty hint when discovery finds no agents", () => {
    const out = renderStatus({
      pid: 42,
      alive: true,
      agents: [],
      agentsSource: "credentials",
    });
    expect(out).toContain("none discovered");
  });

  it("shows '(none)' when the snapshot has no channels or turns", () => {
    const out = renderStatus(
      { pid: 1, alive: true, snapshot: snapshot(), snapshotAgeMs: 100 },
      1_700_000_000_000,
    );
    expect(out).toContain("Channels:");
    expect(out).toContain("(none)");
  });
});
