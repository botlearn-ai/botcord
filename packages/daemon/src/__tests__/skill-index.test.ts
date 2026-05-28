import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentCodexHomeDir,
  agentHermesHomeDir,
  agentWorkspaceDir,
} from "../agent-workspace.js";
import { hermesProfileHomeDir } from "../gateway/runtimes/hermes-agent.js";
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
  it("scopes scans to the selected runtime and maps UI source buckets", () => {
    const agentId = "ag_skilltest";
    const claudePath = path.join(agentWorkspaceDir(agentId), ".claude", "skills");
    const codexPath = path.join(agentCodexHomeDir(agentId), "skills");
    writeSkill(claudePath, "claude-skill", "Claude skill");
    writeSkill(codexPath, "codex-skill", "Codex skill");
    writeSkill(path.join(tmpDir, ".claude", "skills"), "global-claude", "Global Claude");
    writeSkill(path.join(tmpDir, ".codex", "skills"), "global-codex", "Global Codex");

    const claudeScanned = scanSoftSkills(agentId, { runtime: "claude-code" });
    expect(claudeScanned.map((s) => s.name).sort()).toEqual([
      "claude-skill",
      "global-claude",
    ]);
    expect(claudeScanned.every((s) => s.runtime === "claude-code")).toBe(true);

    const codexScanned = scanSoftSkills(agentId, { runtime: "codex" });
    expect(codexScanned.map((s) => s.name).sort()).toEqual([
      "codex-skill",
      "global-codex",
    ]);
    expect(codexScanned.every((s) => s.runtime === "codex")).toBe(true);

    const snapshot = collectAgentSkillSnapshot(agentId, { runtime: "codex" });
    expect(snapshot.agentId).toBe(agentId);
    expect(snapshot.runtime).toBe("codex");
    expect(snapshot.skills).toHaveLength(2);
    expect(snapshot.skills.find((s) => s.name === "codex-skill")?.source)
      .toBe("workspace");
    expect(snapshot.skills.find((s) => s.name === "codex-skill")?.sourceDetail)
      .toBe("agent-codex");
    expect(snapshot.skills.find((s) => s.name === "codex-skill")?.path)
      .toBe(path.join(codexPath, "codex-skill", "SKILL.md"));
    expect(snapshot.skills.find((s) => s.name === "global-codex")?.source)
      .toBe("runtime-global");
    expect(snapshot.probedAt).toBeGreaterThan(0);
  });

  it("scans Codex .system skills and prefers Codex copies for Codex agents", () => {
    const agentId = "ag_codex_system";
    writeSkill(path.join(agentWorkspaceDir(agentId), ".claude", "skills"), "shared", "Claude copy");
    writeSkill(path.join(agentCodexHomeDir(agentId), "skills"), "shared", "Codex copy");
    writeSkill(
      path.join(agentCodexHomeDir(agentId), "skills", ".system"),
      "agent-system",
      "Agent Codex system skill",
    );
    writeSkill(
      path.join(tmpDir, ".codex", "skills", ".system"),
      "imagegen",
      "Codex global system skill",
    );

    const codexScanned = scanSoftSkills(agentId, { runtime: "codex" });
    expect(codexScanned.map((s) => s.name).sort()).toEqual([
      "agent-system",
      "imagegen",
      "shared",
    ]);
    expect(codexScanned.find((s) => s.name === "shared")).toMatchObject({
      source: "agent-codex",
      description: "Codex copy",
    });

    const claudeScanned = scanSoftSkills(agentId, { runtime: "claude-code" });
    expect(claudeScanned.find((s) => s.name === "shared")).toMatchObject({
      source: "agent-claude",
      description: "Claude copy",
    });

    const snapshot = collectAgentSkillSnapshot(agentId, { runtime: "codex" });
    expect(snapshot.skills.find((s) => s.name === "agent-system")?.source)
      .toBe("workspace");
    expect(snapshot.skills.find((s) => s.name === "imagegen")?.source)
      .toBe("runtime-global");
  });

  it("scans Hermes home/profile skills without mixing Claude or Codex dirs", () => {
    const agentId = "ag_hermes_skills";
    writeSkill(path.join(agentWorkspaceDir(agentId), ".claude", "skills"), "claude-only", "Claude only");
    writeSkill(path.join(agentCodexHomeDir(agentId), "skills"), "codex-only", "Codex only");
    writeSkill(path.join(agentHermesHomeDir(agentId), "skills"), "hermes-only", "Hermes only");

    const isolated = scanSoftSkills(agentId, { runtime: "hermes-agent" });
    expect(isolated.map((s) => s.name)).toEqual(["hermes-only"]);
    expect(isolated[0]).toMatchObject({
      source: "agent-hermes",
      runtime: "hermes-agent",
    });

    const profileAgentId = "ag_hermes_profile";
    writeSkill(
      path.join(hermesProfileHomeDir("writer"), "skills"),
      "profile-skill",
      "Hermes profile skill",
    );
    const profile = collectAgentSkillSnapshot(profileAgentId, {
      runtime: "hermes-agent",
      hermesProfile: "writer",
    });
    expect(profile.skills).toHaveLength(1);
    expect(profile.skills[0]).toMatchObject({
      name: "profile-skill",
      source: "workspace",
      sourceDetail: "agent-hermes-profile",
      runtime: "hermes-agent",
      profile: "writer",
    });
  });

  it("keeps same-device workspace skills scoped by agent id", () => {
    writeSkill(
      path.join(agentWorkspaceDir("ag_workspace_a"), ".claude", "skills"),
      "agent-local",
      "Skill for agent A",
    );
    writeSkill(
      path.join(agentWorkspaceDir("ag_workspace_b"), ".claude", "skills"),
      "agent-local",
      "Skill for agent B",
    );

    expect(scanSoftSkills("ag_workspace_a", { runtime: "claude-code" })).toEqual([
      expect.objectContaining({
        name: "agent-local",
        description: "Skill for agent A",
        source: "agent-claude",
      }),
    ]);
    expect(scanSoftSkills("ag_workspace_b", { runtime: "claude-code" })).toEqual([
      expect.objectContaining({
        name: "agent-local",
        description: "Skill for agent B",
        source: "agent-claude",
      }),
    ]);
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
