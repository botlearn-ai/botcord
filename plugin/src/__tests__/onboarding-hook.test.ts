import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildOnboardingHookResult } from "../onboarding-hook.js";

// Mock runtime and config
vi.mock("../runtime.js", () => ({
  getConfig: vi.fn(() => ({ channels: { botcord: { enabled: true } } })),
}));

const mockIsAccountConfigured = vi.fn(() => true);
vi.mock("../config.js", () => ({
  resolveAccountConfig: vi.fn(() => ({
    credentialsFile: "/fake/creds.json",
    docsBaseUrl: "https://botcord.chat",
  })),
  isAccountConfigured: (...args: any[]) => mockIsAccountConfigured(...args),
}));

const mockIsOnboarded = vi.fn(() => false);
vi.mock("../credentials.js", () => ({
  isOnboarded: (...args: any[]) => mockIsOnboarded(...args),
}));

describe("buildOnboardingHookResult", () => {
  beforeEach(() => {
    mockIsOnboarded.mockReset().mockReturnValue(false);
    mockIsAccountConfigured.mockReset().mockReturnValue(true);
  });

  it("injects onboarding for unonboarded normal owner chat", () => {
    const result = buildOnboardingHookResult();
    expect(result).not.toBeNull();
    expect(result?.prependContext).toContain("BotCord Onboarding");
  });

  it("returns null when already onboarded", () => {
    mockIsOnboarded.mockReturnValue(true);
    const result = buildOnboardingHookResult();
    expect(result).toBeNull();
  });

  it("skips onboarding for the exact proactive cron payload", () => {
    const result = buildOnboardingHookResult({
      prompt: "【BotCord 自主任务】执行本轮工作目标。",
    });
    expect(result).toBeNull();
  });

  it("skips onboarding when last message contains proactive trigger", () => {
    const result = buildOnboardingHookResult({
      messages: [
        { content: "hello" },
        { content: "【BotCord 自主任务】执行本轮工作目标。" },
      ],
    });
    expect(result).toBeNull();
  });

  it("does not skip for unrelated text", () => {
    const result = buildOnboardingHookResult({
      prompt: "帮我检查一下消息",
    });
    expect(result).not.toBeNull();
    expect(result?.prependContext).toContain("BotCord Onboarding");
  });

  it("does not skip for partial trigger match without full phrase", () => {
    const result = buildOnboardingHookResult({
      prompt: "什么是自主任务？",
    });
    expect(result).not.toBeNull();
  });
});
