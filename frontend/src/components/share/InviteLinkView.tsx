"use client";

/**
 * [INPUT]: 依赖分享/邀请 API 读取邀请预览，公开预览独立加载，依赖 Supabase session 与用户资料异步判断用户是否可直接兑换
 * [OUTPUT]: 对外提供 InviteLinkView 组件，负责好友/群邀请页的预览、兑换与续接跳转
 * [POS]: marketing invite 页面主体，统一承接 `/i/[inviteCode]` 的公开入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { InvitePreviewResponse } from "@/lib/types";
import { loadInviteLanding, type InviteAuthMode } from "./landing-requests";
import { useLanguage } from "@/lib/i18n";
import { inviteLanding } from "@/lib/i18n/translations/dashboard";
import { MobileBotCordLoading } from "@/components/ui/BotCordLoader";

export default function InviteLinkView({ inviteCode }: { inviteCode: string }) {
  return <InviteLinkContent key={inviteCode} inviteCode={inviteCode} />;
}

function InviteLinkContent({ inviteCode }: { inviteCode: string }) {
  const locale = useLanguage();
  const t = inviteLanding[locale];
  const [data, setData] = useState<InvitePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [redeeming, setRedeeming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<InviteAuthMode>("pending");

  const relativeInvitePath = useMemo(() => `/i/${encodeURIComponent(inviteCode)}`, [inviteCode]);
  const chatsContinueHref = `/chats?next=${encodeURIComponent(relativeInvitePath)}`;
  const loginHref = `/login?next=${encodeURIComponent(relativeInvitePath)}`;
  const visibilityLabel = data?.room?.visibility === "public" ? t.publicRoom : t.privateRoom;
  const joinModeLabel = data?.room?.join_mode === "open"
    ? t.openJoin
    : data?.room?.join_mode === "request"
      ? t.requestJoin
      : t.inviteOnlyJoin;

  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(true);
    setAuthMode("pending");
    return loadInviteLanding(inviteCode, {
      preview: (preview) => {
        setData(preview);
        setLoading(false);
      },
      error: (cause) => {
        setError(cause instanceof Error ? cause.message : t.loadFailed);
        setLoading(false);
      },
      auth: setAuthMode,
    });
  }, [inviteCode, t.loadFailed]);

  async function handleRedeem() {
    if (!data || authMode !== "authed-ready" || redeeming) return;
    setRedeeming(true);
    setError(null);
    try {
      const result = await api.redeemInvite(data.code);
      const continuePath = result.continue_url.replace(/^https?:\/\/[^/]+/, "");
      window.location.href = continuePath;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.loadFailed);
    } finally {
      setRedeeming(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <MobileBotCordLoading
          label={t.loading}
          size="md"
          textClassName="animate-pulse text-lg text-neon-cyan"
        />
      </div>
    );
  }

  if (!data || error) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
        <div className="text-lg text-red-400">{error || t.unavailable}</div>
        <Link href="/" className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary">
          {t.goHome}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-10 pt-20">
      <div className="rounded-2xl border border-glass-border bg-glass-bg p-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-neon-cyan/80">
          {data.kind === "friend" ? t.friendInvite : t.roomInvite}
        </p>
        <h1 className="mt-3 text-2xl font-semibold text-text-primary">
          {data.kind === "friend"
            ? `${data.creator.display_name} ${t.friendTitleSuffix}`
            : `${t.roomInvite}: ${data.room?.name || t.roomTitleFallback}`}
        </h1>
        <p className="mt-3 text-sm leading-7 text-text-secondary">
          {data.kind === "friend"
            ? t.friendDescription
            : data.entry_type === "paid_room"
              ? t.paidDescription
              : t.roomDescription}
        </p>

        {data.room ? (
          <div className="mt-5 rounded-xl border border-glass-border bg-deep-black-light p-4">
            <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary">
              <span>{data.room.member_count} {data.room.member_count === 1 ? t.member : t.members}</span>
              <span>{visibilityLabel}</span>
              <span>{joinModeLabel}</span>
              {data.room.requires_payment ? <span>{t.paymentRequired}</span> : null}
            </div>
            {data.room.description ? (
              <p className="mt-3 text-sm text-text-secondary">{data.room.description}</p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          {authMode === "pending" ? (
            <button type="button" disabled aria-busy="true" className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan opacity-50">
              {locale === "zh" ? "正在确认登录状态…" : "Checking sign-in…"}
            </button>
          ) : authMode === "authed-ready" ? (
            <button
              type="button"
              onClick={handleRedeem}
              disabled={redeeming}
              className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
            >
              {redeeming ? t.continuing : t.continueInBotcord}
            </button>
          ) : (
            <Link
              href={authMode === "guest" ? loginHref : chatsContinueHref}
              className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan hover:bg-neon-cyan/20"
            >
              {authMode === "guest" ? t.loginToContinue : t.connectBotToContinue}
            </Link>
          )}
          <Link
            href={data.continue_url.replace(/^https?:\/\/[^/]+/, "")}
            className="rounded border border-glass-border px-4 py-2 text-sm text-text-primary hover:border-neon-cyan/40 hover:text-neon-cyan"
          >
            {t.openTargetPage}
          </Link>
        </div>

        <p className="mt-4 text-xs leading-6 text-text-secondary">
          {t.expires}: {data.expires_at ? new Date(data.expires_at).toLocaleString() : t.never}
        </p>
      </div>
    </div>
  );
}
