import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDaemonInstallPrefix } from "../self-restart.js";

describe("self restart install prefix detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "botcord-self-restart-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds the npm install prefix for a managed @botcord/daemon entrypoint", () => {
    const prefix = path.join(tmpDir, ".botcord", "daemon");
    const packageRoot = path.join(prefix, "node_modules", "@botcord", "daemon");
    const entrypoint = path.join(packageRoot, "dist", "index.js");
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), '{"name":"@botcord/daemon"}');
    writeFileSync(entrypoint, "");

    expect(findDaemonInstallPrefix(entrypoint)).toBe(prefix);
  });

  it("resolves npm .bin symlinks before looking for the package root", () => {
    const prefix = path.join(tmpDir, ".botcord", "daemon");
    const packageRoot = path.join(prefix, "node_modules", "@botcord", "daemon");
    const entrypoint = path.join(packageRoot, "dist", "index.js");
    const bin = path.join(prefix, "node_modules", ".bin", "botcord-daemon");
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), '{"name":"@botcord/daemon"}');
    writeFileSync(entrypoint, "");
    symlinkSync(entrypoint, bin);

    expect(findDaemonInstallPrefix(bin)).toBe(realpathSync(prefix));
  });

  it("does not treat a monorepo development entrypoint as self-updatable", () => {
    const entrypoint = path.join(tmpDir, "packages", "daemon", "dist", "index.js");
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, "");

    expect(findDaemonInstallPrefix(entrypoint)).toBeNull();
  });
});
