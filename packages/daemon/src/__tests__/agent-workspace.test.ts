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
  agentCodexHomeDir,
  agentHermesHomeDir,
  agentHomeDir,
  agentStateDir,
  agentWorkspaceDir,
  applyAgentIdentity,
  ensureAgentCodexHome,
  ensureAgentHermesWorkspace,
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

  it("seeds bundled Claude Code skills under .claude/skills/", () => {
    ensureAgentWorkspace("ag_skills", {});
    const skillsDir = path.join(agentWorkspaceDir("ag_skills"), ".claude", "skills");
    expect(existsSync(path.join(skillsDir, "botcord", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(skillsDir, "botcord-user-guide", "SKILL.md"))).toBe(true);
  });

  it("re-seeds skills on a second call so daemon upgrades propagate", () => {
    ensureAgentWorkspace("ag_skill_upgrade", {});
    const skillFile = path.join(
      agentWorkspaceDir("ag_skill_upgrade"),
      ".claude",
      "skills",
      "botcord",
      "SKILL.md",
    );
    writeFileSync(skillFile, "stale content from a prior daemon version\n");

    ensureAgentWorkspace("ag_skill_upgrade", {});

    const reseeded = readFileSync(skillFile, "utf8");
    expect(reseeded).not.toBe("stale content from a prior daemon version\n");
    expect(reseeded).toContain("name: botcord");
  });

  it("seeds bundled skills under codex-home/skills/ so per-agent CODEX_HOME sees them", () => {
    ensureAgentWorkspace("ag_codex_skills", {});
    const skillsDir = path.join(agentCodexHomeDir("ag_codex_skills"), "skills");
    expect(existsSync(path.join(skillsDir, "botcord", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(skillsDir, "botcord-user-guide", "SKILL.md"))).toBe(true);
  });

  it("re-seeds codex skills on subsequent ensureAgentCodexHome calls", () => {
    ensureAgentCodexHome("ag_codex_reseed");
    const skillFile = path.join(
      agentCodexHomeDir("ag_codex_reseed"),
      "skills",
      "botcord",
      "SKILL.md",
    );
    writeFileSync(skillFile, "stale content from a prior daemon version\n");

    ensureAgentCodexHome("ag_codex_reseed");

    const reseeded = readFileSync(skillFile, "utf8");
    expect(reseeded).not.toBe("stale content from a prior daemon version\n");
    expect(reseeded).toContain("name: botcord");
  });

  it("does not overwrite a user-modified memory.md on a second call", () => {
    ensureAgentWorkspace("ag_keep", {});
    const memoryPath = path.join(agentWorkspaceDir("ag_keep"), "memory.md");
    writeFileSync(memoryPath, "my custom notes\n");

    ensureAgentWorkspace("ag_keep", {});

    expect(readFileSync(memoryPath, "utf8")).toBe("my custom notes\n");
  });

  it("seeds Hermes config and provider env without copying unrelated secrets", () => {
    const globalHermes = path.join(tmpHome, ".hermes");
    mkdirSync(globalHermes, { recursive: true });
    writeFileSync(
      path.join(globalHermes, ".env"),
      [
        "OPENAI_API_KEY=sk-test",
        "HERMES_INFERENCE_PROVIDER=custom",
        "BOTCORD_PRIVATE_KEY=must-not-copy",
        "TELEGRAM_BOT_TOKEN=must-not-copy",
        "AWS_REGION=us-east-1",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(globalHermes, "config.yaml"),
      "model:\n  provider: custom\n  default: anthropic/claude-opus-4.6\n",
    );

    const { hermesHome } = ensureAgentHermesWorkspace("ag_hermes_seed");
    const env = readFileSync(path.join(hermesHome, ".env"), "utf8");
    const config = readFileSync(path.join(hermesHome, "config.yaml"), "utf8");

    expect(env).toContain("OPENAI_API_KEY=sk-test");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=custom");
    expect(env).toContain("AWS_REGION=us-east-1");
    expect(env).not.toContain("BOTCORD_PRIVATE_KEY");
    expect(env).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(config).toContain("provider: custom");
  });

  it("does not overwrite existing per-agent Hermes env values", () => {
    const globalHermes = path.join(tmpHome, ".hermes");
    mkdirSync(globalHermes, { recursive: true });
    writeFileSync(
      path.join(globalHermes, ".env"),
      "OPENAI_API_KEY=global\nOPENROUTER_API_KEY=openrouter\n",
    );
    const agentHome = agentHermesHomeDir("ag_hermes_keep");
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(path.join(agentHome, ".env"), "OPENAI_API_KEY=local\n");

    ensureAgentHermesWorkspace("ag_hermes_keep");
    const env = readFileSync(path.join(agentHome, ".env"), "utf8");

    expect(env).toContain("OPENAI_API_KEY=local");
    expect(env).not.toContain("OPENAI_API_KEY=global");
    expect(env).toContain("OPENROUTER_API_KEY=openrouter");
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

  describe("applyAgentIdentity", () => {
    it("rewrites display name + bio while preserving Role/Boundaries", () => {
      ensureAgentWorkspace("ag_edit", {
        displayName: "Old",
        bio: "Old bio",
        runtime: "claude-code",
      });
      const identityPath = path.join(agentWorkspaceDir("ag_edit"), "identity.md");
      const original = readFileSync(identityPath, "utf8");
      // User personalises Role/Boundaries — must survive identity sync.
      const customised = original
        .replace("_(Describe what you do and for whom. Edit this section.)_", "I write poetry.")
        .replace("_(What you will and will not do. Edit this section.)_", "No financial advice.");
      writeFileSync(identityPath, customised);

      const result = applyAgentIdentity("ag_edit", {
        displayName: "New Name",
        bio: "Refreshed bio.",
      });
      expect(result.changed).toBe(true);

      const updated = readFileSync(identityPath, "utf8");
      expect(updated).toContain("- **Display name**: New Name");
      expect(updated).toContain("Refreshed bio.");
      expect(updated).not.toContain("Old bio");
      expect(updated).toContain("I write poetry.");
      expect(updated).toContain("No financial advice.");
    });

    it("clears bio back to placeholder when null is passed", () => {
      ensureAgentWorkspace("ag_clearbio", { bio: "Some bio" });
      const result = applyAgentIdentity("ag_clearbio", { bio: null });
      expect(result.changed).toBe(true);
      const updated = readFileSync(
        path.join(agentWorkspaceDir("ag_clearbio"), "identity.md"),
        "utf8",
      );
      expect(updated).not.toContain("Some bio");
      expect(updated).toContain("_(none provided at provision time");
    });

    it("returns no-change when patch matches current values", () => {
      ensureAgentWorkspace("ag_idempotent", { displayName: "Same", bio: "Same bio" });
      const result = applyAgentIdentity("ag_idempotent", {
        displayName: "Same",
        bio: "Same bio",
      });
      expect(result.changed).toBe(false);
      expect(result.skipped).toBe("no-change");
    });

    it("skips when identity.md is missing", () => {
      const result = applyAgentIdentity("ag_missing", { displayName: "X" });
      expect(result.changed).toBe(false);
      expect(result.skipped).toBe("missing-file");
    });

    it("rewrites correctly when identity.md has no trailing sections after Bio", () => {
      ensureAgentWorkspace("ag_eofbio", { displayName: "Old", bio: "Old bio" });
      const identityPath = path.join(agentWorkspaceDir("ag_eofbio"), "identity.md");
      // Strip everything after `## Bio` so the Bio section runs to EOF.
      const truncated =
        readFileSync(identityPath, "utf8").replace(/(## Bio\n\nOld bio)[\s\S]*$/, "$1\n");
      writeFileSync(identityPath, truncated);

      const result = applyAgentIdentity("ag_eofbio", { bio: "New bio" });
      expect(result.changed).toBe(true);
      const updated = readFileSync(identityPath, "utf8");
      expect(updated).toContain("New bio");
      expect(updated).not.toContain("Old bio");
    });

    it("returns unparseable when the canonical metadata header is missing", () => {
      ensureAgentWorkspace("ag_corrupt", {});
      const identityPath = path.join(agentWorkspaceDir("ag_corrupt"), "identity.md");
      writeFileSync(identityPath, "# Identity\n\nThis file was rewritten by a user.\n");

      const result = applyAgentIdentity("ag_corrupt", { displayName: "X" });
      expect(result.changed).toBe(false);
      expect(result.skipped).toBe("unparseable");
    });

    it("treats display names containing regex specials literally", () => {
      ensureAgentWorkspace("ag_specials", { displayName: "old" });
      const identityPath = path.join(agentWorkspaceDir("ag_specials"), "identity.md");
      const result = applyAgentIdentity("ag_specials", { displayName: "$1 backref $&" });
      expect(result.changed).toBe(true);
      const updated = readFileSync(identityPath, "utf8");
      expect(updated).toContain("- **Display name**: $1 backref $&");
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
