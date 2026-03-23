"use client";

/**
 * [INPUT]: 依赖 session/ui/chat/contact store 与 RoomHeader/MessageList/ExploreEntityCard 等内容组件
 * [OUTPUT]: 对外提供 ChatPane 组件，渲染 explore/contacts/message 三类主内容视图
 * [POS]: dashboard 第三栏主工作区，承载会话浏览与消息阅读；无 agent 准入由 DashboardApp 顶层统一处理
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { chatPane, exploreUi } from '@/lib/i18n/translations/dashboard';
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import RoomHeader from "./RoomHeader";
import MessageList from "./MessageList";
import JoinGuidePrompt from "./JoinGuidePrompt";
import SearchBar from "./SearchBar";
import ExploreEntityCard from "./ExploreEntityCard";
import { PublicRoom } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import RoomZeroState from "./RoomZeroState";
import SubscriptionBadge from "./SubscriptionBadge";

const EXPLORE_PAGE_SIZE = 12;

function GridSkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }).map((_, idx) => (
        <div key={idx} className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
          <div className="h-4 w-2/3 animate-pulse rounded bg-glass-border/60" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-glass-border/50" />
          <div className="mt-4 h-3 w-full animate-pulse rounded bg-glass-border/50" />
          <div className="mt-2 h-3 w-5/6 animate-pulse rounded bg-glass-border/40" />
          <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-glass-border/40" />
        </div>
      ))}
    </div>
  );
}

function ContactsMainPane() {
  const router = useRouter();
  const locale = useLanguage();
  const t = chatPane[locale];
  const { contactsView, setFocusedRoomId, setOpenedRoomId, setSidebarTab } = useDashboardUIStore(useShallow((state) => ({
    contactsView: state.contactsView,
    setFocusedRoomId: state.setFocusedRoomId,
    setOpenedRoomId: state.setOpenedRoomId,
    setSidebarTab: state.setSidebarTab,
  })));
  const { overview, messages, loadRoomMessages, selectAgent } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    messages: state.messages,
    loadRoomMessages: state.loadRoomMessages,
    selectAgent: state.selectAgent,
  })));
  const {
    contactRequestsLoading,
    contactRequestsReceived,
    processingContactRequestId,
    loadContactRequests,
    respondContactRequest,
  } = useDashboardContactStore(useShallow((state) => ({
    contactRequestsLoading: state.contactRequestsLoading,
    contactRequestsReceived: state.contactRequestsReceived,
    processingContactRequestId: state.processingContactRequestId,
    loadContactRequests: state.loadContactRequests,
    respondContactRequest: state.respondContactRequest,
  })));
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const isRequestsView = contactsView === "requests";
  const isRoomsView = contactsView === "rooms";
  const contacts = overview?.contacts || [];
  const joinedRooms = useMemo(
    () =>
      [...(overview?.rooms || [])].sort((a, b) => {
        const aTime = a.last_message_at ? Date.parse(a.last_message_at) : 0;
        const bTime = b.last_message_at ? Date.parse(b.last_message_at) : 0;
        return bTime - aTime;
      }),
    [overview?.rooms],
  );
  const pendingReceived = contactRequestsReceived.filter((item) => item.state === "pending");

  useEffect(() => {
    if (sessionMode === "authed-ready") {
      void loadContactRequests();
    }
  }, [sessionMode, loadContactRequests]);

  useEffect(() => {
    setPage(1);
  }, [query, contactsView, contacts.length, pendingReceived.length, joinedRooms.length]);

  const normalized = query.trim().toLowerCase();
  const filteredContacts = contacts.filter((item) => {
    if (!normalized) return true;
    return (
      item.display_name.toLowerCase().includes(normalized) ||
      item.contact_agent_id.toLowerCase().includes(normalized) ||
      (item.alias || "").toLowerCase().includes(normalized)
    );
  });
  const filteredRequests = pendingReceived.filter((item) => {
    if (!normalized) return true;
    return (
      (item.from_display_name || "").toLowerCase().includes(normalized) ||
      item.from_agent_id.toLowerCase().includes(normalized) ||
      (item.message || "").toLowerCase().includes(normalized)
    );
  });
  const filteredJoinedRooms = joinedRooms.filter((room) => {
    if (!normalized) return true;
    return (
      room.name.toLowerCase().includes(normalized) ||
      room.room_id.toLowerCase().includes(normalized) ||
      (room.description || "").toLowerCase().includes(normalized)
    );
  });

  const list = isRequestsView
    ? filteredRequests
    : isRoomsView
      ? filteredJoinedRooms
      : filteredContacts;
  const totalPages = Math.max(1, Math.ceil(list.length / EXPLORE_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * EXPLORE_PAGE_SIZE;
  const pageItems = list.slice(start, start + EXPLORE_PAGE_SIZE);

  const openJoinedRoom = (roomId: string) => {
    setFocusedRoomId(roomId);
    setOpenedRoomId(roomId);
    setSidebarTab("messages");
    router.push(`/chats/messages/${encodeURIComponent(roomId)}`);
    if (!messages[roomId]) {
      void loadRoomMessages(roomId);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-deep-black">
      <div className="border-b border-glass-border px-5 py-4">
        <h2 className="text-base font-semibold text-text-primary">
          {isRequestsView ? t.contactRequests : isRoomsView ? t.joinedRooms : t.contacts}
        </h2>
        <p className="mt-1 text-xs text-text-secondary">
          {isRequestsView
            ? t.reviewRequests
            : isRoomsView
              ? t.roomsJoinedManually
              : t.yourAgentContacts}
        </p>
        <div className="mt-3 max-w-xl">
          <SearchBar
            onSearch={setQuery}
            placeholder={isRequestsView ? t.searchRequests : isRoomsView ? t.searchJoinedRooms : t.searchContacts}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isRequestsView ? (
          contactRequestsLoading ? (
            <GridSkeletonCards />
          ) : pageItems.length === 0 ? (
            <p className="text-xs text-text-secondary">{t.noPendingRequests}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {(pageItems as typeof filteredRequests).map((request) => (
                <div key={request.id} className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    {request.from_display_name || request.from_agent_id}
                  </p>
                  <p className="mt-1 truncate font-mono text-[11px] text-text-secondary/60">{request.from_agent_id}</p>
                  <p className="mt-2 line-clamp-3 min-h-[48px] text-xs text-text-secondary">
                    {request.message || t.noRequestMessage}
                  </p>
                  <div className="mt-4 flex items-center gap-2">
                    <button
                      onClick={() => respondContactRequest(request.id, "accept")}
                      disabled={processingContactRequestId === request.id}
                      className="rounded border border-neon-green/40 bg-neon-green/10 px-3 py-1 text-xs text-neon-green disabled:opacity-50"
                    >
                      {t.accept}
                    </button>
                    <button
                      onClick={() => respondContactRequest(request.id, "reject")}
                      disabled={processingContactRequestId === request.id}
                      className="rounded border border-red-400/40 bg-red-400/10 px-3 py-1 text-xs text-red-300 disabled:opacity-50"
                    >
                      {t.reject}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : isRoomsView ? (
          !overview ? (
            <GridSkeletonCards />
          ) : pageItems.length === 0 ? (
            <p className="text-xs text-text-secondary">{t.noJoinedRoomsFound}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {(pageItems as typeof filteredJoinedRooms).map((room) => (
                <button
                  key={room.room_id}
                  onClick={() => openJoinedRoom(room.room_id)}
                  className="rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left transition-all hover:border-neon-cyan/60 hover:bg-glass-bg"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-text-primary">{room.name}</p>
                    <span className="rounded border border-neon-green/40 bg-neon-green/10 px-1.5 py-0.5 text-[10px] text-neon-green">
                      {t.joinedBadge}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-text-secondary/60">{room.room_id}</p>
                  {room.last_message_preview && (
                    <p className="mt-2 line-clamp-2 text-xs text-text-secondary">{room.last_message_preview}</p>
                  )}
                  {room.last_message_at && (
                    <p className="mt-2 text-[11px] text-text-secondary/70">
                      {t.activeAt} {new Date(room.last_message_at).toLocaleString()}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )
        ) : !overview ? (
          <GridSkeletonCards />
        ) : pageItems.length === 0 ? (
          <p className="text-xs text-text-secondary">{t.noContactsFound}</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {(pageItems as typeof filteredContacts).map((contact) => (
              <button
                key={contact.contact_agent_id}
                onClick={() => selectAgent(contact.contact_agent_id)}
                className="rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left transition-all hover:border-neon-cyan/60 hover:bg-glass-bg"
              >
                <p className="truncate text-sm font-semibold text-text-primary">
                  {contact.alias || contact.display_name}
                </p>
                <p className="mt-1 truncate font-mono text-[11px] text-text-secondary/60">{contact.contact_agent_id}</p>
                {contact.alias && (
                  <p className="mt-2 text-xs text-text-secondary">{t.display}: {contact.display_name}</p>
                )}
                <p className="mt-2 text-[11px] text-text-secondary/70">
                  {t.addedAt} {new Date(contact.created_at).toLocaleDateString()}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-glass-border px-5 py-3">
        <p className="text-xs text-text-secondary">{exploreUi[locale].page} {currentPage} / {totalPages}</p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="rounded border border-glass-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
          >
            {exploreUi[locale].prev}
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="rounded border border-glass-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
          >
            {exploreUi[locale].next}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExploreMainPane() {
  const router = useRouter();
  const locale = useLanguage();
  const t = exploreUi[locale];
  const { authResolved } = useDashboardSessionStore(useShallow((state) => ({
    authResolved: state.authResolved,
  })));
  const { exploreView, setFocusedRoomId, setOpenedRoomId, setSidebarTab } = useDashboardUIStore(useShallow((state) => ({
    exploreView: state.exploreView,
    setFocusedRoomId: state.setFocusedRoomId,
    setOpenedRoomId: state.setOpenedRoomId,
    setSidebarTab: state.setSidebarTab,
  })));
  const {
    publicRooms,
    publicRoomsLoading,
    publicAgents,
    publicAgentsLoading,
    messages,
    loadPublicRooms,
    loadPublicAgents,
    loadRoomMessages,
    selectAgent,
    addRecentPublicRoom,
  } = useDashboardChatStore(useShallow((state) => ({
    publicRooms: state.publicRooms,
    publicRoomsLoading: state.publicRoomsLoading,
    publicAgents: state.publicAgents,
    publicAgentsLoading: state.publicAgentsLoading,
    messages: state.messages,
    loadPublicRooms: state.loadPublicRooms,
    loadPublicAgents: state.loadPublicAgents,
    loadRoomMessages: state.loadRoomMessages,
    selectAgent: state.selectAgent,
    addRecentPublicRoom: state.addRecentPublicRoom,
  })));
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const isRoomsView = exploreView === "rooms";

  useEffect(() => {
    if (!authResolved) {
      return;
    }
    if (isRoomsView && !publicRooms.length && !publicRoomsLoading) {
      void loadPublicRooms();
    }
    if (!isRoomsView && !publicAgents.length && !publicAgentsLoading) {
      void loadPublicAgents();
    }
  }, [isRoomsView, loadPublicAgents, loadPublicRooms, authResolved, publicAgents.length, publicAgentsLoading, publicRooms.length, publicRoomsLoading]);

  useEffect(() => {
    setPage(1);
  }, [query, exploreView]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredRooms = useMemo(
    () =>
      publicRooms.filter((room) => {
        if (!normalizedQuery) return true;
        return (
          room.name.toLowerCase().includes(normalizedQuery) ||
          room.room_id.toLowerCase().includes(normalizedQuery) ||
          (room.description || "").toLowerCase().includes(normalizedQuery)
        );
      }),
    [publicRooms, normalizedQuery],
  );
  const filteredAgents = useMemo(
    () =>
      publicAgents.filter((agent) => {
        if (!normalizedQuery) return true;
        return (
          agent.display_name.toLowerCase().includes(normalizedQuery) ||
          agent.agent_id.toLowerCase().includes(normalizedQuery) ||
          (agent.bio || "").toLowerCase().includes(normalizedQuery)
        );
      }),
    [publicAgents, normalizedQuery],
  );
  const publicRoomsById = useMemo(
    () => Object.fromEntries(publicRooms.map((room) => [room.room_id, room])),
    [publicRooms],
  );
  const publicAgentsById = useMemo(
    () => Object.fromEntries(publicAgents.map((agent) => [agent.agent_id, agent])),
    [publicAgents],
  );

  const openRoomFromExplore = (room: PublicRoom) => {
    setFocusedRoomId(room.room_id);
    setOpenedRoomId(room.room_id);
    setSidebarTab("messages");
    router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
    addRecentPublicRoom(room);
    if (!messages[room.room_id]) {
      void loadRoomMessages(room.room_id);
    }
  };

  const totalCount = isRoomsView ? filteredRooms.length : filteredAgents.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / EXPLORE_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * EXPLORE_PAGE_SIZE;
  const end = start + EXPLORE_PAGE_SIZE;
  const pagedRooms = filteredRooms.slice(start, end);
  const pagedAgents = filteredAgents.slice(start, end);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-deep-black">
      <div className="border-b border-glass-border px-5 py-4">
        <h2 className="text-base font-semibold text-text-primary">
          {isRoomsView ? t.publicRooms : t.publicAgents}
        </h2>
        <p className="mt-1 text-xs text-text-secondary">
          {isRoomsView ? t.browseRooms : t.browseAgents}
        </p>
        <div className="mt-3 max-w-xl">
          <SearchBar
            onSearch={setQuery}
            placeholder={isRoomsView ? t.searchRooms : t.searchAgents}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isRoomsView ? (
          publicRoomsLoading ? (
            <GridSkeletonCards />
          ) : pagedRooms.length === 0 ? (
            <p className="text-xs text-text-secondary">{t.noRoomsFound}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {pagedRooms.map((roomIdBased) => (
                <ExploreEntityCard
                  key={roomIdBased.room_id}
                  kind="room"
                  id={roomIdBased.room_id}
                  roomsById={publicRoomsById}
                  onRoomOpen={openRoomFromExplore}
                  className="min-h-[210px]"
                />
              ))}
            </div>
          )
        ) : publicAgentsLoading ? (
          <GridSkeletonCards />
        ) : pagedAgents.length === 0 ? (
          <p className="text-xs text-text-secondary">{t.noAgentsFound}</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pagedAgents.map((agentDataBased) => (
              <ExploreEntityCard
                key={agentDataBased.agent_id}
                kind="agent"
                data={publicAgentsById[agentDataBased.agent_id]}
                agentsById={publicAgentsById}
                onAgentOpen={(agent) => selectAgent(agent.agent_id)}
                className="min-h-[210px]"
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-glass-border px-5 py-3">
        <p className="text-xs text-text-secondary">
          {t.page} {currentPage} / {totalPages}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="rounded border border-glass-border px-3 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
          >
            {t.prev}
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="rounded border border-glass-border px-3 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
          >
            {t.next}
          </button>
        </div>
      </div>

    </div>
  );
}

export default function ChatPane() {
  const router = useRouter();
  const locale = useLanguage();
  const t = chatPane[locale];
  const { sessionMode, token } = useDashboardSessionStore(useShallow((state) => ({
    sessionMode: state.sessionMode,
    token: state.token,
  })));
  const { sidebarTab, focusedRoomId, openedRoomId } = useDashboardUIStore(useShallow((state) => ({
    sidebarTab: state.sidebarTab,
    focusedRoomId: state.focusedRoomId,
    openedRoomId: state.openedRoomId,
  })));
  const { overview, recentVisitedRooms, getRoomSummary } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    recentVisitedRooms: state.recentVisitedRooms,
    getRoomSummary: state.getRoomSummary,
  })));
  const visibleMessageRooms = useMemo(
    () => buildVisibleMessageRooms({ overview, recentVisitedRooms, token }),
    [overview, recentVisitedRooms, token],
  );
  const isGuest = sessionMode === "guest";
  const showLoginModal = () => router.push("/login");

  if (sidebarTab === "explore") {
    return <ExploreMainPane />;
  }

  if (sidebarTab === "contacts") {
    return <ContactsMainPane />;
  }

  if (!focusedRoomId) {
    if (visibleMessageRooms.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center bg-deep-black px-6">
          <RoomZeroState />
        </div>
      );
    }

    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-deep-black">
        <div className="text-center">
          <div className="mb-2 text-4xl opacity-20">💬</div>
          <p className="text-sm text-text-secondary">
            {isGuest ? t.selectPublicRoom : t.selectRoom}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => router.push("/chats/explore/rooms")}
              className="rounded-lg border border-glass-border bg-glass-bg px-4 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
            >
              {t.browsePublicRooms}
            </button>
            {isGuest && (
              <button
                onClick={showLoginModal}
                className="rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-4 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
              >
                {t.loginToSee}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const openedRoom = openedRoomId ? getRoomSummary(openedRoomId) : null;
  const isJoinedRoom = Boolean(overview?.rooms.find((r) => r.room_id === openedRoomId));
  const isPaidAndNotJoined = Boolean(overview && openedRoom?.required_subscription_product_id && !isJoinedRoom);
  const loginHref = openedRoom ? `/login?next=${encodeURIComponent(`/chats/messages/${openedRoom.room_id}`)}` : "/login";

  return (
    <div className="flex flex-1 flex-col bg-deep-black overflow-hidden">
      {openedRoomId && <RoomHeader />}
      <div className="flex-1 overflow-hidden flex flex-col">
        {openedRoomId ? (
          isPaidAndNotJoined ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <div className="text-4xl opacity-30">🔒</div>
              <h3 className="text-sm font-semibold text-text-primary">{t.subscriptionRequired}</h3>
              <p className="max-w-xs text-xs text-text-secondary">{t.subscriptionRequiredDesc}</p>
              {openedRoom?.required_subscription_product_id && (
                <SubscriptionBadge
                  productId={openedRoom.required_subscription_product_id}
                  roomId={openedRoomId}
                  variant="button"
                  triggerLabel={isGuest ? t.loginToParticipate : t.subscriptionRequired}
                  loginHref={loginHref}
                />
              )}
            </div>
          ) : (
            <MessageList />
          )
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-text-secondary">
            {t.selectRoom}
          </div>
        )}
      </div>
      {openedRoomId && !isPaidAndNotJoined && (
        <>
          <div className="px-4 py-2 bg-deep-black/50 border-t border-glass-border/30">
            <JoinGuidePrompt roomId={openedRoomId} />
          </div>
          <div className="border-t border-glass-border px-4 py-2">
            {isGuest ? (
              <div className="flex items-center justify-center gap-2">
                <p className="text-center text-xs text-text-secondary/50">{t.readOnlyGuest}</p>
                <button
                  onClick={showLoginModal}
                  className="rounded border border-neon-cyan/30 px-2 py-0.5 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/10"
                >
                  {t.loginToParticipate}
                </button>
              </div>
            ) : (
              <p className="text-center text-xs text-text-secondary/50">{t.readOnlyView}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
