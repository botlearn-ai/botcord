import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentCodexHomeDir,
  agentWorkspaceDir,
} from "../agent-workspace.js";
import {
  buildVercelSkillsArgs,
  installAgentSkillManifest,
  installBotLearnArchiveManifest,
  installVercelSkillsForAgent,
} from "../skill-installer.js";

let tmpHome = "";
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "skill-installer-"));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("skill installer", () => {
  it("installs a manifest into the loaded agent runtime path and returns a refreshed snapshot", () => {
    const result = installAgentSkillManifest(
      "ag_manifest",
      {
        name: "review-helper",
        description: "Review pull requests",
        files: [{ path: "references/checklist.md", content: "Check tests\n" }],
      },
      { runtime: "codex" },
    );

    const skillDir = path.join(agentCodexHomeDir("ag_manifest"), "skills", "review-helper");
    expect(readFileSync(path.join(skillDir, "SKILL.md"), "utf8")).toContain("name: review-helper");
    expect(readFileSync(path.join(skillDir, "references", "checklist.md"), "utf8")).toBe("Check tests\n");
    expect(result.installed).toEqual([
      {
        name: "review-helper",
        targets: ["codex"],
        paths: [skillDir],
      },
    ]);
    expect(result.snapshot.skills.map((s) => s.name)).toContain("review-helper");
  });

  it("installs BotLearn archive-style manifests containing multiple skills", () => {
    const result = installBotLearnArchiveManifest(
      "ag_archive",
      {
        targetRuntimes: ["claude-code"],
        skills: [
          {
            id: "planner",
            description: "Plan work",
            skillMd: "---\nname: planner\ndescription: Plan work\n---\n\n# Planner\n",
          },
          {
            name: "tester",
            markdown: "---\nname: tester\n---\n\n# Tester\n",
          },
        ],
      },
      { runtime: "claude-code" },
    );

    const skillsRoot = path.join(agentWorkspaceDir("ag_archive"), ".claude", "skills");
    expect(existsSync(path.join(skillsRoot, "planner", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(skillsRoot, "tester", "SKILL.md"))).toBe(true);
    expect(result.installed.map((skill) => skill.name)).toEqual(["planner", "tester"]);
    expect(result.snapshot.skills.map((skill) => skill.name).sort()).toEqual(["planner", "tester"]);
  });

  it("rejects unsafe names and file paths before writing", () => {
    expect(() => installAgentSkillManifest("ag_unsafe_name", {
      name: "../bad",
    })).toThrow(/unsafe skill name/);

    expect(() => installAgentSkillManifest("ag_unsafe_file", {
      name: "safe",
      files: [{ path: "../escape.txt", content: "no" }],
    })).toThrow(/unsafe skill file path/);
  });

  it("does not leave a partial skill dir when source file validation fails", () => {
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "skill-source-"));
    try {
      expect(() => installAgentSkillManifest("ag_missing_source", {
        name: "missing-source",
        files: [{ path: "references/missing.md", sourcePath: "missing.md" }],
      }, {
        runtime: "codex",
        sourceRoot,
      })).toThrow();

      const skillDir = path.join(agentCodexHomeDir("ag_missing_source"), "skills", "missing-source");
      expect(existsSync(skillDir)).toBe(false);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("does not leave a partial skill dir when an inline file is oversized", () => {
    const oversized = "x".repeat((256 * 1024) + 1);

    expect(() => installAgentSkillManifest("ag_oversized", {
      name: "oversized",
      files: [{ path: "references/large.md", content: oversized }],
    }, {
      runtime: "codex",
    })).toThrow(/skill file too large/);

    const skillDir = path.join(agentCodexHomeDir("ag_oversized"), "skills", "oversized");
    expect(existsSync(skillDir)).toBe(false);
  });

  it("builds a non-interactive vercel-labs/skills command for injected execution", () => {
    expect(buildVercelSkillsArgs("https://github.com/vercel-labs/skills", ["frontend-design"], ["codex"]))
      .toEqual([
        "--yes",
        "skills",
        "add",
        "https://github.com/vercel-labs/skills",
        "--global",
        "--copy",
        "--yes",
        "--skill",
        "frontend-design",
        "--agent",
        "codex",
      ]);
  });

  it("imports skills produced by an injected vercel-labs/skills executor without network", async () => {
    const executor = vi.fn(async (_command, _args, options) => {
      const home = options.env?.HOME as string;
      const namespaced = path.join(home, ".codex", "skills", "vercel-labs", "find-skills");
      mkdirSync(namespaced, { recursive: true });
      writeFileSync(
        path.join(namespaced, "SKILL.md"),
        "---\nname: find-skills\ndescription: Find skills\n---\n\n# Find Skills\n",
      );
    });

    const result = await installVercelSkillsForAgent({
      agentId: "ag_vercel",
      packageSpec: "https://github.com/vercel-labs/skills",
      skills: ["find-skills"],
      runtime: "codex",
      executor,
    });

    const installed = path.join(agentCodexHomeDir("ag_vercel"), "skills", "find-skills", "SKILL.md");
    expect(existsSync(installed)).toBe(true);
    expect(result.installed).toEqual([
      {
        name: "find-skills",
        targets: ["codex"],
        paths: [path.dirname(installed)],
      },
    ]);
    expect(result.snapshot.skills.map((skill) => skill.name)).toContain("find-skills");
    expect(executor).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["skills", "add", "https://github.com/vercel-labs/skills"]),
      expect.objectContaining({ cwd: agentWorkspaceDir("ag_vercel") }),
    );
  });

  it("rejects untrusted vercel package specs", async () => {
    await expect(installVercelSkillsForAgent({
      agentId: "ag_untrusted_vercel",
      packageSpec: "attacker/skills",
      runtime: "codex",
      executor: vi.fn(),
    })).rejects.toThrow(/unsupported vercel skills packageSpec/);
  });

  it("rejects symlinked files from vercel skill import without installing a skill dir", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "skill-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.txt"), "do not copy");
      const executor = vi.fn(async (_command, _args, options) => {
        const home = options.env?.HOME as string;
        const skillDir = path.join(home, ".codex", "skills", "vercel-labs", "linked-skill");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          path.join(skillDir, "SKILL.md"),
          "---\nname: linked-skill\n---\n\n# Linked Skill\n",
        );
        symlinkSync(path.join(outside, "secret.txt"), path.join(skillDir, "secret.txt"));
      });

      await expect(installVercelSkillsForAgent({
        agentId: "ag_vercel_symlink",
        packageSpec: "https://github.com/vercel-labs/skills",
        runtime: "codex",
        executor,
      })).rejects.toThrow(/rejects symlink/);

      const skillDir = path.join(agentCodexHomeDir("ag_vercel_symlink"), "skills", "linked-skill");
      expect(existsSync(skillDir)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
