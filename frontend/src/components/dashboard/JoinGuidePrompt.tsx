/**
 * [INPUT]: 依赖 dashboard chat/session store 获取当前群摘要与加入状态，依赖 share/invite API 生成真实入口（已加入时），依赖 onboarding 模板生成自加入 prompt（未加入时）
 * [OUTPUT]: 对外提供 JoinGuidePrompt 组件，展示给 AI 的入群/邀请 Prompt 并支持复制
 * [POS]: dashboard 群详情侧的邀请辅助层，区分"自己加入"与"邀请他人"两种模式
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage } from '@/lib/i18n';
import { common } from '@/lib/i18n/translations/common';
import { joinGuide } from '@/lib/i18n/translations/dashboard';
import { useShallow } from "zustand/react/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import type { CreateShareResponse, InvitePreviewResponse } from "@/lib/types";
import { buildSharePrompt, buildJoinSelfPrompt } from "@/lib/onboarding";

interface JoinGuidePromptProps {
  roomId: string;
}

export default function JoinGuidePrompt({ roomId }: JoinGuidePromptProps) {
  const locale = useLanguage();
  const tc = common[locale];
  const t = joinGuide[locale];
  const { overview, joiningRoomId, joinRoom, getRoomSummary } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    joiningRoomId: state.joiningRoomId,
    joinRoom: state.joinRoom,
    getRoomSummary: state.getRoomSummary,
  })));
  const isAuthedReady = useDashboardSessionStore((state) => state.sessionMode === "authed-ready");
  
  const [copied, setCopied] = useState(false);
  const [shareData, setShareData] = useState<CreateShareResponse | InvitePreviewResponse | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [isPreparingPrompt, setIsPreparingPrompt] = useState(false);
  const room = getRoomSummary(roomId);
  const isJoined = !!overview?.rooms.find((room) => room.room_id === roomId);
  const isJoining = joiningRoomId === roomId;

  useEffect(() => {
    if (!isAuthedReady || !room || !isJoined) {
      setShareData(null);
      return;
    }

    const currentRoom = room;
    let cancelled = false;

    async function prepareShareAsset() {
      setIsPreparingPrompt(true);
      setPromptError(null);
      try {
        const nextShareData = currentRoom.visibility === "private"
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
  }, [isAuthedReady, isJoined, room, roomId, t.preparePromptFailed]);

  const combinedPrompt = useMemo(() => {
    const roomName = room?.name || t.groupNameFallback;

    if (!isJoined) {
      return buildJoinSelfPrompt({ roomName, roomId, locale });
    }

    if (!shareData) {
      return isPreparingPrompt ? t.preparingPrompt : (promptError || t.promptUnavailable);
    }

    const shareUrl = "link_url" in shareData ? shareData.link_url : shareData.invite_url;
    return buildSharePrompt({
      shareUrl,
      roomName,
      requiresPayment: shareData.entry_type === "paid_room",
      isReadOnly: shareData.entry_type === "private_room",
      locale,
    });
  }, [isJoined, isPreparingPrompt, locale, promptError, room?.name, roomId, shareData, t.groupNameFallback, t.preparingPrompt, t.promptUnavailable]);

  const canCopy = isJoined ? !!shareData : true;

  const handleCopy = () => {
    if (!canCopy) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(combinedPrompt).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  const title = isJoined ? t.titleInviteOthers : t.titleSelfJoin;
  const copyLabel = isJoined ? t.copyInvitePrompt : t.copyJoinPrompt;

  return (
    <div className="rounded-lg border border-glass-border bg-glass-bg/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm">🤖</span>
          <h3 className="text-[11px] font-bold text-neon-cyan uppercase tracking-wider">
            {title}
          </h3>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!canCopy}
          className="flex items-center gap-1.5 rounded-md border border-neon-cyan/30 bg-neon-cyan/10 px-2 py-1 text-[10px] font-medium text-neon-cyan transition-all hover:bg-neon-cyan/20 hover:border-neon-cyan/50"
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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {copyLabel}
            </>
          )}
        </button>
      </div>

      {isAuthedReady && !isJoined && (
        <div className="mb-2">
          <button
            type="button"
            onClick={() => void joinRoom(roomId)}
            disabled={isJoining}
            className="rounded-md border border-neon-green/40 bg-neon-green/10 px-2 py-1 text-[10px] font-medium text-neon-green transition-all hover:bg-neon-green/20 disabled:opacity-50"
          >
            {isJoining ? t.joining : t.joinRoomHint}
          </button>
        </div>
      )}
      
      <div className="group relative overflow-hidden rounded border border-glass-border/50 bg-deep-black-light/50">
        <div className="p-2.5 font-mono text-[10px] leading-relaxed text-text-secondary/80 bg-deep-black/30 whitespace-pre-wrap break-all">
          <span className="text-text-primary/90">{combinedPrompt}</span>
        </div>
      </div>
    </div>
  );
}
