import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { transcriptFilePath } from "../gateway/index.js";

describe("debug runtime-error CLI", () => {
  const tempDirs: string[] = [];
  const originalArgv = process.argv;
  const originalHome = process.env.HOME;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.argv = originalArgv;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints runtime failure details selected by error ref", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "botcord-debug-runtime-error-"));
    tempDirs.push(home);
    process.env.HOME = home;

    const file = transcriptFilePath(
      path.join(home, ".botcord", "agents"),
      "ag_1",
      "rm_1",
      "tp_1",
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({
        ts: "2026-05-31T00:00:00.000Z",
        kind: "turn_error",
        agentId: "ag_1",
        roomId: "rm_1",
        topicId: "tp_1",
        turnId: "turn_2",
        errorRef: "err_abc",
        runtime: "codex",
        error: "codex failed",
        runtimeFailure: {
          agent_id: "ag_1",
          room_id: "rm_1",
          topic_id: "tp_1",
          turn_id: "turn_2",
          runtime: "codex",
          error_message: "codex failed",
        },
      })}\n`,
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("unexpected process.exit");
    }) as typeof process.exit);

    process.argv = [
      process.execPath,
      "botcord-daemon",
      "debug",
      "runtime-error",
      "--agent",
      "ag_1",
      "--room",
      "rm_1",
      "--topic",
      "tp_1",
      "--error-ref",
      "err_abc",
    ];

    await import("../index.js");

    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      turn_id: "turn_2",
      error_ref: "err_abc",
      runtime: "codex",
      message: "codex failed",
      failure: {
        turn_id: "turn_2",
        error_message: "codex failed",
      },
    });
  });

  it("prints runtime failure details selected by turn id", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "botcord-debug-runtime-error-"));
    tempDirs.push(home);
    process.env.HOME = home;

    const file = transcriptFilePath(
      path.join(home, ".botcord", "agents"),
      "ag_1",
      "rm_1",
      "tp_1",
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({
        ts: "2026-05-31T00:00:00.000Z",
        kind: "turn_error",
        agentId: "ag_1",
        roomId: "rm_1",
        topicId: "tp_1",
        turnId: "turn_1",
        errorRef: "err_decoy",
        runtime: "codex",
        error: "decoy failure",
        runtimeFailure: {
          agent_id: "ag_1",
          room_id: "rm_1",
          topic_id: "tp_1",
          turn_id: "turn_1",
          runtime: "codex",
          error_message: "decoy failure",
        },
      })}\n${JSON.stringify({
        ts: "2026-05-31T00:00:01.000Z",
        kind: "turn_error",
        agentId: "ag_1",
        roomId: "rm_1",
        topicId: "tp_1",
        turnId: "turn_2",
        errorRef: "err_abc",
        runtime: "codex",
        error: "codex failed",
        runtimeFailure: {
          agent_id: "ag_1",
          room_id: "rm_1",
          topic_id: "tp_1",
          turn_id: "turn_2",
          runtime: "codex",
          error_message: "codex failed",
        },
      })}\n`,
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("unexpected process.exit");
    }) as typeof process.exit);

    process.argv = [
      process.execPath,
      "botcord-daemon",
      "debug",
      "runtime-error",
      "--agent",
      "ag_1",
      "--room",
      "rm_1",
      "--topic",
      "tp_1",
      "--turn-id",
      "turn_2",
    ];

    await import("../index.js");

    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      turn_id: "turn_2",
      error_ref: "err_abc",
      runtime: "codex",
      message: "codex failed",
      failure: {
        turn_id: "turn_2",
        error_message: "codex failed",
      },
    });
  });
});
