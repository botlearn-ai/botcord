import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TopicTracker } from "../topic-tracker.js";

describe("TopicTracker", () => {
  let tracker: TopicTracker;

  beforeEach(() => {
    tracker = new TopicTracker();
  });

  // ── No topic ────────────────────────────────────────────────────

  it("returns shouldReply: false when no topic is provided", () => {
    const result = tracker.handleIncoming({ type: "message" });
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toContain("no topic");
  });

  it("returns shouldReply: false when topic is null", () => {
    const result = tracker.handleIncoming({ topic: null, type: "message" });
    expect(result.shouldReply).toBe(false);
  });

  it("returns shouldReply: false when topic is empty string", () => {
    const result = tracker.handleIncoming({ topic: "", type: "message" });
    expect(result.shouldReply).toBe(false);
  });

  // ── New topic ───────────────────────────────────────────────────

  it("creates a new topic as open and returns shouldReply: true", () => {
    const result = tracker.handleIncoming({
      topic: "translate-readme",
      goal: "Translate README to Chinese",
      type: "message",
    });
    expect(result.shouldReply).toBe(true);
    expect(result.reason).toContain("new topic");
    expect(tracker.getState("translate-readme")).toBe("open");
  });

  it("creates a new topic without goal and returns shouldReply: true", () => {
    const result = tracker.handleIncoming({
      topic: "chat",
      type: "message",
    });
    expect(result.shouldReply).toBe(true);
    expect(tracker.getState("chat")).toBe("open");
  });

  // ── Open topic, normal message ──────────────────────────────────

  it("returns shouldReply: true for message on open topic", () => {
    tracker.handleIncoming({ topic: "task-1", goal: "Do X", type: "message" });

    const result = tracker.handleIncoming({ topic: "task-1", type: "message" });
    expect(result.shouldReply).toBe(true);
    expect(result.reason).toContain("open");
  });

  // ── Receiving type: result → marks completed ────────────────────

  it("marks topic as completed on type: result and returns shouldReply: false", () => {
    tracker.handleIncoming({ topic: "task-1", goal: "Do X", type: "message" });

    const result = tracker.handleIncoming({ topic: "task-1", type: "result" });
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toContain("completed");
    expect(tracker.getState("task-1")).toBe("completed");
  });

  // ── Receiving type: error → marks failed ────────────────────────

  it("marks topic as failed on type: error and returns shouldReply: false", () => {
    tracker.handleIncoming({ topic: "task-1", goal: "Do X", type: "message" });

    const result = tracker.handleIncoming({ topic: "task-1", type: "error" });
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toContain("failed");
    expect(tracker.getState("task-1")).toBe("failed");
  });

  // ── After completed, message without goal → shouldReply: false ──

  it("does not auto-reply to completed topic without new goal", () => {
    tracker.handleIncoming({ topic: "task-1", goal: "Do X", type: "message" });
    tracker.handleIncoming({ topic: "task-1", type: "result" });

    const result = tracker.handleIncoming({ topic: "task-1", type: "message" });
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toContain("completed");
  });

  // ── After completed, message with new goal → reactivates ────────

  it("reactivates completed topic with new goal", () => {
    tracker.handleIncoming({ topic: "task-1", goal: "Do X", type: "message" });
    tracker.handleIncoming({ topic: "task-1", type: "result" });

    const result = tracker.handleIncoming({
      topic: "task-1",
      goal: "Do Y instead",
      type: "message",
    });
    expect(result.shouldReply).toBe(true);
    expect(result.reason).toContain("reactivated");
    expect(tracker.getState("task-1")).toBe("open");
  });

  // ── After failed, message with new goal → reactivates ───────────

  it("reactivates failed topic with new goal", () => {
    tracker.handleIncoming({ topic: "task-2", goal: "Do Z", type: "message" });
    tracker.handleIncoming({ topic: "task-2", type: "error" });
    expect(tracker.getState("task-2")).toBe("failed");

    const result = tracker.handleIncoming({
      topic: "task-2",
      goal: "Try again with new approach",
      type: "message",
    });
    expect(result.shouldReply).toBe(true);
    expect(tracker.getState("task-2")).toBe("open");
  });

  // ── TTL expiration ──────────────────────────────────────────────

  it("expires an open topic when TTL is exceeded", () => {
    const shortTtl = new TopicTracker({ defaultTtlMs: 100 });
    shortTtl.handleIncoming({ topic: "ephemeral", goal: "Quick task", type: "message" });

    // Simulate time passing by manipulating the topic's lastActivityAt
    const info = shortTtl.getTopicInfo("ephemeral");
    expect(info).toBeDefined();
    expect(info!.state).toBe("open");

    // Use vi.spyOn to mock Date.now
    const originalNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(originalNow + 200);

    expect(shortTtl.getState("ephemeral")).toBe("expired");

    vi.restoreAllMocks();
  });

  it("expired topic does not auto-reply without goal", () => {
    const shortTtl = new TopicTracker({ defaultTtlMs: 100 });
    shortTtl.handleIncoming({ topic: "old", goal: "Something", type: "message" });

    const originalNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(originalNow + 200);

    const result = shortTtl.handleIncoming({ topic: "old", type: "message" });
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toContain("expired");

    vi.restoreAllMocks();
  });

  it("expired topic reactivates with new goal", () => {
    const shortTtl = new TopicTracker({ defaultTtlMs: 100 });
    shortTtl.handleIncoming({ topic: "old", goal: "Something", type: "message" });

    const originalNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(originalNow + 200);

    const result = shortTtl.handleIncoming({
      topic: "old",
      goal: "New goal",
      type: "message",
    });
    expect(result.shouldReply).toBe(true);
    expect(result.reason).toContain("reactivated");

    vi.restoreAllMocks();
  });

  // ── sweepExpired ────────────────────────────────────────────────

  it("sweepExpired removes expired topics and returns count", () => {
    const shortTtl = new TopicTracker({ defaultTtlMs: 50 });
    shortTtl.handleIncoming({ topic: "a", goal: "A", type: "message" });
    shortTtl.handleIncoming({ topic: "b", goal: "B", type: "message" });

    const originalNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(originalNow + 100);

    const count = shortTtl.sweepExpired();
    expect(count).toBe(2);
    expect(shortTtl.size).toBe(0);
    expect(shortTtl.getState("a")).toBeUndefined();
    expect(shortTtl.getState("b")).toBeUndefined();

    vi.restoreAllMocks();
  });

  it("sweepExpired does not remove open or completed topics", () => {
    tracker.handleIncoming({ topic: "active", goal: "Active", type: "message" });
    tracker.handleIncoming({ topic: "done", goal: "Done", type: "message" });
    tracker.handleIncoming({ topic: "done", type: "result" });

    const count = tracker.sweepExpired();
    expect(count).toBe(0);
    expect(tracker.size).toBe(2);
  });

  // ── markCompleted / markFailed ──────────────────────────────────

  it("markCompleted sets topic to completed", () => {
    tracker.handleIncoming({ topic: "t", goal: "G", type: "message" });
    tracker.markCompleted("t");
    expect(tracker.getState("t")).toBe("completed");
  });

  it("markFailed sets topic to failed", () => {
    tracker.handleIncoming({ topic: "t", goal: "G", type: "message" });
    tracker.markFailed("t");
    expect(tracker.getState("t")).toBe("failed");
  });

  it("markCompleted is a no-op for unknown topic", () => {
    tracker.markCompleted("unknown");
    expect(tracker.getState("unknown")).toBeUndefined();
  });

  // ── type: result/error on unseen topic ──────────────────────────

  it("creates topic as completed when first message is type: result", () => {
    const result = tracker.handleIncoming({ topic: "new", type: "result" });
    expect(result.shouldReply).toBe(false);
    expect(tracker.getState("new")).toBe("completed");
  });

  it("creates topic as failed when first message is type: error", () => {
    const result = tracker.handleIncoming({ topic: "new", type: "error" });
    expect(result.shouldReply).toBe(false);
    expect(tracker.getState("new")).toBe("failed");
  });

  // ── Goal tracking ──────────────────────────────────────────────

  it("stores goal from initial message", () => {
    tracker.handleIncoming({ topic: "t", goal: "Translate docs", type: "message" });
    const info = tracker.getTopicInfo("t");
    expect(info?.goal).toBe("Translate docs");
  });

  it("updates goal when reactivating", () => {
    tracker.handleIncoming({ topic: "t", goal: "Goal 1", type: "message" });
    tracker.handleIncoming({ topic: "t", type: "result" });
    tracker.handleIncoming({ topic: "t", goal: "Goal 2", type: "message" });
    const info = tracker.getTopicInfo("t");
    expect(info?.goal).toBe("Goal 2");
    expect(info?.state).toBe("open");
  });

  // ── Default TTL ────────────────────────────────────────────────

  it("uses default TTL of 1 hour", () => {
    tracker.handleIncoming({ topic: "t", type: "message" });
    const info = tracker.getTopicInfo("t");
    expect(info?.ttlMs).toBe(3_600_000);
  });

  it("uses custom TTL from constructor", () => {
    const custom = new TopicTracker({ defaultTtlMs: 5000 });
    custom.handleIncoming({ topic: "t", type: "message" });
    const info = custom.getTopicInfo("t");
    expect(info?.ttlMs).toBe(5000);
  });
});
