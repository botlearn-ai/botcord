"use client";

import { useConversationDirectoryStore } from "@/store/useConversationDirectoryStore";
import EmptyState from "@/components/ui/EmptyState";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import IconButton from "@/components/ui/IconButton";
import Tooltip from "@/components/ui/Tooltip";
import DismissLayer from "@/components/ui/DismissLayer";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
// messagesFilter is in useDashboardUIStore so ChatPane can also read it.
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { messagesGrouping, sidebar } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { Bot, ChevronsRight, ListFilter, MessageSquarePlus, Plus, Search, UserPlus, UserPlus2 } from "lucide-react";
import MessagesBotScopeDropdown from "./MessagesBotScopeDropdown";
import MessagesGroupingSidebar from "./MessagesGroupingSidebar";
import { applyMessagesFilter, mergeOwnerVisibleRooms } from "@/lib/messages-merge";
import { messagePrefetchCandidates, prefetchMessagePages } from "@/lib/message-prefetch";
import type { DashboardRoom } from "@/lib/types";
import RoomList from "../RoomList";
import RoomZeroState from "../RoomZeroState";
import SearchBar from "../SearchBar";
import { animateFadeUp, animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";
import DashboardOverlayPortal from "../DashboardOverlayPortal";

interface MessagesPanelProps {
  isGuest: boolean;
  onCreateRoom: () => void;
  onAddFriend: () => void;
}

export default function MessagesPanel({ isGuest, onCreateRoom, onAddFriend }: MessagesPanelProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = sidebar[locale];
  const tGrouping = messagesGrouping[locale];

  const { sessionMode, activeIdentity, token, humanRooms, ownedAgents } = useDashboardSessionStore(useShallow((s) => ({
    sessionMode: s.sessionMode,
    activeIdentity: s.activeIdentity,
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
  const { overview, overviewErrored, recentVisitedRooms, ownedAgentRooms, ownedAgentRoomsLoaded } = useDashboardChatStore(useShallow((s) => ({
    overview: s.overview,
    overviewErrored: s.overviewErrored,
    recentVisitedRooms: s.recentVisitedRooms,
    ownedAgentRooms: s.ownedAgentRooms,
    ownedAgentRoomsLoaded: s.ownedAgentRoomsLoaded,
  })));
  // Keep unread changes propagating to the room rows.
  useDashboardUnreadStore((state) => state.optimisticUnreadRoomIds);

  const [messageQuery, setMessageQuery] = useState("");
  const [mobileGroupingOpen, setMobileGroupingOpen] = useState(false);
  const [mobileGroupingRendered, setMobileGroupingRendered] = useState(false);
  const mobileGroupingOverlayRef = useRef<HTMLButtonElement | null>(null);
  const mobileGroupingPanelRef = useRef<HTMLDivElement | null>(null);
  const mobileGroupingAnimationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const emptyStateRef = useRef<HTMLDivElement | null>(null);

  // Owner-unified Messages list: my own conversations + tagged bot conversations.
  const directory = useConversationDirectoryStore();
  const visibleMessageRooms = useMemo<DashboardRoom[]>(() => {
    if (directory.accountId) return directory.rooms;
    const ownRooms = buildVisibleMessageRooms({ overview, recentVisitedRooms, token, humanRooms });
    return mergeOwnerVisibleRooms({ ownedAgentRooms, ownRooms });
  }, [overview, recentVisitedRooms, token, humanRooms, ownedAgents, ownedAgentRooms, directory.accountId, directory.rooms]);

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
      (r) => (r._originAgents ?? (r._originAgent ? [r._originAgent] : [])).some((bot) => bot.agent_id === messagesBotScope),
    );
  }, [typeFilteredRooms, isBotsScope, messagesBotScope]);

  const normalizedMessageQuery = messageQuery.trim().toLowerCase();
  // Only subscribe to cached previews while searching, and only in this scope.
  // History loads and messages in other rooms must not rebuild the whole panel.
  const searchPreviews = useDashboardChatStore(useShallow((state) =>
    normalizedMessageQuery
      ? categorizedRooms.map((room) => state.messages[room.room_id]?.findLast(
          (message) => message.type !== "ack" && message.type !== "result" && message.type !== "error",
        ))
      : [],
  ));
  const filteredMessageRooms = useMemo(() => {
    if (!normalizedMessageQuery) return categorizedRooms;
    return categorizedRooms.filter((room, index) => {
      const cachedLatestMessage = searchPreviews[index];
      const searchHaystack = [
        room.name, room.room_id, room.description,
        room.last_message_preview, room.last_sender_name,
        cachedLatestMessage?.text, cachedLatestMessage?.sender_name,
      ].filter(Boolean).join("\n").toLowerCase();
      return searchHaystack.includes(normalizedMessageQuery);
    });
  }, [searchPreviews, normalizedMessageQuery, categorizedRooms]);

  // Independent sources may resolve in any order. Never hide usable rows while
  // waiting for another source, or show onboarding before initial loads finish.
  const awaitingInitialRooms = directory.accountId
    ? (!directory.ready && !directory.error) || directory.hasMore
    : sessionMode !== "guest" && (
    (!overview && !overviewErrored)
    || (activeIdentity?.type === "human" && !ownedAgentRoomsLoaded)
  );
  const showRoomListSkeleton = awaitingInitialRooms && filteredMessageRooms.length === 0;

  useEffect(() => {
    if (isGuest || sidebarTab !== "messages" || showRoomListSkeleton) return;
    if (messagesShowRequests || messagesPane === "user-chat" || openedRoomId) return;

    const candidateRooms = messagePrefetchCandidates(
      normalizedMessageQuery ? filteredMessageRooms : categorizedRooms,
    );
    if (candidateRooms.length === 0) return;

    let cancelPrefetch: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      cancelPrefetch = prefetchMessagePages(
        candidateRooms,
        (roomId) => useDashboardChatStore.getState().prefetchRoomMessages(roomId),
      );
    }, 250);

    return () => {
      window.clearTimeout(timer);
      cancelPrefetch?.();
    };
  }, [
    categorizedRooms,
    filteredMessageRooms,
    isGuest,
    messagesPane,
    messagesShowRequests,
    normalizedMessageQuery,
    openedRoomId,
    showRoomListSkeleton,
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
    if (showRoomListSkeleton) return;
    const emptyState = emptyStateRef.current;
    if (!emptyState) return;

    const animation = animateFadeUp(emptyState);
    return () => cleanupAnime(animation);
  }, [filteredMessageRooms.length, isBotsScope, ownedAgents.length, showRoomListSkeleton, visibleMessageRooms.length]);

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
      <div className="liquid-toolbar flex min-h-14 items-center justify-between border-b border-glass-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {!isGuest && !messagesGroupingOpen ? (
            <IconButton size="sm" label="展开分组"
              onClick={() => setMessagesGroupingOpen(true)}
              title="展开分组"
              aria-label="展开分组"
              className="flex shrink-0 items-center justify-center max-md:hidden"
            >
              <ChevronsRight className="h-3.5 w-3.5" />
            </IconButton>
          ) : null}
          {!isGuest ? (
            <IconButton size="sm" label={tGrouping.header} aria-pressed={mobileGroupingOpen}
              type="button"
              onClick={() => setMobileGroupingOpen((open) => !open)}
              title={tGrouping.header}
              aria-label={tGrouping.header}
              className={`hidden shrink-0 items-center justify-center max-md:flex `}
            >
              <ListFilter className="h-4 w-4" />
            </IconButton>
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
        <DashboardOverlayPortal>
          <div
            className="fixed inset-0 z-50 hidden max-md:block"
            role="dialog"
            aria-modal="true"
            aria-label={tGrouping.header}
          >
            <DismissLayer
              ref={mobileGroupingOverlayRef}

              label={tGrouping.collapse}
              className="absolute inset-0 "
              onClick={() => setMobileGroupingOpen(false)}
            />
            <div
              ref={mobileGroupingPanelRef}
              className="liquid-drawer absolute bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-0 top-0 w-[min(84vw,280px)] overflow-hidden border-r border-glass-border"
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
        </DashboardOverlayPortal>
      ) : null}
      {pendingRequestCount > 0 ? (
        <Button variant="row" aria-pressed={messagesShowRequests}
          onClick={() => {
            setMessagesShowRequests(true);
            setFocusedRoomId(null);
            setOpenedRoomId(null);
            setOpenedTopicId(null);
            startTransition(() => router.push("/chats/messages"));
          }}
          className={`flex items-center gap-3 `}
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning">
            <UserPlus2 className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-medium ${messagesShowRequests ? "text-accent-text" : "text-text-primary"}`}>
                {locale === "zh" ? "新好友申请" : "New Requests"}
              </span>
              <Badge tone="neutral" >
                {pendingRequestCount}
              </Badge>
            </div>
            <p className="truncate text-xs text-text-secondary">
              {locale === "zh"
                ? `${pendingRequestCount} 个待处理请求`
                : `${pendingRequestCount} pending`}
            </p>
          </div>
        </Button>
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
      {directory.accountId && directory.error ? (
        <Alert tone="warning" className="m-3" actions={
          <Button variant="inline" onClick={() => void directory.sync()}>
            {locale === "zh" ? "重试" : "Retry"}
          </Button>
        }>
          {directory.ready
            ? locale === "zh" ? "会话暂时无法更新，已保留本地列表。" : "Conversations could not refresh. Your saved list is still available."
            : locale === "zh" ? "暂时无法加载会话，请重试。" : "Conversations could not load. Please retry."}
        </Alert>
      ) : null}
      {directory.accountId && directory.error && !directory.ready ? null : showRoomListSkeleton ? (
        <RoomList rooms={[]} loading />
      ) : isBotsScope && ownedAgents.length === 0 && filteredMessageRooms.length === 0 ? (
        <div ref={emptyStateRef} className="m-3"><EmptyState compact bordered title={<>还没有 Bot</>} description={<>
            创建你的第一个 Bot，然后在这里观察它在跟谁聊什么。
          </>} icon={<>
            <Bot className="h-7 w-7 text-text-secondary" />
          </>} action={<><Button variant="secondary" size="sm"
            onClick={() => openCreateBotModal()}
            className="mt-5 inline-flex items-center gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            创建 Bot
          </Button></>} /></div>
      ) : visibleMessageRooms.length === 0 ? (
        <div ref={emptyStateRef}>
          <RoomZeroState compact />
        </div>
      ) : filteredMessageRooms.length === 0 ? (
        <div ref={emptyStateRef} className="m-3"><EmptyState compact bordered title={<>{t.noMessages}</>} /></div>
      ) : (
        <>
          <RoomList
            rooms={filteredMessageRooms}
            authoritative={Boolean(directory.accountId)}
            searchQuery={messageQuery}
          />
          {!normalizedMessageQuery && filteredMessageRooms.length < 5 && (
            <Card padding="md" className="mx-3 mb-3 mt-auto">
              <p className="text-xs font-semibold text-text-secondary">
                {locale === "zh" ? "发现更多社区" : "Discover communities"}
              </p>
              <p className="mt-1 text-xs leading-4 text-text-secondary">
                {locale === "zh" ? "加入公开房间，或创建你自己的社区" : "Join a public room or create your own."}
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {!isGuest && (
                  <Button variant="primary" size="sm"
                    type="button"
                    onClick={onCreateRoom}

                  >
                    {locale === "zh" ? "创建房间" : "Create a room"}
                  </Button>
                )}
                <Button variant="secondary" size="sm"
                  type="button"
                  onClick={() => {
                    useDashboardUIStore.getState().setExploreView("rooms");
                    useDashboardUIStore.getState().setSidebarTab("explore");
                    startTransition(() => { router.push("/chats/explore/rooms"); });
                  }}

                >
                  {locale === "zh" ? "探索公开社区" : "Explore public rooms"}
                </Button>
              </div>
            </Card>
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
    <Tooltip content={label} side="bottom">
      <IconButton size="sm" label={label} title="" aria-pressed={active} onClick={onClick}>
        {children}
      </IconButton>
    </Tooltip>
  );
}
