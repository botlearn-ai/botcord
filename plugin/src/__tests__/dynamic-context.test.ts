import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildDynamicContext } from "../dynamic-context.js";
import * as roomContext from "../room-context.js";
import * as memory from "../memory.js";
import * as loopRisk from "../loop-risk.js";

// Mock dependencies
vi.mock("../runtime.js", () => ({
  getBotCordRuntime: () => ({ subagent: { getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }) } }),
  getConfig: () => ({}),
}));

vi.mock("../config.js", () => ({
  resolveAccountConfig: () => null,
  resolveChannelConfig: () => null,
  resolveAccounts: () => [],
  isAccountConfigured: () => false,
}));

vi.mock("../credentials.js", () => ({
  attachTokenPersistence: vi.fn(),
}));

describe("buildDynamicContext", () => {
  const sessionKey = "botcord:test:session";

  beforeEach(() => {
    roomContext.registerSessionRoom(sessionKey, {
      roomId: "rm_test",
      roomName: "Test Room",
      accountId: "ag_test",
      lastActivityAt: Date.now(),
    });
  });

  afterEach(() => {
    roomContext.clearSessionRoom(sessionKey);
    vi.restoreAllMocks();
  });

  it("returns null for non-BotCord sessions", async () => {
    const result = await buildDynamicContext({
      sessionKey: "some-other-session",
    });
    expect(result).toBeNull();
  });

  it("returns context with working memory for BotCord sessions", async () => {
    vi.spyOn(memory, "readWorkingMemory").mockReturnValue({
      version: 2,
      sections: { notes: "test memory" },
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const result = await buildDynamicContext({ sessionKey });

    expect(result).not.toBeNull();
    expect(result).toContain("Working Memory");
    expect(result).toContain("test memory");
  });

  it("includes loop-risk prompt when triggered", async () => {
    vi.spyOn(memory, "readWorkingMemory").mockReturnValue(null);
    vi.spyOn(loopRisk, "shouldRunBotCordLoopRiskCheck").mockReturnValue(true);
    vi.spyOn(loopRisk, "buildBotCordLoopRiskPrompt").mockReturnValue("[BotCord loop-risk check]\ntest warning");

    const result = await buildDynamicContext({
      sessionKey,
      prompt: "hello",
      messages: [],
    });

    expect(result).toContain("loop-risk check");
  });

  it("works for owner-chat session", async () => {
    vi.spyOn(memory, "readWorkingMemory").mockReturnValue({
      version: 2,
      sections: { notes: "owner memory" },
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const result = await buildDynamicContext({
      sessionKey: "botcord:owner:main",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("owner memory");
  });

  it("passes channelId and trigger to loop-risk check", async () => {
    vi.spyOn(memory, "readWorkingMemory").mockReturnValue(null);
    const spy = vi.spyOn(loopRisk, "shouldRunBotCordLoopRiskCheck").mockReturnValue(false);

    await buildDynamicContext({
      sessionKey,
      channelId: "botcord",
      prompt: "test",
      trigger: "user",
    });

    expect(spy).toHaveBeenCalledWith({
      channelId: "botcord",
      prompt: "test",
      trigger: "user",
    });
  });

  it("gracefully handles working memory read failure", async () => {
    vi.spyOn(memory, "readWorkingMemory").mockImplementation(() => {
      throw new Error("disk error");
    });

    // Should not throw, should return null or partial context
    const result = await buildDynamicContext({ sessionKey });
    // Even on error, should not throw
    expect(result).toBeDefined();
  });

  it("returns context as string suitable for appendSystemContext", async () => {
    vi.spyOn(memory, "readWorkingMemory").mockReturnValue({
      content: "important fact",
      updatedAt: "2026-01-01T00:00:00Z",
      version: 1,
    });

    const result = await buildDynamicContext({ sessionKey });

    // Result is a plain string (not an object) — ready for appendSystemContext
    expect(typeof result).toBe("string");
  });
});
