import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDiagnosticBundle } from "../diagnostics.js";

describe("diagnostics bundle", () => {
  it("writes a zip bundle under ~/.botcord/diagnostics", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "botcord-diag-test-"));
    const logFile = path.join(tmp, "daemon.log");
    const configFile = path.join(tmp, "config.json");
    const snapshotFile = path.join(tmp, "snapshot.json");
    const diagnosticsDir = path.join(tmp, "diagnostics");
    writeFileSync(logFile, 'Authorization: Bearer secret-token\n{"refreshToken":"drt_secret"}\n');
    writeFileSync(configFile, '{"token":"agent-secret","ok":true}\n');
    writeFileSync(snapshotFile, '{"version":1}\n');

    const bundle = await createDiagnosticBundle({
      diagnosticsDir,
      logFile,
      configFile,
      snapshotFile,
      doctor: { text: "doctor ok", json: { ok: true } },
    });
    expect(bundle.filename).toMatch(/^botcord-daemon-diagnostics-.*\.zip$/);
    expect(bundle.path).toContain(diagnosticsDir);
    if (process.platform === "linux") {
      expect(bundle.revealCommand).toContain(diagnosticsDir);
    } else {
      expect(bundle.revealCommand).toContain(bundle.path);
    }
    expect(bundle.copyPathCommand).toContain(bundle.path);
    expect(existsSync(bundle.path)).toBe(true);
    const bytes = readFileSync(bundle.path);
    expect(bytes.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");

    const listing = execFileSync("unzip", ["-l", bundle.path], {
      encoding: "utf8",
    });
    expect(listing).toContain("daemon.log");
    expect(listing).toContain("doctor.json");
    expect(listing).toContain("status.json");
    expect(listing).toContain("config.json.redacted");

    const log = execFileSync("unzip", ["-p", bundle.path, "daemon.log"], {
      encoding: "utf8",
    });
    expect(log).toContain("Authorization: Bearer [REDACTED]");
    expect(log).toContain('"refreshToken":"[REDACTED]"');
  }, 20_000);
});
