import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayInboundMessage } from "../gateway/index.js";

// Shared tempdir used for both working-memory (resolved via $HOME since the
// §8 migration) and the activity tracker file. Each test gets a fresh HOME
// so `~/.botcord/agents/<id>/state/working-memory.json` is isolated.
let tmpDir = "";
let prevHome: string | undefined;

vi.mock("../config.js", () => {
  return {
    get DAEMON_DIR_PATH() {
      return path.join(tmpDir, ".botcord", "daemon");
    },
  };
});

// Import after the mock so DAEMON_DIR_PATH is stubbed for all transitive
// dependencies (working-memory, activity-tracker).
const { updateWorkingMemory, clearWorkingMemory } = await import(
  "../working-memory.js"
);
const { ActivityTracker } = await import("../activity-tracker.js");
const { createDaemonSystemContextBuilder } = await import("../system-context.js");

function makeMessage(
  partial: Partial<GatewayInboundMessage> = {},
): GatewayInboundMessage {
  return {
    id: partial.id ?? "hub_msg_sc",
    channel: partial.channel ?? "botcord",
    accountId: partial.accountId ?? "ag_me",
    conversation: partial.conversation ?? { id: "rm_current", kind: "group" },
    sender: partial.sender ?? { id: "ag_peer", kind: "agent" },
    text: partial.text ?? "hello",
    raw: partial.raw ?? {},
    receivedAt: partial.receivedAt ?? Date.now(),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "daemon-sc-"));
  prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("createDaemonSystemContextBuilder", () => {
  it("returns undefined when working memory is empty and no activity tracker is wired", () => {
    const builder = createDaemonSystemContextBuilder({ agentId: "ag_me" });
    expect(builder(makeMessage())).toBeUndefined();
  });

  it("returns undefined when working memory is empty and the activity digest is empty", () => {
    const tracker = new ActivityTracker({
      filePath: path.join(tmpDir, "activity.json"),
    });
    const builder = createDaemonSystemContextBuilder({
      agentId: "ag_me",
      activityTracker: tracker,
    });
    expect(builder(makeMessage({ conversation: { id: "rm_x", kind: "group" } }))).toBeUndefined();
  });

  it("injects the working-memory block when goal / sections are set", () => {
    updateWorkingMemory("ag_me", { goal: "ship feature" });
    updateWorkingMemory("ag_me", { section: "notes", content: "remember X" });

    const builder = createDaemonSystemContextBuilder({ agentId: "ag_me" });
    const out = builder(makeMessage());
    expect(typeof out).toBe("string");
    expect(out).toContain("[BotCord Working Memory]");
    expect(out).toContain("Goal: ship feature");
    expect(out).toContain("<section_notes>");
    expect(out).toContain("remember X");
  });

  it("emits the 'memory is currently empty' notice when the memory file exists but is blank", () => {
    clearWorkingMemory("ag_me");
    const builder = createDaemonSystemContextBuilder({ agentId: "ag_me" });
    const out = builder(makeMessage());
    expect(out).toContain("[BotCord Working Memory]");
    expect(out).toContain("Your working memory is currently empty.");
  });

  it("includes cross-room digest for OTHER rooms and excludes the current room", () => {
    const tracker = new ActivityTracker({
      filePath: path.join(tmpDir, "activity.json"),
    });
    tracker.record({
      agentId: "ag_me",
      roomId: "rm_other",
      roomName: "Other Room",
      topic: null,
      lastInboundPreview: "ping from elsewhere",
      lastSenderKind: "agent",
      lastSender: "ag_peer",
    });
    tracker.record({
      agentId: "ag_me",
      roomId: "rm_current",
      roomName: "Current",
      topic: null,
      lastInboundPreview: "hi in current",
      lastSenderKind: "agent",
      lastSender: "ag_here",
    });

    const builder = createDaemonSystemContextBuilder({
      agentId: "ag_me",
      activityTracker: tracker,
    });
    const out = builder(
      makeMessage({ conversation: { id: "rm_current", kind: "group" } }),
    );
    expect(out).toContain("[BotCord Cross-Room Awareness]");
    expect(out).toContain("Other Room (rm_other)");
    // Current room must be filtered out of the digest even though it has activity.
    expect(out).not.toContain("Current (rm_current)");
    expect(out).not.toContain("hi in current");
  });

  it("excludes the current (room, topic) tuple — activity on a different topic of the same room still shows", () => {
    const tracker = new ActivityTracker({
      filePath: path.join(tmpDir, "activity.json"),
    });
    tracker.record({
      agentId: "ag_me",
      roomId: "rm_shared",
      roomName: "Shared",
      topic: "tp_alpha",
      lastInboundPreview: "alpha ping",
      lastSenderKind: "agent",
      lastSender: "ag_peer",
    });
    tracker.record({
      agentId: "ag_me",
      roomId: "rm_shared",
      roomName: "Shared",
      topic: "tp_beta",
      lastInboundPreview: "beta ping",
      lastSenderKind: "agent",
      lastSender: "ag_peer",
    });

    const builder = createDaemonSystemContextBuilder({
      agentId: "ag_me",
      activityTracker: tracker,
    });
    const out = builder(
      makeMessage({
        conversation: { id: "rm_shared", kind: "group", threadId: "tp_alpha" },
      }),
    );
    // Different topic on same room is still digest-worthy.
    expect(out).toContain("beta ping");
    // Current (room, topic) is excluded.
    expect(out).not.toContain("alpha ping");
  });

  it("concatenates memory + digest blocks with a blank-line separator", () => {
    updateWorkingMemory("ag_me", { goal: "ship feature" });
    const tracker = new ActivityTracker({
      filePath: path.join(tmpDir, "activity.json"),
    });
    tracker.record({
      agentId: "ag_me",
      roomId: "rm_other",
      topic: null,
      lastInboundPreview: "ping",
      lastSenderKind: "agent",
      lastSender: "ag_peer",
    });

    const builder = createDaemonSystemContextBuilder({
      agentId: "ag_me",
      activityTracker: tracker,
    });
    const raw = builder(
      makeMessage({ conversation: { id: "rm_current", kind: "group" } }),
    );
    expect(typeof raw).toBe("string");
    const out = raw as string;
    expect(out).toContain("[BotCord Working Memory]");
    expect(out).toContain("[BotCord Cross-Room Awareness]");
    // Blocks joined with a single blank line in between (matches old builder).
    const memoryIdx = out.indexOf("[BotCord Working Memory]");
    const digestIdx = out.indexOf("[BotCord Cross-Room Awareness]");
    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    expect(digestIdx).toBeGreaterThan(memoryIdx);
    expect(out.slice(memoryIdx, digestIdx)).toMatch(/\n\n/);
  });

  it("injects the owner-chat scene block for rm_oc_ rooms", () => {
    const builder = createDaemonSystemContextBuilder({ agentId: "ag_me" });
    const out = builder(
      makeMessage({
        conversation: { id: "rm_oc_abc", kind: "direct" },
        sender: { id: "usr_1", name: "Susan", kind: "user" },
      }),
    );
    expect(typeof out).toBe("string");
    expect(out).toContain("[BotCord Scene: Owner Chat]");
    expect(out).toContain("full administrative authority");
  });

  it("injects the owner-chat scene for dashboard_user_chat regardless of room prefix", () => {
    const builder = createDaemonSystemContextBuilder({ agentId: "ag_me" });
    const out = builder(
      makeMessage({
        conversation: { id: "rm_plain", kind: "direct" },
        sender: { id: "usr_1", name: "Susan", kind: "user" },
        raw: { source_type: "dashboard_user_chat" },
      }),
    );
    expect(out).toContain("[BotCord Scene: Owner Chat]");
  });

  it("does NOT inject the owner scene for regular agent-to-agent rooms", () => {
    const builder = createDaemonSystemContextBuilder({ agentId: "ag_me" });
    const out = builder(
      makeMessage({
        conversation: { id: "rm_group", kind: "group" },
        sender: { id: "ag_peer", kind: "agent" },
      }),
    );
    expect(out).toBeUndefined();
  });

  it("translates GatewayInboundMessage.conversation.id → old `room_id` for the digest exclude key", () => {
    const tracker = new ActivityTracker({
      filePath: path.join(tmpDir, "activity.json"),
    });
    // Record activity ONLY for the current conversation so the digest is empty
    // if and only if the builder correctly pulls exclude from conversation.id.
    tracker.record({
      agentId: "ag_me",
      roomId: "rm_conv_id_123",
      topic: null,
      lastInboundPreview: "self",
      lastSenderKind: "agent",
      lastSender: "ag_peer",
    });
    const builder = createDaemonSystemContextBuilder({
      agentId: "ag_me",
      activityTracker: tracker,
    });
    const out = builder(
      makeMessage({ conversation: { id: "rm_conv_id_123", kind: "group" } }),
    );
    // Empty working memory + digest excluding the only entry → undefined.
    expect(out).toBeUndefined();
  });
});
