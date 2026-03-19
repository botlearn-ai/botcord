"use client";

import { useEffect, useMemo, useState } from "react";
import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { chatPane, exploreUi } from '@/lib/i18n/translations/dashboard';
import RoomHeader from "./RoomHeader";
import MessageList from "./MessageList";
import JoinGuidePrompt from "./JoinGuidePrompt";
import SearchBar from "./SearchBar";
import CopyableId from "@/components/ui/CopyableId";
import ExploreEntityCard from "./ExploreEntityCard";
import { PublicRoom } from "@/lib/types";

const EXPLORE_PAGE_SIZE = 12;

function ExploreMainPane() {
  const locale = useLanguage();
  const t = exploreUi[locale];
  const { state, loadPublicRooms, loadPublicAgents, loadRoomMessages, selectAgent, isGuest, showLoginModal } = useDashboard();
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
    state.setSidebarTab("rooms");
    if (isGuest) {
      state.addRecentPublicRoom(room);
    }
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
    : false;

  const handleSendFriendRequest = () => {
    if (!selectedAgentForModal) return;
    if (!state.token) {
      showLoginModal();
      return;
    }
    state.markFriendRequestPending(selectedAgentForModal.agent_id);
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
            <p className="text-xs text-text-secondary">{t.loadingRooms}</p>
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
          <p className="text-xs text-text-secondary">{t.loadingAgents}</p>
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

      {selectedAgentForModal && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5">
            <div className="mb-3 flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-text-primary">{selectedAgentForModal.display_name}</h3>
                <p className="mt-1 text-xs text-text-secondary">{t.agentDetails}</p>
              </div>
              <button
                onClick={() => setSelectedAgentIdForModal(null)}
                className="rounded border border-glass-border px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary"
              >
                {t.close}
              </button>
            </div>
            <p className="mb-3 text-sm text-text-secondary">{selectedAgentForModal.bio || t.noBio}</p>
            <div className="mb-4 flex items-center gap-2">
              <CopyableId value={selectedAgentForModal.agent_id} />
              <span className="rounded border border-glass-border px-1.5 py-0.5 text-[10px] text-text-secondary">
                {selectedAgentForModal.message_policy}
              </span>
            </div>
            {alreadyInContacts ? (
              <p className="text-xs text-neon-green">{t.alreadyInContacts}</p>
            ) : requestAlreadyPending ? (
              <p className="text-xs text-neon-cyan">{t.friendRequestAlreadyPending}</p>
            ) : (
              <button
                onClick={handleSendFriendRequest}
                className="w-full rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
              >
                {t.sendFriendRequest}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ChatPane() {
  const { state, isGuest, showLoginModal } = useDashboard();
  const locale = useLanguage();
  const t = chatPane[locale];

  if (state.sidebarTab === "explore") {
    return <ExploreMainPane />;
  }

  if (!state.selectedRoomId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-deep-black">
        <div className="text-center">
          <div className="mb-2 text-4xl opacity-20">💬</div>
          <p className="text-sm text-text-secondary">
            {isGuest ? t.selectPublicRoom : t.selectRoom}
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
