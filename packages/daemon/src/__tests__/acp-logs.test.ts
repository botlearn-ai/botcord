import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.BOTCORD_ACP_LOGS;
  delete process.env.BOTCORD_ACP_TRACE;
  vi.resetModules();
});

describe("ACP trace logs", () => {
  it("writes redacted safe-mode jsonl and lists it for diagnostics", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "botcord-acp-log-home-"));
    process.env.HOME = home;
    vi.resetModules();
    const { createAcpTraceLogger, listAcpTraceLogFiles } = await import("../acp-logs.js");

    const logger = createAcpTraceLogger({
      runtime: "openclaw-acp",
      accountId: "ag_test",
      roomId: "rm_test",
      gatewayName: "qclaw-127-0-0-1-28789",
      gatewayUrl: "ws://127.0.0.1:28789",
    });
    expect(logger).not.toBeNull();
    logger!.write({
      stream: "rpc_out",
      direction: "out",
      id: 1,
      method: "session/prompt",
      status: "request",
      params: {
        sessionId: "sess_1",
        token: "secret-token",
        prompt: [{ type: "text", text: "hello from a user prompt" }],
      },
    });

    const raw = readFileSync(logger!.path, "utf8");
    expect(raw).toContain('"method":"session/prompt"');
    expect(raw).toContain('"preview":"[REDACTED]"');
    expect(raw).toContain('"textBytes"');
    expect(raw).toContain('"textPreview"');
    expect(raw).not.toContain("secret-token");
    const files = listAcpTraceLogFiles();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(logger!.path);
  });

  it("bundles ACP and runtime logs in diagnostics", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "botcord-diag-acp-home-"));
    process.env.HOME = home;
    vi.resetModules();
    const { createAcpTraceLogger } = await import("../acp-logs.js");
    const { createDiagnosticBundle } = await import("../diagnostics.js");

    const logger = createAcpTraceLogger({ runtime: "hermes-agent", accountId: "ag_hermes" });
    logger!.write({ stream: "stderr", chunk: "hermes auth token=secret\n" });
    const botcordDaemon = path.join(home, ".botcord", "daemon");
    const qclawLogs = path.join(home, ".qclaw", "logs");
    mkdirSync(botcordDaemon, { recursive: true });
    writeFileSync(path.join(home, ".botcord", "daemon.log"), "daemon\n", { flag: "w" });
    writeFileSync(path.join(home, ".botcord", "snapshot.json"), "{}\n", { flag: "w" });
    writeFileSync(path.join(botcordDaemon, "config.json"), "{}\n", { flag: "w" });
    mkdirSync(qclawLogs, { recursive: true });
    writeFileSync(path.join(qclawLogs, "qclaw.log"), "qclaw token=secret\n");

    const bundle = await createDiagnosticBundle({
      diagnosticsDir: path.join(home, ".botcord", "diagnostics"),
      doctor: { text: "doctor ok", json: { ok: true } },
    });

    expect(existsSync(bundle.path)).toBe(true);
    const listing = execFileSync("unzip", ["-l", bundle.path], { encoding: "utf8" });
    expect(listing).toContain("acp-logs/hermes-agent");
    expect(listing).toContain("runtime-logs/qclaw/qclaw.log");
    const acpLog = execFileSync("unzip", ["-p", bundle.path, "acp-logs/hermes-agent/ag_hermes.jsonl"], {
      encoding: "utf8",
    });
    expect(acpLog).toContain("[REDACTED]");
  });
});
