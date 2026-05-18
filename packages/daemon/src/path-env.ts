import path from "node:path";

const COMMON_USER_BIN_RELATIVE_PATHS = [
  ".botcord/bin",
  ".local/bin",
  ".cargo/bin",
  ".bun/bin",
  ".deno/bin",
  ".npm-global/bin",
  ".yarn/bin",
  ".pnpm",
  ".pyenv/shims",
  ".rye/shims",
  ".pixi/bin",
];

const COMMON_SYSTEM_BIN_PATHS =
  process.platform === "darwin"
    ? ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]
    : ["/usr/local/bin", "/usr/local/sbin"];

export function commonDaemonPathEntries(home = process.env.HOME): string[] {
  const userEntries = home
    ? COMMON_USER_BIN_RELATIVE_PATHS.map((entry) => path.join(home, entry))
    : [];
  return [...COMMON_SYSTEM_BIN_PATHS, ...userEntries];
}

export function mergePathEntries(basePath: string | undefined, extras: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of [...(basePath ?? "").split(path.delimiter), ...extras]) {
    const entry = raw.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }

  return out.join(path.delimiter);
}

/**
 * GUI-launched macOS apps inherit a sparse launchd PATH and do not read the
 * user's shell profile. Add common per-user CLI install locations so runtime
 * adapters can find tools installed by uv/pipx, cargo, bun, npm, etc.
 */
export function augmentProcessPath(): void {
  process.env.PATH = mergePathEntries(
    process.env.PATH,
    commonDaemonPathEntries(process.env.HOME),
  );
}
