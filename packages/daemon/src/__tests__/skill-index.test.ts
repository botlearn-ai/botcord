import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentCodexHomeDir,
  agentWorkspaceDir,
} from "../agent-workspace.js";
import {
  buildSoftSkillIndexPrompt,
  collectAgentSkillSnapshot,
  scanSoftSkills,
} from "../skill-index.js";

let tmpDir = "";
let prevHome: string | undefined;

function writeSkill(dir: string, name: string, description: string): void {
  const skillDir = path.join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`,
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "skill-index-"));
  prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("skill snapshots", () => {
  it("scans agent workspace/runtime-global skills and maps UI source buckets", () => {
    const agentId = "ag_skilltest";
    writeSkill(path.join(agentWorkspaceDir(agentId), ".claude", "skills"), "workspace-skill", "Workspace skill");
    writeSkill(path.join(agentCodexHomeDir(agentId), "skills"), "codex-skill", "Codex skill");
    writeSkill(path.join(tmpDir, ".codex", "skills"), "global-skill", "Global skill");

    const scanned = scanSoftSkills(agentId);
    expect(scanned.map((s) => s.name).sort()).toEqual([
      "codex-skill",
      "global-skill",
      "workspace-skill",
    ]);

    const snapshot = collectAgentSkillSnapshot(agentId);
    expect(snapshot.agentId).toBe(agentId);
    expect(snapshot.skills).toHaveLength(3);
    expect(snapshot.skills.find((s) => s.name === "workspace-skill")?.source)
      .toBe("workspace");
    expect(snapshot.skills.find((s) => s.name === "codex-skill")?.source)
      .toBe("workspace");
    expect(snapshot.skills.find((s) => s.name === "global-skill")?.source)
      .toBe("runtime-global");
    expect(snapshot.probedAt).toBeGreaterThan(0);
  });

  it("returns complete snapshots while keeping the prompt soft index capped", () => {
    const agentId = "ag_manyskills";
    const workspaceSkills = path.join(agentWorkspaceDir(agentId), ".claude", "skills");
    for (let i = 0; i < 30; i += 1) {
      const name = `skill-${String(i).padStart(2, "0")}`;
      writeSkill(workspaceSkills, name, `Skill ${i}`);
    }

    const scanned = scanSoftSkills(agentId);
    expect(scanned).toHaveLength(30);
    expect(scanned.map((s) => s.name)).toEqual(
      Array.from({ length: 30 }, (_, i) => `skill-${String(i).padStart(2, "0")}`),
    );

    const snapshot = collectAgentSkillSnapshot(agentId);
    expect(snapshot.skills).toHaveLength(30);

    const prompt = buildSoftSkillIndexPrompt(agentId);
    expect(prompt).not.toBeNull();
    const skillLines = prompt
      ?.split("\n")
      .filter((line) => line.startsWith("- skill-"));
    expect(skillLines).toHaveLength(24);
    expect(skillLines?.at(0)).toContain("skill-00");
    expect(skillLines?.at(-1)).toContain("skill-23");
  });
});
