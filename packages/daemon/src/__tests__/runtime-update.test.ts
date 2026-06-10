import { describe, expect, it, vi, afterEach } from "vitest";
import {
  startRuntimeAutoUpdate,
  updateAllRuntimes,
  type RuntimeUpdateDeps,
} from "../runtime-update.js";
import type { RuntimeModule } from "../gateway/runtimes/registry.js";
import type { GatewayLogger } from "../gateway/log.js";

function makeLogger(): GatewayLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Build a fake runtime module whose probe version flips after `bump()`. */
function fakeModule(
  id: string,
  opts: {
    update?: RuntimeModule["update"];
    available?: boolean;
    path?: string;
    versions?: [string, string];
  } = {},
): { mod: RuntimeModule; bump: () => void } {
  const versions = opts.versions ?? ["1.0.0", "1.0.0"];
  let probeCount = 0;
  let bumped = false;
  const mod: RuntimeModule = {
    id,
    displayName: id,
    binary: id,
    probe: () => {
      probeCount += 1;
      if (opts.available === false) return { available: false };
      return {
        available: true,
        path: opts.path ?? `/usr/local/bin/${id}`,
        version: bumped ? versions[1] : versions[0],
      };
    },
    create: () => {
      throw new Error("not used in tests");
    },
    update: opts.update,
  };
  return { mod, bump: () => (bumped = true) };
}

const baseEnv: NodeJS.ProcessEnv = {};

describe("updateAllRuntimes", () => {
  it("runs a self-update command with the probed binary path", async () => {
    const { mod } = fakeModule("claude-code", {
      update: { kind: "self", args: ["update"] },
      path: "/opt/claude/claude",
    });
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const results = await updateAllRuntimes({
      modules: [mod],
      execFileFn: exec,
      realpathFn: (p) => p,
      env: baseEnv,
    });
    expect(exec).toHaveBeenCalledWith(
      "/opt/claude/claude",
      ["update"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(results[0]).toMatchObject({ id: "claude-code", status: "unchanged" });
  });

  it("reports `updated` when the probed version changes", async () => {
    const { mod, bump } = fakeModule("claude-code", {
      update: { kind: "self", args: ["update"] },
      versions: ["1.0.0", "2.0.0"],
    });
    const exec = vi.fn().mockImplementation(async () => {
      bump();
      return { stdout: "", stderr: "" };
    });
    const results = await updateAllRuntimes({
      modules: [mod],
      execFileFn: exec,
      realpathFn: (p) => p,
      env: baseEnv,
    });
    expect(results[0]).toMatchObject({
      status: "updated",
      versionBefore: "1.0.0",
      versionAfter: "2.0.0",
    });
  });

  it("updates npm-managed installs via npm install -g", async () => {
    const { mod } = fakeModule("codex", {
      update: { kind: "npm", pkg: "@openai/codex" },
      path: "/Users/me/.nvm/versions/node/v20/bin/codex",
    });
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const results = await updateAllRuntimes({
      modules: [mod],
      execFileFn: exec,
      realpathFn: () => "/Users/me/.nvm/versions/node/v20/lib/node_modules/@openai/codex/bin/codex.js",
      env: baseEnv,
    });
    expect(exec).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@openai/codex@latest"],
      expect.anything(),
    );
    expect(results[0]).toMatchObject({ id: "codex", status: "unchanged" });
  });

  it("skips npm updates for non-npm installs (e.g. brew)", async () => {
    const { mod } = fakeModule("gemini", {
      update: { kind: "npm", pkg: "@google/gemini-cli" },
      path: "/opt/homebrew/bin/gemini",
    });
    const exec = vi.fn();
    const results = await updateAllRuntimes({
      modules: [mod],
      execFileFn: exec,
      realpathFn: () => "/opt/homebrew/Cellar/gemini-cli/1.0/bin/gemini",
      env: baseEnv,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      status: "skipped",
      detail: "not an npm-managed install",
    });
  });

  it("serializes npm updates but keeps self-updates parallel", async () => {
    const order: string[] = [];
    let inFlightNpm = 0;
    const { mod: codex } = fakeModule("codex", {
      update: { kind: "npm", pkg: "@openai/codex" },
    });
    const { mod: gemini } = fakeModule("gemini", {
      update: { kind: "npm", pkg: "@google/gemini-cli" },
    });
    const exec = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "npm") {
        inFlightNpm += 1;
        expect(inFlightNpm).toBe(1);
        await new Promise((r) => setTimeout(r, 5));
        inFlightNpm -= 1;
      }
      order.push(args.join(" "));
      return { stdout: "", stderr: "" };
    });
    await updateAllRuntimes({
      modules: [codex, gemini],
      execFileFn: exec,
      realpathFn: (p) => `/x/node_modules/${p}`,
      env: baseEnv,
    });
    expect(order).toHaveLength(2);
  });

  it("skips runtimes that are not installed or have no channel", async () => {
    const { mod: missing } = fakeModule("kimi-cli", {
      update: { kind: "self", args: ["update"] },
      available: false,
    });
    const { mod: noChannel } = fakeModule("hermes-agent", {});
    const exec = vi.fn();
    const results = await updateAllRuntimes({
      modules: [missing, noChannel],
      execFileFn: exec,
      realpathFn: (p) => p,
      env: baseEnv,
    });
    expect(exec).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: "skipped", detail: "not installed" });
    expect(results[1]).toMatchObject({ status: "skipped", detail: "no auto-update channel" });
  });

  it("honors BOTCORD_RUNTIME_AUTOUPDATE_SKIP", async () => {
    const { mod } = fakeModule("openclaw-acp", {
      update: { kind: "self", args: ["update", "--yes", "--no-restart"] },
    });
    const exec = vi.fn();
    const results = await updateAllRuntimes({
      modules: [mod],
      execFileFn: exec,
      realpathFn: (p) => p,
      env: { BOTCORD_RUNTIME_AUTOUPDATE_SKIP: "openclaw-acp, codex" },
    });
    expect(exec).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: "skipped" });
  });

  it("turns an exec failure into a failed result without rejecting", async () => {
    const { mod } = fakeModule("claude-code", {
      update: { kind: "self", args: ["update"] },
    });
    const exec = vi.fn().mockRejectedValue(new Error("network down"));
    const results = await updateAllRuntimes({
      modules: [mod],
      execFileFn: exec,
      realpathFn: (p) => p,
      env: baseEnv,
    });
    expect(results[0]).toMatchObject({ status: "failed", detail: "network down" });
  });
});

describe("startRuntimeAutoUpdate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a startup round and reports results via onCompleted", async () => {
    const { mod, bump } = fakeModule("claude-code", {
      update: { kind: "self", args: ["update"] },
      versions: ["1.0.0", "2.0.0"],
    });
    const exec = vi.fn().mockImplementation(async () => {
      bump();
      return { stdout: "", stderr: "" };
    });
    const onCompleted = vi.fn();
    const handle = startRuntimeAutoUpdate(
      { log: makeLogger(), onCompleted },
      { modules: [mod], execFileFn: exec, realpathFn: (p) => p, env: baseEnv },
    );
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(onCompleted.mock.calls[0][0][0]).toMatchObject({ status: "updated" });
    handle.stop();
  });

  it("is a no-op when BOTCORD_DISABLE_RUNTIME_AUTOUPDATE=1", () => {
    const exec = vi.fn();
    const handle = startRuntimeAutoUpdate(
      { log: makeLogger() },
      { execFileFn: exec, env: { BOTCORD_DISABLE_RUNTIME_AUTOUPDATE: "1" } },
    );
    expect(exec).not.toHaveBeenCalled();
    handle.stop();
  });

  it("is a no-op under NODE_ENV=test so daemon unit tests never run real updates", () => {
    const exec = vi.fn();
    const handle = startRuntimeAutoUpdate(
      { log: makeLogger() },
      { execFileFn: exec, env: { NODE_ENV: "test" } },
    );
    expect(exec).not.toHaveBeenCalled();
    handle.stop();
  });

  it("schedules interval rounds at the configured cadence", async () => {
    vi.useFakeTimers();
    const { mod } = fakeModule("claude-code", {
      update: { kind: "self", args: ["update"] },
    });
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const onCompleted = vi.fn();
    const handle = startRuntimeAutoUpdate(
      { log: makeLogger(), onCompleted },
      {
        modules: [mod],
        execFileFn: exec,
        realpathFn: (p) => p,
        env: { BOTCORD_RUNTIME_UPDATE_INTERVAL_MS: "1000" },
      },
    );
    await vi.advanceTimersByTimeAsync(0); // flush the startup round
    expect(onCompleted).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCompleted).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCompleted).toHaveBeenCalledTimes(3);
    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onCompleted).toHaveBeenCalledTimes(3);
  });
});
