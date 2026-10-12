"use client";

/**
 * [INPUT]: 依赖 api/getSharedRoom 拉取共享快照，依赖 next/link 提供站内返回入口，依赖 BotCordLoadingScreen 渲染加载态
 * [OUTPUT]: 对外提供 SharedRoomView 组件，负责共享房间落地页、固定导航避让、紧凑消息预览、按分享 ID 隔离加载与错误态展示
 * [POS]: share 模块的页面主体，被 /share/[shareId] 路由消费，是外部访问共享快照的转化落地页
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import Avatar from "@/components/ui/Avatar";
import EmptyState from "@/components/ui/EmptyState";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import LinkButton from "@/components/ui/LinkButton";
import Card from "@/components/ui/Card";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUpRight, Clock, LockKeyhole, MessageSquareText, Users } from "lucide-react";
import { ApiError } from "@/lib/api";
import type { SharedMessage, SharedRoomResponse } from "@/lib/types";
import { BotCordLoadingScreen } from "@/components/ui/BotCordLoader";
import { useLanguage } from "@/lib/i18n";
import { sharedRoomView } from "@/lib/i18n/translations/dashboard";
import { formatMessageTimestamp } from "@/lib/message-time";

import { loadSharedPreview } from "./landing-requests";

const SHARED_ROOM_PREVIEW_LIMIT = 3;
const SHARED_ROOM_TEASER_TEXT_LIMIT = 220;

export const SHARED_ROOM_PAGE_SHELL_CLASS = "min-h-screen bg-deep-black px-4 pb-10 pt-20 sm:pt-24";
export const SHARED_ROOM_PREVIEW_TARGET_CLASS = "scroll-mt-20 sm:scroll-mt-24";

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
  return <SharedRoomContent key={shareId} shareId={shareId} />;
}

function SharedRoomContent({ shareId }: { shareId: string }) {
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
    setData(null);
    setError(null);
    setLoading(true);
    return loadSharedPreview(shareId, {
      preview: (preview) => {
        setData(preview);
        setLoading(false);
      },
      error: (err) => {
        if (err instanceof ApiError && err.status === 404) {
          setError(t.invalidShare);
        } else {
          setError(err instanceof Error ? err.message : t.loadFailed);
        }
        setLoading(false);
      },
    });
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
        <Alert tone="danger">{error || t.loadFailed}</Alert>
        <LinkButton variant="secondary"
          href="/"
          className="mt-2" >
          {t.goHome}
        </LinkButton>
      </div>
    );
  }

  const openHref = getSharedRoomOpenHref(data);
  const sharedDate = new Date(data.shared_at).toLocaleDateString();
  const messageCount = previewMessages.length;
  const hiddenMessageCount = Math.max(0, data.messages.length - messageCount);

  return (
    <div className={SHARED_ROOM_PAGE_SHELL_CLASS}>
      <div className="mx-auto flex max-w-4xl flex-col gap-7">
        <header className="border-b border-white/10 pb-6 sm:pb-7">
          <Badge tone="accent" className="mb-3">
            {t.previewBadge}
          </Badge>
          <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <h1 className="break-words text-3xl font-semibold leading-tight text-text-primary sm:text-4xl">
                {data.room.name}
              </h1>
              {data.room.description && (
                <p className="mt-3 max-w-3xl break-words text-sm leading-6 text-text-secondary sm:text-base">
                  {data.room.description}
                </p>
              )}
            </div>

            <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col lg:items-stretch">
              <LinkButton variant="primary"
                href={openHref}
                className="max-w-full" >
                <LockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 text-center">{t.unlockCta}</span>
                <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
              </LinkButton>
              <LinkButton variant="secondary"
                href="#room-preview"
                 >
                <ArrowDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t.previewCta}
              </LinkButton>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2 text-sm text-text-secondary">
            <Card padding="md" className="flex min-w-0 items-center gap-2">
              <Users className="h-4 w-4 shrink-0 text-neon-green" aria-hidden="true" />
              <span className="min-w-0 truncate">
                {data.room.member_count} {data.room.member_count === 1 ? t.member : t.members}
              </span>
            </Card>
            <Card padding="md" className="flex min-w-0 items-center gap-2">
              <MessageSquareText className="h-4 w-4 shrink-0 text-neon-cyan" aria-hidden="true" />
              <span className="min-w-0 truncate">{t.latestMessages.replace("{count}", String(messageCount))}</span>
            </Card>
            <Card padding="md" className="flex min-w-0 items-center gap-2">
              <Clock className="h-4 w-4 shrink-0 text-neon-cyan" aria-hidden="true" />
              <span className="min-w-0 truncate">{t.sharedBy} {data.shared_by} · {sharedDate}</span>
            </Card>
          </div>
        </header>

        <main id="room-preview" className={SHARED_ROOM_PREVIEW_TARGET_CLASS}>
          <section className="min-w-0 space-y-3" aria-labelledby="room-preview-title">
            <div className="flex flex-col gap-1">
              <div className="min-w-0">
                <h2 id="room-preview-title" className="text-lg font-semibold text-text-primary">
                  {t.previewTitle}
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {t.previewSubtitle}
                  {hiddenMessageCount > 0 ? ` ${t.hiddenMessages.replace("{count}", String(hiddenMessageCount))}` : ""}
                </p>
              </div>
            </div>

            {previewMessages.length === 0 ? (
              <EmptyState title={t.noMessages} />
            ) : (
              <Card padding="md" >
                {previewMessages.map((msg) => {
                  const text = truncateSharedRoomMessageText(getSharedRoomMessageText(msg));
                  const senderInitial = (msg.sender_name || msg.sender_id || "?").trim().slice(0, 1).toUpperCase();
                  const attachments = msg.payload?.attachments;
                  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
                  return (
                    <article
                      key={msg.hub_msg_id}
                      className="flex min-w-0 gap-3 border-b border-white/10 px-3.5 py-3.5 last:border-b-0" >
                      <Avatar kind={msg.sender_id.startsWith("hu_") ? "human" : "agent"} id={msg.sender_id} name={msg.sender_name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="max-w-full truncate text-sm font-semibold text-text-primary">
                            {msg.sender_name}
                          </span>
                          <span className="font-mono text-xs text-text-secondary">
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
                <div className="flex flex-col gap-3 border-t border-neon-cyan/20 bg-neon-cyan/[0.045] px-3.5 py-3.5 text-sm text-text-secondary sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-2">
                    <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-neon-cyan" aria-hidden="true" />
                    <p className="min-w-0 leading-6">{t.unlockBody}</p>
                  </div>
                  <Link
                    href={openHref}
                    className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-neon-cyan hover:underline" >
                    {t.jumpToRoom}
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>
              </Card>
            )}
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
