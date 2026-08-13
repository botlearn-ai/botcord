import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApplySessionProfileParams } from "@botcord/protocol-core";
import type { GatewayRoute } from "../gateway/index.js";

const fakeHome = mkdtempSync(path.join(tmpdir(), "botcord-session-profile-test-"));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => fakeHome };
});

const {
  applySessionProfile,
  buildSessionProfilePrompt,
  cleanupExpiredSessionProfiles,
  getSessionProfileStatus,
} = await import("../session-profile.js");
const { agentSessionProfileDir } = await import("../agent-workspace.js");

function packageDigest(files: Record<string, string>): string {
  const digest = createHash("sha256");
  for (const relative of Object.keys(files).sort()) {
    digest.update(relative, "utf8");
    digest.update("\0");
    digest.update(Buffer.from(files[relative]!, "utf8"));
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function profile(roomId = "rm_oc_course_a"): ApplySessionProfileParams {
  const files = {
    "SKILL.md": "# Strategy\n\nUse the evidence checklist.",
    "references/checklist.md": "# Checklist\n\n- Evidence",
  };
  const refContent = files["references/checklist.md"];
  return {
    agentId: "ag_course",
    sessionKey: `course_run:${roomId}`,
    roomId,
    schemaVersion: "botlearn-course-runtime-profile/0.1",
    profileId: "crp_1234567890",
    profileHash: `sha256:${"1".repeat(64)}`,
    courseVersionId: "58ba4dc9-e8c6-4e58-9fd0-3c13fa682c36",
    promptPack: {
      id: "botlearn.executor.ai-creator",
      version: "1.0.0",
      digest: `sha256:${"2".repeat(64)}`,
      systemInstructions: "Use a source-grounded plan and stay inside the task contract.",
    },
    skillPackages: [{
      id: "botlearn.plan-ai-creator-strategy",
      version: "0.1.0",
      digest: packageDigest(files),
      archiveManifest: {
        name: "botlearn.plan-ai-creator-strategy",
        skillMd: files["SKILL.md"],
        files: [{
          path: "references/checklist.md",
          content: refContent,
          size: Buffer.byteLength(refContent),
          sha256: createHash("sha256").update(refContent).digest("hex"),
        }],
      },
    }],
    requiredCapabilities: ["web.search", "workspace.write"],
    ttlSeconds: 900,
  };
}

function route(runtime = "deepseek-tui", extraArgs?: string[]): GatewayRoute {
  const cwd = path.join(fakeHome, "workspace");
  mkdirSync(cwd, { recursive: true });
  return {
    runtime,
    cwd,
    ...(extraArgs ? { extraArgs } : {}),
    match: { accountId: "ag_course" },
  };
}

beforeAll(() => mkdirSync(fakeHome, { recursive: true }));
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

describe("BotLearn session profile overlay", () => {
  it("materializes a digest-verified profile and injects it only into the matching room", () => {
    const input = profile();
    const status = applySessionProfile(input, route());

    expect(status).toMatchObject({
      status: "applied",
      profileId: input.profileId,
      appliedSkillRefs: ["botlearn.plan-ai-creator-strategy@0.1.0"],
      availableCapabilities: ["web.search", "workspace.write"],
      missingCapabilities: [],
    });
    const prompt = buildSessionProfilePrompt(input.agentId, input.roomId);
    expect(prompt).toContain("[BotLearn Course Session Profile]");
    expect(prompt).toContain(input.promptPack.systemInstructions);
    expect(prompt).toContain("botlearn.plan-ai-creator-strategy@0.1.0");
    expect(buildSessionProfilePrompt(input.agentId, "rm_oc_other_course")).toBeNull();

    const stored = JSON.parse(readFileSync(
      path.join(agentSessionProfileDir(input.agentId, input.roomId), "profile.json"),
      "utf8",
    ));
    expect(stored.sessionKey).toBe(input.sessionKey);
    expect(stored.promptPack.ref).toBe("botlearn.executor.ai-creator@1.0.0");
    expect(stored.skills[0].skillMdPath).not.toContain(".staging-");
    expect(existsSync(stored.skills[0].skillMdPath)).toBe(true);
  });

  it("reports requirements unmet without treating course requirements as authorization", () => {
    const input = profile("rm_oc_codex_without_search");
    const status = applySessionProfile(input, route("codex"));
    expect(status.status).toBe("requirements_unmet");
    expect(status.availableCapabilities).toEqual(["workspace.write"]);
    expect(status.missingCapabilities).toEqual(["web.search"]);
    expect(buildSessionProfilePrompt(input.agentId, input.roomId)).toContain(
      "Do not execute the course task",
    );
  });

  it("rejects package digest drift and traversal before publishing a session directory", () => {
    const drifted = profile("rm_oc_drifted");
    drifted.skillPackages[0]!.archiveManifest.files![0]!.content = "changed";
    expect(() => applySessionProfile(drifted, route())).toThrow(/size mismatch|digest mismatch/);
    expect(getSessionProfileStatus(drifted.agentId, drifted.roomId)).toBeNull();

    const traversal = profile("rm_oc_traversal");
    traversal.skillPackages[0]!.archiveManifest.files![0]!.path = "../escape.md";
    expect(() => applySessionProfile(traversal, route())).toThrow(/unsafe session skill path/);
    expect(getSessionProfileStatus(traversal.agentId, traversal.roomId)).toBeNull();
  });

  it("removes expired session state without touching another room", () => {
    const expired = profile("rm_oc_expired");
    const active = profile("rm_oc_active");
    active.ttlSeconds = 1_800;
    applySessionProfile(expired, route());
    applySessionProfile(active, route());
    const future = Date.now() + 901_000;
    expect(cleanupExpiredSessionProfiles(expired.agentId, future)).toBeGreaterThanOrEqual(2);
    expect(getSessionProfileStatus(expired.agentId, expired.roomId)).toBeNull();
    expect(getSessionProfileStatus(active.agentId, active.roomId)).not.toBeNull();
  });
});
