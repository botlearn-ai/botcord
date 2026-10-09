/**
 * Who may do what with whose Agent: the Team agent directory, access requests,
 * per-room capability/reply views, the admin overview, per-sender reply rules
 * and the personal "default permission for others". All calls use user auth.
 */
import type { AgentAccessRole } from "./team-spaces";
import { spaceRequest } from "./team-spaces";
import { grantExpiresAt, parseAllowedCommands, type GrantDuration } from "./agent-access";

export type MyAgentAccess = "owner" | "collaborator" | "consultant" | "none";
/** What a non-owner's messages may make an Agent do. */
export type AgentCapability = "full" | "collaborator" | "consult";
export type ReplyMode = "always" | "mention_only" | "keyword" | "allowed_senders" | "muted";
export type AccessRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface DirectoryAgent {
  agent_id: string;
  display_name: string;
  owner_user_id: string;
  owner_name: string;
  owner_human_id: string;
  my_access: MyAgentAccess;
  grant_id: string | null;
  pending_request: { id: string; requested_role: AgentAccessRole } | null;
  default_reply_mode: ReplyMode;
}
export interface AccessRequest {
  id: string;
  agent_id: string;
  requester_user_id?: string;
  requester_name?: string;
  requester_human_id?: string;
  requested_role: AgentAccessRole;
  message: string | null;
  status: AccessRequestStatus;
  grant_id: string | null;
  created_at: string;
  decided_at: string | null;
}
export interface AccessRequests {
  to_decide: AccessRequest[];
  mine: AccessRequest[];
}
export interface ApproveInput {
  role?: AgentAccessRole;
  workspace_path?: string | null;
  allowed_commands?: string[];
  expires_at?: string | null;
}
export interface RoomAgentAccess {
  agent_id: string;
  display_name: string;
  my_capability: AgentCapability;
  basis: "owner" | "grant" | "room";
  reply_mode: ReplyMode;
  keywords: string[];
}
export interface AgentRoomReply {
  room_id: string;
  name: string;
  kind: string | null;
  reply_mode: ReplyMode;
  keywords: string[];
  inherits_default: boolean;
  sender_rules: { sender_id: string; attention_mode: ReplyMode }[];
}
export interface AccessOverviewGrant {
  grant_id: string;
  agent_id: string;
  agent_name: string;
  owner_name: string;
  grantee_name: string;
  grantee_human_id: string;
  role: AgentAccessRole;
  workspace_path: string | null;
  expires_at: string | null;
  created_at: string;
}
export interface AccessOverview {
  grants: AccessOverviewGrant[];
  counts: { collaborator: number; consultant: number; pending_requests: number };
}
export interface ReplyRule {
  sender_id: string;
  room_id: string | null;
  attention_mode: ReplyMode;
  keywords: string[] | null;
  muted_until: string | null;
}
export interface ReplyRuleInput {
  sender_id: string;
  room_id?: string | null;
  attention_mode: ReplyMode;
  keywords?: string[] | null;
  muted_until?: string | null;
}
export type DefaultCapability = "consult" | "full";

const part = encodeURIComponent;
const spacePath = (id: string) => `/api/spaces/${part(id)}`;
const agentPath = (id: string) => `/api/agents/${part(id)}`;
const post = (body: unknown = {}): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

export const teamAccessApi = {
  directory: (space: string, signal?: AbortSignal) =>
    spaceRequest<{ agents: DirectoryAgent[] }>(`${spacePath(space)}/agent-directory`, { signal }),
  requestAccess: (space: string, agentId: string, role: AgentAccessRole, message?: string) =>
    spaceRequest<AccessRequest>(
      `${spacePath(space)}/agents/${part(agentId)}/access-requests`,
      post(message?.trim() ? { role, message: message.trim() } : { role }),
    ),
  requests: (space: string, status: "pending" | "all" = "pending", signal?: AbortSignal) =>
    spaceRequest<AccessRequests>(`${spacePath(space)}/access-requests?status=${status}`, { signal }),
  approve: (space: string, requestId: string, body: ApproveInput = {}) =>
    spaceRequest<AccessRequest & { grant_role: AgentAccessRole }>(
      `${spacePath(space)}/access-requests/${part(requestId)}/approve`,
      post(body),
    ),
  reject: (space: string, requestId: string) =>
    spaceRequest<AccessRequest>(`${spacePath(space)}/access-requests/${part(requestId)}/reject`, post()),
  cancel: (space: string, requestId: string) =>
    spaceRequest<AccessRequest>(`${spacePath(space)}/access-requests/${part(requestId)}/cancel`, post()),
  roomAgentAccess: (space: string, roomId: string, signal?: AbortSignal) =>
    spaceRequest<{ agents: RoomAgentAccess[] }>(
      `${spacePath(space)}/rooms/${part(roomId)}/agent-access`,
      { signal },
    ),
  agentRooms: (space: string, agentId: string, signal?: AbortSignal) =>
    spaceRequest<{ rooms: AgentRoomReply[] }>(`${spacePath(space)}/agents/${part(agentId)}/rooms`, {
      signal,
    }),
  overview: (space: string, signal?: AbortSignal) =>
    spaceRequest<AccessOverview>(`${spacePath(space)}/access-overview`, { signal }),
};

export const replyRulesApi = {
  list: (agentId: string, signal?: AbortSignal) =>
    spaceRequest<{ rules: ReplyRule[] }>(`${agentPath(agentId)}/reply-rules`, { signal }),
  put: (agentId: string, body: ReplyRuleInput) =>
    spaceRequest<ReplyRule>(`${agentPath(agentId)}/reply-rules`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  remove: (agentId: string, senderId: string, roomId?: string | null) => {
    const params = new URLSearchParams({ sender_id: senderId });
    if (roomId) params.set("room_id", roomId);
    return spaceRequest<void>(`${agentPath(agentId)}/reply-rules?${params}`, { method: "DELETE" });
  },
};

export const agentDefaultAccessApi = {
  get: (agentId: string, signal?: AbortSignal) =>
    spaceRequest<{ default_capability: DefaultCapability }>(`${agentPath(agentId)}/access/relations`, {
      signal,
    }),
  set: (agentId: string, capability: DefaultCapability) =>
    spaceRequest<{ agent_id: string; default_capability: DefaultCapability }>(
      `${agentPath(agentId)}/access/default`,
      { method: "PATCH", body: JSON.stringify({ capability }) },
    ),
};

export type BadgeTone = "owner" | "collaborator" | "consult" | "full" | "none";
export interface AccessBadgeInfo {
  label: string;
  explanation: string;
  tone: BadgeTone;
}

const EXPLAIN = {
  consult: ["只能回答问题和读文件。", "Can only answer questions and read files."],
  collaborator: [
    "在单独的分支里改代码，不会动所有者的原始代码。",
    "Edits code in a separate branch and never touches the owner's original code.",
  ],
  full: [
    "可以在所有者的电脑上运行任何命令。",
    "Can run any command on the owner's computer.",
  ],
} as const;

/** "What I can do" with an Agent in the Team directory. */
export function accessBadge(access: MyAgentAccess, zh: boolean): AccessBadgeInfo {
  const i = zh ? 0 : 1;
  switch (access) {
    case "owner":
      return {
        label: zh ? "所有者" : "Owner",
        explanation: zh ? "这是你的 Agent，你可以使用和管理它。" : "This is your Agent. You can use and manage it.",
        tone: "owner",
      };
    case "collaborator":
      return { label: zh ? "协作" : "Collaborate", explanation: EXPLAIN.collaborator[i], tone: "collaborator" };
    case "consultant":
      return { label: zh ? "只读" : "Read-only", explanation: EXPLAIN.consult[i], tone: "consult" };
    default:
      return {
        label: zh ? "无权限" : "No access",
        explanation: zh ? "还不能使用这个 Agent，可以向所有者申请。" : "You can't use this Agent yet. Ask its owner for access.",
        tone: "none",
      };
  }
}

/** What my messages may make an Agent do (rooms, personal default). */
export function capabilityBadge(capability: AgentCapability, zh: boolean): AccessBadgeInfo {
  const i = zh ? 0 : 1;
  if (capability === "full")
    return { label: zh ? "完整" : "Full", explanation: EXPLAIN.full[i], tone: "full" };
  if (capability === "collaborator")
    return { label: zh ? "协作" : "Collaborate", explanation: EXPLAIN.collaborator[i], tone: "collaborator" };
  return { label: zh ? "只读" : "Read-only", explanation: EXPLAIN.consult[i], tone: "consult" };
}

/** Requested/granted role with its plain-language meaning. */
export function roleBadge(role: AgentAccessRole, zh: boolean): AccessBadgeInfo {
  return accessBadge(role, zh);
}

export const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  owner: "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan",
  collaborator: "border-neon-purple/30 bg-neon-purple/10 text-neon-purple",
  consult: "border-neon-green/30 bg-neon-green/10 text-neon-green",
  full: "border-red-500/30 bg-red-500/10 text-red-500",
  none: "border-glass-border bg-glass-bg text-text-secondary",
};

/** Requesting makes sense with no access, or to upgrade read-only to collaborate. */
export function canRequestAccess(agent: Pick<DirectoryAgent, "my_access">): boolean {
  return agent.my_access === "none" || agent.my_access === "consultant";
}

export function canChatWith(agent: Pick<DirectoryAgent, "my_access">): boolean {
  return agent.my_access !== "none";
}

/** Composer hint about when an Agent replies; null when it always replies. */
export function replyModeHint(
  name: string,
  mode: ReplyMode,
  keywords: string[],
  zh: boolean,
): string | null {
  switch (mode) {
    case "mention_only":
      return zh ? `${name} 只在被 @ 时回复` : `${name} only replies when @mentioned`;
    case "keyword": {
      const list = keywords.join(zh ? "、" : ", ");
      if (!list) return zh ? `${name} 只在提到关键词时回复` : `${name} only replies to keywords`;
      return zh ? `${name} 只在提到关键词 ${list} 时回复` : `${name} only replies when you mention ${list}`;
    }
    case "allowed_senders":
      return zh ? `${name} 只回复指定的人` : `${name} only replies to selected people`;
    case "muted":
      return zh ? `${name} 暂时不会回复` : `${name} is muted for now`;
    default:
      return null;
  }
}

export function replyModeLabel(mode: ReplyMode | "inherit", zh: boolean): string {
  const labels: Record<ReplyMode | "inherit", [string, string]> = {
    inherit: ["跟随默认", "Use default"],
    always: ["每条都回复", "Every message"],
    mention_only: ["只在被 @ 时", "Only when @mentioned"],
    keyword: ["只在提到关键词时", "Only on keywords"],
    allowed_senders: ["只回复指定的人", "Selected people only"],
    muted: ["暂停回复", "Muted"],
  };
  return labels[mode][zh ? 0 : 1];
}

/** Split comma/、/newline separated keywords into a unique, trimmed list. */
export function parseKeywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[,，、\n]/)
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  );
}

export function pendingToDecide(requests: AccessRequests, agentId?: string): AccessRequest[] {
  return requests.to_decide.filter(
    (r) => r.status === "pending" && (!agentId || r.agent_id === agentId),
  );
}

/** My latest request per Agent (newest first input), for showing its status. */
export function latestRequestByAgent(mine: AccessRequest[]): Record<string, AccessRequest> {
  const out: Record<string, AccessRequest> = {};
  for (const r of mine) {
    const prev = out[r.agent_id];
    if (!prev || new Date(r.created_at).getTime() > new Date(prev.created_at).getTime())
      out[r.agent_id] = r;
  }
  return out;
}

/** Approval body: workspace/commands only apply to collaborators. */
export function buildApproveInput(form: {
  role: AgentAccessRole;
  duration: GrantDuration;
  workspacePath: string;
  commands: string;
  now?: Date;
}): ApproveInput {
  const body: ApproveInput = {
    role: form.role,
    expires_at: grantExpiresAt(form.duration, form.now),
  };
  if (form.role === "collaborator") {
    body.workspace_path = form.workspacePath.trim() || null;
    body.allowed_commands = parseAllowedCommands(form.commands);
  }
  return body;
}
