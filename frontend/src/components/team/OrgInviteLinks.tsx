"use client";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Checkbox from "@/components/ui/Checkbox";
import Disclosure from "@/components/ui/Disclosure";
import Field from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

import Select from "@/components/ui/Select";
import { useLanguage } from "@/lib/i18n";
import {
  INVITE_EXPIRY_OPTIONS,
  buildInviteLinkInput,
  canShare,
  copyText,
  inviteExpiryLabel,
  inviteLinkUrl,
  inviteRowStatus,
  inviteUsageLabel,
  type InviteExpiry,
} from "@/lib/org-invite-links";
import { spaceError, teamSpacesApi, type InviteLink } from "@/lib/team-spaces";
import { useConfirm } from "@/store/useConfirmStore";
import { Check, Copy, Link2, Loader2, Share2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Manager-side invites. Each invite is a personal link for one person (single
 * use, 7 days) — no settings needed up front; expiry and multi-use links live
 * under "More options".
 */
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
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
    null,
  );
  const [expiry, setExpiry] = useState<InviteExpiry>("7");
  const [multiUse, setMultiUse] = useState(false);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<InviteLink | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [shareable, setShareable] = useState(false);

  useEffect(() => {
    // Browser-only values are read after mount so server markup stays stable.
    setOrigin(window.location.origin);
    setShareable(canShare());
  }, []);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const { links: next } = await teamSpacesApi.inviteLinks(
          spaceId,
          signal,
        );
        if (mounted.current)
          setLinks(next.filter((l) => l.status !== "revoked"));
      } catch (cause) {
        if (mounted.current && !signal?.aborted)
          setNotice({ error: true, text: spaceError(cause, zh) });
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [spaceId, zh],
  );
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

  async function run(
    task: () => Promise<boolean | void>,
    success: string | null,
  ) {
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
      if (mounted.current)
        setNotice({ error: true, text: spaceError(cause, zh) });
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
    setNotice({
      error: false,
      text: t("已选中链接，请手动复制。", "Link selected. Copy it manually."),
    });
  }

  async function handleShare(link: InviteLink) {
    try {
      await navigator.share({
        title: t(
          `加入 ${spaceName ?? "组织"}`,
          `Join ${spaceName ?? "the organization"}`,
        ),
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
    <Input
      ref={(el) => {
        if (el) fields.current.set(link.id, el);
        else fields.current.delete(link.id);
      }}
      readOnly
      aria-label={t("邀请链接", "Invite link")}

      value={origin ? urlOf(link) : link.path}
      onFocus={(e) => e.currentTarget.select()}
    />
  );
  const copyButton = (link: InviteLink) => (
    <Button
      variant="secondary"
      type="button"
      disabled={busy}
      onClick={() => void handleCopy(link)}
    >
      {copiedId === link.id ? <Check size={16} /> : <Copy size={16} />}
      {copiedId === link.id
        ? t("已复制", "Copied")
        : t("复制链接", "Copy link")}
    </Button>
  );

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div>
          <h3 className="flex items-center gap-2 font-medium">
            <Link2 size={16} />
            {t("邀请成员", "Invite a member")}
          </h3>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {multiUse
              ? t(
                  "生成一个多人可用的链接，有效期内任何拿到链接的人都能加入。",
                  "Creates a shareable link anyone can use to join until it expires.",
                )
              : t(
                  "为每位成员生成一个专属链接：仅限 1 人使用，对方登录或注册 BotCord 后即可加入。",
                  "Each teammate gets their own link: it works once, after they sign in or sign up for BotCord.",
                )}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={label}
            maxLength={64}
            disabled={busy}
            placeholder={t(
              "对方称呼（可选），如：Alice",
              "Who is it for? (optional), e.g. Alice",
            )}
            aria-label={t("对方称呼", "Invitee name")}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button
            variant="primary"
            type="button"
            className="w-full shrink-0"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const link = await teamSpacesApi.createInviteLink(
                  spaceId,
                  buildInviteLinkInput(expiry, multiUse, label),
                );
                if (!mounted.current) return;
                setCreated(link);
                setLabel("");
              }, null)
            }
          >
            {busy ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Link2 size={16} />
            )}
            {multiUse
              ? t("生成邀请链接", "Create invite link")
              : t("生成专属邀请链接", "Create personal invite link")}
          </Button>
        </div>
        <Disclosure
          title={
            <>
              {t("更多选项", "More options")} · {inviteExpiryLabel(expiry, zh)}{" "}
              ·{" "}
              {multiUse
                ? t("多人可用", "Multi-use")
                : t("仅限 1 人", "One person")}
            </>
          }
        >
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={<>{t("有效期", "Expires after")}</>}>
              <Select
                value={expiry}
                disabled={busy}
                onChange={(e) => setExpiry(e.target.value as InviteExpiry)}
              >
                {INVITE_EXPIRY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {inviteExpiryLabel(value, zh)}
                  </option>
                ))}
              </Select>
            </Field>
            <Checkbox
              checked={multiUse}
              disabled={busy}
              onCheckedChange={(checked) => setMultiUse(checked)}
              label={
                <>
                  <span>
                    {t(
                      "多人可用（不限次数）",
                      "Anyone with the link (unlimited uses)",
                    )}
                  </span>
                </>
              }
            />
          </div>
        </Disclosure>
        {created && (
          <Card className="space-y-2" role="status">
            <p className="text-xs text-neon-cyan">
              {created.max_uses === 1
                ? t(
                    `专属邀请链接已生成${created.label ? `（给 ${created.label}）` : ""} · 仅限 1 人`,
                    `Personal invite link created${created.label ? ` for ${created.label}` : ""} · one person`,
                  )
                : `${t("邀请链接已生成", "Invite link created")} · ${inviteUsageLabel(created, zh)}`}{" "}
              · {expiresText(created)}
            </p>
            {linkField(created)}
            <div className="grid grid-cols-2 gap-2 sm:flex">
              {copyButton(created)}
              {shareable && (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void handleShare(created)}
                >
                  <Share2 size={16} />
                  {t("分享", "Share")}
                </Button>
              )}
            </div>
          </Card>
        )}
      </Card>

      {notice && (
        <Alert tone={notice.error ? "danger" : "success"}>{notice.text}</Alert>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-medium">
          {t("已发出的邀请", "Sent invites")}
        </h4>
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 size={14} className="animate-spin" />
            {t("正在加载邀请链接…", "Loading invite links…")}
          </p>
        ) : links.length === 0 ? (
          <p className="text-sm text-text-secondary">
            {t("还没有发出邀请。", "No invites sent yet.")}
          </p>
        ) : (
          <ul className="divide-y divide-glass-border">
            {links.map((link) => (
              <li key={link.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                  <span className="text-sm font-medium text-text-primary">
                    {link.label ||
                      (link.max_uses === 1
                        ? t("专属邀请", "Personal invite")
                        : t("多人邀请链接", "Shared invite link"))}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 ${link.status === "active" ? "border-neon-cyan/40 text-neon-cyan" : "border-glass-border"}`}
                  >
                    {inviteRowStatus(link, zh)}
                  </span>
                  {link.max_uses !== 1 && (
                    <span>{inviteUsageLabel(link, zh)}</span>
                  )}
                  {link.status === "active" && <span>{expiresText(link)}</span>}
                </div>
                {link.status === "active" && linkField(link)}
                <div className="flex flex-wrap gap-2">
                  {link.status === "active" && copyButton(link)}
                  <Button
                    variant="danger"
                    type="button"

                    disabled={busy}
                    onClick={() =>
                      void run(
                        async () => {
                          if (
                            !(await confirm({
                              title:
                                link.status === "active"
                                  ? t("撤销这个邀请？", "Revoke this invite?")
                                  : t("移除这条记录？", "Remove this record?"),
                              message: t(
                                "撤销后该链接立即失效，已加入的成员不受影响。",
                                "The link stops working immediately. Members who already joined are unaffected.",
                              ),
                              tone: "danger",
                              confirmLabel:
                                link.status === "active"
                                  ? t("撤销", "Revoke")
                                  : t("移除", "Remove"),
                            })) ||
                            !mounted.current
                          )
                            return false;
                          await teamSpacesApi.revokeInviteLink(
                            spaceId,
                            link.id,
                          );
                          if (mounted.current)
                            setCreated((c) => (c?.id === link.id ? null : c));
                        },
                        link.status === "active"
                          ? t("邀请已撤销。", "Invite revoked.")
                          : null,
                      )
                    }
                  >
                    {link.status === "active"
                      ? t("撤销", "Revoke")
                      : t("移除", "Remove")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
