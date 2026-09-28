/** Pure helpers for organization invite links (options, URLs, labels, copy). */
import type { InviteLink, InviteLinkInput, OrgInvitePreview } from "./team-spaces";

export const INVITE_EXPIRY_OPTIONS = ["1", "7", "30", "never"] as const;
export const INVITE_USES_OPTIONS = ["unlimited", "1", "5", "20"] as const;
export type InviteExpiry = (typeof INVITE_EXPIRY_OPTIONS)[number];
export type InviteUses = (typeof INVITE_USES_OPTIONS)[number];

export function buildInviteLinkInput(expiry: InviteExpiry, uses: InviteUses): InviteLinkInput {
  return {
    expires_in_days: expiry === "never" ? null : Number(expiry),
    max_uses: uses === "unlimited" ? null : Number(uses),
  };
}

export function inviteLinkUrl(origin: string, link: Pick<InviteLink, "path" | "code">): string {
  const path = link.path || `/join/${encodeURIComponent(link.code)}`;
  return `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export function inviteExpiryLabel(value: InviteExpiry, zh: boolean): string {
  if (value === "never") return zh ? "永久" : "Never expires";
  const n = Number(value);
  return zh ? `${n} 天` : `${n} day${n === 1 ? "" : "s"}`;
}

export function inviteUsesLabel(value: InviteUses, zh: boolean): string {
  if (value === "unlimited") return zh ? "不限次数" : "Unlimited uses";
  const n = Number(value);
  return zh ? `${n} 次` : `${n} use${n === 1 ? "" : "s"}`;
}

export function inviteStatusLabel(
  status: OrgInvitePreview["status"],
  zh: boolean,
): string {
  const labels: Record<OrgInvitePreview["status"], [string, string]> = {
    active: ["有效", "Active"],
    expired: ["已过期", "Expired"],
    exhausted: ["已达上限", "Limit reached"],
    revoked: ["已撤销", "Revoked"],
    unavailable: ["组织不可用", "Organization unavailable"],
  };
  return labels[status][zh ? 0 : 1];
}

/** Why a non-active invite cannot be accepted, shown on the landing page. */
export function inviteUnavailableReason(
  status: Exclude<OrgInvitePreview["status"], "active">,
  zh: boolean,
): string {
  const reasons: Record<typeof status, [string, string]> = {
    expired: ["这个邀请链接已过期。", "This invite link has expired."],
    exhausted: ["这个邀请链接已达到使用次数上限。", "This invite link has reached its usage limit."],
    revoked: ["这个邀请链接已被管理员撤销。", "This invite link was revoked by an administrator."],
    unavailable: ["该组织当前不可用。", "This organization is currently unavailable."],
  };
  return `${reasons[status][zh ? 0 : 1]} ${zh ? "请向管理员索取新的链接。" : "Ask an administrator for a new link."}`;
}

export function inviteUsageLabel(link: Pick<InviteLink, "use_count" | "max_uses">, zh: boolean): string {
  return link.max_uses == null
    ? zh ? `已使用 ${link.use_count} 次 · 不限` : `${link.use_count} used · unlimited`
    : zh ? `已使用 ${link.use_count}/${link.max_uses}` : `${link.use_count}/${link.max_uses} used`;
}

/** Copy via the async Clipboard API; returns false so callers can fall back to selection. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function canShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}
