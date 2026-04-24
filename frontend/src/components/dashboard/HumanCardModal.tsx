"use client";

/**
 * [INPUT]: 依赖 human 资料与联系人关系状态，依赖 i18n 提供文案
 * [OUTPUT]: 对外提供 HumanCardModal 统一 human 详情模态框
 * [POS]: dashboard 通用弹层组件，被 Explore humans 目录复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import CopyableId from "@/components/ui/CopyableId";
import { useLanguage } from "@/lib/i18n";
import { exploreUi } from "@/lib/i18n/translations/dashboard";
import type { PublicHumanProfile } from "@/lib/types";
import { Loader2 } from "lucide-react";

interface HumanCardModalProps {
  isOpen: boolean;
  human: PublicHumanProfile | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  alreadyInContacts: boolean;
  requestAlreadyPending: boolean;
  requestSent?: boolean;
  sendingFriendRequest?: boolean;
  onSendFriendRequest: () => void;
  onRetry?: () => void;
}

export default function HumanCardModal({
  isOpen,
  human,
  loading = false,
  error = null,
  onClose,
  alreadyInContacts,
  requestAlreadyPending,
  requestSent = false,
  sendingFriendRequest = false,
  onSendFriendRequest,
  onRetry,
}: HumanCardModalProps) {
  const locale = useLanguage();
  const t = exploreUi[locale];

  if (!isOpen) return null;

  const initials = human?.display_name?.slice(0, 1).toUpperCase() ?? "H";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-3">
            {human?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={human.avatar_url}
                alt={human.display_name}
                className="h-9 w-9 shrink-0 rounded-full border border-neon-green/30 object-cover"
              />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neon-green/30 bg-neon-green/10 text-xs font-semibold text-neon-green">
                {initials}
              </div>
            )}
            <div>
              <h3 className="text-base font-semibold text-text-primary">{human?.display_name || "Human"}</h3>
              <p className="mt-0.5 text-xs text-neon-green/80">{t.personaHuman}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded border border-glass-border px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary"
          >
            {t.close}
          </button>
        </div>

        {loading ? (
          <div className="space-y-3 py-2">
            {human && <CopyableId value={human.human_id} />}
            <p className="text-xs text-text-secondary animate-pulse">Loading profile...</p>
          </div>
        ) : error ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={onRetry}
              className="w-full rounded-lg border border-glass-border py-2 text-xs text-text-primary transition-colors hover:bg-glass-bg"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="mb-4">
              {human && <CopyableId value={human.human_id} />}
            </div>
            {requestSent ? (
              <p className="text-xs text-neon-green">{t.friendRequestSent}</p>
            ) : alreadyInContacts ? (
              <p className="text-xs text-neon-green">{t.alreadyInContacts}</p>
            ) : requestAlreadyPending ? (
              <p className="text-xs text-neon-cyan">{t.friendRequestAlreadyPending}</p>
            ) : (
              <button
                onClick={onSendFriendRequest}
                disabled={sendingFriendRequest}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neon-green/40 bg-neon-green/10 py-2 text-xs font-medium text-neon-green transition-colors hover:bg-neon-green/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendingFriendRequest ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {sendingFriendRequest ? t.sendingFriendRequest : t.sendFriendRequest}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
