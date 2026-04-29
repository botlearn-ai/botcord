"use client";

import { startTransition, useMemo, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { sidebar } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import RoomList from "../RoomList";
import RoomZeroState from "../RoomZeroState";
import SearchBar from "../SearchBar";

interface MessagesPanelProps {
  isGuest: boolean;
  onCreateRoom: () => void;
}

export default function MessagesPanel({ isGuest, onCreateRoom }: MessagesPanelProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = sidebar[locale];

  const { activeAgentId, sessionMode, token, humanRooms } = useDashboardSessionStore(useShallow((s) => ({
    activeAgentId: s.activeAgentId,
    sessionMode: s.sessionMode,
    token: s.token,
    humanRooms: s.humanRooms,
  })));
  const { sidebarTab, openedRoomId, messagesPane } = useDashboardUIStore(useShallow((s) => ({
    sidebarTab: s.sidebarTab,
    openedRoomId: s.openedRoomId,
    messagesPane: s.messagesPane,
  })));
  const { overview, messages, recentVisitedRooms } = useDashboardChatStore(useShallow((s) => ({
    overview: s.overview,
    messages: s.messages,
    recentVisitedRooms: s.recentVisitedRooms,
  })));
  const { optimisticUnreadRoomIds, isRoomUnread } = useDashboardUnreadStore(useShallow((s) => ({
    optimisticUnreadRoomIds: s.optimisticUnreadRoomIds,
    isRoomUnread: s.isRoomUnread,
  })));

  const [messageQuery, setMessageQuery] = useState("");

  const visibleMessageRooms = useMemo(
    () => buildVisibleMessageRooms({ overview, recentVisitedRooms, token, humanRooms }),
    [overview, recentVisitedRooms, token, humanRooms],
  );

  const normalizedMessageQuery = messageQuery.trim().toLowerCase();
  const filteredMessageRooms = useMemo(() => {
    if (!normalizedMessageQuery) return visibleMessageRooms;
    return visibleMessageRooms.filter((room) => {
      const cachedLatestMessage = messages[room.room_id]?.findLast(
        (m) => m.type !== "ack" && m.type !== "result" && m.type !== "error",
      );
      const searchHaystack = [
        room.name, room.room_id, room.description,
        room.last_message_preview, room.last_sender_name,
        cachedLatestMessage?.text, cachedLatestMessage?.sender_name,
      ].filter(Boolean).join("\n").toLowerCase();
      return searchHaystack.includes(normalizedMessageQuery);
    });
  }, [messages, normalizedMessageQuery, visibleMessageRooms]);

  const showOverviewSkeleton = sessionMode === "authed-ready" && !overview && sidebarTab === "messages";

  return (
    <div className="flex min-h-full flex-col py-1">
      <div className="border-b border-glass-border px-3 pb-3">
        <SearchBar onSearch={setMessageQuery} placeholder={t.searchMessages} />
      </div>
      {visibleMessageRooms.length === 0 && !activeAgentId ? (
        <RoomZeroState compact />
      ) : !showOverviewSkeleton && filteredMessageRooms.length === 0 && !activeAgentId ? (
        <div className="px-4 py-6 text-center text-xs text-text-secondary">
          {t.noMessages}
        </div>
      ) : (
        <>
          <RoomList rooms={filteredMessageRooms} loading={showOverviewSkeleton} searchQuery={messageQuery} />
          {!showOverviewSkeleton && !normalizedMessageQuery && filteredMessageRooms.length < 5 && (
            <div className="mx-3 mb-3 mt-auto rounded-2xl border border-dashed border-glass-border/60 bg-glass-bg/20 p-4">
              <p className="text-[11px] font-semibold text-text-secondary/80">
                {locale === "zh" ? "发现更多社区" : "Discover communities"}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-text-secondary/55">
                {locale === "zh" ? "加入公开房间，或创建你自己的社区" : "Join a public room or create your own."}
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {!isGuest && (
                  <button
                    type="button"
                    onClick={onCreateRoom}
                    className="rounded-xl border border-neon-purple/35 bg-neon-purple/10 px-3 py-1.5 text-[11px] font-medium text-neon-purple transition-colors hover:bg-neon-purple/20"
                  >
                    {locale === "zh" ? "创建房间" : "Create a room"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    useDashboardUIStore.getState().setExploreView("rooms");
                    useDashboardUIStore.getState().setSidebarTab("explore");
                    startTransition(() => { router.push("/chats/explore/rooms"); });
                  }}
                  className="rounded-xl border border-glass-border/70 bg-deep-black-light px-3 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:border-neon-cyan/35 hover:text-neon-cyan"
                >
                  {locale === "zh" ? "探索公开社区" : "Explore public rooms"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
