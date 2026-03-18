import { beforeEach, describe, expect, it } from "vitest";
import {
  buildBotCordLoopRiskPrompt,
  didBotCordSendSucceed,
  evaluateBotCordLoopRisk,
  recordBotCordOutboundText,
  resetBotCordLoopRiskStateForTests,
  shouldRunBotCordLoopRiskCheck,
} from "../loop-risk.js";

function botcordPrompt(body: string): string {
  return [
    "[BotCord Message] | from: ag_peer | to: default",
    body,
    '[If the conversation has naturally concluded or no response is needed, reply with exactly "NO_REPLY" and nothing else.]',
  ].join("\n");
}

describe("BotCord loop risk detection", () => {
  beforeEach(() => {
    resetBotCordLoopRiskStateForTests();
  });

  it("runs only for botcord turns", () => {
    expect(shouldRunBotCordLoopRiskCheck({
      channelId: "botcord",
      prompt: "hello",
      trigger: "user",
    })).toBe(true);

    expect(shouldRunBotCordLoopRiskCheck({
      channelId: "discord",
      prompt: botcordPrompt("hello"),
      trigger: "user",
    })).toBe(true);

    expect(shouldRunBotCordLoopRiskCheck({
      channelId: "discord",
      prompt: "hello",
      trigger: "user",
    })).toBe(false);
  });

  it("detects high-turn-rate, ack tail, and repeated outbound sends without another LLM call", () => {
    const sessionKey = "agent:main:botcord:direct:ag_peer";
    const now = 1_700_000_000_000;

    recordBotCordOutboundText({
      sessionKey,
      text: "Thanks. Let me know if anything else comes up.",
      timestamp: now - 100_000,
    });
    recordBotCordOutboundText({
      sessionKey,
      text: "Thanks. Let me know if anything else comes up.",
      timestamp: now - 70_000,
    });
    recordBotCordOutboundText({
      sessionKey,
      text: "Thanks. Let me know if anything else comes up.",
      timestamp: now - 40_000,
    });
    recordBotCordOutboundText({
      sessionKey,
      text: "Thanks. Let me know if anything else comes up.",
      timestamp: now - 10_000,
    });

    const messages = [
      { role: "user", content: botcordPrompt("hello"), timestamp: now - 110_000 },
      { role: "user", content: botcordPrompt("understood"), timestamp: now - 80_000 },
      { role: "user", content: botcordPrompt("收到"), timestamp: now - 50_000 },
      { role: "user", content: botcordPrompt("好的"), timestamp: now - 20_000 },
    ];

    const evaluation = evaluateBotCordLoopRisk({
      prompt: botcordPrompt("谢谢"),
      messages,
      sessionKey,
      now,
    });

    expect(evaluation.reasons.map((reason) => reason.id)).toEqual([
      "high_turn_rate",
      "short_ack_tail",
      "repeated_outbound",
    ]);

    const prompt = buildBotCordLoopRiskPrompt({
      prompt: botcordPrompt("谢谢"),
      messages,
      sessionKey,
      now,
    });

    expect(prompt).toContain("[BotCord loop-risk check]");
    expect(prompt).toContain("same session shows");
    expect(prompt).toContain("last two inbound user messages");
    expect(prompt).toContain("recent botcord_send texts");
    expect(prompt).toContain('"NO_REPLY"');
  });

  it("stays quiet for normal substantive turns", () => {
    const sessionKey = "agent:main:botcord:direct:ag_peer";
    const now = 1_700_000_000_000;

    recordBotCordOutboundText({
      sessionKey,
      text: "I checked the issue and the config mismatch is on line 14.",
      timestamp: now - 90_000,
    });

    const prompt = buildBotCordLoopRiskPrompt({
      prompt: botcordPrompt("Can you show me which file is wrong?"),
      messages: [
        {
          role: "user",
          content: botcordPrompt("The deployment failed after I changed the env vars."),
          timestamp: now - 100_000,
        },
      ],
      sessionKey,
      now,
    });

    expect(prompt).toBeUndefined();
  });

  it("tracks successful botcord_send calls only", () => {
    expect(didBotCordSendSucceed({ ok: true })).toBe(true);
    expect(didBotCordSendSucceed({ error: "send failed" })).toBe(false);
    expect(didBotCordSendSucceed(undefined, "transport error")).toBe(false);
  });
});
