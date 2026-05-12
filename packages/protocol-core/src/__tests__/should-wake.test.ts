import { describe, expect, it } from "vitest";
import { shouldWake, type AttentionPolicy } from "../should-wake.js";

const NOW = 1_700_000_000_000;

function policy(overrides: Partial<AttentionPolicy> = {}): AttentionPolicy {
  return { mode: "always", keywords: [], ...overrides };
}

describe("shouldWake", () => {
  it("mode=always always wakes", () => {
    expect(shouldWake(policy(), { text: "hi" }, NOW)).toBe(true);
    expect(shouldWake(policy(), { text: "" }, NOW)).toBe(true);
  });

  it("mode=muted never wakes even when text mentions agent", () => {
    expect(
      shouldWake(policy({ mode: "muted" }), { text: "@me hi", mentioned: true }, NOW),
    ).toBe(false);
  });

  it("muted_until in the future suppresses wake regardless of mode", () => {
    expect(
      shouldWake(
        policy({ mode: "always", muted_until: NOW + 60_000 }),
        { text: "anything" },
        NOW,
      ),
    ).toBe(false);
  });

  it("muted_until in the past does not suppress", () => {
    expect(
      shouldWake(
        policy({ mode: "always", muted_until: NOW - 1 }),
        { text: "anything" },
        NOW,
      ),
    ).toBe(true);
  });

  it("mode=mention_only requires msg.mentioned === true", () => {
    expect(
      shouldWake(policy({ mode: "mention_only" }), { text: "hi", mentioned: false }, NOW),
    ).toBe(false);
    expect(
      shouldWake(policy({ mode: "mention_only" }), { text: "hi", mentioned: true }, NOW),
    ).toBe(true);
    expect(
      shouldWake(policy({ mode: "mention_only" }), { text: "hi" }, NOW),
    ).toBe(false);
  });

  it("mode=keyword matches case-insensitive substring", () => {
    const p = policy({ mode: "keyword", keywords: ["Foo", "BAR"] });
    expect(shouldWake(p, { text: "hello foo world" }, NOW)).toBe(true);
    expect(shouldWake(p, { text: "BAR" }, NOW)).toBe(true);
    expect(shouldWake(p, { text: "nothing here" }, NOW)).toBe(false);
    expect(shouldWake(p, {}, NOW)).toBe(false);
  });

  it("mode=keyword with empty list never wakes", () => {
    expect(
      shouldWake(policy({ mode: "keyword", keywords: [] }), { text: "anything" }, NOW),
    ).toBe(false);
  });

  it("mode=allowed_senders only wakes for listed sender ids", () => {
    const p = policy({ mode: "allowed_senders", allowedSenderIds: ["ag_alice", "hu_bob"] });
    expect(shouldWake(p, { senderId: "ag_alice", text: "hi" }, NOW)).toBe(true);
    expect(shouldWake(p, { senderId: "hu_bob", text: "hi" }, NOW)).toBe(true);
    expect(shouldWake(p, { senderId: "ag_carol", text: "hi" }, NOW)).toBe(false);
    expect(shouldWake(p, { text: "hi" }, NOW)).toBe(false);
  });

  it("unknown mode fails open (forward-compat)", () => {
    const future = { mode: "future_mode", keywords: [] } as unknown as AttentionPolicy;
    expect(shouldWake(future, { text: "hi" }, NOW)).toBe(true);
  });
});
