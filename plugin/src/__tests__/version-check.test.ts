import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkVersionInfo, _resetWarningFlag, PLUGIN_VERSION } from "../version-check.js";

describe("version-check", () => {
  const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    _resetWarningFlag();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  it("returns ok when current version matches latest", () => {
    const result = checkVersionInfo(
      { latest_plugin_version: PLUGIN_VERSION, min_plugin_version: "0.1.0" },
      mockLog,
    );
    expect(result).toBe("ok");
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it("returns update_available when latest is newer", () => {
    const result = checkVersionInfo(
      { latest_plugin_version: "99.0.0", min_plugin_version: "0.1.0" },
      mockLog,
    );
    expect(result).toBe("update_available");
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn.mock.calls[0][0]).toContain("99.0.0");
  });

  it("returns incompatible when below min version", () => {
    const result = checkVersionInfo(
      { latest_plugin_version: "99.0.0", min_plugin_version: "99.0.0" },
      mockLog,
    );
    expect(result).toBe("incompatible");
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.error.mock.calls[0][0]).toContain("minimum required");
  });

  it("only warns once per session for update_available", () => {
    checkVersionInfo({ latest_plugin_version: "99.0.0" }, mockLog);
    checkVersionInfo({ latest_plugin_version: "99.0.0" }, mockLog);
    checkVersionInfo({ latest_plugin_version: "99.0.0" }, mockLog);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it("handles null/missing version fields gracefully", () => {
    const result = checkVersionInfo({}, mockLog);
    expect(result).toBe("ok");
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it("works without a logger", () => {
    expect(() => checkVersionInfo({ latest_plugin_version: "99.0.0" })).not.toThrow();
    expect(() => checkVersionInfo({ min_plugin_version: "99.0.0" })).not.toThrow();
  });

  // --- Malformed version handling ---

  it("handles v-prefixed version strings", () => {
    const result = checkVersionInfo(
      { latest_plugin_version: "v99.0.0", min_plugin_version: "v0.1.0" },
      mockLog,
    );
    expect(result).toBe("update_available");
  });

  it("handles versions with pre-release suffixes", () => {
    const result = checkVersionInfo(
      { latest_plugin_version: "99.0.0-beta.1", min_plugin_version: "0.1.0-rc.1" },
      mockLog,
    );
    expect(result).toBe("update_available");
  });

  it("treats completely invalid version strings as ok (no action)", () => {
    const result = checkVersionInfo(
      { latest_plugin_version: "not-a-version", min_plugin_version: "also-bad" },
      mockLog,
    );
    expect(result).toBe("ok");
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it("treats empty strings as no version info", () => {
    const result = checkVersionInfo(
      { latest_plugin_version: "", min_plugin_version: "" },
      mockLog,
    );
    expect(result).toBe("ok");
  });

  // --- incompatible always logs error (no session dedup) ---

  it("logs error on every incompatible check (not deduped)", () => {
    _resetWarningFlag();
    checkVersionInfo({ min_plugin_version: "99.0.0" }, mockLog);
    checkVersionInfo({ min_plugin_version: "99.0.0" }, mockLog);
    expect(mockLog.error).toHaveBeenCalledTimes(2);
  });

  // --- PLUGIN_VERSION export ---

  it("exports PLUGIN_VERSION as a valid semver string", () => {
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
