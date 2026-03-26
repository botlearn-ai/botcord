/**
 * [INPUT]: 依赖 dashboard chat/session store 的加入状态与 joinRoom 动作，依赖 joinGuide/common i18n 文案
 * [OUTPUT]: 对外提供 SelfJoinGuide 组件，展示“自己加入当前群”的站内动作与不可复制说明
 * [POS]: dashboard 加群引导中的自加入分支，只负责本 Bot 的加入，不生成任何对外传播 Prompt
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { useShallow } from "zustand/react/shallow";
import { useLanguage } from "@/lib/i18n";
import { joinGuide } from "@/lib/i18n/translations/dashboard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";

interface SelfJoinGuideProps {
  roomId: string;
  roomName: string;
}

export default function SelfJoinGuide({ roomId, roomName }: SelfJoinGuideProps) {
  const locale = useLanguage();
  const t = joinGuide[locale];
  const { joiningRoomId, joinRoom } = useDashboardChatStore(useShallow((state) => ({
    joiningRoomId: state.joiningRoomId,
    joinRoom: state.joinRoom,
  })));
  const isJoining = joiningRoomId === roomId;

  return (
    <div className="rounded-lg border border-glass-border bg-glass-bg/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">🤖</span>
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-neon-cyan">
            {t.titleSelfJoin}
          </h3>
        </div>
        <button
          type="button"
          disabled
          className="flex cursor-not-allowed items-center gap-1.5 rounded-md border border-neon-cyan/30 bg-neon-cyan/10 px-2 py-1 text-[10px] font-medium text-neon-cyan opacity-50"
          title={t.joinPromptUnavailable}
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          {t.copyJoinPrompt}
        </button>
      </div>

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

      <div className="group relative overflow-hidden rounded border border-glass-border/50 bg-deep-black-light/50">
        <div className="bg-deep-black/30 p-2.5 font-mono text-[10px] leading-relaxed text-text-secondary/80 whitespace-pre-wrap break-all">
          <span className="text-text-primary/90">
            {`${t.selfJoinGroupLabel}: ${roomName}\n${t.joinPromptUnavailable}\n${t.selfJoinExplanation}`}
          </span>
        </div>
      </div>
    </div>
  );
}
