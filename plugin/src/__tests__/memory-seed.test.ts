import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readOrSeedWorkingMemory, readWorkingMemory, writeWorkingMemory } from "../memory.js";
import type { WorkingMemory } from "../memory.js";

// Mock runtime to avoid real workspace resolution
vi.mock("../runtime.js", () => ({
  getBotCordRuntime: vi.fn(() => ({})),
  getConfig: vi.fn(() => null),
}));

// Mock isLegacyOnboarded from credentials
const mockIsLegacyOnboarded = vi.fn().mockReturnValue(false);
vi.mock("../credentials.js", () => ({
  isLegacyOnboarded: (...args: any[]) => mockIsLegacyOnboarded(...args),
  attachTokenPersistence: vi.fn(),
}));

// Mock client
function createMockClient(seed: any | null = null, shouldThrow = false) {
  return {
    getDefaultMemory: vi.fn(async () => {
      if (shouldThrow) throw new Error("network error");
      return seed;
    }),
  } as any;
}

const SEED_MEMORY = {
  version: 2,
  goal: "完成初始设置",
  sections: {
    onboarding: "## BotCord 初始设置\n\n步骤...",
  },
};

describe("readOrSeedWorkingMemory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "botcord-seed-test-"));
    mockIsLegacyOnboarded.mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns existing local memory without calling API", async () => {
    const existing: WorkingMemory = {
      version: 2,
      goal: "已有目标",
      sections: { strategy: "已有策略" },
      updatedAt: "2026-04-01T00:00:00Z",
    };
    writeWorkingMemory(existing, tmpDir);

    const client = createMockClient(SEED_MEMORY);
    const result = await readOrSeedWorkingMemory({
      client,
      memDir: tmpDir,
    });

    expect(result).toEqual(existing);
    expect(client.getDefaultMemory).not.toHaveBeenCalled();
  });

  it("fetches seed from API when local memory is empty", async () => {
    const client = createMockClient(SEED_MEMORY);
    const result = await readOrSeedWorkingMemory({
      client,
      memDir: tmpDir,
    });

    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.goal).toBe("完成初始设置");
    expect(result!.sections.onboarding).toContain("BotCord");
    expect(client.getDefaultMemory).toHaveBeenCalledOnce();

    // Verify it was persisted to disk
    const persisted = readWorkingMemory(tmpDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.goal).toBe("完成初始设置");
  });

  it("returns null when legacy onboarded (migration bridge)", async () => {
    const client = createMockClient(SEED_MEMORY);
    mockIsLegacyOnboarded.mockReturnValue(true);

    const result = await readOrSeedWorkingMemory({
      client,
      credentialsFile: "/fake/creds.json",
      memDir: tmpDir,
    });

    expect(result).toBeNull();
    expect(client.getDefaultMemory).not.toHaveBeenCalled();
  });

  it("skips legacy check when no credentialsFile provided", async () => {
    const client = createMockClient(SEED_MEMORY);
    mockIsLegacyOnboarded.mockClear();
    mockIsLegacyOnboarded.mockReturnValue(true); // would skip if called

    const result = await readOrSeedWorkingMemory({
      client,
      // no credentialsFile — legacy check should be skipped entirely
      memDir: tmpDir,
    });

    // Should still fetch seed because credentialsFile is not provided
    expect(result).not.toBeNull();
    expect(mockIsLegacyOnboarded).not.toHaveBeenCalled();
  });

  it("returns null on API network error (offline graceful)", async () => {
    const client = createMockClient(null, true);
    const result = await readOrSeedWorkingMemory({
      client,
      memDir: tmpDir,
    });

    expect(result).toBeNull();
    // No file should be written
    expect(readWorkingMemory(tmpDir)).toBeNull();
  });

  it("returns null when API returns null", async () => {
    const client = createMockClient(null);
    const result = await readOrSeedWorkingMemory({
      client,
      memDir: tmpDir,
    });

    expect(result).toBeNull();
  });

  it("returns null when API returns wrong version", async () => {
    const client = createMockClient({ version: 1, content: "old format" });
    const result = await readOrSeedWorkingMemory({
      client,
      memDir: tmpDir,
    });

    expect(result).toBeNull();
  });

  it("handles seed without goal gracefully", async () => {
    const seedNoGoal = {
      version: 2,
      sections: { onboarding: "content" },
    };
    const client = createMockClient(seedNoGoal);
    const result = await readOrSeedWorkingMemory({
      client,
      memDir: tmpDir,
    });

    expect(result).not.toBeNull();
    expect(result!.goal).toBeUndefined();
    expect(result!.sections.onboarding).toBe("content");
  });

  it("sets updatedAt timestamp on seeded memory", async () => {
    const before = new Date().toISOString();
    const client = createMockClient(SEED_MEMORY);
    const result = await readOrSeedWorkingMemory({
      client,
      memDir: tmpDir,
    });

    expect(result).not.toBeNull();
    expect(result!.updatedAt).toBeDefined();
    expect(result!.updatedAt >= before).toBe(true);
  });
});
