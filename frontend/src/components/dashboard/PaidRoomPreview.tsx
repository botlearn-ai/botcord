"use client";

/**
 * [INPUT]: 依赖有界页面缓存及公开摘要 API，保留已加载摘要并后台复核，依赖 SubscriptionBadge 完成登录/订阅入口
 * [OUTPUT]: 对外提供 PaidRoomPreview 组件，向未订阅用户展示固定 3 条消息摘要与订阅动作
 * [POS]: dashboard 付费房间门前橱窗，被 ChatPane 的付费未加入分支消费，避免权限空态变成黑洞
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo } from "react";
import { Lock } from "lucide-react";
import { useStore } from "zustand";
import { getPaidRoomPreviewStore } from "./paid-room-preview-cache";
import type { PublicRoomMessagePreview } from "@/lib/types";
import { useLanguage } from "@/lib/i18n";
import { chatPane } from "@/lib/i18n/translations/dashboard";
import { MobileBotCordLoading } from "@/components/ui/BotCordLoader";
import SubscriptionBadge from "./SubscriptionBadge";


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
  const store = useMemo(() => getPaidRoomPreviewStore(roomId, productId), [roomId, productId]);
  const { messages, loading, error, load } = useStore(store);

  useEffect(() => {
    void load();
  }, [load, roomId, productId]);

  const previewMessages = useMemo(
    () => (messages ?? [])
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
            <div className="liquid-empty-state flex items-center justify-center rounded-lg border border-glass-border px-3 py-5 text-xs text-text-secondary">
              <MobileBotCordLoading
                label={t.loadingPreviewMessages}
                size="sm"
                textClassName="text-xs text-text-secondary"
              />
            </div>
          ) : error && messages === null ? (
            <div role="alert" className="rounded-lg border border-glass-border px-3 py-5 text-center text-xs text-text-secondary">
              <p>{locale === "zh" ? "预览加载失败" : "Unable to load previews"}</p>
              <button type="button" onClick={() => void load()} className="mt-2 text-neon-cyan hover:underline">
                {locale === "zh" ? "重试" : "Retry"}
              </button>
            </div>
          ) : previewMessages.length > 0 ? (
            <div className="space-y-2">
              {previewMessages.map(({ message, text }) => (
                <div
                  key={message.hub_msg_id}
                  className="liquid-card rounded-lg border border-glass-border px-3 py-2.5"
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
            <div className="liquid-empty-state rounded-lg border border-glass-border px-3 py-5 text-center text-xs text-text-secondary">
              {t.noPreviewMessages}
            </div>
          )}
        </div>

        {error && messages !== null ? (
          <p role="status" className="mt-3 text-xs text-text-secondary">
            {locale === "zh" ? "暂时无法更新预览。" : "Unable to refresh previews. "}
            <button type="button" onClick={() => void load()} className="ml-1 text-neon-cyan hover:underline">
              {locale === "zh" ? "重试" : "Retry"}
            </button>
          </p>
        ) : null}

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
