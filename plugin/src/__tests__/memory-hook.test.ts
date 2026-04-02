import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildWorkingMemoryHookResult } from "../memory-hook.js";
import {
  registerSessionRoom,
  getAllSessionRooms,
} from "../room-context.js";

// Mock runtime and config
vi.mock("../runtime.js", () => ({
  getBotCordRuntime: vi.fn(() => ({})),
  getConfig: vi.fn(() => null),
}));

vi.mock("../config.js", () => ({
  resolveAccountConfig: vi.fn(() => ({})),
  resolveChannelConfig: vi.fn(() => ({})),
  resolveAccounts: vi.fn(() => ({})),
  isAccountConfigured: vi.fn(() => false),
}));

vi.mock("../credentials.js", () => ({
  attachTokenPersistence: vi.fn(),
}));

// Mock memory read/write to avoid filesystem in unit tests
const mockReadWorkingMemory = vi.fn().mockReturnValue(null);
vi.mock("../memory.js", () => ({
  readWorkingMemory: (...args: any[]) => mockReadWorkingMemory(...args),
}));

describe("memory-hook", () => {
  beforeEach(() => {
    const map = getAllSessionRooms() as Map<string, any>;
    map.clear();
    mockReadWorkingMemory.mockReset().mockReturnValue(null);
  });

  // ── buildWorkingMemoryHookResult ─────────────────────────────────

  describe("buildWorkingMemoryHookResult", () => {
    it("returns null for undefined session key", async () => {
      expect(await buildWorkingMemoryHookResult(undefined)).toBeNull();
    });

    it("returns null for unregistered sessions", async () => {
      expect(await buildWorkingMemoryHookResult("botcord:unknown")).toBeNull();
    });

    it("injects memory for owner-chat session without registration", async () => {
      // Owner-chat uses fixed key "botcord:owner:main" and is never registered
      const result = await buildWorkingMemoryHookResult("botcord:owner:main");
      expect(result).not.toBeNull();
      expect(result?.prependContext).toContain("Working Memory");
    });

    it("returns prependContext for registered sessions", async () => {
      registerSessionRoom("botcord:test", {
        roomId: "rm_test",
        accountId: "default",
        lastActivityAt: Date.now(),
      });

      const result = await buildWorkingMemoryHookResult("botcord:test");
      expect(result).not.toBeNull();
      expect(result?.prependContext).toContain("Working Memory");
      expect(result?.prependContext).toContain("currently empty");
    });

    it("includes existing memory content", async () => {
      registerSessionRoom("botcord:test", {
        roomId: "rm_test",
        accountId: "default",
        lastActivityAt: Date.now(),
      });
      mockReadWorkingMemory.mockReturnValue({
        version: 1,
        content: "- important fact",
        updatedAt: "2026-04-01T11:00:00Z",
      });

      const result = await buildWorkingMemoryHookResult("botcord:test");
      expect(result?.prependContext).toContain("important fact");
    });
  });
});
