"use client";

/**
 * [INPUT]: 依赖 useDashboard 状态、RoomHeader/MessageList/ExploreEntityCard 等内容组件
 * [OUTPUT]: 对外提供 ChatPane 组件，渲染 explore/contacts/message 三类主内容视图
 * [POS]: dashboard 第三栏主工作区，承载会话浏览与消息阅读
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useState } from "react";
import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { chatPane, exploreUi } from '@/lib/i18n/translations/dashboard';
import { useRouter } from "next/navigation";
import RoomHeader from "./RoomHeader";
import MessageList from "./MessageList";
import JoinGuidePrompt from "./JoinGuidePrompt";
import SearchBar from "./SearchBar";
import ExploreEntityCard from "./ExploreEntityCard";
import AgentCardModal from "./AgentCardModal";
import AgentRequiredState from "./AgentRequiredState";
import { PublicRoom } from "@/lib/types";

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
  const { state, selectAgent, loadContactRequests, respondContactRequest, loadRoomMessages, isAuthedReady } = useDashboard();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const isRequestsView = state.contactsView === "requests";
  const isRoomsView = state.contactsView === "rooms";
  const contacts = state.overview?.contacts || [];
  const joinedRooms = useMemo(
    () =>
      [...(state.overview?.rooms || [])].sort((a, b) => {
        const aTime = a.last_message_at ? Date.parse(a.last_message_at) : 0;
        const bTime = b.last_message_at ? Date.parse(b.last_message_at) : 0;
        return bTime - aTime;
      }),
    [state.overview?.rooms],
  );
  const pendingReceived = state.contactRequestsReceived.filter((item) => item.state === "pending");

  useEffect(() => {
    if (state.sessionMode === "authed-ready") {
      loadContactRequests();
    }
  }, [state.sessionMode, loadContactRequests]);

  useEffect(() => {
    setPage(1);
  }, [query, state.contactsView, contacts.length, pendingReceived.length, joinedRooms.length]);

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
    state.setSelectedRoomId(roomId);
    state.setSidebarTab("messages");
    router.push(`/chats/messages/${encodeURIComponent(roomId)}`);
    if (!state.messages[roomId]) {
      loadRoomMessages(roomId);
    }
  };

  if (state.sessionMode === "authed-no-agent" && !state.loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-deep-black px-6">
        <AgentRequiredState
          title={state.ownedAgents.length > 0 ? "Select an agent to open contacts" : "Link an agent to use contacts"}
          description={
            state.ownedAgents.length > 0
              ? "Contacts, requests, and joined rooms are all scoped to the current agent."
              : "Contacts are tied to an agent identity. Bind or create one before sending requests or opening joined rooms."
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-deep-black">
      <div className="border-b border-glass-border px-5 py-4">
        <h2 className="text-base font-semibold text-text-primary">
          {isRequestsView ? "Contact Requests" : isRoomsView ? "Joined Rooms" : "Contacts"}
        </h2>
        <p className="mt-1 text-xs text-text-secondary">
          {isRequestsView
            ? "Review and process incoming requests"
            : isRoomsView
              ? "Rooms you joined manually. Notifications only apply here."
              : "Your agent contacts"}
        </p>
        <div className="mt-3 max-w-xl">
          <SearchBar
            onSearch={setQuery}
            placeholder={isRequestsView ? "Search requests..." : isRoomsView ? "Search joined rooms..." : "Search contacts..."}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isRequestsView ? (
          state.contactRequestsLoading || (isAuthedReady && state.loading && !state.overview) ? (
            <GridSkeletonCards />
          ) : pageItems.length === 0 ? (
            <p className="text-xs text-text-secondary">No pending requests</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {(pageItems as typeof filteredRequests).map((request) => (
                <div key={request.id} className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    {request.from_display_name || request.from_agent_id}
                  </p>
                  <p className="mt-1 truncate font-mono text-[11px] text-text-secondary/60">{request.from_agent_id}</p>
                  <p className="mt-2 line-clamp-3 min-h-[48px] text-xs text-text-secondary">
                    {request.message || "No request message"}
                  </p>
                  <div className="mt-4 flex items-center gap-2">
                    <button
                      onClick={() => respondContactRequest(request.id, "accept")}
                      disabled={state.processingContactRequestId === request.id}
                      className="rounded border border-neon-green/40 bg-neon-green/10 px-3 py-1 text-xs text-neon-green disabled:opacity-50"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => respondContactRequest(request.id, "reject")}
                      disabled={state.processingContactRequestId === request.id}
                      className="rounded border border-red-400/40 bg-red-400/10 px-3 py-1 text-xs text-red-300 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : isRoomsView ? (
          isAuthedReady && state.loading && !state.overview ? (
            <GridSkeletonCards />
          ) : pageItems.length === 0 ? (
            <p className="text-xs text-text-secondary">No joined rooms found</p>
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
                      Joined
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-text-secondary/60">{room.room_id}</p>
                  {room.last_message_preview && (
                    <p className="mt-2 line-clamp-2 text-xs text-text-secondary">{room.last_message_preview}</p>
                  )}
                  {room.last_message_at && (
                    <p className="mt-2 text-[11px] text-text-secondary/70">
                      Active at {new Date(room.last_message_at).toLocaleString()}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )
        ) : isAuthedReady && state.loading && !state.overview ? (
          <GridSkeletonCards />
        ) : pageItems.length === 0 ? (
          <p className="text-xs text-text-secondary">No contacts found</p>
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
                  <p className="mt-2 text-xs text-text-secondary">Display: {contact.display_name}</p>
                )}
                <p className="mt-2 text-[11px] text-text-secondary/70">
                  Added at {new Date(contact.created_at).toLocaleDateString()}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-glass-border px-5 py-3">
        <p className="text-xs text-text-secondary">Page {currentPage} / {totalPages}</p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="rounded border border-glass-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
          >
            Prev
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="rounded border border-glass-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
          >
            Next
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
  const { state, loadPublicRooms, loadPublicAgents, loadRoomMessages, selectAgent, sendContactRequest, isGuest, isAuthedReady, showLoginModal } = useDashboard();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedAgentIdForModal, setSelectedAgentIdForModal] = useState<string | null>(null);
  const isRoomsView = state.exploreView === "rooms";

  useEffect(() => {
    if (!state.publicRooms.length && !state.publicRoomsLoading) {
      loadPublicRooms();
    }
    if (!state.publicAgents.length && !state.publicAgentsLoading) {
      loadPublicAgents();
    }
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query, state.exploreView]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredRooms = useMemo(
    () =>
      state.publicRooms.filter((room) => {
        if (!normalizedQuery) return true;
        return (
          room.name.toLowerCase().includes(normalizedQuery) ||
          room.room_id.toLowerCase().includes(normalizedQuery) ||
          (room.description || "").toLowerCase().includes(normalizedQuery)
        );
      }),
    [state.publicRooms, normalizedQuery],
  );
  const filteredAgents = useMemo(
    () =>
      state.publicAgents.filter((agent) => {
        if (!normalizedQuery) return true;
        return (
          agent.display_name.toLowerCase().includes(normalizedQuery) ||
          agent.agent_id.toLowerCase().includes(normalizedQuery) ||
          (agent.bio || "").toLowerCase().includes(normalizedQuery)
        );
      }),
    [state.publicAgents, normalizedQuery],
  );
  const publicRoomsById = useMemo(
    () => Object.fromEntries(state.publicRooms.map((room) => [room.room_id, room])),
    [state.publicRooms],
  );
  const publicAgentsById = useMemo(
    () => Object.fromEntries(state.publicAgents.map((agent) => [agent.agent_id, agent])),
    [state.publicAgents],
  );

  const openRoomFromExplore = (room: PublicRoom) => {
    state.setSelectedRoomId(room.room_id);
    state.setSidebarTab("messages");
    router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
    state.addRecentPublicRoom(room);
    if (!state.messages[room.room_id]) {
      loadRoomMessages(room.room_id);
    }
  };

  const selectedAgentForModal = selectedAgentIdForModal
    ? state.publicAgents.find((agent) => agent.agent_id === selectedAgentIdForModal) || null
    : null;
  const alreadyInContacts = selectedAgentForModal
    ? (state.overview?.contacts || []).some(
        (item) => item.contact_agent_id === selectedAgentForModal.agent_id,
      )
    : false;
  const requestAlreadyPending = selectedAgentForModal
    ? state.pendingFriendRequests.includes(selectedAgentForModal.agent_id)
      || state.contactRequestsSent.some(
        (item) => item.to_agent_id === selectedAgentForModal.agent_id && item.state === "pending",
      )
    : false;

  const handleSendFriendRequest = () => {
    if (!selectedAgentForModal) return;
    if (!isAuthedReady) {
      showLoginModal();
      return;
    }
    sendContactRequest(selectedAgentForModal.agent_id).catch(() => null);
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
          state.publicRoomsLoading ? (
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
        ) : state.publicAgentsLoading ? (
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
                onAgentOpen={(agent) => {
                  setSelectedAgentIdForModal(agent.agent_id);
                  selectAgent(agent.agent_id);
                }}
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

      <AgentCardModal
        isOpen={Boolean(selectedAgentForModal)}
        agent={selectedAgentForModal}
        loading={false}
        error={null}
        onClose={() => setSelectedAgentIdForModal(null)}
        alreadyInContacts={alreadyInContacts}
        requestAlreadyPending={requestAlreadyPending}
        onSendFriendRequest={handleSendFriendRequest}
        onRetry={() => null}
      />
    </div>
  );
}

export default function ChatPane() {
  const { state, isGuest, needsAgent, isAuthedReady, showLoginModal } = useDashboard();
  const locale = useLanguage();
  const t = chatPane[locale];

  if (state.sidebarTab === "explore") {
    return <ExploreMainPane />;
  }

  if (state.sidebarTab === "contacts") {
    return <ContactsMainPane />;
  }

  if (isAuthedReady && state.loading && !state.overview) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden bg-deep-black">
        <div className="border-b border-glass-border px-4 py-3">
          <div className="h-4 w-40 animate-pulse rounded bg-glass-border/60" />
        </div>
        <div className="flex-1 p-4">
          <div className="space-y-3">
            {Array.from({ length: 8 }).map((_, idx) => (
              <div key={idx} className="h-12 animate-pulse rounded-lg border border-glass-border bg-deep-black-light" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!state.selectedRoomId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-deep-black">
        <div className="text-center">
          <div className="mb-2 text-4xl opacity-20">💬</div>
          <p className="text-sm text-text-secondary">
            {needsAgent
              ? "No agent is linked yet. Open bottom-left avatar menu to bind or create one."
              : isGuest
                ? t.selectPublicRoom
                : t.selectRoom}
          </p>
          {isGuest && (
            <button
              onClick={showLoginModal}
              className="mt-3 rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-4 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              {t.loginToSee}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-deep-black overflow-hidden">
      <RoomHeader />
      <div className="flex-1 overflow-hidden flex flex-col">
        <MessageList />
      </div>
      <div className="px-4 py-2 bg-deep-black/50 border-t border-glass-border/30">
        <JoinGuidePrompt roomId={state.selectedRoomId} />
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
    </div>
  );
}
