/**
 * [INPUT]: 依赖 invite 页拿到的 session 存在性、Supabase metadata、后端 /api/users/me 资料
 * [OUTPUT]: 对外提供 invite 准入判定函数与 InvitePageState 类型，统一产出页面状态与跳转决策
 * [POS]: frontend invite 准入真相层，消除客户端 metadata 与服务端用户资料分裂带来的卡页问题
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

export type InvitePageState = "loading" | "guest" | "activated" | "idle";

interface ResolveInviteAccessInput {
  betaGateEnabled: boolean;
  hasSession: boolean;
  sessionBetaAccess: boolean;
  profileBetaAccess: boolean;
}

interface ResolveInviteAccessResult {
  pageState: InvitePageState;
  shouldRedirectToChats: boolean;
  shouldRefreshSession: boolean;
}

export function resolveInviteAccess(input: ResolveInviteAccessInput): ResolveInviteAccessResult {
  if (!input.hasSession) {
    return {
      pageState: "guest",
      shouldRedirectToChats: false,
      shouldRefreshSession: false,
    };
  }

  if (!input.betaGateEnabled) {
    return {
      pageState: "activated",
      shouldRedirectToChats: true,
      shouldRefreshSession: false,
    };
  }

  if (input.profileBetaAccess) {
    return {
      pageState: "activated",
      shouldRedirectToChats: true,
      shouldRefreshSession: !input.sessionBetaAccess,
    };
  }

  if (input.sessionBetaAccess) {
    return {
      pageState: "activated",
      shouldRedirectToChats: true,
      shouldRefreshSession: false,
    };
  }

  return {
    pageState: "idle",
    shouldRedirectToChats: false,
    shouldRefreshSession: false,
  };
}
