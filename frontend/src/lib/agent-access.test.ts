import { describe, expect, it } from "vitest";
import {
  buildGrantInput,
  grantExpiresAt,
  grantExpiryLabel,
  isValidWorkspacePath,
  parseAllowedCommands,
} from "./agent-access";
import type { AgentAccessGrant } from "./team-spaces";

const now = new Date("2026-09-28T00:00:00.000Z");

describe("agent access helpers", () => {
  it("computes expiry from the selected duration", () => {
    expect(grantExpiresAt("none", now)).toBeNull();
    expect(grantExpiresAt("1d", now)).toBe("2026-09-29T00:00:00.000Z");
    expect(grantExpiresAt("30d", now)).toBe("2026-10-28T00:00:00.000Z");
  });
  it("splits commands by comma or newline, dropping blanks and duplicates", () => {
    expect(parseAllowedCommands("npm test, npm run lint\n\n npm test ,")).toEqual([
      "npm test",
      "npm run lint",
    ]);
  });
  it("sends workspace and commands only for collaborators", () => {
    const base = {
      userId: "u1",
      duration: "7d" as const,
      workspacePath: " ~/repo ",
      commands: "npm test",
      now,
    };
    expect(buildGrantInput({ ...base, role: "consultant" })).toEqual({
      user_id: "u1",
      role: "consultant",
      expires_at: "2026-10-05T00:00:00.000Z",
    });
    expect(buildGrantInput({ ...base, role: "collaborator" })).toEqual({
      user_id: "u1",
      role: "collaborator",
      expires_at: "2026-10-05T00:00:00.000Z",
      workspace_path: "~/repo",
      allowed_commands: ["npm test"],
    });
    expect(
      buildGrantInput({ ...base, role: "collaborator", workspacePath: "  ", commands: "" }),
    ).toMatchObject({ workspace_path: null, allowed_commands: [] });
  });
  it("accepts only absolute or home-relative workspace paths", () => {
    expect(isValidWorkspacePath("")).toBe(true);
    expect(isValidWorkspacePath("/srv/repo")).toBe(true);
    expect(isValidWorkspacePath("~/repo")).toBe(true);
    expect(isValidWorkspacePath("repo")).toBe(false);
  });
  it("labels unlimited and expired grants", () => {
    const grant = { expires_at: null } as AgentAccessGrant;
    expect(grantExpiryLabel(grant, true, now)).toBe("长期有效");
    expect(
      grantExpiryLabel({ ...grant, expires_at: "2026-09-27T00:00:00Z" }, true, now),
    ).toBe("已过期");
  });
});
