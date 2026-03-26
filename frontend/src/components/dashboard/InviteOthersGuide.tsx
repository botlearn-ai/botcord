/**
 * [INPUT]: 依赖 share/invite API 为当前已加入群生成真实 share asset，依赖 onboarding 模板把真实入口写成可复制 Prompt
 * [OUTPUT]: 对外提供 InviteOthersGuide 组件，展示邀请他人加入当前群的 Prompt 并支持复制
 * [POS]: dashboard 加群引导中的外部邀请分支，只消费真实 invite/share 资产，不接触内部 room route
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { common } from "@/lib/i18n/translations/common";
import { joinGuide } from "@/lib/i18n/translations/dashboard";
import type { CreateShareResponse, InvitePreviewResponse } from "@/lib/types";
import { buildSharePrompt } from "@/lib/onboarding";

interface InviteOthersGuideProps {
  roomId: string;
  roomName: string;
  visibility: string;
  canInvite?: boolean;
}

export default function InviteOthersGuide({ roomId, roomName, visibility, canInvite = true }: InviteOthersGuideProps) {
  const locale = useLanguage();
  const tc = common[locale];
  const t = joinGuide[locale];
  const [copied, setCopied] = useState(false);
  const [shareData, setShareData] = useState<CreateShareResponse | InvitePreviewResponse | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [isPreparingPrompt, setIsPreparingPrompt] = useState(false);

  const needsInviteLink = visibility === "private";

  useEffect(() => {
    if (needsInviteLink && !canInvite) return;

    let cancelled = false;

    async function prepareShareAsset() {
      setIsPreparingPrompt(true);
      setPromptError(null);
      try {
        const nextShareData = needsInviteLink
          ? await api.createRoomInvite(roomId)
          : await api.createShareLink(roomId);
        if (!cancelled) {
          setShareData(nextShareData);
        }
      } catch (err) {
        if (!cancelled) {
          setPromptError(err instanceof Error ? err.message : t.preparePromptFailed);
        }
      } finally {
        if (!cancelled) {
          setIsPreparingPrompt(false);
        }
      }
    }

    void prepareShareAsset();

    return () => {
      cancelled = true;
    };
  }, [canInvite, needsInviteLink, roomId, t.preparePromptFailed]);

  const combinedPrompt = useMemo(() => {
    if (!shareData) {
      return isPreparingPrompt ? t.preparingPrompt : (promptError || t.promptUnavailable);
    }

    const shareId = "share_id" in shareData ? shareData.share_id : undefined;
    const inviteCode = "code" in shareData ? shareData.code : undefined;
    return buildSharePrompt({
      shareId,
      inviteCode,
      roomId,
      roomName,
      requiresPayment: shareData.entry_type === "paid_room",
      isReadOnly: shareData.entry_type === "private_room",
      locale,
    });
  }, [isPreparingPrompt, locale, promptError, roomName, shareData, t.preparingPrompt, t.promptUnavailable]);

  const handleCopy = () => {
    if (!shareData || typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(combinedPrompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (needsInviteLink && !canInvite) {
    return (
      <div className="rounded-lg border border-glass-border bg-glass-bg/30 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm">🔒</span>
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-secondary/60">
            {t.titleInviteOthers}
          </h3>
        </div>
        <p className="text-[10px] leading-relaxed text-text-secondary/70">
          {t.noInvitePermission}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-glass-border bg-glass-bg/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">🤖</span>
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-neon-cyan">
            {t.titleInviteOthers}
          </h3>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!shareData}
          className="flex items-center gap-1.5 rounded-md border border-neon-cyan/30 bg-neon-cyan/10 px-2 py-1 text-[10px] font-medium text-neon-cyan transition-all hover:bg-neon-cyan/20 hover:border-neon-cyan/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copied ? (
            <>
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {tc.copied}
            </>
          ) : (
            <>
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {t.copyInvitePrompt}
            </>
          )}
        </button>
      </div>

      <div className="group relative overflow-hidden rounded border border-glass-border/50 bg-deep-black-light/50">
        <div className="bg-deep-black/30 p-2.5 font-mono text-[10px] leading-relaxed text-text-secondary/80 whitespace-pre-wrap break-all">
          <span className="text-text-primary/90">{combinedPrompt}</span>
        </div>
      </div>
    </div>
  );
}
