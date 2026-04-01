import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildWorkingMemoryHookResult,
  processOutboundMemory,
} from "../memory-hook.js";
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
const mockWriteWorkingMemory = vi.fn();

vi.mock("../memory.js", () => ({
  readWorkingMemory: (...args: any[]) => mockReadWorkingMemory(...args),
  writeWorkingMemory: (...args: any[]) => mockWriteWorkingMemory(...args),
}));

describe("memory-hook", () => {
  beforeEach(() => {
    const map = getAllSessionRooms() as Map<string, any>;
    map.clear();
    mockReadWorkingMemory.mockReset().mockReturnValue(null);
    mockWriteWorkingMemory.mockReset();
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

  // ── processOutboundMemory ────────────────────────────────────────

  describe("processOutboundMemory", () => {
    it("returns original text when no memory block", () => {
      const result = processOutboundMemory("Hello world");
      expect(result).toBe("Hello world");
      expect(mockWriteWorkingMemory).not.toHaveBeenCalled();
    });

    it("extracts memory and returns cleaned text", () => {
      const text =
        "Here is my response.\n\n<memory_update>\n- new note\n</memory_update>";
      const result = processOutboundMemory(text, "botcord:test");
      expect(result).toBe("Here is my response.");
      expect(mockWriteWorkingMemory).toHaveBeenCalledTimes(1);
      expect(mockWriteWorkingMemory.mock.calls[0][0]).toMatchObject({
        version: 1,
        content: "- new note",
        sourceSessionKey: "botcord:test",
      });
    });

    it("returns empty string for empty input", () => {
      expect(processOutboundMemory("")).toBe("");
      expect(mockWriteWorkingMemory).not.toHaveBeenCalled();
    });

    it("handles write errors gracefully", () => {
      mockWriteWorkingMemory.mockImplementation(() => {
        throw new Error("disk full");
      });
      const text = "Response.\n<memory_update>notes</memory_update>";
      // Should not throw — logs error and returns cleaned text
      const result = processOutboundMemory(text);
      expect(result).toBe("Response.");
    });
  });
});
