"use client";

/**
 * [INPUT]: 依赖 teamSpacesApi 读取组织邀请链接的公开预览与接受；依赖 Supabase session 判断登录态
 * [OUTPUT]: OrgInviteLanding（`/join/[code]` 页面主体）与无状态 OrgInviteCard
 * [POS]: 组织邀请链接落地页；未登录跳 `/login?next=/join/<code>`，接受后进入 `/chats/team?space=`
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Loader2, Users } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { userApi } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { spaceError, teamSpacesApi, type OrgInvitePreview } from "@/lib/team-spaces";
import { inviteUnavailableReason } from "@/lib/org-invite-links";
import { MobileBotCordLoading } from "@/components/ui/BotCordLoader";

export type OrgInviteAuth = "pending" | "guest" | "authed";

/** Public preview and session resolution complete independently; either may fail alone. */
export function loadOrgInviteLanding(code: string, handlers: {
  preview: (preview: OrgInvitePreview) => void;
  error: (error: unknown) => void;
  auth: (mode: OrgInviteAuth) => void;
}) {
  let cancelled = false;
  const controller = new AbortController();
  void teamSpacesApi.orgInvite(code, controller.signal).then(
    (preview) => { if (!cancelled) handlers.preview(preview); },
    (error) => { if (!cancelled) handlers.error(error); },
  );
  void (async () => {
    try {
      const result = await createClient().auth.getSession();
      if (cancelled) return;
      if (!result.data.session?.access_token) {
        handlers.auth("guest");
        return;
      }
      // Loading the profile provisions the BotCord user for brand-new sign-ups.
      await userApi.getMe({ force: true }).catch(() => undefined);
      if (!cancelled) handlers.auth("authed");
    } catch {
      if (!cancelled) handlers.auth("guest");
    }
  })();
  return () => {
    cancelled = true;
    controller.abort();
  };
}

export function joinPath(code: string): string {
  return `/join/${encodeURIComponent(code)}`;
}

export function OrgInviteCard({
  code,
  preview,
  auth,
  joining = false,
  error = null,
  onJoin,
}: {
  code: string;
  preview: OrgInvitePreview;
  auth: OrgInviteAuth;
  joining?: boolean;
  error?: string | null;
  onJoin?: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const name = preview.organization_name;
  const primary =
    "inline-flex w-full items-center justify-center gap-2 rounded-xl border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-3 text-sm font-medium text-neon-cyan hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto";
  const secondary =
    "inline-flex w-full items-center justify-center rounded-xl border border-glass-border px-4 py-3 text-sm text-text-secondary hover:text-text-primary sm:w-auto";

  return (
    <div className="mx-auto w-full max-w-lg px-4 pb-10 pt-20 sm:pt-28">
      <div className="rounded-2xl border border-glass-border bg-glass-bg p-5 sm:p-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-neon-cyan/80">
          {t("组织邀请", "Organization invite")}
        </p>
        <div className="mt-4 flex items-center gap-3">
          <div className="shrink-0 rounded-xl bg-neon-cyan/10 p-3 text-neon-cyan">
            <Building2 size={24} />
          </div>
          <h1 className="min-w-0 break-words text-xl font-semibold text-text-primary sm:text-2xl">
            {name}
          </h1>
        </div>
        <p className="mt-4 text-sm leading-6 text-text-secondary">
          {preview.inviter_name
            ? t(
                `${preview.inviter_name} 邀请你加入这个 BotCord 组织，与团队成员和 Agent 协作。`,
                `${preview.inviter_name} invited you to join this BotCord organization and collaborate with teammates and Agents.`,
              )
            : t(
                "你受邀加入这个 BotCord 组织，与团队成员和 Agent 协作。",
                "You are invited to join this BotCord organization and collaborate with teammates and Agents.",
              )}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
          <span className="inline-flex items-center gap-1">
            <Users size={14} />
            {t(`${preview.member_count} 位成员`, `${preview.member_count} member${preview.member_count === 1 ? "" : "s"}`)}
          </span>
          {preview.status === "active" && (
            <span>
              {preview.expires_at
                ? `${t("链接到期", "Link expires")}: ${new Date(preview.expires_at).toLocaleString()}`
                : t("链接永不过期", "Link never expires")}
            </span>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-5 rounded-xl border border-red-500/30 p-3 text-sm text-red-500">
            {error}
          </p>
        )}

        {preview.status !== "active" ? (
          <div className="mt-6 space-y-4">
            <p role="alert" className="rounded-xl border border-glass-border bg-deep-black-light p-4 text-sm text-text-secondary">
              {inviteUnavailableReason(preview.status, zh, preview.single_use === true)}
            </p>
            <Link href="/" className={secondary}>{t("返回首页", "Go home")}</Link>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {auth === "pending" ? (
              <button type="button" disabled aria-busy="true" className={primary}>
                {t("正在确认登录状态…", "Checking sign-in…")}
              </button>
            ) : auth === "guest" ? (
              <Link href={`/login?next=${encodeURIComponent(joinPath(code))}`} className={primary}>
                {t("登录 / 注册后加入", "Sign in or sign up to join")}
              </Link>
            ) : (
              <button type="button" className={primary} disabled={joining} onClick={onJoin}>
                {joining && <Loader2 size={16} className="animate-spin" />}
                {joining ? t("正在加入…", "Joining…") : t(`加入 ${name}`, `Join ${name}`)}
              </button>
            )}
          </div>
        )}
        {preview.status === "active" && auth === "guest" && (
          <p className="mt-3 text-xs leading-5 text-text-secondary">
            {t(
              "还没有 BotCord 账户？在登录页选择注册，完成后会自动回到此页面。",
              "No BotCord account yet? Choose sign up on the next page; you will return here afterwards.",
            )}
          </p>
        )}
      </div>
    </div>
  );
}

export default function OrgInviteLanding({ code }: { code: string }) {
  return <OrgInviteLandingContent key={code} code={code} />;
}

function OrgInviteLandingContent({ code }: { code: string }) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const [preview, setPreview] = useState<OrgInvitePreview | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [auth, setAuth] = useState<OrgInviteAuth>("pending");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      loadOrgInviteLanding(code, {
        preview: setPreview,
        error: setLoadError,
        auth: setAuth,
      }),
    [code],
  );

  async function handleJoin() {
    if (!preview || auth !== "authed" || joining) return;
    setJoining(true);
    setError(null);
    try {
      const result = await teamSpacesApi.acceptOrgInvite(code);
      window.location.href = `/chats/team?space=${encodeURIComponent(result.space_id)}`;
    } catch (cause) {
      setError(spaceError(cause, zh));
      setJoining(false);
    }
  }

  if (loadError != null) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 pt-16 text-center">
        <p role="alert" className="max-w-sm text-base text-red-400">{spaceError(loadError, zh)}</p>
        <Link href="/" className="rounded-xl border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary">
          {t("返回首页", "Go home")}
        </Link>
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <MobileBotCordLoading
          label={t("正在加载邀请…", "Loading invite…")}
          size="md"
          textClassName="animate-pulse text-lg text-neon-cyan"
        />
      </div>
    );
  }
  return (
    <OrgInviteCard
      code={code}
      preview={preview}
      auth={auth}
      joining={joining}
      error={error}
      onJoin={() => void handleJoin()}
    />
  );
}
