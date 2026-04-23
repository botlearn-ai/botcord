import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityTracker } from "../activity-tracker.js";

let tmpDir = "";
let filePath = "";

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "daemon-act-"));
  filePath = path.join(tmpDir, "activity.json");
});
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("ActivityTracker", () => {
  it("records + reads by (agent, room, topic)", () => {
    const t = new ActivityTracker({ filePath });
    t.record({
      agentId: "ag_a",
      roomId: "rm_1",
      topic: "tp_plan",
      lastInboundPreview: "hi there",
      lastSenderKind: "agent",
      lastSender: "ag_peer",
    });
    const got = t.get("ag_a", "rm_1", "tp_plan");
    expect(got?.lastSender).toBe("ag_peer");
    expect(got?.lastActivityAt).toBeGreaterThan(Date.now() - 1000);
    // Different topic → distinct entry
    expect(t.get("ag_a", "rm_1", null)).toBeNull();
  });

  it("caps preview length at ACTIVITY_PREVIEW_CHARS", () => {
    const t = new ActivityTracker({ filePath });
    t.record({
      agentId: "ag_a",
      roomId: "rm_1",
      topic: null,
      lastInboundPreview: "x".repeat(500),
      lastSenderKind: "agent",
      lastSender: "ag_peer",
    });
    const got = t.get("ag_a", "rm_1", null);
    expect(got?.lastInboundPreview.length).toBe(120);
  });

  it("listActive filters by agent + window, excludes current key, sorts newest first", () => {
    const t = new ActivityTracker({ filePath });
    const now = Date.now();
    t.record({
      agentId: "ag_a",
      roomId: "rm_old",
      topic: null,
      lastInboundPreview: "old",
      lastSenderKind: "agent",
      lastSender: "p",
      lastActivityAt: now - 3 * 60 * 60 * 1000, // 3h ago
    });
    t.record({
      agentId: "ag_a",
      roomId: "rm_new",
      topic: null,
      lastInboundPreview: "new",
      lastSenderKind: "agent",
      lastSender: "p",
      lastActivityAt: now - 10 * 60 * 1000, // 10m ago
    });
    t.record({
      agentId: "ag_a",
      roomId: "rm_cur",
      topic: null,
      lastInboundPreview: "cur",
      lastSenderKind: "agent",
      lastSender: "p",
      lastActivityAt: now - 1 * 60 * 1000,
    });
    // Different agent entry — must be ignored.
    t.record({
      agentId: "ag_b",
      roomId: "rm_other",
      topic: null,
      lastInboundPreview: "nope",
      lastSenderKind: "agent",
      lastSender: "p",
    });

    const list = t.listActive({
      agentId: "ag_a",
      windowMs: 2 * 60 * 60 * 1000,
      excludeKey: t.keyFor("ag_a", "rm_cur", null),
    });
    expect(list.map((e) => e.roomId)).toEqual(["rm_new"]);
  });

  it("flushes atomically to disk", () => {
    const t = new ActivityTracker({ filePath });
    t.record({
      agentId: "ag_a",
      roomId: "rm_1",
      topic: null,
      lastInboundPreview: "hi",
      lastSenderKind: "agent",
      lastSender: "p",
    });
    t.flushSync();
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.version).toBe(1);
    const entry = Object.values(raw.entries)[0] as Record<string, unknown>;
    expect(entry.roomId).toBe("rm_1");
  });

  it("survives reopen — previous records reload from disk", () => {
    const t1 = new ActivityTracker({ filePath });
    t1.record({
      agentId: "ag_a",
      roomId: "rm_1",
      topic: null,
      lastInboundPreview: "x",
      lastSenderKind: "agent",
      lastSender: "p",
    });
    t1.flushSync();

    const t2 = new ActivityTracker({ filePath });
    expect(t2.get("ag_a", "rm_1", null)?.lastSender).toBe("p");
  });
});
