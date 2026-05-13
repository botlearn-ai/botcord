"use client";

import { startTransition, useMemo, useState } from "react";
// messagesFilter is in useDashboardUIStore so ChatPane can also read it.
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { sidebar } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import { buildVisibleMessageRooms, isOwnerChatRoom } from "@/store/dashboard-shared";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { Bot, ChevronsRight, MessageSquarePlus, Plus, Search, UserPlus } from "lucide-react";
import MessagesBotScopeDropdown from "./MessagesBotScopeDropdown";
import { applyMessagesFilter, mergeOwnerVisibleRooms } from "@/lib/messages-merge";
import type { DashboardRoom } from "@/lib/types";
import RoomList from "../RoomList";
import RoomZeroState from "../RoomZeroState";
import SearchBar from "../SearchBar";

interface MessagesPanelProps {
  isGuest: boolean;
  onCreateRoom: () => void;
  onAddFriend: () => void;
}

export default function MessagesPanel({ isGuest, onCreateRoom, onAddFriend }: MessagesPanelProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = sidebar[locale];

  const { activeAgentId, sessionMode, token, humanRooms, ownedAgents } = useDashboardSessionStore(useShallow((s) => ({
    activeAgentId: s.activeAgentId,
    sessionMode: s.sessionMode,
    token: s.token,
    humanRooms: s.humanRooms,
    ownedAgents: s.ownedAgents,
  })));
  const { sidebarTab, openedRoomId, messagesPane, messagesFilter, messagesGroupingOpen, setMessagesGroupingOpen, messagesSearchOpen, setMessagesSearchOpen, messagesBotScope, openCreateBotModal } = useDashboardUIStore(useShallow((s) => ({
    sidebarTab: s.sidebarTab,
    openedRoomId: s.openedRoomId,
    messagesPane: s.messagesPane,
    messagesFilter: s.messagesFilter,
    messagesGroupingOpen: s.messagesGroupingOpen,
    setMessagesGroupingOpen: s.setMessagesGroupingOpen,
    messagesSearchOpen: s.messagesSearchOpen,
    setMessagesSearchOpen: s.setMessagesSearchOpen,
    messagesBotScope: s.messagesBotScope,
    openCreateBotModal: s.openCreateBotModal,
  })));
  const { overview, messages, recentVisitedRooms, ownedAgentRooms } = useDashboardChatStore(useShallow((s) => ({
    overview: s.overview,
    messages: s.messages,
    recentVisitedRooms: s.recentVisitedRooms,
    ownedAgentRooms: s.ownedAgentRooms,
  })));
  const { optimisticUnreadRoomIds, isRoomUnread } = useDashboardUnreadStore(useShallow((s) => ({
    optimisticUnreadRoomIds: s.optimisticUnreadRoomIds,
    isRoomUnread: s.isRoomUnread,
  })));

  const [messageQuery, setMessageQuery] = useState("");

  // Owner-unified Messages list: my own conversations + tagged bot conversations.
  const visibleMessageRooms = useMemo<DashboardRoom[]>(() => {
    const ownRooms = buildVisibleMessageRooms({ overview, recentVisitedRooms, token, humanRooms });
    return mergeOwnerVisibleRooms({ ownedAgentRooms, ownRooms });
  }, [overview, recentVisitedRooms, token, humanRooms, ownedAgents, ownedAgentRooms]);

  const isBotsScope = messagesFilter.startsWith("bots-");
  // Type-filtered rooms (used both for the list and for the bot-scope dropdown
  // counts — so each owned bot's count reflects the current type filter).
  const typeFilteredRooms = useMemo(() => {
    const ids = new Set(ownedAgents.map((agent) => agent.agent_id));
    return applyMessagesFilter(visibleMessageRooms, messagesFilter, ids);
  }, [messagesFilter, visibleMessageRooms, ownedAgents]);

  // After the type filter, narrow further by which owned bot's conversations
  // when we're in a bots-* filter and the user has picked a specific bot.
  const categorizedRooms = useMemo(() => {
    if (!isBotsScope || messagesBotScope === "all") return typeFilteredRooms;
    return typeFilteredRooms.filter(
      (r) => r._originAgent?.agent_id === messagesBotScope,
    );
  }, [typeFilteredRooms, isBotsScope, messagesBotScope]);

  const normalizedMessageQuery = messageQuery.trim().toLowerCase();
  const filteredMessageRooms = useMemo(() => {
    if (!normalizedMessageQuery) return categorizedRooms;
    return categorizedRooms.filter((room) => {
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
  }, [messages, normalizedMessageQuery, categorizedRooms]);

  const includeUserChat = (messagesFilter === "self-all" || messagesFilter === "self-my-bot")
    && !filteredMessageRooms.some(
      (room) => isOwnerChatRoom(room.room_id) && room._originAgent?.agent_id === activeAgentId,
    );

  // (filter chips moved into MessagesGroupingSidebar as expandable children)

  const showOverviewSkeleton = sessionMode === "authed-ready" && !overview && sidebarTab === "messages";
  const showRoomListSkeleton = showOverviewSkeleton;

  // When the search toggles off, clear the query so the room list isn't accidentally
  // left filtered behind the scenes.
  // (Keep behavior minimal — only reset on close, not on every keystroke.)
  // The setMessageQuery call lives in the onClick path below.

  return (
    <div className="flex min-h-full flex-col">
      {/* Column header — peer-level to MessagesGroupingSidebar's header */}
      <div className="flex min-h-14 items-center justify-between border-b border-glass-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {!messagesGroupingOpen ? (
            <button
              onClick={() => setMessagesGroupingOpen(true)}
              title="展开分组"
              aria-label="展开分组"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-glass-border text-text-secondary/70 transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
            >
              <ChevronsRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <h2 className="truncate text-sm font-semibold text-text-primary">Messages</h2>
        </div>
        {!isGuest && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMessagesSearchOpen(!messagesSearchOpen)}
              title="搜索消息"
              aria-label="搜索消息"
              className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan ${
                messagesSearchOpen ? "bg-neon-cyan/10 text-neon-cyan" : "text-text-secondary"
              }`}
            >
              <Search className="h-4 w-4" />
            </button>
            <button
              onClick={onAddFriend}
              title="邀请好友"
              aria-label="邀请好友"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan"
            >
              <UserPlus className="h-4 w-4" />
            </button>
            <button
              onClick={onCreateRoom}
              title="新建会话"
              aria-label="新建会话"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      {messagesSearchOpen ? (
        <div className="border-b border-glass-border px-3 py-2">
          <SearchBar onSearch={setMessageQuery} placeholder={t.searchMessages} />
        </div>
      ) : null}
      {isBotsScope && ownedAgents.length > 0 ? (
        <div className="border-b border-glass-border px-3 py-2">
          <MessagesBotScopeDropdown rooms={typeFilteredRooms} />
        </div>
      ) : null}
      {isBotsScope && ownedAgents.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-glass-border bg-glass-bg/40">
            <Bot className="h-7 w-7 text-text-secondary/70" />
          </div>
          <p className="text-sm font-medium text-text-primary">还没有 Bot</p>
          <p className="mt-1 max-w-[180px] text-xs text-text-secondary/60">
            创建你的第一个 Bot，然后在这里观察它在跟谁聊什么。
          </p>
          <button
            onClick={() => openCreateBotModal()}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3.5 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            <Plus className="h-3.5 w-3.5" />
            创建 Bot
          </button>
        </div>
      ) : visibleMessageRooms.length === 0 && !activeAgentId ? (
        <RoomZeroState compact />
      ) : !showOverviewSkeleton && filteredMessageRooms.length === 0 && !activeAgentId ? (
        <div className="px-4 py-6 text-center text-xs text-text-secondary">
          {t.noMessages}
        </div>
      ) : (
        <>
          <RoomList
            rooms={filteredMessageRooms}
            loading={showRoomListSkeleton}
            searchQuery={messageQuery}
            includeUserChat={includeUserChat}
          />
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
