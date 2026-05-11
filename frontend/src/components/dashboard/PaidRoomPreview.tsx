"use client";

/**
 * [INPUT]: 依赖 api.getPublicRoomMessagePreviews 拉取订阅房间公开摘要，依赖 SubscriptionBadge 完成登录/订阅入口
 * [OUTPUT]: 对外提供 PaidRoomPreview 组件，向未订阅用户展示固定 3 条消息摘要与订阅动作
 * [POS]: dashboard 付费房间门前橱窗，被 ChatPane 的付费未加入分支消费，避免权限空态变成黑洞
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useState } from "react";
import { Lock, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { PublicRoomMessagePreview } from "@/lib/types";
import { useLanguage } from "@/lib/i18n";
import { chatPane } from "@/lib/i18n/translations/dashboard";
import SubscriptionBadge from "./SubscriptionBadge";

const PREVIEW_LIMIT = 3;

function senderName(message: PublicRoomMessagePreview): string {
  return message.sender_name || message.sender_id;
}

function timeLabel(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PaidRoomPreview({
  roomId,
  productId,
  isGuest,
  loginHref,
}: {
  roomId: string;
  productId: string;
  isGuest: boolean;
  loginHref: string;
}) {
  const locale = useLanguage();
  const t = chatPane[locale];
  const [messages, setMessages] = useState<PublicRoomMessagePreview[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessages([]);

    api.getPublicRoomMessagePreviews(roomId)
      .then((result) => {
        if (cancelled) return;
        setMessages(result.messages.slice(0, PREVIEW_LIMIT));
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("[PaidRoomPreview] Failed to load preview messages:", error);
          setMessages([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const previewMessages = useMemo(
    () => messages
      .map((message) => ({ message, text: message.preview }))
      .filter((item) => item.text.length > 0),
    [messages],
  );

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8 text-center">
      <div className="w-full max-w-xl">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-neon-cyan/20 bg-neon-cyan/10 text-neon-cyan">
          <Lock className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-text-primary">{t.subscriptionRequired}</h3>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-text-secondary">
          {t.subscriptionPreviewDesc}
        </p>

        <div className="mt-6 text-left">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-text-primary">{t.previewMessages}</p>
            <p className="text-[11px] text-text-secondary/70">{t.previewMessagesHint}</p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center rounded-lg border border-glass-border bg-deep-black-light px-3 py-5 text-xs text-text-secondary">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              {t.loadingPreviewMessages}
            </div>
          ) : previewMessages.length > 0 ? (
            <div className="space-y-2">
              {previewMessages.map(({ message, text }) => (
                <div
                  key={message.hub_msg_id}
                  className="rounded-lg border border-glass-border bg-glass-bg px-3 py-2.5"
                >
                  <div className="mb-1 flex min-w-0 items-center gap-2 text-[11px] text-text-secondary/70">
                    <span className="truncate font-medium text-neon-purple/90">{senderName(message)}</span>
                    <span className="shrink-0 text-text-secondary/40">/</span>
                    <span className="shrink-0">{timeLabel(message.created_at)}</span>
                  </div>
                  <p className="line-clamp-2 text-xs leading-relaxed text-text-primary/85">{text}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-glass-border bg-deep-black-light px-3 py-5 text-center text-xs text-text-secondary">
              {t.noPreviewMessages}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-center">
          <SubscriptionBadge
            productId={productId}
            roomId={roomId}
            variant="button"
            triggerLabel={isGuest ? t.loginToParticipate : t.subscriptionRequired}
            loginHref={loginHref}
          />
        </div>
      </div>
    </div>
  );
}
