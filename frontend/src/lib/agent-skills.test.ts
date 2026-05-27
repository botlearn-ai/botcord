import { describe, expect, it } from "vitest";
import {
  createAgentSkillsRequestGuard,
  groupAgentSkills,
  normalizeAgentSkillSnapshot,
} from "./agent-skills";

describe("normalizeAgentSkillSnapshot", () => {
  it("keeps runtime-global and workspace skills from Hub snapshots", () => {
    const snapshot = normalizeAgentSkillSnapshot(
      {
        agent_id: "ag_1",
        daemon_instance_id: "dm_1",
        runtime: "codex",
        sniffed_at: "2026-05-27T00:00:00Z",
        skills: [
          {
            id: "skill_global",
            name: "openai-docs",
            source: "runtime_global",
            description: "OpenAI API docs helper",
            path: "/home/user/.codex/skills/openai-docs/SKILL.md",
          },
          {
            name: "botcord",
            source: "workspace",
            updated_at: "2026-05-26T00:00:00Z",
          },
          {
            name: "ignored",
            source: "memory",
          },
        ],
      },
      "ag_fallback",
    );

    expect(snapshot.agentId).toBe("ag_1");
    expect(snapshot.daemonInstanceId).toBe("dm_1");
    expect(snapshot.runtime).toBe("codex");
    expect(snapshot.sniffedAt).toBe("2026-05-27T00:00:00Z");
    expect(snapshot.skills).toHaveLength(2);
    expect(snapshot.skills[0]).toMatchObject({
      id: "skill_global",
      name: "openai-docs",
      source: "runtime-global",
      description: "OpenAI API docs helper",
    });
    expect(snapshot.skills[1]).toMatchObject({
      name: "botcord",
      source: "workspace",
      updatedAt: "2026-05-26T00:00:00Z",
    });
  });

  it("accepts alternate item response shape and builds stable fallback ids", () => {
    const snapshot = normalizeAgentSkillSnapshot(
      {
        agentId: "ag_2",
        items: [
          {
            slug: "custom-skill",
            kind: "global",
          },
        ],
      },
      "ag_fallback",
    );

    expect(snapshot.skills).toEqual([
      {
        id: "runtime-global:custom-skill:0",
        name: "custom-skill",
        source: "runtime-global",
        description: undefined,
        runtime: undefined,
        path: undefined,
        file: undefined,
        updatedAt: undefined,
        mtimeMs: undefined,
      },
    ]);
  });
});

describe("groupAgentSkills", () => {
  it("splits skills by display source", () => {
    const grouped = groupAgentSkills([
      { id: "a", name: "A", source: "runtime-global" },
      { id: "b", name: "B", source: "workspace" },
    ]);

    expect(grouped["runtime-global"].map((skill) => skill.name)).toEqual(["A"]);
    expect(grouped.workspace.map((skill) => skill.name)).toEqual(["B"]);
  });
});

describe("createAgentSkillsRequestGuard", () => {
  it("rejects a completed request after the current agent changes", () => {
    const guard = createAgentSkillsRequestGuard("ag_old");
    const oldRequest = guard.begin("ag_old", "load");

    guard.setAgentId("ag_new");
    const newRequest = guard.begin("ag_new", "load");

    expect(guard.canCommit(oldRequest)).toBe(false);
    expect(guard.canFinishOperation(oldRequest)).toBe(false);
    expect(guard.canCommit(newRequest)).toBe(true);
    expect(guard.canFinishOperation(newRequest)).toBe(true);
  });

  it("lets a committed lifecycle update invalidate previous-agent loading and finally paths", () => {
    const guard = createAgentSkillsRequestGuard("ag_old");
    const oldRequest = guard.begin("ag_old", "load");

    guard.setAgentId("ag_new");

    expect(guard.canCommit(oldRequest)).toBe(false);
    expect(guard.canFinishOperation(oldRequest)).toBe(false);
  });

  it("lets a new request establish the current agent without render-time mutation", () => {
    const guard = createAgentSkillsRequestGuard("ag_old");
    const oldRequest = guard.begin("ag_old", "load");
    const newRequest = guard.begin("ag_new", "load");

    expect(guard.canCommit(oldRequest)).toBe(false);
    expect(guard.canFinishOperation(oldRequest)).toBe(false);
    expect(guard.canCommit(newRequest)).toBe(true);
    expect(guard.canFinishOperation(newRequest)).toBe(true);
  });

  it("lets cleanup invalidate same-agent success, error, and finally paths", () => {
    const guard = createAgentSkillsRequestGuard("ag_1");
    const request = guard.begin("ag_1", "load");

    guard.invalidate();

    expect(guard.canCommit(request)).toBe(false);
    expect(guard.canFinishOperation(request)).toBe(false);
  });

  it("only accepts the newest request for the same agent", () => {
    const guard = createAgentSkillsRequestGuard("ag_1");
    const initialLoad = guard.begin("ag_1", "load");
    const refresh = guard.begin("ag_1", "refresh");

    expect(guard.canCommit(initialLoad)).toBe(false);
    expect(guard.canCommit(refresh)).toBe(true);
  });

  it("lets older load cleanup run after a newer refresh request starts", () => {
    const guard = createAgentSkillsRequestGuard("ag_1");
    const load = guard.begin("ag_1", "load");
    const refresh = guard.begin("ag_1", "refresh");

    expect(guard.canCommit(load)).toBe(false);
    expect(guard.canFinishOperation(load)).toBe(true);
    expect(guard.canCommit(refresh)).toBe(true);
    expect(guard.canFinishOperation(refresh)).toBe(true);
  });

  it("does not let older same-operation cleanup clear a newer busy state", () => {
    const guard = createAgentSkillsRequestGuard("ag_1");
    const firstRefresh = guard.begin("ag_1", "refresh");
    const secondRefresh = guard.begin("ag_1", "refresh");

    expect(guard.canCommit(firstRefresh)).toBe(false);
    expect(guard.canFinishOperation(firstRefresh)).toBe(false);
    expect(guard.canCommit(secondRefresh)).toBe(true);
    expect(guard.canFinishOperation(secondRefresh)).toBe(true);
  });
});
