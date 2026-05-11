import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

  it("bundles active log plus latest 5 rotated logs by default, or all with includeAllLogs", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "botcord-diag-logs-test-"));
    const logFile = path.join(tmp, "daemon.log");
    const configFile = path.join(tmp, "config.json");
    const snapshotFile = path.join(tmp, "snapshot.json");
    writeFileSync(logFile, "active\n");
    writeFileSync(configFile, "{}\n");
    writeFileSync(snapshotFile, "{}\n");
    for (let i = 0; i < 7; i += 1) {
      const rotated = path.join(tmp, `daemon.log.rot-${i}`);
      writeFileSync(rotated, `rotated ${i}\n`);
      const t = new Date(1_700_000_000_000 + i * 1000);
      utimesSync(rotated, t, t);
    }

    const baseOpts = {
      diagnosticsDir: path.join(tmp, "diagnostics"),
      logFile,
      configFile,
      snapshotFile,
      doctor: { text: "doctor ok", json: { ok: true } },
    };
    const bundle = await createDiagnosticBundle(baseOpts);
    const listing = execFileSync("unzip", ["-l", bundle.path], { encoding: "utf8" });
    expect(listing).toContain("daemon.log");
    expect(listing).toContain("logs/daemon.log.rot-6");
    expect(listing).toContain("logs/daemon.log.rot-2");
    expect(listing).not.toContain("logs/daemon.log.rot-1");
    expect(listing).not.toContain("logs/daemon.log.rot-0");

    const full = await createDiagnosticBundle({ ...baseOpts, includeAllLogs: true });
    const fullListing = execFileSync("unzip", ["-l", full.path], { encoding: "utf8" });
    expect(fullListing).toContain("logs/daemon.log.rot-0");
    expect(fullListing).toContain("logs/daemon.log.rot-6");
  }, 20_000);
});
