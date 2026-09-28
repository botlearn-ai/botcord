"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Link2, Loader2, Share2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError, teamSpacesApi, type InviteLink } from "@/lib/team-spaces";
import {
  INVITE_EXPIRY_OPTIONS,
  INVITE_USES_OPTIONS,
  buildInviteLinkInput,
  canShare,
  copyText,
  inviteExpiryLabel,
  inviteLinkUrl,
  inviteStatusLabel,
  inviteUsageLabel,
  inviteUsesLabel,
  type InviteExpiry,
  type InviteUses,
} from "@/lib/org-invite-links";
import { useConfirm } from "@/store/useConfirmStore";

const input =
  "w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan focus:ring-2 focus:ring-neon-cyan/20 disabled:opacity-50";
const button =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-glass-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-neon-cyan/10 focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan`;

/** Manager-side invite links: generate, copy/share, list and revoke. */
export default function OrgInviteLinks({
  spaceId,
  spaceName,
}: {
  spaceId: string;
  spaceName: string | null;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const confirm = useConfirm();
  const mounted = useRef(false);
  const locked = useRef(false);
  const fields = useRef(new Map<string, HTMLInputElement>());
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [expiry, setExpiry] = useState<InviteExpiry>("7");
  const [uses, setUses] = useState<InviteUses>("unlimited");
  const [created, setCreated] = useState<InviteLink | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [shareable, setShareable] = useState(false);

  useEffect(() => {
    // Browser-only values are read after mount so server markup stays stable.
    setOrigin(window.location.origin);
    setShareable(canShare());
  }, []);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const { links: next } = await teamSpacesApi.inviteLinks(spaceId, signal);
      if (mounted.current) setLinks(next.filter((l) => l.status !== "revoked"));
    } catch (cause) {
      if (mounted.current && !signal?.aborted)
        setNotice({ error: true, text: spaceError(cause, zh) });
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [spaceId, zh]);
  useEffect(() => {
    mounted.current = true;
    setCreated(null);
    setLoading(true);
    const controller = new AbortController();
    void reload(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [reload]);

  async function run(task: () => Promise<boolean | void>, success: string | null) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setNotice(null);
    try {
      if ((await task()) === false) return;
      if (!mounted.current) return;
      if (success) setNotice({ error: false, text: success });
      await reload();
    } catch (cause) {
      if (mounted.current) setNotice({ error: true, text: spaceError(cause, zh) });
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const urlOf = (link: InviteLink) => inviteLinkUrl(origin, link);

  async function handleCopy(link: InviteLink) {
    if (await copyText(urlOf(link))) {
      setCopiedId(link.id);
      window.setTimeout(() => {
        if (mounted.current) setCopiedId((id) => (id === link.id ? null : id));
      }, 2000);
      return;
    }
    // Clipboard blocked (insecure context, permissions): select the text for manual copy.
    const field = fields.current.get(link.id);
    field?.focus();
    field?.select();
    setNotice({ error: false, text: t("已选中链接，请手动复制。", "Link selected. Copy it manually.") });
  }

  async function handleShare(link: InviteLink) {
    try {
      await navigator.share({
        title: t(`加入 ${spaceName ?? "组织"}`, `Join ${spaceName ?? "the organization"}`),
        text: t(
          `邀请你加入 BotCord 组织「${spaceName ?? ""}」`,
          `You're invited to join ${spaceName ?? "an organization"} on BotCord`,
        ),
        url: urlOf(link),
      });
    } catch {
      // The user dismissed the share sheet; nothing to report.
    }
  }

  const expiresText = (link: InviteLink) =>
    link.expires_at
      ? `${t("到期", "Expires")} ${new Date(link.expires_at).toLocaleString()}`
      : t("永不过期", "Never expires");

  const linkField = (link: InviteLink) => (
    <input
      ref={(el) => {
        if (el) fields.current.set(link.id, el);
        else fields.current.delete(link.id);
      }}
      readOnly
      aria-label={t("邀请链接", "Invite link")}
      className={`${input} font-mono text-xs`}
      value={origin ? urlOf(link) : link.path}
      onFocus={(e) => e.currentTarget.select()}
    />
  );
  const copyButton = (link: InviteLink, className = button) => (
    <button type="button" className={className} disabled={busy} onClick={() => void handleCopy(link)}>
      {copiedId === link.id ? <Check size={16} /> : <Copy size={16} />}
      {copiedId === link.id ? t("已复制", "Copied") : t("复制链接", "Copy link")}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-glass-border bg-deep-black/40 p-4">
        <div>
          <h3 className="flex items-center gap-2 font-medium">
            <Link2 size={16} />
            {t("邀请链接", "Invite link")}
          </h3>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t(
              "把链接发给同事，对方登录或注册 BotCord 后即可加入组织。",
              "Send the link to teammates. They join after signing in or signing up for BotCord.",
            )}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs text-text-secondary">
            <span>{t("有效期", "Expires after")}</span>
            <select
              className={input}
              value={expiry}
              disabled={busy}
              onChange={(e) => setExpiry(e.target.value as InviteExpiry)}
            >
              {INVITE_EXPIRY_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {inviteExpiryLabel(value, zh)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-text-secondary">
            <span>{t("可用次数", "Max uses")}</span>
            <select
              className={input}
              value={uses}
              disabled={busy}
              onChange={(e) => setUses(e.target.value as InviteUses)}
            >
              {INVITE_USES_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {inviteUsesLabel(value, zh)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          className={`${primary} w-full sm:w-auto`}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const link = await teamSpacesApi.createInviteLink(
                spaceId,
                buildInviteLinkInput(expiry, uses),
              );
              if (mounted.current) setCreated(link);
            }, null)
          }
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
          {t("生成邀请链接", "Generate invite link")}
        </button>
        {created && (
          <div className="space-y-2 rounded-xl border border-neon-cyan/30 bg-neon-cyan/5 p-3" role="status">
            <p className="text-xs text-neon-cyan">
              {t("邀请链接已生成", "Invite link created")} · {expiresText(created)} · {inviteUsageLabel(created, zh)}
            </p>
            {linkField(created)}
            <div className="grid grid-cols-2 gap-2 sm:flex">
              {copyButton(created, primary)}
              {shareable && (
                <button type="button" className={button} onClick={() => void handleShare(created)}>
                  <Share2 size={16} />
                  {t("分享", "Share")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className={`text-sm ${notice.error ? "text-red-500" : "text-neon-cyan"}`}
        >
          {notice.text}
        </p>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("现有邀请链接", "Existing invite links")}</h4>
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 size={14} className="animate-spin" />
            {t("正在加载邀请链接…", "Loading invite links…")}
          </p>
        ) : links.length === 0 ? (
          <p className="text-sm text-text-secondary">{t("暂无邀请链接。", "No invite links yet.")}</p>
        ) : (
          <ul className="divide-y divide-glass-border">
            {links.map((link) => (
              <li key={link.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                  <span
                    className={`rounded-full border px-2 py-0.5 ${link.status === "active" ? "border-neon-cyan/40 text-neon-cyan" : "border-glass-border"}`}
                  >
                    {inviteStatusLabel(link.status, zh)}
                  </span>
                  <span>{inviteUsageLabel(link, zh)}</span>
                  <span>{expiresText(link)}</span>
                </div>
                {link.status === "active" && linkField(link)}
                <div className="flex flex-wrap gap-2">
                  {link.status === "active" && copyButton(link)}
                  <button
                    type="button"
                    className={`${button} text-red-500`}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (
                          !(await confirm({
                            title: t("撤销邀请链接？", "Revoke invite link?"),
                            message: t(
                              "撤销后该链接立即失效，已加入的成员不受影响。",
                              "The link stops working immediately. Members who already joined are unaffected.",
                            ),
                            tone: "danger",
                            confirmLabel: t("撤销", "Revoke"),
                          })) ||
                          !mounted.current
                        )
                          return false;
                        await teamSpacesApi.revokeInviteLink(spaceId, link.id);
                        if (mounted.current) setCreated((c) => (c?.id === link.id ? null : c));
                      }, t("邀请链接已撤销。", "Invite link revoked."))
                    }
                  >
                    {t("撤销", "Revoke")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
