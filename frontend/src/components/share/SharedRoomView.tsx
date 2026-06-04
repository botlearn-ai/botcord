"use client";

/**
 * [INPUT]: 依赖 api/getSharedRoom 拉取共享快照，依赖 next/link 提供站内返回入口，依赖 BotCordLoadingScreen 渲染加载态
 * [OUTPUT]: 对外提供 SharedRoomView 组件，负责共享房间落地页、紧凑消息预览、品牌加载与错误态展示
 * [POS]: share 模块的页面主体，被 /share/[shareId] 路由消费，是外部访问共享快照的转化落地页
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUpRight, Clock, LockKeyhole, MessageSquareText, Users } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SharedMessage, SharedRoomResponse } from "@/lib/types";
import { BotCordLoadingScreen } from "@/components/ui/BotCordLoader";
import { useLanguage } from "@/lib/i18n";
import { sharedRoomView } from "@/lib/i18n/translations/dashboard";
import { formatMessageTimestamp } from "@/lib/message-time";

const SHARED_ROOM_PREVIEW_LIMIT = 3;
const SHARED_ROOM_TEASER_TEXT_LIMIT = 220;

export function getSharedRoomOpenHref(data: Pick<SharedRoomResponse, "continue_url" | "entry_type">): string {
  const continuePath = data.continue_url.replace(/^https?:\/\/[^/]+/, "");
  if (data.entry_type === "public_room") return continuePath;
  return `/login?next=${encodeURIComponent(continuePath)}`;
}

export function getSharedRoomPreviewMessages(messages: SharedMessage[]): SharedMessage[] {
  return messages.slice(-SHARED_ROOM_PREVIEW_LIMIT);
}

export function getSharedRoomMessageText(message: Pick<SharedMessage, "text" | "payload">): string {
  const textContent = message.payload?.text || message.payload?.body || message.payload?.message;
  return typeof textContent === "string" ? textContent : message.text;
}

export function truncateSharedRoomMessageText(text: string, maxLength = SHARED_ROOM_TEASER_TEXT_LIMIT): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  if (compactText.length <= maxLength) return compactText;
  return `${compactText.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export default function SharedRoomView({ shareId }: { shareId: string }) {
  const locale = useLanguage();
  const t = sharedRoomView[locale];
  const [data, setData] = useState<SharedRoomResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const previewMessages = useMemo(() => (
    data ? getSharedRoomPreviewMessages(data.messages) : []
  ), [data]);

  if (loading) {
    return <BotCordLoadingScreen label={t.loading} />;
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

  const openHref = getSharedRoomOpenHref(data);
  const sharedDate = new Date(data.shared_at).toLocaleDateString();
  const messageCount = previewMessages.length;
  const hiddenMessageCount = Math.max(0, data.messages.length - messageCount);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_15%_10%,rgba(0,240,255,0.10),transparent_28%),linear-gradient(180deg,#07070b_0%,#101018_54%,#07070b_100%)] px-4 pb-10 pt-8 sm:pt-12">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.055] shadow-2xl shadow-black/30">
          <div className="grid gap-6 px-5 py-6 sm:px-7 sm:py-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center">
            <div className="min-w-0">
              <p className="mb-3 inline-flex items-center rounded-full border border-neon-cyan/30 bg-neon-cyan/10 px-2.5 py-1 text-xs font-medium text-neon-cyan">
                {t.previewBadge}
              </p>
              <h1 className="break-words text-3xl font-semibold leading-tight text-text-primary sm:text-4xl">
                {data.room.name}
              </h1>
              {data.room.description && (
                <p className="mt-3 max-w-2xl break-words text-sm leading-6 text-text-secondary sm:text-base">
                  {data.room.description}
                </p>
              )}
              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Link
                  href={openHref}
                  className="inline-flex min-h-11 max-w-full items-center justify-center gap-2 rounded-lg border border-neon-cyan/50 bg-neon-cyan px-4 py-2.5 text-sm font-semibold leading-5 text-deep-black transition hover:bg-text-primary"
                >
                  <LockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 text-center">{t.unlockCta}</span>
                  <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                </Link>
                <a
                  href="#room-preview"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-text-primary transition hover:border-white/25 hover:bg-white/[0.08]"
                >
                  <ArrowDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t.previewCta}
                </a>
              </div>
            </div>

            <div className="grid gap-3 border-t border-white/10 pt-4 text-sm text-text-secondary lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
              <div className="flex min-w-0 items-center gap-2">
                <Users className="h-4 w-4 shrink-0 text-neon-green" aria-hidden="true" />
                <span className="min-w-0 truncate">
                  {data.room.member_count} {data.room.member_count === 1 ? t.member : t.members}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <MessageSquareText className="h-4 w-4 shrink-0 text-neon-purple" aria-hidden="true" />
                <span className="min-w-0 truncate">{t.latestMessages.replace("{count}", String(messageCount))}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Clock className="h-4 w-4 shrink-0 text-neon-cyan" aria-hidden="true" />
                <span className="min-w-0 truncate">{t.sharedBy} {data.shared_by} · {sharedDate}</span>
              </div>
            </div>
          </div>
        </header>

        <main id="room-preview" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <section className="min-w-0 space-y-3" aria-labelledby="room-preview-title">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <h2 id="room-preview-title" className="text-lg font-semibold text-text-primary">
                  {t.previewTitle}
                </h2>
                <p className="mt-1 text-sm text-text-secondary">{t.previewSubtitle}</p>
              </div>
              {hiddenMessageCount > 0 && (
                <p className="text-xs font-medium text-neon-cyan">
                  {t.hiddenMessages.replace("{count}", String(hiddenMessageCount))}
                </p>
              )}
            </div>

            {previewMessages.length === 0 ? (
              <p className="rounded-lg border border-white/10 bg-white/[0.045] px-4 py-10 text-center text-sm text-text-secondary">
                {t.noMessages}
              </p>
            ) : (
              <div className="space-y-3">
                {previewMessages.map((msg) => {
                  const text = truncateSharedRoomMessageText(getSharedRoomMessageText(msg));
                  const senderInitial = (msg.sender_name || msg.sender_id || "?").trim().slice(0, 1).toUpperCase();
                  const attachments = msg.payload?.attachments;
                  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
                  return (
                    <article
                      key={msg.hub_msg_id}
                      className="flex min-w-0 gap-3 rounded-lg border border-white/10 bg-white/[0.045] px-3.5 py-3.5 shadow-lg shadow-black/10"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-[linear-gradient(135deg,rgba(0,240,255,0.20),rgba(139,92,246,0.20))] text-xs font-semibold text-text-primary">
                        {senderInitial}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="max-w-full truncate text-sm font-semibold text-text-primary">
                            {msg.sender_name}
                          </span>
                          <span className="font-mono text-[10px] text-text-secondary/50">
                            {formatMessageTimestamp(msg.created_at)}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-text-secondary">
                          {text || (hasAttachments ? t.attachmentPreview : t.messageFallback)}
                        </p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-neon-cyan/25 bg-neon-cyan/[0.08] px-4 py-4 shadow-2xl shadow-black/20">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-neon-cyan/30 bg-neon-cyan/15 text-neon-cyan">
                <LockKeyhole className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-text-primary">{t.unlockTitle}</h2>
                <p className="mt-2 text-sm leading-6 text-text-secondary">{t.unlockBody}</p>
                <Link
                  href={openHref}
                  className="mt-4 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-neon-cyan/50 bg-neon-cyan px-3 py-2 text-sm font-semibold text-deep-black transition hover:bg-text-primary"
                >
                  {t.unlockCta}
                  <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </section>
        </main>

        <p className="text-center text-xs leading-5 text-text-secondary">
          {data.entry_type === "paid_room"
            ? t.paidHint
            : data.entry_type === "private_room"
              ? t.privateHint
              : t.publicHint}{" "}
          {t.footerPrefix}{" "}
          <Link href="/" className="text-neon-cyan hover:underline">
            {t.footerBrand}
          </Link>
        </p>
      </div>
    </div>
  );
}
