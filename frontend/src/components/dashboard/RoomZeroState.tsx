"use client";

/**
 * [INPUT]: 依赖 session store 获取登录态与当前 agent，依赖 nextjs-toploader/app 跳转 Explore 并触发全局进度反馈，依赖 i18n/common 输出空态与复制反馈
 * [OUTPUT]: 对外提供 RoomZeroState 组件，输出“复制建房 Prompt / 去 Explore 选房间 / 登录”动作
 * [POS]: messages 空态的统一引导层，被 Sidebar 与 ChatPane 复用，避免无房间时出现死胡同
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { roomZeroState } from "@/lib/i18n/translations/dashboard";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import CreateRoomModal from "./CreateRoomModal";

interface RoomZeroStateProps {
  compact?: boolean;
}

export default function RoomZeroState({ compact = false }: RoomZeroStateProps) {
  const router = useRouter();
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const human = useDashboardSessionStore((state) => state.human);
  const ownedAgents = useDashboardSessionStore((state) => state.ownedAgents);
  const locale = useLanguage();
  const t = roomZeroState[locale];
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const isGuest = sessionMode === "guest";
  const showLoginModal = () => router.push("/login");
  // Human-first onboarding: brand-new users (have a Human identity but zero
  // Agents) get a friendlier "welcome, start a room" framing that reassures
  // them an Agent is optional.
  const isHumanFirstTime = !isGuest && human && ownedAgents.length === 0;
  const titleCopy = isHumanFirstTime ? t.humanTitle : t.title;
  const descCopy = isHumanFirstTime ? t.humanDescription : t.description;

  const containerClassName = compact
    ? "m-3 rounded-2xl border border-dashed border-glass-border bg-glass-bg/30 p-4"
    : "mx-auto flex w-full max-w-xl flex-col items-center rounded-3xl border border-dashed border-glass-border bg-glass-bg/30 p-6 text-center";

  return (
    <div className={containerClassName}>
      <div className={compact ? "" : "max-w-md"}>
        <p className="text-sm font-semibold text-text-primary">{titleCopy}</p>
        <p className="mt-2 text-xs leading-6 text-text-secondary">{descCopy}</p>
      </div>

      <div className={`mt-4 flex ${compact ? "flex-col" : "flex-wrap justify-center"} gap-3`}>
        {!isGuest && human ? (
          <button
            type="button"
            onClick={() => setShowCreateRoom(true)}
            className="rounded-xl border border-neon-purple/40 bg-neon-purple/10 px-4 py-2 text-xs font-medium text-neon-purple transition-colors hover:bg-neon-purple/20"
          >
            {locale === "zh" ? "创建房间" : "Create a room"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => router.push("/chats/explore/rooms")}
          className="rounded-xl border border-glass-border bg-deep-black-light px-4 py-2 text-xs font-medium text-text-primary transition-colors hover:border-neon-cyan/35 hover:text-neon-cyan"
        >
          {t.openExplore}
        </button>
        {isGuest && (
          <button
            type="button"
            onClick={showLoginModal}
            className="rounded-xl border border-neon-cyan/25 bg-neon-cyan/10 px-4 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            {t.loginToCreate}
          </button>
        )}
      </div>
      {showCreateRoom && <CreateRoomModal onClose={() => setShowCreateRoom(false)} />}
    </div>
  );
}
