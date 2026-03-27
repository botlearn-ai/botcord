"use client";

/**
 * [INPUT]: 依赖邀请 API 创建好友邀请码，依赖 onboarding Prompt 模板生成给 AI 的邀请文案
 * [OUTPUT]: 对外提供 FriendInviteModal 组件，展示好友邀请链接与复制 Prompt 操作
 * [POS]: dashboard contacts 视图的轻量邀请器，为好友建联提供直接入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState } from "react";
import { api } from "@/lib/api";
import { common } from "@/lib/i18n/translations/common";
import { useLanguage } from "@/lib/i18n";
import type { InvitePreviewResponse } from "@/lib/types";
import { buildFriendInvitePrompt, rebaseToCurrentOrigin } from "@/lib/onboarding";
import { friendInviteModal } from "@/lib/i18n/translations/dashboard";

export default function FriendInviteModal({ onClose }: { onClose: () => void }) {
  const locale = useLanguage();
  const tc = common[locale];
  const t = friendInviteModal[locale];
  const [invite, setInvite] = useState<InvitePreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "prompt" | null>(null);

  async function handleCreate() {
    setLoading(true);
    setError(null);
    try {
      setInvite(await api.createFriendInvite());
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-glass-border bg-deep-black p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-text-primary">{t.title}</h2>
        <p className="mb-4 text-sm text-text-secondary">
          {t.description}
        </p>

        {error ? (
          <div className="mb-4 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        ) : null}

        {!invite ? (
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
            >
              {tc.cancel}
            </button>
            <button
              onClick={handleCreate}
              disabled={loading}
              className="rounded border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
            >
              {loading ? t.creating : t.createInvite}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                  {t.invitePrompt}
                </p>
                <button
                  onClick={() => copyField("prompt")}
                  className="shrink-0 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-3 py-1 text-xs text-neon-cyan hover:bg-neon-cyan/20"
                >
                  {copied === "prompt" ? tc.copied : t.copyPrompt}
                </button>
              </div>
              <textarea
                readOnly
                rows={6}
                value={buildFriendInvitePrompt({ inviteCode: invite.code, locale })}
                className="w-full resize-none rounded border border-glass-border bg-glass-bg px-3 py-2 font-mono text-xs leading-relaxed text-text-primary outline-none"
              />
            </div>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
              >
                {tc.done}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
