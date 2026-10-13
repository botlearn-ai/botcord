"use client";
import PageHeader from "@/components/ui/PageHeader";
import IconTile from "@/components/ui/IconTile";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";

/**
 * [INPUT]: 依赖 teamSpacesApi 读取组织邀请链接的公开预览与接受；依赖 Supabase session 判断登录态
 * [OUTPUT]: OrgInviteLanding（`/join/[code]` 页面主体）与无状态 OrgInviteCard
 * [POS]: 组织邀请链接落地页；未登录跳 `/login?next=/join/<code>`，接受后进入 `/chats/team?space=`
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { BotCordLoadingBlock } from "@/components/ui/BotCordLoader";
import LinkButton from "@/components/ui/LinkButton";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { inviteUnavailableReason } from "@/lib/org-invite-links";
import { createClient } from "@/lib/supabase/client";
import {
  spaceError,
  teamSpacesApi,
  type OrgInvitePreview,
} from "@/lib/team-spaces";
import { Building2, Loader2, Users } from "lucide-react";
import { useEffect, useState } from "react";

export type OrgInviteAuth = "pending" | "guest" | "authed";

/** Public preview and session resolution complete independently; either may fail alone. */
export function loadOrgInviteLanding(
  code: string,
  handlers: {
    preview: (preview: OrgInvitePreview) => void;
    error: (error: unknown) => void;
    auth: (mode: OrgInviteAuth) => void;
  },
) {
  let cancelled = false;
  const controller = new AbortController();
  void teamSpacesApi.orgInvite(code, controller.signal).then(
    (preview) => {
      if (!cancelled) handlers.preview(preview);
    },
    (error) => {
      if (!cancelled) handlers.error(error);
    },
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

  return (
    <div className="mx-auto w-full max-w-lg px-4 pb-10 pt-20 sm:pt-28">
      <Card>
        <PageHeader
          eyebrow={t("组织邀请", "Organization invite")}
          icon={
            <IconTile>
              <Building2 />
            </IconTile>
          }
          title={name}
          description={
            preview.inviter_name
              ? t(
                  `${preview.inviter_name} 邀请你加入这个 BotCord 组织，与团队成员和 Agent 协作。`,
                  `${preview.inviter_name} invited you to join this BotCord organization and collaborate with teammates and Agents.`,
                )
              : t(
                  "你受邀加入这个 BotCord 组织，与团队成员和 Agent 协作。",
                  "You are invited to join this BotCord organization and collaborate with teammates and Agents.",
                )
          }
        />
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
          <span className="inline-flex items-center gap-1">
            <Users size={14} />
            {t(
              `${preview.member_count} 位成员`,
              `${preview.member_count} member${preview.member_count === 1 ? "" : "s"}`,
            )}
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
          <Alert tone="danger" className="mt-5">
            {error}
          </Alert>
        )}

        {preview.status !== "active" ? (
          <div className="mt-6 space-y-4">
            <Alert tone="danger">
              {inviteUnavailableReason(
                preview.status,
                zh,
                preview.single_use === true,
              )}
            </Alert>
            <LinkButton variant="secondary" href="/">
              {t("返回首页", "Go home")}
            </LinkButton>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {auth === "pending" ? (
              <Button variant="primary" type="button" disabled aria-busy="true">
                {t("正在确认登录状态…", "Checking sign-in…")}
              </Button>
            ) : auth === "guest" ? (
              <LinkButton
                variant="primary"
                href={`/login?next=${encodeURIComponent(joinPath(code))}`}
              >
                {t("登录 / 注册后加入", "Sign in or sign up to join")}
              </LinkButton>
            ) : (
              <Button
                variant="primary"
                type="button"
                disabled={joining}
                onClick={onJoin}
              >
                {joining && <Loader2 size={16} className="animate-spin" />}
                {joining
                  ? t("正在加入…", "Joining…")
                  : t(`加入 ${name}`, `Join ${name}`)}
              </Button>
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
      </Card>
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
        <Alert tone="danger">{spaceError(loadError, zh)}</Alert>
        <LinkButton variant="primary" href="/">
          {t("返回首页", "Go home")}
        </LinkButton>
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <BotCordLoadingBlock
          label={t("正在加载邀请…", "Loading invite…")}
          size="md"
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
