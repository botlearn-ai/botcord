import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { consoleLogger } from "./log.js";

const require = createRequire(import.meta.url);

// Tri-state cache: `undefined` means "not yet attempted"; `null` means
// "attempted and unavailable" (don't retry, don't re-log).
let cached: { binDir: string; binPath: string } | null | undefined;

export interface BundledCliBin {
  /** Directory containing the `botcord` symlink — safe to prepend to PATH. */
  binDir: string;
  /** Absolute path to the CLI's JS entry — for direct spawn (not via PATH). */
  binPath: string;
}

/**
 * Resolve the bundled `@botcord/cli` package and return both the
 * `<install-root>/node_modules/.bin` directory (for PATH injection so
 * `botcord` shows up to runtimes) and the absolute JS entry (for callers
 * that want to spawn the CLI directly without depending on the symlink).
 *
 * Returns `null` when `@botcord/cli` is not installed alongside the daemon
 * — callers should fall back to whatever `botcord` is on the user's PATH.
 */
export function resolveBundledCliBin(): BundledCliBin | null {
  if (cached !== undefined) return cached;
  try {
    const pkgJsonPath = require.resolve("@botcord/cli/package.json");
    const pkgRoot = path.dirname(pkgJsonPath);
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binRel =
      typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.botcord;
    if (!binRel) {
      consoleLogger.warn("cli-resolver: @botcord/cli has no bin.botcord entry");
      cached = null;
      return null;
    }
    const binPath = path.resolve(pkgRoot, binRel);
    // PATH must point at `<install-root>/node_modules/.bin` (where npm puts
    // the `botcord` shim), not the package's own `dist/` — there is no
    // executable named `botcord` inside the package directory.
    const binDir = path.resolve(pkgRoot, "..", "..", ".bin");
    cached = { binDir, binPath };
    return cached;
  } catch (err) {
    consoleLogger.warn(
      "cli-resolver: bundled @botcord/cli not resolvable; runtimes will fall back to PATH",
      { error: err instanceof Error ? err.message : String(err) },
    );
    cached = null;
    return null;
  }
}

/** Test-only: clear the cached resolution. */
export function __resetBundledCliBinCache(): void {
  cached = undefined;
}

/**
 * Return env additions that point a runtime CLI subprocess at the right
 * BotCord identity:
 *   - `BOTCORD_HUB`      — hub URL the agent is registered against
 *   - `BOTCORD_AGENT_ID` — default `--agent` for `botcord ...` invocations
 *   - `PATH`             — prepended with the bundled CLI's `.bin` dir so
 *                          `botcord` resolves to the version daemon shipped
 *                          with (avoiding protocol-core drift). Falls
 *                          through to whatever the user already has on PATH
 *                          when the bundled CLI can't be resolved.
 */
export function buildCliEnv(opts: {
  hubUrl?: string;
  accountId?: string;
  basePath?: string | undefined;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (opts.hubUrl) env.BOTCORD_HUB = opts.hubUrl;
  if (opts.accountId) env.BOTCORD_AGENT_ID = opts.accountId;
  const cli = resolveBundledCliBin();
  if (cli) {
    const existing = opts.basePath ?? "";
    env.PATH = existing
      ? `${cli.binDir}${path.delimiter}${existing}`
      : cli.binDir;
  }
  return env;
}
