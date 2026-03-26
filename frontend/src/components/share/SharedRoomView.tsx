"use client";

/**
 * [INPUT]: 依赖 api/getSharedRoom 拉取共享快照，依赖 next/link 提供站内返回入口，依赖 SharedMessageBubble 渲染消息内容
 * [OUTPUT]: 对外提供 SharedRoomView 组件，负责共享房间的加载、错误态与只读消息列表展示
 * [POS]: share 模块的页面主体，被 /share/[shareId] 路由消费，是外部访问共享快照的只读容器
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import type { SharedRoomResponse } from "@/lib/types";
import SharedMessageBubble from "./SharedMessageBubble";
import { buildSharePrompt } from "@/lib/onboarding";
import { useLanguage } from "@/lib/i18n";
import { sharedRoomView } from "@/lib/i18n/translations/dashboard";

export default function SharedRoomView({ shareId }: { shareId: string }) {
  const locale = useLanguage();
  const t = sharedRoomView[locale];
  const [data, setData] = useState<SharedRoomResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!shareId) {
      setError(t.missingShareId);
      setLoading(false);
      return;
    }
    api
      .getSharedRoom(shareId)
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setError(t.invalidShare);
        } else {
          setError(err.message || t.loadFailed);
        }
      })
      .finally(() => setLoading(false));
  }, [shareId, t.invalidShare, t.loadFailed, t.missingShareId]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="animate-pulse text-lg text-neon-cyan">{t.loading}</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
        <div className="text-4xl">:/</div>
        <div className="text-lg text-red-400">{error || t.loadFailed}</div>
        <Link
          href="/"
          className="mt-2 rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          {t.goHome}
        </Link>
      </div>
    );
  }

  const loginHref = `/login?next=${encodeURIComponent(data.continue_url.replace(/^https?:\/\/[^/]+/, ""))}`;
  const sharePrompt = buildSharePrompt({
    shareUrl: data.link_url,
    roomName: data.room.name,
    requiresPayment: data.entry_type === "paid_room",
    isReadOnly: data.entry_type === "private_room",
    locale,
  });

  async function handleCopyPrompt() {
    try {
      await navigator.clipboard.writeText(sharePrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t.copyPromptFailed);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-8 pt-20">
      {/* Room header */}
      <div className="mb-6 rounded-xl border border-glass-border bg-glass-bg p-4">
        <h1 className="text-xl font-semibold text-text-primary">{data.room.name}</h1>
        {data.room.description && (
          <p className="mt-1 text-sm text-text-secondary">{data.room.description}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
          <span>{data.room.member_count} {data.room.member_count === 1 ? t.member : t.members}</span>
          <span>{t.sharedBy} {data.shared_by}</span>
          <span>{new Date(data.shared_at).toLocaleDateString()}</span>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href={loginHref}
            className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan hover:bg-neon-cyan/20"
          >
            {t.openInBotcord}
          </Link>
          <button
            type="button"
            onClick={handleCopyPrompt}
            className="rounded border border-glass-border px-4 py-2 text-sm text-text-primary hover:border-neon-cyan/40 hover:text-neon-cyan"
          >
            {copied ? t.promptCopied : t.copyInvitePrompt}
          </button>
        </div>
        <p className="mt-3 text-xs leading-6 text-text-secondary">
          {data.entry_type === "paid_room"
            ? t.paidHint
            : data.entry_type === "private_room"
              ? t.privateHint
              : t.publicHint}
        </p>
      </div>

      {/* Messages */}
      <div className="space-y-0">
        {data.messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-secondary">{t.noMessages}</p>
        ) : (
          data.messages.map((msg) => (
            <SharedMessageBubble key={msg.hub_msg_id} message={msg} />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="mt-8 border-t border-glass-border pt-4 text-center text-xs text-text-secondary">
        {t.footerPrefix}{" "}
        <Link href="/" className="text-neon-cyan hover:underline">
          {t.footerBrand}
        </Link>
      </div>
    </div>
  );
}
