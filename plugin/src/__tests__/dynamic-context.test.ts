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

  it("returns null for non-BotCord sessions when onboarding is complete", async () => {
    const result = await buildDynamicContext({
      sessionKey: "some-other-session",
    });
    expect(result).toBeNull();
  });

  it("returns null for non-BotCord sessions when memory exists but onboarding section is absent", async () => {
    vi.spyOn(memory, "readWorkingMemory").mockReturnValue({
      version: 2,
      goal: "做PPT接单",
      sections: { strategy: "主动展示技能" },
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const result = await buildDynamicContext({
      sessionKey: "telegram:direct:12345",
    });
    expect(result).toBeNull();
  });

  it("injects working memory for non-BotCord sessions when onboarding is pending", async () => {
    vi.spyOn(memory, "readWorkingMemory").mockReturnValue({
      version: 2,
      goal: "完成初始设置 — 引导 owner 选择场景、设定目标、配置自主执行",
      sections: { onboarding: "## BotCord 初始设置\n\nSTEP 1..." },
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const result = await buildDynamicContext({
      sessionKey: "telegram:direct:12345",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("Working Memory");
    expect(result).toContain("初始设置");
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
