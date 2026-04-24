import { afterEach, describe, expect, it } from "vitest";
import {
  buildLoopRiskPrompt,
  clearLoopRiskSession,
  evaluateLoopRisk,
  loopRiskSessionKey,
  recordInboundText,
  recordOutboundText,
  resetLoopRiskStateForTests,
  stripBotCordPromptScaffolding,
} from "../loop-risk.js";

afterEach(() => {
  resetLoopRiskStateForTests();
});

describe("stripBotCordPromptScaffolding", () => {
  it("removes headers, hints, and wrapper tags but keeps the actual body", () => {
    const wrapped = [
      "[BotCord Message] | from: ag_alice | to: ag_me | room: Team",
      '<agent-message sender="ag_alice" sender_kind="agent">',
      "hello world",
      "</agent-message>",
      "",
      '[In group chats, do NOT reply unless you are explicitly mentioned or addressed. If no response is needed, reply with exactly "NO_REPLY" and nothing else.]',
    ].join("\n");
    expect(stripBotCordPromptScaffolding(wrapped)).toBe("hello world");
  });

  it("leaves plain text untouched", () => {
    expect(stripBotCordPromptScaffolding("just a line")).toBe("just a line");
  });
});

describe("evaluateLoopRisk", () => {
  const key = "ag_me:rm_team:";

  it("returns no reasons for an unknown session", () => {
    expect(evaluateLoopRisk({ sessionKey: "unknown" })).toEqual({ reasons: [] });
  });

  it("flags short_ack_tail when the last two inbound messages are both acks", () => {
    const now = 1_700_000_000_000;
    recordInboundText({ sessionKey: key, text: "Let's ship it", timestamp: now - 3000 });
    recordInboundText({ sessionKey: key, text: "Thanks!", timestamp: now - 2000 });
    recordInboundText({ sessionKey: key, text: "好的", timestamp: now - 1000 });
    const out = evaluateLoopRisk({ sessionKey: key, now });
    expect(out.reasons.some((r) => r.id === "short_ack_tail")).toBe(true);
  });

  it("does NOT flag short_ack_tail when only one message is an ack", () => {
    const now = 1_700_000_000_000;
    recordInboundText({ sessionKey: key, text: "Can you help with X?", timestamp: now - 2000 });
    recordInboundText({ sessionKey: key, text: "OK", timestamp: now - 1000 });
    const out = evaluateLoopRisk({ sessionKey: key, now });
    expect(out.reasons.some((r) => r.id === "short_ack_tail")).toBe(false);
  });

  it("flags repeated_outbound when the last outbound reply matches the previous one exactly", () => {
    const now = 1_700_000_000_000;
    recordOutboundText({ sessionKey: key, text: "Got it, thanks!", timestamp: now - 2000 });
    recordOutboundText({ sessionKey: key, text: "Got it, thanks!", timestamp: now - 1000 });
    const out = evaluateLoopRisk({ sessionKey: key, now });
    expect(out.reasons.some((r) => r.id === "repeated_outbound")).toBe(true);
  });

  it("flags repeated_outbound on high trigram similarity (>= 0.88)", () => {
    const now = 1_700_000_000_000;
    const a = "Sounds good, I'll take care of that shortly.";
    const b = "Sounds good, I'll take care of that shortly!";
    const c = "Sounds good, I'll take care of that shortly :)";
    recordOutboundText({ sessionKey: key, text: a, timestamp: now - 3000 });
    recordOutboundText({ sessionKey: key, text: b, timestamp: now - 2000 });
    recordOutboundText({ sessionKey: key, text: c, timestamp: now - 1000 });
    const out = evaluateLoopRisk({ sessionKey: key, now });
    expect(out.reasons.some((r) => r.id === "repeated_outbound")).toBe(true);
  });

  it("flags high_turn_rate on rapid user↔assistant alternation", () => {
    const now = 1_700_000_000_000;
    // 8 turns over the last 60s, tightly alternating.
    const base = now - 60_000;
    for (let i = 0; i < 4; i++) {
      recordInboundText({
        sessionKey: key,
        text: `inbound ${i}`,
        timestamp: base + i * 14_000,
      });
      recordOutboundText({
        sessionKey: key,
        text: `outbound ${i}`,
        timestamp: base + i * 14_000 + 7_000,
      });
    }
    const out = evaluateLoopRisk({ sessionKey: key, now });
    expect(out.reasons.some((r) => r.id === "high_turn_rate")).toBe(true);
  });

  it("does NOT flag high_turn_rate when the turns are spread out beyond the 2-minute window", () => {
    const now = 1_700_000_000_000;
    const base = now - 5 * 60_000;
    for (let i = 0; i < 4; i++) {
      recordInboundText({
        sessionKey: key,
        text: `in ${i}`,
        timestamp: base + i * 30_000,
      });
      recordOutboundText({
        sessionKey: key,
        text: `out ${i}`,
        timestamp: base + i * 30_000 + 1000,
      });
    }
    const out = evaluateLoopRisk({ sessionKey: key, now });
    expect(out.reasons.some((r) => r.id === "high_turn_rate")).toBe(false);
  });

  it("prunes samples older than the 10-minute max age", () => {
    const now = 1_700_000_000_000;
    recordOutboundText({ sessionKey: key, text: "ancient", timestamp: now - 20 * 60_000 });
    recordOutboundText({ sessionKey: key, text: "ancient", timestamp: now - 15 * 60_000 });
    // Same text immediately before now would trigger repeated_outbound if the
    // old samples survived; they should be pruned, so no flag fires.
    recordOutboundText({ sessionKey: key, text: "ancient", timestamp: now });
    const out = evaluateLoopRisk({ sessionKey: key, now });
    expect(out.reasons.some((r) => r.id === "repeated_outbound")).toBe(false);
  });

  it("clearLoopRiskSession drops all state for the given key", () => {
    const now = 1_700_000_000_000;
    recordOutboundText({ sessionKey: key, text: "same", timestamp: now - 1000 });
    recordOutboundText({ sessionKey: key, text: "same", timestamp: now });
    clearLoopRiskSession(key);
    expect(evaluateLoopRisk({ sessionKey: key, now }).reasons).toEqual([]);
  });
});

describe("buildLoopRiskPrompt", () => {
  const key = "ag_me:rm_x:";

  it("returns null when no risk is detected", () => {
    expect(buildLoopRiskPrompt({ sessionKey: key })).toBeNull();
  });

  it("renders the full prompt block when a risk fires", () => {
    const now = 1_700_000_000_000;
    recordOutboundText({ sessionKey: key, text: "same outbound", timestamp: now - 1000 });
    recordOutboundText({ sessionKey: key, text: "same outbound", timestamp: now });
    const out = buildLoopRiskPrompt({ sessionKey: key, now });
    expect(out).toContain("[BotCord loop-risk check]");
    expect(out).toContain("Observed signals:");
    expect(out).toContain("recent outbound texts in this session are highly similar");
    expect(out).toContain('reply with exactly "NO_REPLY"');
  });
});

describe("loopRiskSessionKey", () => {
  it("includes threadId when present", () => {
    expect(
      loopRiskSessionKey({ accountId: "ag_me", conversationId: "rm_1", threadId: "tp_a" }),
    ).toBe("ag_me:rm_1:tp_a");
  });

  it("uses empty string for threadId when null/undefined", () => {
    expect(loopRiskSessionKey({ accountId: "ag_me", conversationId: "rm_1" })).toBe(
      "ag_me:rm_1:",
    );
    expect(
      loopRiskSessionKey({ accountId: "ag_me", conversationId: "rm_1", threadId: null }),
    ).toBe("ag_me:rm_1:");
  });
});
