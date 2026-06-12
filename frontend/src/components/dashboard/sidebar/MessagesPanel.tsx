"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
// messagesFilter is in useDashboardUIStore so ChatPane can also read it.
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { messagesGrouping, sidebar } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import { buildVisibleMessageRooms, isOwnerChatRoom } from "@/store/dashboard-shared";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { Bot, ChevronsRight, ListFilter, MessageSquarePlus, Plus, Search, UserPlus, UserPlus2 } from "lucide-react";
import MessagesBotScopeDropdown from "./MessagesBotScopeDropdown";
import MessagesGroupingSidebar from "./MessagesGroupingSidebar";
import { applyMessagesFilter, mergeOwnerVisibleRooms } from "@/lib/messages-merge";
import type { DashboardRoom } from "@/lib/types";
import RoomList from "../RoomList";
import RoomZeroState from "../RoomZeroState";
import SearchBar from "../SearchBar";
import { animateFadeUp, animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";

interface MessagesPanelProps {
  isGuest: boolean;
  onCreateRoom: () => void;
  onAddFriend: () => void;
}

const PREFETCH_VISIBLE_ROOM_LIMIT = 6;

function rankPrefetchRooms(a: DashboardRoom, b: DashboardRoom): number {
  const unreadDelta = Number(Boolean(b.has_unread)) - Number(Boolean(a.has_unread));
  if (unreadDelta !== 0) return unreadDelta;
  const bTime = b.last_message_at ? Date.parse(b.last_message_at) : 0;
  const aTime = a.last_message_at ? Date.parse(a.last_message_at) : 0;
  return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
}

export default function MessagesPanel({ isGuest, onCreateRoom, onAddFriend }: MessagesPanelProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = sidebar[locale];
  const tGrouping = messagesGrouping[locale];

  const { sessionMode, token, humanRooms, ownedAgents } = useDashboardSessionStore(useShallow((s) => ({
    sessionMode: s.sessionMode,
    token: s.token,
    humanRooms: s.humanRooms,
    ownedAgents: s.ownedAgents,
  })));
  const { sidebarTab, openedRoomId, messagesPane, messagesFilter, messagesGroupingOpen, setMessagesGroupingOpen, messagesSearchOpen, setMessagesSearchOpen, messagesBotScope, openCreateBotModal, messagesShowRequests, setMessagesShowRequests, setFocusedRoomId, setOpenedRoomId, setOpenedTopicId } = useDashboardUIStore(useShallow((s) => ({
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
    messagesShowRequests: s.messagesShowRequests,
    setMessagesShowRequests: s.setMessagesShowRequests,
    setFocusedRoomId: s.setFocusedRoomId,
    setOpenedRoomId: s.setOpenedRoomId,
    setOpenedTopicId: s.setOpenedTopicId,
  })));
  const contactRequestsReceived = useDashboardContactStore((s) => s.contactRequestsReceived);
  const pendingRequests = useMemo(
    () => contactRequestsReceived.filter((r) => r.state === "pending"),
    [contactRequestsReceived],
  );
  const pendingRequestCount = pendingRequests.length;
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
  const [mobileGroupingOpen, setMobileGroupingOpen] = useState(false);
  const [mobileGroupingRendered, setMobileGroupingRendered] = useState(false);
  const mobileGroupingOverlayRef = useRef<HTMLButtonElement | null>(null);
  const mobileGroupingPanelRef = useRef<HTMLDivElement | null>(null);
  const mobileGroupingAnimationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const emptyStateRef = useRef<HTMLDivElement | null>(null);

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

  const showOverviewSkeleton = sessionMode === "authed-ready" && !overview && sidebarTab === "messages";
  const showRoomListSkeleton = showOverviewSkeleton;

  useEffect(() => {
    if (isGuest || sidebarTab !== "messages" || showOverviewSkeleton) return;
    if (messagesShowRequests || messagesPane === "user-chat") return;

    const candidateRooms = (normalizedMessageQuery ? filteredMessageRooms : categorizedRooms)
      .filter((room) => !isOwnerChatRoom(room.room_id) && (room.last_message_at || room.has_unread))
      .slice()
      .sort(rankPrefetchRooms)
      .slice(0, PREFETCH_VISIBLE_ROOM_LIMIT);

    if (candidateRooms.length === 0) return;

    const timer = window.setTimeout(() => {
      const { prefetchRoomMessages } = useDashboardChatStore.getState();
      for (const room of candidateRooms) {
        void prefetchRoomMessages(room.room_id);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [
    categorizedRooms,
    filteredMessageRooms,
    isGuest,
    messagesPane,
    messagesShowRequests,
    normalizedMessageQuery,
    showOverviewSkeleton,
    sidebarTab,
  ]);

  useEffect(() => {
    if (isGuest || sidebarTab !== "messages") {
      setMobileGroupingOpen(false);
    }
  }, [isGuest, sidebarTab]);

  useEffect(() => {
    if (!messagesSearchOpen && messageQuery) {
      setMessageQuery("");
    }
  }, [messageQuery, messagesSearchOpen]);

  useEffect(() => {
    if (!mobileGroupingOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileGroupingOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileGroupingOpen]);

  useEffect(() => {
    if (mobileGroupingOpen) {
      setMobileGroupingRendered(true);
      return;
    }

    if (!mobileGroupingRendered) return;

    cleanupAnime(mobileGroupingAnimationRef.current);
    if (mobileGroupingOverlayRef.current) {
      mobileGroupingOverlayRef.current.style.opacity = "1";
    }
    if (mobileGroupingPanelRef.current) {
      mobileGroupingPanelRef.current.style.opacity = "1";
      mobileGroupingPanelRef.current.style.transform = "translate3d(0, 0, 0) scale(1)";
      mobileGroupingPanelRef.current
        .querySelectorAll<HTMLElement>("[data-mobile-grouping-motion]")
        .forEach((part) => {
          part.style.opacity = "1";
          part.style.transform = "translateY(0)";
        });
    }
    mobileGroupingAnimationRef.current = animateOverlayPanelExit(
      mobileGroupingOverlayRef.current,
      mobileGroupingPanelRef.current,
      {
        direction: "left",
        contentSelector: "[data-mobile-grouping-motion]",
        onComplete: () => {
          setMobileGroupingRendered(false);
          mobileGroupingAnimationRef.current = null;
        },
      },
    );
  }, [mobileGroupingOpen, mobileGroupingRendered]);

  useEffect(() => {
    if (!mobileGroupingOpen || !mobileGroupingRendered) return;

    const frameId = window.requestAnimationFrame(() => {
      cleanupAnime(mobileGroupingAnimationRef.current);
      mobileGroupingAnimationRef.current = animateOverlayPanelEnter(
        mobileGroupingOverlayRef.current,
        mobileGroupingPanelRef.current,
        {
          direction: "left",
          contentSelector: "[data-mobile-grouping-motion]",
        },
      );
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [mobileGroupingOpen, mobileGroupingRendered]);

  useEffect(() => () => cleanupAnime(mobileGroupingAnimationRef.current), []);

  useEffect(() => {
    if (showOverviewSkeleton) return;
    const emptyState = emptyStateRef.current;
    if (!emptyState) return;

    const animation = animateFadeUp(emptyState);
    return () => cleanupAnime(animation);
  }, [filteredMessageRooms.length, isBotsScope, ownedAgents.length, showOverviewSkeleton, visibleMessageRooms.length]);

  // (filter chips moved into MessagesGroupingSidebar as expandable children)

  const toggleMessagesSearch = () => {
    const nextOpen = !messagesSearchOpen;
    setMessagesSearchOpen(nextOpen);
    if (!nextOpen) {
      setMessageQuery("");
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      {/* Column header — peer-level to MessagesGroupingSidebar's header */}
      <div className="flex min-h-14 items-center justify-between border-b border-glass-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {!isGuest && !messagesGroupingOpen ? (
            <button
              onClick={() => setMessagesGroupingOpen(true)}
              title="展开分组"
              aria-label="展开分组"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-glass-border text-text-secondary/70 transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan max-md:hidden"
            >
              <ChevronsRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {!isGuest ? (
            <button
              type="button"
              onClick={() => setMobileGroupingOpen((open) => !open)}
              title={tGrouping.header}
              aria-label={tGrouping.header}
              className={`hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors max-md:flex ${
                mobileGroupingOpen
                  ? "bg-neon-cyan/10 text-neon-cyan"
                  : "text-text-secondary hover:bg-neon-cyan/10 hover:text-neon-cyan"
              }`}
            >
              <ListFilter className="h-4 w-4" />
            </button>
          ) : null}
          <h2 className="truncate text-sm font-semibold text-text-primary">Messages</h2>
        </div>
        {!isGuest && (
          <div className="flex items-center gap-1">
            <TooltipIconButton
              label={locale === "zh" ? "搜索消息" : "Search messages"}
              onClick={toggleMessagesSearch}
              active={messagesSearchOpen}
            >
              <Search className="h-4 w-4" />
            </TooltipIconButton>
            <TooltipIconButton
              label={locale === "zh" ? "邀请好友" : "Invite friend"}
              onClick={onAddFriend}
            >
              <UserPlus className="h-4 w-4" />
            </TooltipIconButton>
            <TooltipIconButton
              label={locale === "zh" ? "新建会话" : "New conversation"}
              onClick={onCreateRoom}
            >
              <MessageSquarePlus className="h-4 w-4" />
            </TooltipIconButton>
          </div>
        )}
      </div>
      {!isGuest && mobileGroupingRendered ? (
        <div
          className="fixed inset-0 z-50 hidden max-md:block"
          role="dialog"
          aria-modal="true"
          aria-label={tGrouping.header}
        >
          <button
            ref={mobileGroupingOverlayRef}
            type="button"
            aria-label={tGrouping.collapse}
            className="absolute inset-0 bg-black/45 backdrop-blur-sm"
            onClick={() => setMobileGroupingOpen(false)}
          />
          <div
            ref={mobileGroupingPanelRef}
            className="absolute bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-0 top-0 w-[min(84vw,280px)] overflow-hidden border-r border-glass-border bg-deep-black-light shadow-2xl shadow-black/60"
          >
            <div data-mobile-grouping-motion className="h-full">
            <MessagesGroupingSidebar
              fullWidth
              onCollapse={() => setMobileGroupingOpen(false)}
              onFilterSelect={() => setMobileGroupingOpen(false)}
            />
            </div>
          </div>
        </div>
      ) : null}
      {pendingRequestCount > 0 ? (
        <button
          onClick={() => {
            setMessagesShowRequests(true);
            setFocusedRoomId(null);
            setOpenedRoomId(null);
            setOpenedTopicId(null);
            startTransition(() => router.push("/chats/messages"));
          }}
          className={`flex items-center gap-3 border-b border-glass-border px-3 py-3 text-left transition-colors ${
            messagesShowRequests ? "bg-neon-cyan/10" : "hover:bg-glass-bg/60"
          }`}
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-500/15 text-orange-400">
            <UserPlus2 className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-medium ${messagesShowRequests ? "text-neon-cyan" : "text-text-primary"}`}>
                {locale === "zh" ? "新好友申请" : "New Requests"}
              </span>
              <span className="rounded-full bg-neon-cyan px-1.5 text-[10px] font-bold text-black">
                {pendingRequestCount}
              </span>
            </div>
            <p className="truncate text-[11px] text-text-secondary/60">
              {locale === "zh"
                ? `${pendingRequestCount} 个待处理请求`
                : `${pendingRequestCount} pending`}
            </p>
          </div>
        </button>
      ) : null}
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
        <div ref={emptyStateRef} className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
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
      ) : visibleMessageRooms.length === 0 ? (
        <div ref={emptyStateRef}>
          <RoomZeroState compact />
        </div>
      ) : !showOverviewSkeleton && filteredMessageRooms.length === 0 ? (
        <div ref={emptyStateRef} className="px-4 py-6 text-center text-xs text-text-secondary">
          {t.noMessages}
        </div>
      ) : (
        <>
          <RoomList
            rooms={filteredMessageRooms}
            loading={showRoomListSkeleton}
            searchQuery={messageQuery}
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

function TooltipIconButton({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan ${
          active ? "bg-neon-cyan/10 text-neon-cyan" : "text-text-secondary"
        }`}
      >
        {children}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-glass-border bg-deep-black px-2 py-0.5 text-[11px] text-text-primary opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100"
      >
        {label}
      </span>
    </div>
  );
}
