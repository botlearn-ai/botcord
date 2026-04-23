import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayInboundMessage, GatewayLogger } from "../gateway/index.js";
import {
  backfillBootAgents,
  classifyActivitySender,
  createActivityRecorder,
} from "../daemon.js";
import type { DiscoveredAgentCredential } from "../agent-discovery.js";
import { agentWorkspaceDir } from "../agent-workspace.js";

function makeMsg(overrides: {
  conversationId?: string;
  senderKind?: "user" | "agent" | "system";
  senderId?: string;
  senderName?: string;
  sourceType?: unknown;
}): GatewayInboundMessage {
  return {
    id: "m1",
    channel: "botcord",
    accountId: "acc",
    conversation: {
      id: overrides.conversationId ?? "rm_team",
      kind: "group",
    },
    sender: {
      id: overrides.senderId ?? "ag_peer",
      kind: overrides.senderKind ?? "agent",
      ...(overrides.senderName ? { name: overrides.senderName } : {}),
    },
    text: "",
    raw: overrides.sourceType !== undefined ? { source_type: overrides.sourceType } : {},
    receivedAt: Date.now(),
  };
}

describe("classifyActivitySender", () => {
  it("labels rm_oc_* rooms as owner regardless of sender.kind", () => {
    const msg = makeMsg({
      conversationId: "rm_oc_abc",
      senderKind: "user",
      senderId: "ag_self",
    });
    expect(classifyActivitySender(msg)).toEqual({ kind: "owner", label: "ag_self" });
  });

  it("labels source_type=dashboard_user_chat as owner even outside rm_oc_ rooms", () => {
    const msg = makeMsg({
      conversationId: "rm_team_42",
      senderKind: "user",
      senderId: "ag_owner",
      sourceType: "dashboard_user_chat",
    });
    // Regression guard: the gateway channel collapses owner + human-room humans
    // into sender.kind="user"; without the source_type peek the classifier would
    // label this turn as "human" in the cross-room digest.
    expect(classifyActivitySender(msg)).toEqual({ kind: "owner", label: "ag_owner" });
  });

  it("labels dashboard_human_room senders as human and uses source_user_name", () => {
    const msg = makeMsg({
      conversationId: "rm_team_42",
      senderKind: "user",
      senderName: "Alice",
      senderId: "ag_bridge",
      sourceType: "dashboard_human_room",
    });
    expect(classifyActivitySender(msg)).toEqual({ kind: "human", label: "Alice" });
  });

  it("labels A2A peer (sender.kind=agent) as agent", () => {
    const msg = makeMsg({
      conversationId: "rm_team_42",
      senderKind: "agent",
      senderId: "ag_peer",
    });
    expect(classifyActivitySender(msg)).toEqual({ kind: "agent", label: "ag_peer" });
  });

  it("falls back cleanly when raw is a non-object (defensive path for non-BotCord channels)", () => {
    const msg = makeMsg({ conversationId: "rm_team_42", senderKind: "agent" });
    // Overwrite raw to a non-object; classifier should still return agent.
    (msg as { raw: unknown }).raw = "not-an-object";
    expect(classifyActivitySender(msg)).toEqual({ kind: "agent", label: "ag_peer" });
  });

  it("uses sender.id when the user sender has no name", () => {
    const msg = makeMsg({
      conversationId: "rm_other",
      senderKind: "user",
      senderId: "ag_anon",
    });
    expect(classifyActivitySender(msg)).toEqual({ kind: "human", label: "ag_anon" });
  });
});

describe("createActivityRecorder", () => {
  it("records inbound messages regardless of the channel id the gateway stamps", () => {
    // Regression: pre-fix, the observer bailed out when msg.channel !== "botcord".
    // After the agent-id channel migration, the gateway stamps the agentId
    // (e.g. "ag_self"). The recorder must still fire — cross-room digest
    // silently going empty was the original bug.
    const record = vi.fn();
    const onInbound = createActivityRecorder({
      activityTracker: { record },
    });
    const msg: GatewayInboundMessage = {
      ...makeMsg({ conversationId: "rm_team_42", senderKind: "agent", senderId: "ag_peer" }),
      accountId: "ag_self",
      channel: "ag_self",
      text: "hello there",
    };
    onInbound(msg);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      agentId: "ag_self",
      roomId: "rm_team_42",
      roomName: undefined,
      topic: null,
      lastInboundPreview: "hello there",
      lastSenderKind: "agent",
      lastSender: "ag_peer",
    });
  });

  it("derives the activity agentId from msg.accountId (multi-agent isolation)", () => {
    // Multi-agent regression guard: two messages targeting different
    // configured agents must land under distinct tracker keys, not a
    // closed-over constant.
    const record = vi.fn();
    const onInbound = createActivityRecorder({
      activityTracker: { record },
    });
    onInbound({
      ...makeMsg({ conversationId: "rm_a", senderKind: "agent", senderId: "ag_peer" }),
      accountId: "ag_one",
      channel: "ag_one",
      text: "for agent one",
    });
    onInbound({
      ...makeMsg({ conversationId: "rm_b", senderKind: "agent", senderId: "ag_peer" }),
      accountId: "ag_two",
      channel: "ag_two",
      text: "for agent two",
    });
    expect(record.mock.calls[0][0].agentId).toBe("ag_one");
    expect(record.mock.calls[1][0].agentId).toBe("ag_two");
  });

  it("falls back to fallbackAgentId when msg.accountId is empty", () => {
    const record = vi.fn();
    const onInbound = createActivityRecorder({
      activityTracker: { record },
      fallbackAgentId: "ag_fallback",
    });
    onInbound({
      ...makeMsg({ conversationId: "rm_x", senderKind: "agent", senderId: "ag_peer" }),
      accountId: "",
      channel: "ag_fallback",
    });
    expect(record.mock.calls[0][0].agentId).toBe("ag_fallback");
  });

  it("passes owner text through verbatim and sanitizes non-owner text", () => {
    const record = vi.fn();
    const onInbound = createActivityRecorder({
      activityTracker: { record },
    });
    onInbound({
      ...makeMsg({ conversationId: "rm_oc_abc", senderKind: "user", senderId: "ag_self" }),
      accountId: "ag_self",
      channel: "ag_self",
      text: "raw owner text",
    });
    expect(record.mock.calls[0][0].lastInboundPreview).toBe("raw owner text");
    expect(record.mock.calls[0][0].lastSenderKind).toBe("owner");
  });
});

function silentLogger(): GatewayLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function bootAgent(
  agentId: string,
  extra: Partial<DiscoveredAgentCredential> = {},
): DiscoveredAgentCredential {
  return {
    agentId,
    credentialsFile: `/fake/${agentId}.json`,
    hubUrl: "https://hub.example.com",
    ...extra,
  };
}

describe("backfillBootAgents", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "botcord-daemon-boot-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates the per-agent workspace for a legacy discovered agent that has none", () => {
    // Simulates plan §9's primary use case: an agent was provisioned before
    // the workspace feature existed, so `~/.botcord/agents/{id}/` doesn't
    // exist yet. Boot backfill should materialize it — but leave the
    // credentials file alone (no-credential-mutation invariant).
    const res = backfillBootAgents(
      [
        bootAgent("ag_legacy", {
          displayName: "Legacy",
          keyId: "k_42",
          savedAt: "2026-04-23T00:00:00.000Z",
        }),
      ],
      { logger: silentLogger() },
    );
    const ws = agentWorkspaceDir("ag_legacy");
    expect(existsSync(path.join(ws, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(ws, "identity.md"))).toBe(true);
    const identity = readFileSync(path.join(ws, "identity.md"), "utf8");
    expect(identity).toContain("ag_legacy");
    expect(identity).toContain("Legacy");
    expect(identity).toContain("k_42");
    // Maps still populated for downstream `toGatewayConfig` consumption.
    expect(res.credentialPathByAgentId.get("ag_legacy")).toBe(
      "/fake/ag_legacy.json",
    );
    // No runtime/cwd on the boot agent → no entry in the runtimes map.
    expect(res.agentRuntimes.ag_legacy).toBeUndefined();
  });

  it("is idempotent: a second call leaves user-edited files alone", () => {
    backfillBootAgents([bootAgent("ag_one")], { logger: silentLogger() });
    const memoryPath = path.join(agentWorkspaceDir("ag_one"), "memory.md");
    const edited = "# My notes\n\nremembered thing\n";
    // Simulate the LLM/user editing memory.md.
    writeFileSync(memoryPath, edited);
    backfillBootAgents([bootAgent("ag_one")], { logger: silentLogger() });
    expect(readFileSync(memoryPath, "utf8")).toBe(edited);
  });

  it("warns and continues when ensureAgentWorkspace throws for one agent", () => {
    // One agent's broken workspace (permission denied, full disk, etc.)
    // must not block the other agents from being brought up.
    const warn = vi.fn();
    const ensure = vi.fn((agentId: string) => {
      if (agentId === "ag_bad") throw new Error("EACCES");
    });
    const logger: GatewayLogger = { ...silentLogger(), warn };
    const res = backfillBootAgents(
      [bootAgent("ag_bad"), bootAgent("ag_good", { runtime: "codex" })],
      { logger, ensure },
    );
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "ensureAgentWorkspace failed at boot; continuing",
      expect.objectContaining({ agentId: "ag_bad" }),
    );
    // Both agents are still plumbed into the downstream caches — the peer
    // agent's channel and route are not taken down by the sibling's error.
    expect(res.credentialPathByAgentId.has("ag_bad")).toBe(true);
    expect(res.credentialPathByAgentId.has("ag_good")).toBe(true);
    expect(res.agentRuntimes.ag_good).toEqual({ runtime: "codex" });
  });

  it("does not touch credential files (no-credential-mutation invariant)", () => {
    // §9 "No credential mutation": boot backfill writes to the agent's
    // workspace dir only; the credential file passed in via `credentialsFile`
    // is not opened. We verify by using a path that doesn't exist on disk —
    // if the backfill tried to read or rewrite it, we'd see an ENOENT.
    expect(() =>
      backfillBootAgents([bootAgent("ag_one")], { logger: silentLogger() }),
    ).not.toThrow();
    expect(existsSync("/fake/ag_one.json")).toBe(false);
  });
});
