import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  RUNTIME_MODULES,
  type RuntimeModule,
} from "./gateway/runtimes/registry.js";
import type { GatewayLogger } from "./gateway/log.js";
import type { RuntimeProbeResult } from "./gateway/types.js";

/**
 * Default cadence for the background runtime-update loop. Override via
 * `BOTCORD_RUNTIME_UPDATE_INTERVAL_MS`; disable the whole feature with
 * `BOTCORD_DISABLE_RUNTIME_AUTOUPDATE=1`.
 */
const DEFAULT_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap for a single runtime's update command. Self-updaters download a
 * binary and npm installs resolve a dependency tree — minutes, not seconds —
 * but a wedged updater must not pin the loop forever.
 */
const DEFAULT_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

export interface RuntimeUpdateResult {
  id: string;
  /**
   * - `updated`: command succeeded and the probed version changed.
   * - `unchanged`: command succeeded, same version (already latest).
   * - `skipped`: no update channel applies (not installed, not npm-managed,
   *   or excluded via BOTCORD_RUNTIME_AUTOUPDATE_SKIP).
   * - `failed`: command errored or timed out.
   */
  status: "updated" | "unchanged" | "skipped" | "failed";
  versionBefore?: string;
  versionAfter?: string;
  detail?: string;
}

/** Injection seam so tests don't shell out or touch the filesystem. */
export interface RuntimeUpdateDeps {
  modules?: readonly RuntimeModule[];
  execFileFn?: (
    cmd: string,
    args: string[],
    opts: { timeout: number; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  realpathFn?: (p: string) => string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function defaultExecFile(
  cmd: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeout,
        env: opts.env,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      } as Parameters<typeof execFile>[2],
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${err.message}${stderr ? `\n${String(stderr).slice(0, 2000)}` : ""}`,
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function parseSkipList(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.BOTCORD_RUNTIME_AUTOUPDATE_SKIP;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function safeProbe(mod: RuntimeModule): RuntimeProbeResult {
  try {
    return mod.probe();
  } catch {
    return { available: false };
  }
}

/**
 * Run one module's update command and classify the outcome by re-probing
 * the version afterwards. Never throws — every failure mode collapses into
 * a `failed`/`skipped` result so one broken updater can't sink the round.
 */
async function updateOneRuntime(
  mod: RuntimeModule,
  deps: Required<Pick<RuntimeUpdateDeps, "execFileFn" | "realpathFn" | "env" | "timeoutMs">>,
): Promise<RuntimeUpdateResult> {
  const spec = mod.update;
  if (!spec) {
    return { id: mod.id, status: "skipped", detail: "no auto-update channel" };
  }
  const before = safeProbe(mod);
  if (!before.available) {
    return { id: mod.id, status: "skipped", detail: "not installed" };
  }

  let cmd: string;
  let args: string[];
  if (spec.kind === "self") {
    cmd = before.path ?? mod.binary;
    args = spec.args;
  } else {
    // npm channel: only touch installs we can prove npm owns. A brew or
    // native install resolves outside node_modules — skip those instead of
    // clobbering them with a parallel npm copy.
    let real = before.path ?? "";
    try {
      if (real) real = deps.realpathFn(real);
    } catch {
      // fall through with the unresolved path
    }
    if (!real.includes("node_modules")) {
      return {
        id: mod.id,
        status: "skipped",
        versionBefore: before.version,
        detail: "not an npm-managed install",
      };
    }
    cmd = "npm";
    args = ["install", "-g", `${spec.pkg}@latest`];
  }

  try {
    await deps.execFileFn(cmd, args, {
      timeout: deps.timeoutMs,
      env: deps.env,
    });
  } catch (err) {
    return {
      id: mod.id,
      status: "failed",
      versionBefore: before.version,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const after = safeProbe(mod);
  const changed =
    after.version !== undefined && after.version !== before.version;
  return {
    id: mod.id,
    status: changed ? "updated" : "unchanged",
    versionBefore: before.version,
    versionAfter: after.version,
  };
}

/**
 * Update every runtime that declares an update channel. Self-updaters run
 * in parallel (independent binaries); npm-channel updates run sequentially
 * because concurrent `npm install -g` invocations race on the same global
 * tree. Resolves with one result per registered module, in registry order.
 */
export async function updateAllRuntimes(
  deps: RuntimeUpdateDeps = {},
): Promise<RuntimeUpdateResult[]> {
  const modules = deps.modules ?? RUNTIME_MODULES;
  const env = deps.env ?? process.env;
  const resolved = {
    execFileFn: deps.execFileFn ?? defaultExecFile,
    realpathFn: deps.realpathFn ?? realpathSync,
    env,
    timeoutMs: deps.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS,
  };
  const skip = parseSkipList(env);

  const results = new Array<RuntimeUpdateResult>(modules.length);
  const npmQueue: Array<{ index: number; mod: RuntimeModule }> = [];
  const parallel: Array<Promise<void>> = [];

  modules.forEach((mod, index) => {
    if (skip.has(mod.id)) {
      results[index] = {
        id: mod.id,
        status: "skipped",
        detail: "excluded via BOTCORD_RUNTIME_AUTOUPDATE_SKIP",
      };
      return;
    }
    if (mod.update?.kind === "npm") {
      npmQueue.push({ index, mod });
      return;
    }
    parallel.push(
      updateOneRuntime(mod, resolved).then((r) => {
        results[index] = r;
      }),
    );
  });

  const npmChain = (async () => {
    for (const { index, mod } of npmQueue) {
      results[index] = await updateOneRuntime(mod, resolved);
    }
  })();

  await Promise.all([...parallel, npmChain]);
  return results;
}

/** Handle returned by {@link startRuntimeAutoUpdate}. */
export interface RuntimeAutoUpdateHandle {
  stop: () => void;
}

export interface RuntimeAutoUpdateOptions {
  log: GatewayLogger;
  /**
   * Called after every completed round with all results — wire this to
   * `clearRuntimeProbeCache()` + a live `runtime_snapshot` push so the
   * dashboard sees new versions without waiting for a restart.
   */
  onCompleted?: (results: RuntimeUpdateResult[]) => void;
}

function resolveIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.BOTCORD_RUNTIME_UPDATE_INTERVAL_MS;
  if (!raw) return DEFAULT_UPDATE_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_UPDATE_INTERVAL_MS;
  return n;
}

function autoUpdateDisabled(env: NodeJS.ProcessEnv): boolean {
  // Keep unit tests that boot a full daemon from running real CLI updates
  // on the developer's machine (same pattern as runtime-models.ts).
  if (env.NODE_ENV === "test") return true;
  const raw = (env.BOTCORD_DISABLE_RUNTIME_AUTOUPDATE ?? "").toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Fire-and-forget runtime auto-update loop: one round immediately at daemon
 * startup, then one every 24h (configurable). Rounds never block startup or
 * throw; results are logged and handed to `onCompleted`.
 */
export function startRuntimeAutoUpdate(
  opts: RuntimeAutoUpdateOptions,
  deps: RuntimeUpdateDeps = {},
): RuntimeAutoUpdateHandle {
  const env = deps.env ?? process.env;
  if (autoUpdateDisabled(env)) {
    opts.log.info("runtime-update: disabled via BOTCORD_DISABLE_RUNTIME_AUTOUPDATE");
    return { stop: () => undefined };
  }

  let stopped = false;
  let running = false;

  const runRound = async (trigger: "startup" | "interval"): Promise<void> => {
    if (running) {
      // A 24h cadence should never lap a 5-minute-capped round, but a
      // pathological hang (timeout disabled via deps) must not stack rounds.
      opts.log.warn("runtime-update: previous round still running; skipping", {
        trigger,
      });
      return;
    }
    running = true;
    try {
      const results = await updateAllRuntimes(deps);
      if (stopped) return;
      const updated = results.filter((r) => r.status === "updated");
      const failed = results.filter((r) => r.status === "failed");
      opts.log.info("runtime-update: round completed", {
        trigger,
        updated: updated.map((r) => `${r.id} ${r.versionBefore ?? "?"} -> ${r.versionAfter ?? "?"}`),
        failed: failed.map((r) => r.id),
        results: results.map((r) => ({ id: r.id, status: r.status })),
      });
      for (const r of failed) {
        opts.log.warn("runtime-update: runtime update failed", {
          id: r.id,
          detail: r.detail,
        });
      }
      opts.onCompleted?.(results);
    } catch (err) {
      opts.log.warn("runtime-update: round crashed", {
        trigger,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  void runRound("startup");
  const timer = setInterval(() => {
    void runRound("interval");
  }, resolveIntervalMs(env));
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
