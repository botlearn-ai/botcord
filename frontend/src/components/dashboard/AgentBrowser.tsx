"use client";

/**
 * [INPUT]: 依赖 dashboard store 的会话/联系人状态，依赖 api 层拉取成员与 agent 详情
 * [OUTPUT]: 对外提供右侧 agent 浏览器与成员点击弹窗交互
 * [POS]: dashboard 右侧信息面板，连接成员列表、搜索结果与 agent 详情弹层
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useState } from "react";
import { useDashboard } from "./DashboardApp";
import SubscriptionBadge from "./SubscriptionBadge";
import { useLanguage } from '@/lib/i18n';
import { agentBrowser } from '@/lib/i18n/translations/dashboard';
import SearchBar from "./SearchBar";
import CopyableId from "@/components/ui/CopyableId";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { AgentProfile, PublicRoomMember } from "@/lib/types";
import AgentCardModal from "./AgentCardModal";

export default function AgentBrowser() {
  const { state, searchAgents, selectAgent, loadRoomMessages, sendContactRequest, isGuest, isAuthedReady, showLoginModal } = useDashboard();
  const router = useRouter();
  const locale = useLanguage();
  const t = agentBrowser[locale];
  const [roomMembers, setRoomMembers] = useState<PublicRoomMember[]>([]);
  const [roomMembersLoading, setRoomMembersLoading] = useState(false);
  const [roomMembersError, setRoomMembersError] = useState<string | null>(null);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [selectedAgentForModal, setSelectedAgentForModal] = useState<AgentProfile | null>(null);

  const currentRoom = state.focusedRoomId ? state.getRoomSummary(state.focusedRoomId) : null;
  const alreadyInContacts = selectedAgentForModal
    ? (state.overview?.contacts || []).some((item) => item.contact_agent_id === selectedAgentForModal.agent_id)
    : false;
  const requestAlreadyPending = selectedAgentForModal
    ? state.pendingFriendRequests.includes(selectedAgentForModal.agent_id)
      || state.contactRequestsSent.some(
        (item) => item.to_agent_id === selectedAgentForModal.agent_id && item.state === "pending",
      )
    : false;

  const openAgentModal = (member: PublicRoomMember) => {
    setSelectedAgentForModal({
      agent_id: member.agent_id,
      display_name: member.display_name,
      bio: member.bio,
      message_policy: member.message_policy,
      created_at: member.created_at,
    });
    setAgentModalOpen(true);
  };

  const closeAgentModal = () => {
    setAgentModalOpen(false);
    setSelectedAgentForModal(null);
  };

  const handleSendFriendRequest = () => {
    if (!selectedAgentForModal) return;
    if (!isAuthedReady) {
      showLoginModal();
      return;
    }
    sendContactRequest(selectedAgentForModal.agent_id).catch(() => null);
  };

  useEffect(() => {
    if (!state.focusedRoomId) {
      setRoomMembers([]);
      setRoomMembersError(null);
      setRoomMembersLoading(false);
      return;
    }
    let cancelled = false;
    setRoomMembersLoading(true);
    setRoomMembersError(null);
    api.getPublicRoomMembers(state.focusedRoomId)
      .then((result) => {
        if (cancelled) return;
        setRoomMembers(result.members);
      })
      .catch(() => {
        if (cancelled) return;
        setRoomMembers([]);
        setRoomMembersError("Failed to load members");
      })
      .finally(() => {
        if (cancelled) return;
        setRoomMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.focusedRoomId]);

  return (
    <div className="flex h-full min-h-0 w-[320px] min-w-[320px] flex-col border-l border-glass-border bg-deep-black-light">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between border-b border-glass-border px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">{t.agents}</h3>
        <button
          onClick={() => state.toggleRightPanel()}
          className="rounded p-1 text-text-secondary hover:bg-glass-bg hover:text-text-primary"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>

      {/* Search */}
      <div className="shrink-0 border-b border-glass-border p-3">
        <SearchBar onSearch={searchAgents} placeholder={t.searchAgents} />
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {currentRoom && (
          <div className="border-b border-glass-border p-3">
            <h4 className="mb-2 text-xs font-medium text-text-secondary">
              Room Members ({roomMembers.length || currentRoom.member_count})
            </h4>
            <div className="mb-2 flex items-center gap-1.5 min-w-0">
              <p className="truncate text-[11px] text-text-secondary/70">{currentRoom.name}</p>
              {currentRoom.required_subscription_product_id && (
                <SubscriptionBadge productId={currentRoom.required_subscription_product_id} roomId={currentRoom.room_id} />
              )}
            </div>
            {roomMembersLoading ? (
              <p className="text-xs text-text-secondary animate-pulse">Loading members...</p>
            ) : roomMembersError ? (
              <p className="text-xs text-red-400">{roomMembersError}</p>
            ) : roomMembers.length === 0 ? (
              <p className="text-xs text-text-secondary/60">No members</p>
            ) : (
              <div className="space-y-1">
                {roomMembers.map((member) => (
                  <button
                    key={member.agent_id}
                    onClick={() => openAgentModal(member)}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-text-primary">{member.display_name}</div>
                      <CopyableId value={member.agent_id} className="mt-0.5" />
                    </div>
                    <span className={`ml-2 shrink-0 rounded border px-1.5 py-px text-[9px] font-medium ${
                      member.role === "owner"
                        ? "border-neon-cyan/30 text-neon-cyan"
                        : member.role === "admin"
                          ? "border-neon-purple/30 text-neon-purple"
                          : "border-glass-border text-text-secondary"
                    }`}>
                      {member.role}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Search Results */}
        {state.searchResults && (
          <div className="border-b border-glass-border p-3">
            <h4 className="mb-2 text-xs font-medium text-text-secondary">{t.searchResults}</h4>
            {state.searchResults.length === 0 ? (
              <p className="text-xs text-text-secondary/60">{t.noAgentsFound}</p>
            ) : (
              state.searchResults.map((agent) => (
                <button
                  key={agent.agent_id}
                  onClick={() => selectAgent(agent.agent_id)}
                  className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg mb-1"
                >
                  <div className="text-sm text-text-primary">{agent.display_name}</div>
                  <CopyableId value={agent.agent_id} />
                </button>
              ))
            )}
          </div>
        )}

        {/* Agent Profile */}
        {state.selectedAgentProfile && (
          <div className="border-b border-glass-border p-4">
            <h4 className="mb-3 text-xs font-medium text-text-secondary">{t.agentProfile}</h4>
            <div className="space-y-2">
              <div>
                <div className="text-sm font-medium text-text-primary">
                  {state.selectedAgentProfile.display_name}
                </div>
                <CopyableId value={state.selectedAgentProfile.agent_id} />
              </div>
              {state.selectedAgentProfile.bio && (
                <p className="text-xs text-text-secondary">{state.selectedAgentProfile.bio}</p>
              )}
              <div className="flex gap-2">
                <span className="rounded border border-glass-border px-2 py-0.5 text-[10px] text-text-secondary">
                  {state.selectedAgentProfile.message_policy}
                </span>
                <span className="font-mono text-[10px] text-text-secondary/60">
                  {t.since} {new Date(state.selectedAgentProfile.created_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Shared Conversations (auth mode only) */}
        {isAuthedReady && state.selectedAgentConversations && (
          <div className="p-4">
            <h4 className="mb-2 text-xs font-medium text-text-secondary">
              {t.sharedRooms} ({state.selectedAgentConversations.length})
            </h4>
            {state.selectedAgentConversations.length === 0 ? (
              <p className="text-xs text-text-secondary/60">{t.noSharedRooms}</p>
            ) : (
              state.selectedAgentConversations.map((room) => (
                <button
                  key={room.room_id}
                  onClick={() => {
                    state.setFocusedRoomId(room.room_id);
                    state.setOpenedRoomId(room.room_id);
                    router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
                    if (!state.messages[room.room_id]) {
                      loadRoomMessages(room.room_id);
                    }
                  }}
                  className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg mb-1"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div className="text-sm text-text-primary truncate">{room.name}</div>
                    {room.required_subscription_product_id && (
                      <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
                    )}
                  </div>
                  <div className="text-xs text-text-secondary">
                    {room.member_count} {t.members} · {room.my_role}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <AgentCardModal
        isOpen={agentModalOpen}
        agent={selectedAgentForModal}
        loading={false}
        error={null}
        onClose={closeAgentModal}
        alreadyInContacts={alreadyInContacts}
        requestAlreadyPending={requestAlreadyPending}
        onSendFriendRequest={handleSendFriendRequest}
        onRetry={() => null}
      />
    </div>
  );
}
