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
import { Loader2 } from "lucide-react";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import RoomHeader from "./RoomHeader";
import MessageList from "./MessageList";
import RoomHumanComposer from "./RoomHumanComposer";
import TopicDrawer from "./TopicDrawer";
import JoinGuidePrompt from "./JoinGuidePrompt";
import FriendInviteModal from "./FriendInviteModal";
import HumanCardModal from "./HumanCardModal";
import SearchBar from "./SearchBar";
import ExploreEntityCard from "./ExploreEntityCard";
import { PublicHumanProfile, PublicRoom } from "@/lib/types";
import { api, humansApi } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import RoomZeroState from "./RoomZeroState";
import PendingApprovalsPanel from "./PendingApprovalsPanel";
import SubscriptionBadge from "./SubscriptionBadge";

const EXPLORE_GRID_CLASS = "grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

function GridSkeletonCards({ count = 10 }: { count?: number }) {
  return (
    <div className={EXPLORE_GRID_CLASS}>
      {Array.from({ length: count }).map((_, idx) => (
        <div key={idx} className="rounded-xl border border-glass-border bg-deep-black-light p-3">
          <div className="h-3 w-2/3 animate-pulse rounded bg-glass-border/60" />
          <div className="mt-1.5 h-2.5 w-1/2 animate-pulse rounded bg-glass-border/50" />
          <div className="mt-2.5 h-2.5 w-full animate-pulse rounded bg-glass-border/50" />
          <div className="mt-1.5 h-2.5 w-5/6 animate-pulse rounded bg-glass-border/40" />
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
  const { overview, messages, loadRoomMessages, selectAgent, refreshOverview } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    messages: state.messages,
    loadRoomMessages: state.loadRoomMessages,
    selectAgent: state.selectAgent,
    refreshOverview: state.refreshOverview,
  })));
  const {
    contactRequestsLoading,
    contactRequestsReceived,
    processingContactRequestId,
    processingContactRequestAction,
    loadContactRequests,
    respondContactRequest,
  } = useDashboardContactStore(useShallow((state) => ({
    contactRequestsLoading: state.contactRequestsLoading,
    contactRequestsReceived: state.contactRequestsReceived,
    processingContactRequestId: state.processingContactRequestId,
    processingContactRequestAction: state.processingContactRequestAction,
    loadContactRequests: state.loadContactRequests,
    respondContactRequest: state.respondContactRequest,
  })));
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const activeAgentId = useDashboardSessionStore((state) => state.activeAgentId);
  const [query, setQuery] = useState("");
  const [showFriendInvite, setShowFriendInvite] = useState(false);
  const isRequestsView = contactsView === "requests";
  const isRoomsView = contactsView === "rooms";
  const isCreatedView = contactsView === "created";
  const contacts = overview?.contacts || [];
  const sortedRooms = useMemo(
    () =>
      [...(overview?.rooms || [])].sort((a, b) => {
        const aTime = (a.last_message_at || a.created_at) ? Date.parse(a.last_message_at || a.created_at!) : 0;
        const bTime = (b.last_message_at || b.created_at) ? Date.parse(b.last_message_at || b.created_at!) : 0;
        return bTime - aTime;
      }),
    [overview?.rooms],
  );
  const joinedRooms = useMemo(
    () => sortedRooms.filter((room) => !activeAgentId || room.owner_id !== activeAgentId),
    [sortedRooms, activeAgentId],
  );
  const createdRooms = useMemo(
    () => sortedRooms.filter((room) => activeAgentId && room.owner_id === activeAgentId),
    [sortedRooms, activeAgentId],
  );
  const pendingReceived = contactRequestsReceived.filter((item) => item.state === "pending");

  useEffect(() => {
    if (sessionMode === "authed-ready") {
      void loadContactRequests();
    }
  }, [sessionMode, loadContactRequests]);

  // Always refresh overview when entering the contacts pane so that newly
  // created rooms (built by the agent via /hub/rooms with no messages yet)
  // and freshly added contacts show up without waiting for a realtime event.
  useEffect(() => {
    if (sessionMode === "authed-ready") {
      void refreshOverview();
    }
  }, [sessionMode, contactsView, refreshOverview]);

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
  const roomMatcher = (room: typeof sortedRooms[number]) => {
    if (!normalized) return true;
    return (
      room.name.toLowerCase().includes(normalized) ||
      room.room_id.toLowerCase().includes(normalized) ||
      (room.description || "").toLowerCase().includes(normalized)
    );
  };
  const filteredJoinedRooms = joinedRooms.filter(roomMatcher);
  const filteredCreatedRooms = createdRooms.filter(roomMatcher);

  const pageItems = isRequestsView
    ? filteredRequests
    : isRoomsView
      ? filteredJoinedRooms
      : isCreatedView
        ? filteredCreatedRooms
        : filteredContacts;

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
          {isRequestsView
            ? t.contactRequests
            : isRoomsView
              ? t.joinedRooms
              : isCreatedView
                ? t.createdRooms
                : t.contacts}
        </h2>
        <p className="mt-1 text-xs text-text-secondary">
          {isRequestsView
            ? t.reviewRequests
            : isRoomsView
              ? t.roomsJoinedManually
              : isCreatedView
                ? t.roomsCreatedByMe
                : t.yourAgentContacts}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="min-w-[240px] max-w-xl flex-1">
            <SearchBar
              onSearch={setQuery}
              placeholder={
                isRequestsView
                  ? t.searchRequests
                  : isRoomsView
                    ? t.searchJoinedRooms
                    : isCreatedView
                      ? t.searchCreatedRooms
                      : t.searchContacts
              }
            />
          </div>
          {!isRequestsView && !isRoomsView && !isCreatedView ? (
            <button
              type="button"
              onClick={() => setShowFriendInvite(true)}
              className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-xs font-medium text-neon-cyan hover:bg-neon-cyan/20"
            >
              {t.inviteFriend}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isRequestsView ? <PendingApprovalsPanel /> : null}
        {isRequestsView ? (
          contactRequestsLoading ? (
            <GridSkeletonCards />
          ) : pageItems.length === 0 ? (
            <p className="text-xs text-text-secondary">{t.noPendingRequests}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {(pageItems as typeof filteredRequests).map((request) => {
                const isProcessing = processingContactRequestId === request.id;
                const isAccepting = isProcessing && processingContactRequestAction === "accept";
                const isRejecting = isProcessing && processingContactRequestAction === "reject";

                return (
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
                        disabled={isProcessing}
                        className="inline-flex items-center gap-1.5 rounded border border-neon-green/40 bg-neon-green/10 px-3 py-1 text-xs text-neon-green disabled:opacity-50"
                      >
                        {isAccepting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {isAccepting ? t.accepting : t.accept}
                      </button>
                      <button
                        onClick={() => respondContactRequest(request.id, "reject")}
                        disabled={isProcessing}
                        className="inline-flex items-center gap-1.5 rounded border border-red-400/40 bg-red-400/10 px-3 py-1 text-xs text-red-300 disabled:opacity-50"
                      >
                        {isRejecting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {isRejecting ? t.rejecting : t.reject}
                      </button>
                    </div>
                  </div>
                );
              })}
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
        ) : isCreatedView ? (
          !overview ? (
            <GridSkeletonCards />
          ) : pageItems.length === 0 ? (
            <p className="text-xs text-text-secondary">{t.noCreatedRoomsFound}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {(pageItems as typeof filteredCreatedRooms).map((room) => (
                <button
                  key={room.room_id}
                  onClick={() => openJoinedRoom(room.room_id)}
                  className="rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left transition-all hover:border-neon-cyan/60 hover:bg-glass-bg"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-text-primary">{room.name}</p>
                    <span className="rounded border border-neon-purple/40 bg-neon-purple/10 px-1.5 py-0.5 text-[10px] text-neon-purple">
                      {t.ownerBadge}
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

      {showFriendInvite ? <FriendInviteModal onClose={() => setShowFriendInvite(false)} /> : null}
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
    publicHumans,
    publicHumansLoading,
    messages,
    loadPublicRooms,
    loadPublicAgents,
    loadPublicHumans,
    loadRoomMessages,
    selectAgent,
    addRecentPublicRoom,
  } = useDashboardChatStore(useShallow((state) => ({
    publicRooms: state.publicRooms,
    publicRoomsLoading: state.publicRoomsLoading,
    publicAgents: state.publicAgents,
    publicAgentsLoading: state.publicAgentsLoading,
    publicHumans: state.publicHumans,
    publicHumansLoading: state.publicHumansLoading,
    messages: state.messages,
    loadPublicRooms: state.loadPublicRooms,
    loadPublicAgents: state.loadPublicAgents,
    loadPublicHumans: state.loadPublicHumans,
    loadRoomMessages: state.loadRoomMessages,
    selectAgent: state.selectAgent,
    addRecentPublicRoom: state.addRecentPublicRoom,
  })));
  const { viewMode } = useDashboardSessionStore(useShallow((state) => ({
    viewMode: state.viewMode,
  })));
  const contactAgentIds = useMemo(
    () => new Set((useDashboardChatStore.getState().overview?.contacts ?? []).map((c) => c.contact_agent_id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [query, setQuery] = useState("");
  const [humanModal, setHumanModal] = useState<{
    human: PublicHumanProfile;
    sending: boolean;
    status: "idle" | "sent" | "exists" | "pending";
    error: string | null;
  } | null>(null);
  const isRoomsView = exploreView === "rooms";
  const isAgentsView = exploreView === "agents";
  const isHumansView = exploreView === "humans";

  useEffect(() => {
    if (!authResolved) return;
    if (isRoomsView && !publicRoomsLoading) {
      void loadPublicRooms();
    } else if (isAgentsView && !publicAgentsLoading) {
      void loadPublicAgents();
    } else if (isHumansView && !publicHumansLoading) {
      void loadPublicHumans();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally refresh on view switch, not on data length
  }, [exploreView, authResolved]);

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
  const filteredHumans = useMemo(
    () =>
      publicHumans.filter((human) => {
        if (!normalizedQuery) return true;
        return (
          human.display_name.toLowerCase().includes(normalizedQuery) ||
          human.human_id.toLowerCase().includes(normalizedQuery)
        );
      }),
    [publicHumans, normalizedQuery],
  );
  const publicRoomsById = useMemo(
    () => Object.fromEntries(publicRooms.map((room) => [room.room_id, room])),
    [publicRooms],
  );
  const publicAgentsById = useMemo(
    () => Object.fromEntries(publicAgents.map((agent) => [agent.agent_id, agent])),
    [publicAgents],
  );
  const publicHumansById = useMemo(
    () => Object.fromEntries(publicHumans.map((human) => [human.human_id, human])),
    [publicHumans],
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

  const openHumanFromExplore = (human: PublicHumanProfile) => {
    setHumanModal({ human, sending: false, status: "idle", error: null });
  };

  const sendHumanContactRequest = async () => {
    if (!humanModal) return;
    setHumanModal((prev) => prev && { ...prev, sending: true, error: null });
    try {
      const targetId = humanModal.human.human_id;
      const res =
        viewMode === "human"
          ? await humansApi.sendContactRequest({ peer_id: targetId })
          : await api.createContactRequest({ to_human_id: targetId });
      if (res && typeof res === "object" && "status" in res) {
        const s = (res as { status: string }).status;
        if (s === "already_contact") setHumanModal((prev) => prev && { ...prev, sending: false, status: "exists" });
        else if (s === "already_requested") setHumanModal((prev) => prev && { ...prev, sending: false, status: "pending" });
        else setHumanModal((prev) => prev && { ...prev, sending: false, status: "sent" });
      } else {
        setHumanModal((prev) => prev && { ...prev, sending: false, status: "sent" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Request failed";
      if (/already.*contact/i.test(msg)) setHumanModal((prev) => prev && { ...prev, sending: false, status: "exists" });
      else if (/already.*request|pending/i.test(msg)) setHumanModal((prev) => prev && { ...prev, sending: false, status: "pending" });
      else setHumanModal((prev) => prev && { ...prev, sending: false, error: msg });
    }
  };

  const title = isRoomsView ? t.publicRooms : isAgentsView ? t.publicAgents : t.publicHumans;
  const subtitle = isRoomsView ? t.browseRooms : isAgentsView ? t.browseAgents : t.browseHumans;
  const searchPlaceholder = isRoomsView ? t.searchRooms : isAgentsView ? t.searchAgents : t.searchHumans;
  const loading = isRoomsView ? publicRoomsLoading : isAgentsView ? publicAgentsLoading : publicHumansLoading;
  const emptyText = isRoomsView ? t.noRoomsFound : isAgentsView ? t.noAgentsFound : t.noHumansFound;

  const handleRefresh = () => {
    if (isRoomsView) void loadPublicRooms();
    else if (isAgentsView) void loadPublicAgents();
    else if (isHumansView) void loadPublicHumans();
  };

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-deep-black">
      <div className="border-b border-glass-border px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            <p className="mt-1 text-xs text-text-secondary">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            className="shrink-0 rounded border border-glass-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-neon-cyan/50 hover:text-neon-cyan disabled:opacity-40"
          >
            {loading ? "…" : t.refresh}
          </button>
        </div>
        <div className="mt-3 max-w-xl">
          <SearchBar onSearch={setQuery} placeholder={searchPlaceholder} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <GridSkeletonCards />
        ) : isRoomsView ? (
          filteredRooms.length === 0 ? (
            <p className="text-xs text-text-secondary">{emptyText}</p>
          ) : (
            <div className={EXPLORE_GRID_CLASS}>
              {filteredRooms.map((room) => (
                <ExploreEntityCard
                  key={room.room_id}
                  kind="room"
                  id={room.room_id}
                  roomsById={publicRoomsById}
                  onRoomOpen={openRoomFromExplore}
                />
              ))}
            </div>
          )
        ) : isAgentsView ? (
          filteredAgents.length === 0 ? (
            <p className="text-xs text-text-secondary">{emptyText}</p>
          ) : (
            <div className={EXPLORE_GRID_CLASS}>
              {filteredAgents.map((agent) => (
                <ExploreEntityCard
                  key={agent.agent_id}
                  kind="agent"
                  data={publicAgentsById[agent.agent_id]}
                  agentsById={publicAgentsById}
                  onAgentOpen={(a) => selectAgent(a.agent_id)}
                />
              ))}
            </div>
          )
        ) : filteredHumans.length === 0 ? (
          <p className="text-xs text-text-secondary">{emptyText}</p>
        ) : (
          <div className={EXPLORE_GRID_CLASS}>
            {filteredHumans.map((human) => (
              <ExploreEntityCard
                key={human.human_id}
                kind="human"
                data={publicHumansById[human.human_id]}
                humansById={publicHumansById}
                onHumanOpen={openHumanFromExplore}
              />
            ))}
          </div>
        )}
      </div>

      <HumanCardModal
        isOpen={humanModal !== null}
        human={humanModal?.human ?? null}
        onClose={() => setHumanModal(null)}
        alreadyInContacts={humanModal?.status === "exists" || (humanModal ? contactAgentIds.has(humanModal.human.human_id) : false)}
        requestAlreadyPending={humanModal?.status === "pending"}
        requestSent={humanModal?.status === "sent"}
        sendingFriendRequest={humanModal?.sending ?? false}
        onSendFriendRequest={sendHumanContactRequest}
        error={humanModal?.error ?? null}
      />
    </div>
  );
}

export default function ChatPane() {
  const router = useRouter();
  const locale = useLanguage();
  const t = chatPane[locale];
  const { sessionMode, token, humanRooms } = useDashboardSessionStore(useShallow((state) => ({
    sessionMode: state.sessionMode,
    token: state.token,
    humanRooms: state.humanRooms,
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
    () => buildVisibleMessageRooms({ overview, recentVisitedRooms, token, humanRooms }),
    [overview, recentVisitedRooms, token, humanRooms],
  );
  const isGuest = sessionMode === "guest";
  const isAuthedReady = sessionMode === "authed-ready";
  const isAuthedHuman = sessionMode === "authed-no-agent";
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
  const joinedRoom = overview?.rooms.find((r) => r.room_id === openedRoomId);
  const joinedHumanRoom = humanRooms.find((r) => r.room_id === openedRoomId);
  const isJoinedRoom = Boolean(joinedRoom || joinedHumanRoom);
  const humanSendAllowed = joinedRoom?.allow_human_send !== false;
  const isPaidRoom = Boolean(openedRoom?.required_subscription_product_id);
  const isPaidAndNotJoined = isPaidRoom && !isJoinedRoom;
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
          {isAuthedReady && overview && !isJoinedRoom && (
            <div className="px-4 py-2 bg-deep-black/50 border-t border-glass-border/30">
              <JoinGuidePrompt roomId={openedRoomId} />
            </div>
          )}
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
            ) : (isAuthedReady || isAuthedHuman) && isJoinedRoom && openedRoomId && humanSendAllowed ? (
              <RoomHumanComposer roomId={openedRoomId} />
            ) : (isAuthedReady || isAuthedHuman) && isJoinedRoom && !humanSendAllowed ? (
              <p className="text-center text-xs text-text-secondary/50">{t.humanSendDisabled}</p>
            ) : (
              <p className="text-center text-xs text-text-secondary/50">{t.readOnlyView}</p>
            )}
          </div>
        </>
      )}
      <TopicDrawer />
    </div>
  );
}
