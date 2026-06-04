import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { lookupRuntimeFailureTranscript, safeCommand, sanitizeRuntimeFailureText } from "../runtime-failure.js";
import { transcriptFilePath } from "../transcript-paths.js";

describe("runtime failure observability", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds runtime failures by turn id and error ref while ignoring malformed lines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runtime-failure-"));
    tempDirs.push(root);
    const file = transcriptFilePath(root, "ag_1", "rm_1", null);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      [
        "{bad json",
        JSON.stringify({ kind: "inbound", turnId: "turn_1" }),
        JSON.stringify({
          ts: "2026-05-31T00:00:00.000Z",
          kind: "turn_error",
          turnId: "turn_2",
          errorRef: "err_abc",
          runtime: "codex",
          error: "codex failed",
          runtimeFailure: {
            agent_id: "ag_1",
            room_id: "rm_1",
            turn_id: "turn_2",
            runtime: "codex",
            error_message: "codex failed",
          },
        }),
      ].join("\n"),
    );

    expect(lookupRuntimeFailureTranscript({
      rootDir: root,
      agentId: "ag_1",
      roomId: "rm_1",
      turnId: "turn_2",
    })?.record.errorRef).toBe("err_abc");

    expect(lookupRuntimeFailureTranscript({
      rootDir: root,
      agentId: "ag_1",
      roomId: "rm_1",
      errorRef: "err_abc",
    })?.record.turnId).toBe("turn_2");
  });

  it("redacts obvious token-like values from captured tails", () => {
    expect(sanitizeRuntimeFailureText("Authorization: Bearer secret-token token=abc123 drt_live")).toBe(
      "Authorization: Bearer [REDACTED] token=[REDACTED] drt_[REDACTED]",
    );
  });

  it("redacts common API key and password forms from captured tails", () => {
    const sanitized = sanitizeRuntimeFailureText(
      [
        "OPENAI_API_KEY=openai-secret",
        "ANTHROPIC_API_KEY=anthropic-secret",
        "x-api-key: header-secret",
        "password: pw-secret",
        "--api-key cli-secret",
        "--token token-secret",
      ].join(" "),
    );

    for (const secret of [
      "openai-secret",
      "anthropic-secret",
      "header-secret",
      "pw-secret",
      "cli-secret",
      "token-secret",
    ]) {
      expect(sanitized).not.toContain(secret);
    }
    expect(sanitized).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(sanitized).toContain("ANTHROPIC_API_KEY=[REDACTED]");
    expect(sanitized).toContain("x-api-key: [REDACTED]");
    expect(sanitized).toContain("password: [REDACTED]");
    expect(sanitized).toContain("--api-key [REDACTED]");
    expect(sanitized).toContain("--token [REDACTED]");
  });

  it("redacts command arguments that pass secret values in the following argv token", () => {
    expect(safeCommand([
      "codex",
      "--api-key",
      "cli-secret",
      "--token",
      "token-secret",
      "--password=pass-secret",
      "run",
    ])).toEqual([
      "codex",
      "--api-key",
      "[REDACTED]",
      "--token",
      "[REDACTED]",
      "--password=[REDACTED]",
      "run",
    ]);
  });
});
