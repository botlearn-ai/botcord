"use client";

/**
 * [INPUT]: 依赖 session store 获取登录态与当前 agent，依赖 nextjs-toploader/app 跳转 Explore 并触发全局进度反馈，依赖 i18n/common 输出空态与复制反馈
 * [OUTPUT]: 对外提供 RoomZeroState 组件，输出“复制建房 Prompt / 去 Explore 选房间 / 登录”动作
 * [POS]: messages 空态的统一引导层，被 Sidebar 与 ChatPane 复用，避免无房间时出现死胡同
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { common } from "@/lib/i18n/translations/common";
import { roomZeroState } from "@/lib/i18n/translations/dashboard";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { buildCreateRoomPrompt } from "@/lib/onboarding";
import { humansApi } from "@/lib/api";

interface RoomZeroStateProps {
  compact?: boolean;
}

export default function RoomZeroState({ compact = false }: RoomZeroStateProps) {
  const router = useRouter();
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const human = useDashboardSessionStore((state) => state.human);
  const refreshHumanRooms = useDashboardSessionStore((state) => state.refreshHumanRooms);
  const locale = useLanguage();
  const tc = common[locale];
  const t = roomZeroState[locale];
  const [copied, setCopied] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [createRoomError, setCreateRoomError] = useState<string | null>(null);
  const isGuest = sessionMode === "guest";
  const isAuthedReady = sessionMode === "authed-ready";
  const showLoginModal = () => router.push("/login");

  const handleCreateHumanRoom = async () => {
    if (!human) return;
    setCreatingRoom(true);
    setCreateRoomError(null);
    try {
      const defaultName =
        locale === "zh"
          ? `${human.display_name || "我"}的房间`
          : `${human.display_name || "My"}'s room`;
      const room = await humansApi.createRoom({ name: defaultName });
      // Refresh so the sidebar room list picks up the new Human-owned room
      // before we navigate — avoids a flash where the list is stale.
      await refreshHumanRooms();
      router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
    } catch (err: any) {
      setCreateRoomError(err?.message || "Failed to create room");
    } finally {
      setCreatingRoom(false);
    }
  };

  const createRoomPrompt = useMemo(() => {
    return buildCreateRoomPrompt({ locale });
  }, [locale]);

  const handleCopyPrompt = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    await navigator.clipboard.writeText(createRoomPrompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const containerClassName = compact
    ? "m-3 rounded-2xl border border-dashed border-glass-border bg-glass-bg/30 p-4"
    : "mx-auto flex w-full max-w-xl flex-col items-center rounded-3xl border border-dashed border-glass-border bg-glass-bg/30 p-6 text-center";

  return (
    <div className={containerClassName}>
      <div className={compact ? "" : "max-w-md"}>
        <p className="text-sm font-semibold text-text-primary">{t.title}</p>
        <p className="mt-2 text-xs leading-6 text-text-secondary">{t.description}</p>
      </div>

      <div className={`mt-4 flex ${compact ? "flex-col" : "flex-wrap justify-center"} gap-3`}>
        {!isGuest && human ? (
          <button
            type="button"
            onClick={() => void handleCreateHumanRoom()}
            disabled={creatingRoom}
            className="rounded-xl border border-neon-purple/40 bg-neon-purple/10 px-4 py-2 text-xs font-medium text-neon-purple transition-colors hover:bg-neon-purple/20 disabled:opacity-50"
          >
            {creatingRoom
              ? locale === "zh"
                ? "创建中…"
                : "Creating…"
              : locale === "zh"
                ? "以 Human 创建房间"
                : "Create a room as yourself"}
          </button>
        ) : null}
        {isAuthedReady && (
          <button
            type="button"
            onClick={() => void handleCopyPrompt()}
            className="rounded-xl border border-neon-cyan/35 bg-neon-cyan/10 px-4 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            {copied ? tc.copied : t.copyPrompt}
          </button>
        )}
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
      {createRoomError ? (
        <p className="mt-3 text-xs text-red-300">{createRoomError}</p>
      ) : null}

      {isAuthedReady && (
        <div className="mt-4 w-full overflow-hidden rounded-2xl border border-glass-border/70 bg-deep-black/40 text-left">
          <div className="border-b border-glass-border/60 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-text-secondary/70">
            {t.promptLabel}
          </div>
          <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-5 text-text-secondary/85">
            {createRoomPrompt}
          </pre>
        </div>
      )}
    </div>
  );
}
