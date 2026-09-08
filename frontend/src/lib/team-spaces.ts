/** User-authenticated Team governance. These calls never select an Agent actor. */
import { ApiError, apiFetch } from "./api";

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, { ...init, cache: "no-store" }, null);
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
  approveAgent: (id: string, agentId: string) =>
    request<Membership>(
      `${spacePath(id)}/agents/${part(agentId)}/admission/approve`,
      post(),
    ),
  removeAgent: (id: string, agentId: string) =>
    request<void>(`${spacePath(id)}/agents/${part(agentId)}`, {
      method: "DELETE",
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
