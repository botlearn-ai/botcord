"use client";

/**
 * [INPUT]: 依赖 api/getSharedRoom 拉取共享快照，依赖 next/link 提供站内返回入口，依赖 SharedMessageBubble 渲染消息内容
 * [OUTPUT]: 对外提供 SharedRoomView 组件，负责共享房间最新 30 条预览、加载、错误态与只读消息列表展示
 * [POS]: share 模块的页面主体，被 /share/[shareId] 路由消费，是外部访问共享快照的只读容器
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { ArrowUpRight, Clock, MessageSquareText, Users } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { SharedMessage, SharedRoomResponse } from "@/lib/types";
import SharedMessageBubble from "./SharedMessageBubble";
import { useLanguage } from "@/lib/i18n";
import { sharedRoomView } from "@/lib/i18n/translations/dashboard";

const SHARED_ROOM_PREVIEW_LIMIT = 30;

export function getSharedRoomOpenHref(data: Pick<SharedRoomResponse, "continue_url" | "entry_type">): string {
  const continuePath = data.continue_url.replace(/^https?:\/\/[^/]+/, "");
  if (data.entry_type === "public_room") return continuePath;
  return `/login?next=${encodeURIComponent(continuePath)}`;
}

export function getSharedRoomPreviewMessages(messages: SharedMessage[]): SharedMessage[] {
  return messages.slice(-SHARED_ROOM_PREVIEW_LIMIT);
}

export default function SharedRoomView({ shareId }: { shareId: string }) {
  const locale = useLanguage();
  const t = sharedRoomView[locale];
  const [data, setData] = useState<SharedRoomResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!data || previewMessages.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data, previewMessages.length]);

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

  const openHref = getSharedRoomOpenHref(data);
  const sharedDate = new Date(data.shared_at).toLocaleDateString();
  const messageCount = previewMessages.length;

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#0a0a0f_0%,#12121a_48%,#0a0a0f_100%)] px-4 pb-10 pt-16">
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        <header className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.06] shadow-2xl shadow-black/30">
          <div className="border-b border-white/10 bg-[linear-gradient(135deg,rgba(0,240,255,0.12),rgba(139,92,246,0.10)_48%,rgba(16,185,129,0.10))] px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="mb-2 inline-flex items-center rounded-full border border-neon-cyan/30 bg-neon-cyan/10 px-2.5 py-1 text-xs font-medium text-neon-cyan">
                  {t.previewBadge}
                </p>
                <h1 className="text-2xl font-semibold text-text-primary sm:text-3xl">{data.room.name}</h1>
                {data.room.description && (
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">{data.room.description}</p>
                )}
              </div>
              <Link
                href={openHref}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-neon-cyan/50 bg-neon-cyan px-4 py-2.5 text-sm font-semibold text-deep-black transition hover:bg-text-primary"
              >
                {t.openInBotcord}
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="grid gap-3 px-5 py-4 text-sm text-text-secondary sm:grid-cols-3 sm:px-6">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-neon-green" aria-hidden="true" />
              <span>{data.room.member_count} {data.room.member_count === 1 ? t.member : t.members}</span>
            </div>
            <div className="flex items-center gap-2">
              <MessageSquareText className="h-4 w-4 text-neon-purple" aria-hidden="true" />
              <span>{t.latestMessages.replace("{count}", String(messageCount))}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-neon-cyan" aria-hidden="true" />
              <span>{t.sharedBy} {data.shared_by} · {sharedDate}</span>
            </div>
          </div>
        </header>

        <main className="overflow-hidden rounded-lg border border-white/10 bg-deep-black-light/80 shadow-2xl shadow-black/20">
          <div className="sticky top-0 z-10 border-b border-white/10 bg-deep-black-light/95 px-4 py-3 backdrop-blur sm:px-5">
            <Link
              href={openHref}
              className="group flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-text-secondary transition hover:border-neon-cyan/40 hover:bg-neon-cyan/10 hover:text-text-primary"
            >
              <span>{t.showMore}</span>
              <span className="inline-flex items-center gap-1 font-medium text-neon-cyan">
                {t.jumpToRoom}
                <ArrowUpRight className="h-4 w-4 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
              </span>
            </Link>
          </div>

          <div className="px-3 py-4 sm:px-5 sm:py-5">
            {previewMessages.length === 0 ? (
              <p className="py-12 text-center text-sm text-text-secondary">{t.noMessages}</p>
            ) : (
              <div className="space-y-3">
                {previewMessages.map((msg) => (
                  <SharedMessageBubble key={msg.hub_msg_id} message={msg} />
                ))}
                <div ref={messagesEndRef} aria-hidden="true" />
              </div>
            )}
          </div>
        </main>

        <p className="text-center text-xs text-text-secondary">
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
