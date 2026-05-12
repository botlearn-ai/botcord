"use client";

/**
 * [INPUT]: 依赖 session/ui/chat/contact store 与 RoomHeader/MessageList/PaidRoomPreview/ExploreEntityCard 等内容组件
 * [OUTPUT]: 对外提供 ChatPane 组件，渲染 explore/contacts/message 三类主内容视图，并把公开目录搜索委托给远端查询
 * [POS]: dashboard 第三栏主工作区，承载会话浏览与消息阅读；无 agent 准入由 DashboardApp 顶层统一处理
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { startTransition, useEffect, useMemo, useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { chatPane, exploreUi } from '@/lib/i18n/translations/dashboard';
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { Bot, Loader2, MessageSquare, User, Users } from "lucide-react";
import {
  buildVisibleMessageRooms,
  isRoomOwnedByCurrentViewer,
  mergeDashboardRoomsWithHumanRooms,
} from "@/store/dashboard-shared";
import RoomHeader from "./RoomHeader";
import MessageList from "./MessageList";
import PaidRoomPreview from "./PaidRoomPreview";
import RoomHumanComposer from "./RoomHumanComposer";
import TopicDrawer from "./TopicDrawer";
import FriendInviteModal from "./FriendInviteModal";
import SearchBar from "./SearchBar";
import ExploreEntityCard from "./ExploreEntityCard";
import { PublicHumanProfile, PublicRoom } from "@/lib/types";
import { api } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { usePresenceStore } from "@/store/usePresenceStore";
import RoomZeroState from "./RoomZeroState";
import { initialsFromName } from "./roomVisualTheme";
import { dmPeerId } from "./dmRoom";
import ContactsDetailPane from "./ContactsDetailPane";
import { findOriginAgentForRoom } from "@/lib/messages-merge";

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

function ContactsMainPane({ onHumanOpen }: { onHumanOpen?: (human: PublicHumanProfile) => void }) {
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
  const humanId = useDashboardSessionStore((state) => state.human?.human_id ?? null);
  const humanRooms = useDashboardSessionStore((state) => state.humanRooms);
  const isAuthed = sessionMode === "authed-ready" || sessionMode === "authed-no-agent";
  const [query, setQuery] = useState("");
  const [showFriendInvite, setShowFriendInvite] = useState(false);
  const isRequestsView = contactsView === "requests";
  const isRoomsView = contactsView === "rooms";
  const isCreatedView = contactsView === "created";
  const contacts = overview?.contacts || [];
  const sortedRooms = useMemo(
    () => mergeDashboardRoomsWithHumanRooms(overview?.rooms || [], humanRooms),
    [overview?.rooms, humanRooms],
  );
  const ownerViewer = useMemo(() => ({ activeAgentId, humanId }), [activeAgentId, humanId]);
  const joinedRooms = useMemo(
    () => sortedRooms.filter((room) => !isRoomOwnedByCurrentViewer(room, ownerViewer)),
    [sortedRooms, ownerViewer],
  );
  const createdRooms = useMemo(
    () => sortedRooms.filter((room) => isRoomOwnedByCurrentViewer(room, ownerViewer)),
    [sortedRooms, ownerViewer],
  );
  const pendingReceived = contactRequestsReceived.filter((item) => item.state === "pending");

  useEffect(() => {
    if (isAuthed) {
      void loadContactRequests();
    }
  }, [isAuthed, loadContactRequests]);

  // Always refresh overview when entering the contacts pane so that newly
  // created rooms (built by the agent via /hub/rooms with no messages yet)
  // and freshly added contacts show up without waiting for a realtime event.
  useEffect(() => {
    if (isAuthed) {
      void refreshOverview();
    }
  }, [isAuthed, contactsView, refreshOverview]);

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
            {(pageItems as typeof filteredContacts).map((contact) => {
              const isHuman = contact.peer_type === "human" || contact.contact_agent_id.startsWith("hu_");
              const primaryName = contact.alias || contact.display_name;
              const hasRealName = primaryName && primaryName !== contact.contact_agent_id;
              const initials = initialsFromName(hasRealName ? primaryName : contact.contact_agent_id);
              const avatarBorder = isHuman ? "border-neon-green/30" : "border-neon-cyan/30";
              const avatarFallback = isHuman
                ? "border-neon-green/30 bg-neon-green/10 text-neon-green"
                : "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan";
              return (
                <button
                  key={contact.contact_agent_id}
                  onClick={async () => {
                    if (isHuman) {
                      try {
                        const human = await api.getPublicHuman(contact.contact_agent_id);
                        onHumanOpen?.(human);
                      } catch {
                        onHumanOpen?.({
                          human_id: contact.contact_agent_id,
                          display_name: contact.display_name,
                          avatar_url: contact.avatar_url ?? null,
                          created_at: contact.created_at,
                        });
                      }
                    } else {
                      void selectAgent(contact.contact_agent_id);
                    }
                  }}
                  className="rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left transition-all hover:border-neon-cyan/60 hover:bg-glass-bg"
                >
                  <div className="flex items-start gap-3">
                    {contact.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={contact.avatar_url}
                        alt={primaryName}
                        className={`h-10 w-10 shrink-0 rounded-full border object-cover ${avatarBorder}`}
                      />
                    ) : (
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${avatarFallback}`}
                      >
                        {initials}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {hasRealName ? primaryName : (isHuman ? t.unnamedHuman : t.unnamedAgent)}
                      </p>
                      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-text-secondary/60">
                        {isHuman ? t.contactKindHuman : t.contactKindAgent}
                      </p>
                      <p className="mt-1 truncate font-mono text-[11px] text-text-secondary/60">{contact.contact_agent_id}</p>
                      {contact.alias && contact.display_name && contact.display_name !== contact.alias && (
                        <p className="mt-1 truncate text-xs text-text-secondary">{t.display}: {contact.display_name}</p>
                      )}
                    </div>
                  </div>
                  <p className="mt-3 text-[11px] text-text-secondary/70">
                    {t.addedAt} {new Date(contact.created_at).toLocaleDateString()}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {showFriendInvite ? <FriendInviteModal onClose={() => setShowFriendInvite(false)} /> : null}
    </div>
  );
}

interface ChatPaneProps {
  onHumanOpen?: (human: PublicHumanProfile) => void;
}

function ExploreMainPane({ onHumanOpen }: ChatPaneProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = exploreUi[locale];
  const { authResolved } = useDashboardSessionStore(useShallow((state) => ({
    authResolved: state.authResolved,
  })));
  const { exploreView, setExploreView, setFocusedRoomId, setOpenedRoomId, setSidebarTab } = useDashboardUIStore(useShallow((state) => ({
    exploreView: state.exploreView,
    setExploreView: state.setExploreView,
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
  const [query, setQuery] = useState("");
  const isRoomsView = exploreView === "rooms";
  const isAgentsView = exploreView === "agents";
  const isHumansView = exploreView === "humans";

  useEffect(() => {
    if (!authResolved) return;
    const normalizedQuery = query.trim();
    if (isRoomsView) {
      void loadPublicRooms(normalizedQuery);
    } else if (isAgentsView) {
      void loadPublicAgents(normalizedQuery);
    } else if (isHumansView) {
      void loadPublicHumans(normalizedQuery);
    }
  }, [authResolved, isRoomsView, isAgentsView, isHumansView, query, loadPublicRooms, loadPublicAgents, loadPublicHumans]);
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

  const openHumanOwnerFromAgent = async (humanId: string) => {
    const existing = publicHumansById[humanId];
    if (existing) {
      onHumanOpen?.(existing);
      return;
    }
    try {
      const human = await api.getPublicHuman(humanId);
      onHumanOpen?.(human);
    } catch {
      // Swallow lookup failure; the owner link should not break agent-card navigation.
    }
  };

  const searchPlaceholder = isRoomsView ? t.searchRooms : isAgentsView ? t.searchAgents : t.searchHumans;
  const loading = isRoomsView ? publicRoomsLoading : isAgentsView ? publicAgentsLoading : publicHumansLoading;
  const emptyText = isRoomsView ? t.noRoomsFound : isAgentsView ? t.noAgentsFound : t.noHumansFound;

  const exploreTabs: Array<{ key: "rooms" | "agents" | "humans"; label: string }> = [
    { key: "rooms", label: locale === "zh" ? "群组" : "Groups" },
    { key: "agents", label: locale === "zh" ? "Bot" : "Agents" },
    { key: "humans", label: locale === "zh" ? "真人" : "Humans" },
  ];

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-deep-black">
      <div className="mx-auto w-full max-w-5xl px-6 pt-8">
        <h1 className="text-2xl font-semibold text-text-primary">
          {locale === "zh" ? "发现" : "Explore"}
        </h1>
        <p className="mt-1 text-sm text-text-secondary/70">
          {locale === "zh" ? "找到你的同好，与有趣的人聊天" : "Find your tribe, chat with interesting people"}
        </p>
        <div className="mt-5 inline-flex items-center gap-1 rounded-full border border-glass-border bg-glass-bg/60 p-1">
          {exploreTabs.map((tab) => {
            const active = exploreView === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => {
                  setExploreView(tab.key);
                  startTransition(() => router.push(`/chats/explore/${tab.key}`));
                }}
                className={`rounded-full px-5 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-text-primary text-deep-black"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="mt-5 max-w-xl">
          <SearchBar onSearch={setQuery} placeholder={searchPlaceholder} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-6">
        {loading ? (
          <GridSkeletonCards />
        ) : isRoomsView ? (
          publicRooms.length === 0 ? (
            <p className="text-xs text-text-secondary">{emptyText}</p>
          ) : (
            <div className={EXPLORE_GRID_CLASS}>
              {publicRooms.map((room) => (
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
          publicAgents.length === 0 ? (
            <p className="text-xs text-text-secondary">{emptyText}</p>
          ) : (
            <div className={EXPLORE_GRID_CLASS}>
              {publicAgents.map((agent) => (
                <ExploreEntityCard
                  key={agent.agent_id}
                  kind="agent"
                  data={publicAgentsById[agent.agent_id]}
                  agentsById={publicAgentsById}
                  onAgentOpen={(a) => selectAgent(a.agent_id)}
                  onAgentOwnerOpen={(humanId) => void openHumanOwnerFromAgent(humanId)}
                />
              ))}
            </div>
          )
        ) : publicHumans.length === 0 ? (
          <p className="text-xs text-text-secondary">{emptyText}</p>
        ) : (
          <div className={EXPLORE_GRID_CLASS}>
            {publicHumans.map((human) => (
              <ExploreEntityCard
                key={human.human_id}
                kind="human"
                data={publicHumansById[human.human_id]}
                humansById={publicHumansById}
                onHumanOpen={onHumanOpen}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type MessagesFilter = "all" | "bots" | "humans" | "groups";

const messagesEmptyByFilter: Record<MessagesFilter, {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  hint: string;
}> = {
  all: {
    icon: MessageSquare,
    title: "选择一个对话",
    description: "从左侧列表选一条对话开始 — Bot、真人、群聊都在这里。",
    hint: "提示：用顶部的「全部 / Bot / 真人 / 群聊」chip 快速切换。",
  },
  bots: {
    icon: Bot,
    title: "和你的 Bot 聊一聊",
    description: "左侧是你与每个 Bot 的私聊，点开就可以发消息。",
    hint: "想发现更多 Bot？去「发现」标签浏览公开 agents。",
  },
  humans: {
    icon: User,
    title: "和真人聊一聊",
    description: "左侧是你与真实联系人的私聊。",
    hint: "想认识更多人？去「发现」→ 公开 Human。",
  },
  groups: {
    icon: Users,
    title: "选一个群开始",
    description: "你已加入的群聊都列在左侧，点击进入即可发言。",
    hint: "想找新的群？去「发现」→ 公开房间。",
  },
};

function MessagesEmptyState({ filter }: { filter: MessagesFilter }) {
  const config = messagesEmptyByFilter[filter];
  const Icon = config.icon;
  return (
    <div className="w-full max-w-md text-center">
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-glass-border bg-glass-bg/40">
        <Icon className="h-6 w-6 text-neon-cyan/80" />
      </div>
      <h2 className="text-lg font-semibold text-text-primary">{config.title}</h2>
      <p className="mt-2 text-sm text-text-secondary/70">{config.description}</p>
      <p className="mt-4 inline-block rounded-full border border-glass-border/60 bg-glass-bg/30 px-3 py-1 text-[11px] text-text-secondary/60">
        {config.hint}
      </p>
    </div>
  );
}

export default function ChatPane({ onHumanOpen }: ChatPaneProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = chatPane[locale];
  const { sessionMode, token, humanRooms, viewMode, activeAgentId, humanId } = useDashboardSessionStore(useShallow((state) => ({
    sessionMode: state.sessionMode,
    token: state.token,
    humanRooms: state.humanRooms,
    viewMode: state.viewMode,
    activeAgentId: state.activeAgentId,
    humanId: state.human?.human_id ?? null,
  })));
  const { sidebarTab, focusedRoomId, openedRoomId, messagesFilter } = useDashboardUIStore(useShallow((state) => ({
    sidebarTab: state.sidebarTab,
    focusedRoomId: state.focusedRoomId,
    openedRoomId: state.openedRoomId,
    messagesFilter: state.messagesFilter,
  })));
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
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

  // Seed presence for the opened room's members so MessageBubble's PresenceDot
  // reflects real online state. Without this, senders that aren't the user's
  // own agents stay "offline" until they happen to transition during the
  // session — realtime presence events only fire on online/offline edges.
  useEffect(() => {
    if (!openedRoomId) return;
    let cancelled = false;
    api.getRoomMembers(openedRoomId)
      .catch(() => api.getPublicRoomMembers(openedRoomId))
      .then((result) => {
        if (cancelled) return;
        usePresenceStore.getState().seed(
          result.members.map((m) => ({ agentId: m.agent_id, online: Boolean(m.online) })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [openedRoomId]);

  if (sidebarTab === "explore") {
    return <ExploreMainPane onHumanOpen={onHumanOpen} />;
  }

  if (sidebarTab === "contacts") {
    return <ContactsDetailPane />;
  }

  if (!focusedRoomId) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-y-auto bg-deep-black px-6 py-10">
        <MessagesEmptyState filter={messagesFilter} />
      </div>
    );
  }

  const openedRoom = openedRoomId ? getRoomSummary(openedRoomId) : null;
  const joinedRoom = overview?.rooms.find((r) => r.room_id === openedRoomId);
  const joinedHumanRoom = humanRooms.find((r) => r.room_id === openedRoomId);
  const isHumanView = viewMode === "human";
  // DM rooms are auto-created server-side on first send, so treat the user
  // as a member of an unseen rm_dm_* room when their own id is one of the
  // two encoded parties.
  const selfId = (isHumanView || isAuthedHuman) ? humanId : activeAgentId;
  const isPendingDmForSelf = dmPeerId(openedRoomId, selfId) !== null;
  const isJoinedRoom = ((isHumanView || isAuthedHuman) ? Boolean(joinedHumanRoom) : Boolean(joinedRoom))
    || isPendingDmForSelf;
  const humanSendAllowed = joinedRoom?.allow_human_send !== false;
  const isPaidRoom = Boolean(openedRoom?.required_subscription_product_id);
  const isPaidAndNotJoined = isPaidRoom && !isJoinedRoom;
  const loginHref = openedRoom ? `/login?next=${encodeURIComponent(`/chats/messages/${openedRoom.room_id}`)}` : "/login";

  return (
    <div className="flex flex-1 flex-col bg-deep-black overflow-hidden">
      {openedRoomId && <RoomHeader />}
      <div className="flex-1 overflow-hidden flex flex-col">
        {openedRoomId ? (
          isPaidAndNotJoined && openedRoom?.required_subscription_product_id ? (
            <PaidRoomPreview
              roomId={openedRoomId}
              productId={openedRoom.required_subscription_product_id}
              isGuest={isGuest}
              loginHref={loginHref}
            />
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
          {openedRoomId && findOriginAgentForRoom(openedRoomId, ownedAgents) ? (
            <div className="border-t border-glass-border bg-glass-bg/30 px-4 py-2.5">
              <p className="text-center text-xs text-text-secondary/70">
                <span className="mr-1">🔒</span>
                由 {findOriginAgentForRoom(openedRoomId, ownedAgents)?.display_name} 代为发言 · 你是 owner，可观察不可发
              </p>
            </div>
          ) : isGuest ? (
            <div className="border-t border-glass-border px-4 py-2">
              <div className="flex items-center justify-center gap-2">
                <p className="text-center text-xs text-text-secondary/50">{t.readOnlyGuest}</p>
                <button
                  onClick={showLoginModal}
                  className="rounded border border-neon-cyan/30 px-2 py-0.5 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/10"
                >
                  {t.loginToParticipate}
                </button>
              </div>
            </div>
          ) : (isAuthedReady || isAuthedHuman) && isJoinedRoom && openedRoomId && humanSendAllowed ? (
            <div className="border-t border-glass-border px-4 py-2">
              <RoomHumanComposer roomId={openedRoomId} />
            </div>
          ) : (isAuthedReady || isAuthedHuman) && isJoinedRoom && !humanSendAllowed ? (
            <div className="border-t border-glass-border px-4 py-2">
              <p className="text-center text-xs text-text-secondary/50">{t.humanSendDisabled}</p>
            </div>
          ) : null}
        </>
      )}
      <TopicDrawer />
    </div>
  );
}
