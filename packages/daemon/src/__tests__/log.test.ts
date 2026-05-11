import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatLogLine, listDaemonLogFiles, rotateLogIfNeeded } from "../log.js";

describe("formatLogLine", () => {
  it("renders compact text with level, message, details, and trailing timestamp", () => {
    const line = formatLogLine(
      "warn",
      "botcord ws error",
      { err: "Error: Unexpected server response: 503" },
      new Date("2026-05-01T00:22:07.131Z"),
    );

    expect(line).toBe(
      '[WARN] botcord ws error err="Error: Unexpected server response: 503" ts=2026-05-01T00:22:07.131Z',
    );
  });

  it("keeps object details readable without replacing the primary message", () => {
    const line = formatLogLine(
      "info",
      "botcord ws server error",
      { msg: { type: "error", code: 503 } },
      new Date("2026-05-01T00:22:07.131Z"),
    );

    expect(line).toBe(
      '[INFO] botcord ws server error msg={"type":"error","code":503} ts=2026-05-01T00:22:07.131Z',
    );
  });

  it("rotates oversized logs and keeps the newest 20 rotated files", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "botcord-log-test-"));
    try {
      const logFile = path.join(tmp, "daemon.log");
      writeFileSync(logFile, "active log line\n");
      for (let i = 0; i < 20; i += 1) {
        const rotated = path.join(tmp, `daemon.log.old-${String(i).padStart(2, "0")}`);
        writeFileSync(rotated, `old ${i}\n`);
        const t = new Date(1_700_000_000_000 + i * 1000);
        utimesSync(rotated, t, t);
      }

      rotateLogIfNeeded(logFile, 1, 10, 20);
      const logs = listDaemonLogFiles(logFile);
      const rotated = logs.filter((entry) => !entry.active);

      expect(rotated).toHaveLength(20);
      expect(rotated.some((entry) => entry.name === "daemon.log.old-00")).toBe(false);
      expect(rotated.some((entry) => entry.name.startsWith("daemon.log."))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
