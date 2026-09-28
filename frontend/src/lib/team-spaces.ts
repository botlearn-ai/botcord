/** User-authenticated Team governance. These calls never select an Agent actor. */
import { ApiError, apiFetch, publicApiFetch } from "./api";

export type MembershipStatus = "invited" | "active" | "suspended" | "removed";
export type SpaceRole = "owner" | "admin" | "member";
export interface Membership {
  id: string;
  space_id: string;
  status: MembershipStatus;
  version: number;
}
export interface TeamSpace {
  id: string;
  kind: "personal" | "organization";
  status: "active" | "suspended" | "archived";
  membership: Membership;
  roles: SpaceRole[];
  organization_id: string | null;
  name: string | null;
  policy_version: number;
  admin_dm_content_access_enabled: boolean;
  external_communication_enabled: boolean;
  organization_execution_available: boolean;
  organization_messaging_available?: boolean;
  agent_direct_admission_available?: boolean;
}
export interface SpaceUser extends Membership {
  user_id: string;
  human_id: string;
  display_name: string;
  roles: SpaceRole[];
}
export interface SpaceAgent extends Membership {
  agent_id: string;
  display_name: string;
  sponsor_user_membership_id: string;
}
export interface SpaceMembers {
  users: SpaceUser[];
  agents: SpaceAgent[];
}
export type AgentAccessRole = "consultant" | "collaborator";
export interface AgentAccessGrant {
  id: string;
  space_id: string;
  agent_id: string;
  agent_name: string | null;
  grantee_user_id: string;
  grantee_human_id: string | null;
  grantee_name: string | null;
  granted_by_user_id: string;
  granted_by_name: string | null;
  role: AgentAccessRole;
  workspace_path: string | null;
  allowed_commands: string[];
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
export interface AgentAccessGrantInput {
  user_id: string;
  role: AgentAccessRole;
  expires_at: string | null;
  workspace_path?: string | null;
  allowed_commands?: string[];
}

export type InviteLinkStatus = "active" | "expired" | "exhausted" | "revoked";
export interface InviteLink {
  id: string;
  space_id: string;
  code: string;
  path: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  status: InviteLinkStatus;
  /** Who the (personal) link is meant for, e.g. "Alice". */
  label: string | null;
  /** Latest member who joined through the link (the only one for single-use links). */
  redeemed_by_name: string | null;
  redeemed_at: string | null;
  created_at: string;
}
export interface InviteLinkInput {
  expires_in_days: number | null;
  max_uses: number | null;
  label?: string | null;
}
export interface OrgInvitePreview {
  space_id: string;
  organization_name: string;
  inviter_name: string | null;
  member_count: number;
  status: InviteLinkStatus | "unavailable";
  expires_at: string | null;
  /** Personal link meant for one person. */
  single_use?: boolean;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  fetcher: (path: string, init: RequestInit) => Promise<Response> = (p, i) => apiFetch(p, i, null),
): Promise<T> {
  const response = await fetcher(path, { ...init, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      typeof body.detail === "string" ? body.detail : "space_request_failed",
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const part = encodeURIComponent;
const spacePath = (id: string) => `/api/spaces/${part(id)}`;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body ? { body: JSON.stringify(body) } : {}),
});

export const teamSpacesApi = {
  list: (signal?: AbortSignal) =>
    request<{ spaces: TeamSpace[] }>("/api/spaces", { signal }),
  members: (id: string, signal?: AbortSignal) =>
    request<SpaceMembers>(`${spacePath(id)}/members`, { signal }),
  create: (name: string, slug: string) =>
    request<{ id: string; space_id: string }>(
      "/api/organizations",
      post({ name, slug }),
    ),
  invite: (id: string, humanId: string) =>
    request<Membership>(
      `${spacePath(id)}/invitations`,
      post({ human_id: humanId }),
    ),
  accept: (id: string) =>
    request<Membership>(`${spacePath(id)}/invitations/accept`, post()),
  removeUser: (id: string, userId: string) =>
    request<void>(`${spacePath(id)}/members/${part(userId)}`, {
      method: "DELETE",
    }),
  requestAgent: (id: string, agentId: string) =>
    request<Membership>(
      `${spacePath(id)}/agents/${part(agentId)}/admission`,
      post(),
    ),
  addOwnedAgent: (id: string, agentId: string) =>
    request<Membership>(`${spacePath(id)}/agents/${part(agentId)}/admission/add`, post()),
  approveAgent: (id: string, agentId: string) =>
    request<Membership>(
      `${spacePath(id)}/agents/${part(agentId)}/admission/approve`,
      post(),
    ),
  removeAgent: (id: string, agentId: string) =>
    request<void>(`${spacePath(id)}/agents/${part(agentId)}`, {
      method: "DELETE",
    }),
  inviteLinks: (id: string, signal?: AbortSignal) =>
    request<{ links: InviteLink[] }>(`${spacePath(id)}/invite-links`, { signal }),
  createInviteLink: (id: string, body: InviteLinkInput) =>
    request<InviteLink>(`${spacePath(id)}/invite-links`, post(body)),
  revokeInviteLink: (id: string, linkId: string) =>
    request<InviteLink>(`${spacePath(id)}/invite-links/${part(linkId)}`, {
      method: "DELETE",
    }),
  /** Public preview: works without a session, so never attach credentials. */
  orgInvite: (code: string, signal?: AbortSignal) =>
    request<OrgInvitePreview>(`/api/org-invites/${part(code)}`, { signal }, publicApiFetch),
  acceptOrgInvite: (code: string) =>
    request<{ space_id: string; status: "active" }>(
      `/api/org-invites/${part(code)}/accept`,
      post(),
    ),
  accessGrants: (id: string, agentId: string, signal?: AbortSignal) =>
    request<{ grants: AgentAccessGrant[] }>(
      `${spacePath(id)}/agents/${part(agentId)}/access-grants`,
      { signal },
    ),
  grantAccess: (id: string, agentId: string, body: AgentAccessGrantInput) =>
    request<AgentAccessGrant>(
      `${spacePath(id)}/agents/${part(agentId)}/access-grants`,
      post(body),
    ),
  revokeAccess: (id: string, grantId: string) =>
    request<AgentAccessGrant>(`${spacePath(id)}/access-grants/${part(grantId)}`, {
      method: "DELETE",
    }),
  sharedAgents: (id: string, signal?: AbortSignal) =>
    request<{ agents: AgentAccessGrant[] }>(`${spacePath(id)}/shared-agents`, {
      signal,
    }),
  policy: (id: string, version: number, enabled: boolean) =>
    request<{ policy_version: number }>(
      `/api/organizations/${part(id)}/policies`,
      {
        method: "PATCH",
        body: JSON.stringify({
          expected_version: version,
          admin_dm_content_access_enabled: enabled,
          external_communication_enabled: false,
        }),
      },
    ),
};

export function canManage(space: TeamSpace): boolean {
  return (
    space.kind === "organization" &&
    space.status === "active" &&
    space.membership.status === "active" &&
    space.roles.some((role) => role === "owner" || role === "admin")
  );
}

/** Add a freshly created Agent: managers admit directly, members apply for approval. */
export async function admitNewAgent(
  spaceId: string,
  agentId: string,
  direct: boolean,
): Promise<"added" | "requested"> {
  if (direct) {
    await teamSpacesApi.addOwnedAgent(spaceId, agentId);
    return "added";
  }
  await teamSpacesApi.requestAgent(spaceId, agentId);
  return "requested";
}

export function canRemoveUser(
  space: TeamSpace,
  member: SpaceUser,
  userId: string,
): boolean {
  if (
    space.kind !== "organization" ||
    space.status !== "active" ||
    space.membership.status !== "active" ||
    member.roles.includes("owner") ||
    member.status === "removed"
  )
    return false;
  if (member.user_id === userId) return true;
  return (
    canManage(space) &&
    (!member.roles.includes("admin") || space.roles.includes("owner"))
  );
}

export function spaceError(error: unknown, zh: boolean): string {
  const messages: Record<string, [string, string]> = {
    conversation_not_available: ["会话不存在或你已失去访问权限。", "This conversation is unavailable or you no longer have access."],
    conversation_not_writable: ["对方已离开或暂停组织成员身份，暂不能发送消息。", "The other member has left or is suspended. You cannot send messages."],
    conversation_member_not_active: ["所选成员已发生变化，请刷新后重试。", "The selected membership changed. Refresh and try again."],
    message_retry_conflict: ["消息已发送，请刷新查看。", "The message was already sent. Refresh to view it."],
    policy_version_stale: [
      "设置已被更新，请刷新后确认最新状态再修改。",
      "Settings changed. Refresh and review them before trying again.",
    ],
    space_identity_conflict: [
      "组织标识已被使用，或资料已发生变化。请刷新后重试。",
      "The organization address is taken, or data changed. Refresh and try again.",
    ],
    invitation_user_not_found: [
      "未找到该用户，请核对账户菜单中的用户 ID。",
      "User not found. Check their user ID in the account menu.",
    ],
    organization_owner_cannot_be_removed: [
      "组织所有者暂不能退出或被移除。",
      "Organization owners cannot leave or be removed yet.",
    ],
    owned_agent_required: [
      "只能申请加入自己拥有且有效的 Agent。",
      "Only your own active Agents can apply.",
    ],
    user_not_active: [
      "该用户当前不可用。",
      "This user is currently unavailable.",
    ],
    space_not_available: [
      "空间不可用，或你的成员权限已发生变化。请刷新。",
      "This space is unavailable or your membership changed. Refresh to continue.",
    ],
    agent_owner_required: [
      "只有 Agent 的所有者可以管理使用授权。",
      "Only the Agent owner can manage access.",
    ],
    grantee_not_member: [
      "被授权人不是该组织的有效成员。",
      "The selected person is not an active member of this organization.",
    ],
    cannot_grant_self: [
      "不能授权给自己。",
      "You cannot grant access to yourself.",
    ],
    expires_in_past: [
      "有效期必须晚于当前时间。",
      "The expiry must be in the future.",
    ],
    agent_membership_required: [
      "该 Agent 需要先加入本组织。",
      "This Agent must join the organization first.",
    ],
    agent_access_revoked: [
      "你对该 Agent 的使用授权已被撤销或过期。",
      "Your access to this Agent has been revoked or has expired.",
    ],
    invite_link_not_found: [
      "邀请链接不存在，请向管理员索取新的链接。",
      "This invite link does not exist. Ask an administrator for a new one.",
    ],
    invite_link_expired: [
      "邀请链接已过期，请向管理员索取新的链接。",
      "This invite link has expired. Ask an administrator for a new one.",
    ],
    invite_link_exhausted: [
      "邀请链接已达使用上限，请向管理员索取新的链接。",
      "This invite link has reached its usage limit. Ask an administrator for a new one.",
    ],
    invite_link_revoked: [
      "邀请链接已被撤销，请向管理员索取新的链接。",
      "This invite link was revoked. Ask an administrator for a new one.",
    ],
    membership_requires_direct_invite: [
      "你曾被移出或暂停该组织，无法通过链接重新加入，请联系管理员直接邀请。",
      "You were previously removed or suspended, so you cannot rejoin by link. Ask an administrator to invite you directly.",
    ],
    agent_owner_or_manager_required: [
      "只有该 Agent 的所有者或组织管理员可以把它拉进房间。",
      "Only the Agent's owner or an organization admin can add it to a room.",
    ],
    agents_only_in_rooms: [
      "私聊不能添加 Agent，请在房间里添加。",
      "Agents can't join direct messages. Add them to a room instead.",
    ],
    agent_access_required: [
      "你需要是该 Agent 的所有者，或持有它在本组织的有效授权。",
      "You need to own this Agent or hold an active grant for it in this organization.",
    ],
    cannot_remove_room_owner: [
      "不能移除房间所有者。",
      "The room owner can't be removed.",
    ],
    room_membership_required: [
      "你需要先加入该房间。",
      "Join this room first.",
    ],
    room_manager_required: [
      "只有房间所有者/管理员或组织管理员可以移除成员。",
      "Only room owners/admins or organization admins can remove participants.",
    ],
    room_invite_required: [
      "这是私密房间，需要成员邀请你加入。",
      "This is a private room. A member needs to add you.",
    ],
    org_room_membership_managed_by_team: [
      "组织房间的成员请在 Team 工作区里管理。",
      "Manage organization room members in the Team workspace.",
    ],
    cannot_dm_self: ["不能和自己私聊。", "You can't message yourself."],
    dm_members_fixed: ["私聊成员不可更改。", "Direct message members can't change."],
    room_not_found: [
      "房间不存在或你已失去访问权限。",
      "This room is unavailable or you no longer have access.",
    ],
    organization_role_required: [
      "当前成员角色不允许执行此操作。",
      "Your membership role does not allow this action.",
    ],
  };
  if (error instanceof ApiError) {
    if (messages[error.message]) return messages[error.message][zh ? 0 : 1];
    if (error.status === 401)
      return zh
        ? "登录已过期，请重新登录。"
        : "Your session expired. Sign in again.";
    if (error.status === 404)
      return zh
        ? "空间或操作不可用，请刷新；若仍失败，请确认服务已更新。"
        : "This space or action is unavailable. Refresh; if it persists, check that the service is updated.";
    if (error.status === 403)
      return zh
        ? "当前账户没有此操作权限。"
        : "Your account does not have permission for this action.";
  }
  return zh
    ? "操作未完成，请检查连接后重试。"
    : "The action could not be completed. Check your connection and try again.";
}
