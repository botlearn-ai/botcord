/** Pure helpers for organization invite links (options, URLs, labels, copy). */
import type { InviteLink, InviteLinkInput, OrgInvitePreview } from "./team-spaces";

export const INVITE_EXPIRY_OPTIONS = ["1", "7", "30", "never"] as const;
export type InviteExpiry = (typeof INVITE_EXPIRY_OPTIONS)[number];

/**
 * Invites are personal by default: one person, seven days. `multiUse` is the
 * advanced option for a shareable link anyone can use until it expires.
 */
export function buildInviteLinkInput(
  expiry: InviteExpiry,
  multiUse: boolean,
  label = "",
): InviteLinkInput {
  const trimmed = label.trim();
  return {
    expires_in_days: expiry === "never" ? null : Number(expiry),
    max_uses: multiUse ? null : 1,
    ...(trimmed ? { label: trimmed } : {}),
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

/** Row status for the manager's list; a used personal link reads "joined: <name>". */
export function inviteRowStatus(
  link: Pick<InviteLink, "status" | "max_uses" | "redeemed_by_name">,
  zh: boolean,
): string {
  if (link.status === "exhausted" && link.max_uses === 1) {
    const who = link.redeemed_by_name ?? (zh ? "成员" : "a member");
    return zh ? `已加入：${who}` : `Joined: ${who}`;
  }
  if (link.status === "active" && link.max_uses === 1) return zh ? "待接受" : "Pending";
  return inviteStatusLabel(link.status, zh);
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
  singleUse = false,
): string {
  if (status === "exhausted" && singleUse) {
    return zh
      ? "这是一个专属邀请，已经被使用过了。请向管理员索取你自己的邀请链接。"
      : "This personal invite has already been used. Ask an administrator for your own invite link.";
  }
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
