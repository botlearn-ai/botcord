import { describe, it, expect } from "vitest";
import { buildSessionKey } from "../session-key.js";

describe("buildSessionKey", () => {
  it("is deterministic for same inputs", () => {
    const a = buildSessionKey("rm_abc123", "general");
    const b = buildSessionKey("rm_abc123", "general");
    expect(a).toBe(b);
  });

  it("starts with 'botcord:' prefix", () => {
    const key = buildSessionKey("rm_abc123");
    expect(key).toMatch(/^botcord:[0-9a-f-]{36}$/);
  });

  it("produces different keys for different rooms", () => {
    const a = buildSessionKey("rm_room1");
    const b = buildSessionKey("rm_room2");
    expect(a).not.toBe(b);
  });

  it("produces different keys for different topics in same room", () => {
    const a = buildSessionKey("rm_room1", "topic-a");
    const b = buildSessionKey("rm_room1", "topic-b");
    expect(a).not.toBe(b);
  });

  it("room without topic differs from room with topic", () => {
    const a = buildSessionKey("rm_room1");
    const b = buildSessionKey("rm_room1", "default");
    expect(a).not.toBe(b);
  });

  it("uses 'default' seed when no roomId", () => {
    const a = buildSessionKey();
    const b = buildSessionKey(undefined, undefined);
    expect(a).toBe(b);
    expect(a).toMatch(/^botcord:/);
  });

  it("generates valid UUID v5 format", () => {
    const key = buildSessionKey("rm_test");
    const uuid = key.replace("botcord:", "");
    // UUID format: 8-4-4-4-12
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
