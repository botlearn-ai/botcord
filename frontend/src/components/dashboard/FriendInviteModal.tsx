"use client";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
/**
 * [INPUT]: 依赖邀请 API 创建好友邀请码，依赖 onboarding Prompt 模板生成给 AI 的邀请文案
 * [OUTPUT]: 对外提供 FriendInviteModal 组件，展示好友邀请链接与复制 Prompt 操作
 * [POS]: dashboard contacts 视图的轻量邀请器，为好友建联提供直接入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useRef, useState } from "react";
import { api, humansApi } from "@/lib/api";
import { animatePop, cleanupAnime } from "@/lib/anime";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { common } from "@/lib/i18n/translations/common";
import { useLanguage } from "@/lib/i18n";
import type { InvitePreviewResponse } from "@/lib/types";
import { buildFriendInvitePrompt, rebaseToCurrentOrigin } from "@/lib/onboarding";
import { friendInviteModal } from "@/lib/i18n/translations/dashboard";
import Button from "@/components/ui/Button";
import DialogShell from "@/components/ui/DialogShell";

export default withDashboardOverlayPortal(FriendInviteModal);

function FriendInviteModal({ onClose }: { onClose: () => void }) {
  const locale = useLanguage();
  const tc = common[locale];
  const t = friendInviteModal[locale];
  const isHumanView = useDashboardSessionStore((state) => state.viewMode === "human");
  const [invite, setInvite] = useState<InvitePreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "prompt" | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const feedbackAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  async function handleCreate() {
    setLoading(true);
    setError(null);
    try {
      const inviteApi = isHumanView ? humansApi : api;
      setInvite(await inviteApi.createFriendInvite());
    } catch (err) {
      setError(err instanceof Error ? err.message : t.createFailed);
    } finally {
      setLoading(false);
    }
  }

  async function copyField(kind: "link" | "prompt") {
    if (!invite) return;
    try {
      const text = kind === "link"
        ? rebaseToCurrentOrigin(invite.invite_url)
        : buildFriendInvitePrompt({ inviteCode: invite.code, locale });
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setError(t.copyFailed);
    }
  }

  useEffect(() => {
    const target = copied ? copyButtonRef.current : error ? errorRef.current : null;
    if (!target) return;
    cleanupAnime(feedbackAnimationRef.current);
    feedbackAnimationRef.current = animatePop(target);
    return () => cleanupAnime(feedbackAnimationRef.current);
  }, [copied, error]);

  return (
    <DialogShell
      title={t.title}
      description={t.description}
      onClose={onClose}
      hideCloseButton
      overlayClassName="z-50"
      footer={(close) => (
        !invite ? (
          <>
            <Button variant="ghost" onClick={close}>
              {tc.cancel}
            </Button>
            <Button variant="primary" onClick={handleCreate} loading={loading}>
              {loading ? t.creating : t.createInvite}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={close}>
            {tc.done}
          </Button>
        )
      )}
    >
      {error ? (
        <div ref={errorRef} className="mb-4 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {invite ? (
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.invitePrompt}
            </p>
            <Button
              ref={copyButtonRef}
              variant="secondary"
              size="sm"
              onClick={() => copyField("prompt")}
            >
              {copied === "prompt" ? tc.copied : t.copyPrompt}
            </Button>
          </div>
          <textarea
            readOnly
            rows={6}
            value={buildFriendInvitePrompt({ inviteCode: invite.code, locale })}
            className="liquid-input w-full resize-none rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed text-text-primary outline-none"
          />
        </div>
      ) : null}
    </DialogShell>
  );
}
