import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  agentHomeDir,
  agentStateDir,
  agentWorkspaceDir,
  ensureAgentWorkspace,
} from "../agent-workspace.js";

let tmpHome = "";
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "daemon-workspace-"));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe("ensureAgentWorkspace", () => {
  it("creates the full tree + seed files from a clean slate", () => {
    ensureAgentWorkspace("ag_fresh", {
      displayName: "Writer",
      bio: "A careful assistant.",
      runtime: "claude-code",
      keyId: "k_abc",
      savedAt: "2026-04-23T00:00:00Z",
    });

    const home = agentHomeDir("ag_fresh");
    const workspace = agentWorkspaceDir("ag_fresh");
    const state = agentStateDir("ag_fresh");

    expect(home.startsWith(tmpHome)).toBe(true);
    expect(existsSync(home)).toBe(true);
    expect(statSync(home).isDirectory()).toBe(true);
    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(state)).toBe(true);
    expect(existsSync(path.join(workspace, "notes"))).toBe(true);

    for (const name of ["AGENTS.md", "CLAUDE.md", "identity.md", "memory.md", "task.md"]) {
      expect(existsSync(path.join(workspace, name))).toBe(true);
    }

    const agentsMd = readFileSync(path.join(workspace, "AGENTS.md"), "utf8");
    const claudeMd = readFileSync(path.join(workspace, "CLAUDE.md"), "utf8");
    expect(agentsMd).toBe(claudeMd);
    expect(agentsMd).toContain("# Agent Workspace");

    const identity = readFileSync(path.join(workspace, "identity.md"), "utf8");
    expect(identity).toContain("ag_fresh");
    expect(identity).toContain("Writer");
    expect(identity).toContain("claude-code");
    expect(identity).toContain("k_abc");
    expect(identity).toContain("2026-04-23T00:00:00Z");
    expect(identity).toContain("A careful assistant.");
  });

  it("places .gitkeep inside notes/", () => {
    ensureAgentWorkspace("ag_notes", {});
    expect(existsSync(path.join(agentWorkspaceDir("ag_notes"), "notes", ".gitkeep"))).toBe(true);
  });

  it("does not overwrite a user-modified memory.md on a second call", () => {
    ensureAgentWorkspace("ag_keep", {});
    const memoryPath = path.join(agentWorkspaceDir("ag_keep"), "memory.md");
    writeFileSync(memoryPath, "my custom notes\n");

    ensureAgentWorkspace("ag_keep", {});

    expect(readFileSync(memoryPath, "utf8")).toBe("my custom notes\n");
  });

  it("identity.md renders the bio placeholder when bio is missing", () => {
    ensureAgentWorkspace("ag_nobio", { displayName: "Nameless" });
    const identity = readFileSync(path.join(agentWorkspaceDir("ag_nobio"), "identity.md"), "utf8");
    expect(identity).toContain("_(none provided at provision time");
    expect(identity).toContain("## Bio");
  });

  it("identity.md degrades gracefully when runtime/keyId/savedAt are absent", () => {
    ensureAgentWorkspace("ag_sparse", {});
    const identity = readFileSync(path.join(agentWorkspaceDir("ag_sparse"), "identity.md"), "utf8");
    expect(identity).toContain("ag_sparse");
    // Placeholder used for every missing scalar field.
    expect(identity).toContain("_(not set)_");
    expect(identity).toContain("_(none provided at provision time");
  });

  describe("agentId safety", () => {
    // Defence-in-depth: if a malformed/hostile agentId reached these path
    // builders, `revokeAgent(deleteWorkspace:true)`'s `rmSync(home, {recursive:true})`
    // would happily wipe data outside ~/.botcord/agents/.
    const hostile = [
      "../escape",
      "../../etc",
      "foo/bar",
      "..",
      ".",
      "",
      "has spaces",
      "a\0b",
      "foo/../bar",
    ];
    for (const id of hostile) {
      it(`rejects unsafe agentId ${JSON.stringify(id)}`, () => {
        expect(() => agentHomeDir(id)).toThrow();
        expect(() => agentWorkspaceDir(id)).toThrow();
        expect(() => agentStateDir(id)).toThrow();
        expect(() => ensureAgentWorkspace(id, {})).toThrow();
      });
    }

    it("accepts realistic agent ids", () => {
      for (const ok of ["ag_abc123", "ag_XYZ_9", "ag-dash-ok", "A1", "ag_0"]) {
        expect(() => agentHomeDir(ok)).not.toThrow();
      }
    });
  });

  it("tightens perms on a pre-existing agent home with looser mode", () => {
    // Simulate a home dir created by an older daemon with mode 0o755.
    const home = agentHomeDir("ag_upgrade");
    // Creation goes via ensureAgentWorkspace's recursive mkdir, which wouldn't
    // override an existing mode — that's precisely the bug we fix.
    mkdirSync(home, { recursive: true, mode: 0o755 });
    ensureAgentWorkspace("ag_upgrade", {});
    const mode = statSync(home).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
