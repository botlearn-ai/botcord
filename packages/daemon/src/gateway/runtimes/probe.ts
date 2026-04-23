import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Injection seam for PATH resolution + version probes, so tests can stub syscalls. */
export interface ProbeDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  execFileSyncFn?: typeof execFileSync;
  existsSyncFn?: (p: string) => boolean;
}

function normalizeExecOutput(raw: Buffer | string | null | undefined): string {
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
}

/** Resolve a command name on PATH via `which`/`where`; returns null when missing. */
export function resolveCommandOnPath(command: string, deps: ProbeDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const execFn = deps.execFileSyncFn ?? execFileSync;
  const locator = platform === "win32" ? "where" : "which";
  try {
    const out = normalizeExecOutput(
      execFn(locator, [command], {
        stdio: ["ignore", "pipe", "ignore"],
        env,
      } as ExecFileSyncOptions),
    );
    const resolved = out.trim().split(/\r?\n/)[0];
    return resolved || null;
  } catch {
    return null;
  }
}

/** Return the first path in `candidates` that exists on disk, or null. */
export function firstExistingPath(candidates: string[], deps: ProbeDeps = {}): string | null {
  const exists = deps.existsSyncFn ?? existsSync;
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

/** Run `<command> [...args] --version` and return the first output line, or null. */
export function readCommandVersion(
  command: string,
  args: string[] = [],
  deps: ProbeDeps = {},
): string | null {
  const env = deps.env ?? process.env;
  const execFn = deps.execFileSyncFn ?? execFileSync;
  try {
    const out = normalizeExecOutput(
      execFn(command, [...args, "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        timeout: 5000,
      } as ExecFileSyncOptions),
    );
    return out.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/** Join `relativePath` against HOME (falls back to empty when unset). */
export function resolveHomePath(relativePath: string, deps: ProbeDeps = {}): string {
  const home = deps.homeDir ?? deps.env?.HOME ?? process.env.HOME ?? "";
  return path.join(home, relativePath);
}
