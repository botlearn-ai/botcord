/** Agent sharing: pure helpers for building and describing access grants. */
import type {
  AgentAccessGrant,
  AgentAccessGrantInput,
  AgentAccessRole,
} from "./team-spaces";

export type GrantDuration = "none" | "1d" | "7d" | "30d";
export const GRANT_DURATIONS: GrantDuration[] = ["none", "1d", "7d", "30d"];
const DAYS: Record<Exclude<GrantDuration, "none">, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

export function grantExpiresAt(
  duration: GrantDuration,
  now: Date = new Date(),
): string | null {
  if (duration === "none") return null;
  return new Date(now.getTime() + DAYS[duration] * 86_400_000).toISOString();
}

/** Split a comma- or newline-separated list into unique, trimmed commands. */
export function parseAllowedCommands(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[,\n]/)
        .map((command) => command.trim())
        .filter(Boolean),
    ),
  );
}

export const MAX_ALLOWED_COMMANDS = 20;

export function buildGrantInput(form: {
  userId: string;
  role: AgentAccessRole;
  duration: GrantDuration;
  workspacePath: string;
  commands: string;
  now?: Date;
}): AgentAccessGrantInput {
  const body: AgentAccessGrantInput = {
    user_id: form.userId,
    role: form.role,
    expires_at: grantExpiresAt(form.duration, form.now),
  };
  // Workspace and command allowlist only apply to collaborators.
  if (form.role === "collaborator") {
    body.workspace_path = form.workspacePath.trim() || null;
    body.allowed_commands = parseAllowedCommands(form.commands);
  }
  return body;
}

export function isValidWorkspacePath(path: string): boolean {
  const value = path.trim();
  return !value || value.startsWith("/") || value.startsWith("~/");
}

export function grantRoleLabel(role: AgentAccessRole, zh: boolean): string {
  return role === "collaborator"
    ? zh
      ? "协作者"
      : "Collaborator"
    : zh
      ? "咨询者"
      : "Consultant";
}

export function grantExpiryLabel(
  grant: Pick<AgentAccessGrant, "expires_at">,
  zh: boolean,
  now: Date = new Date(),
): string {
  if (!grant.expires_at) return zh ? "长期有效" : "No expiry";
  if (new Date(grant.expires_at).getTime() <= now.getTime())
    return zh ? "已过期" : "Expired";
  const date = new Date(grant.expires_at).toLocaleString(zh ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return zh ? `有效期至 ${date}` : `Expires ${date}`;
}
