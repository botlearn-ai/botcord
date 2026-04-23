"use client";

/**
 * [INPUT]: 依赖 ui/chat/session/subscription store 的会话/联系人/订阅状态，依赖 api 层拉取成员与 agent 详情
 * [OUTPUT]: 对外提供右侧 agent 浏览器、成员点击后卡片入口与成员面板底部的退出/退订动作
 * [POS]: dashboard 右侧信息面板，连接成员列表、搜索结果与 agent 详情弹层
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useState } from "react";
import SubscriptionBadge from "./SubscriptionBadge";
import { useLanguage } from '@/lib/i18n';
import { agentBrowser } from '@/lib/i18n/translations/dashboard';
import SearchBar from "./SearchBar";
import CopyableId from "@/components/ui/CopyableId";
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { api } from "@/lib/api";
import type { PublicRoomMember } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { usePresenceStore } from "@/store/usePresenceStore";
import { PresenceDot } from "./PresenceDot";
import JoinRequestsPanel from "./JoinRequestsPanel";
import { roomList as roomListI18n } from "@/lib/i18n/translations/dashboard";

export default function AgentBrowser() {
  const router = useRouter();
  const locale = useLanguage();
  const t = agentBrowser[locale];
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const {
    focusedRoomId,
    toggleRightPanel,
    setFocusedRoomId,
    setOpenedRoomId,
  } = useDashboardUIStore(useShallow((state) => ({
    focusedRoomId: state.focusedRoomId,
    toggleRightPanel: state.toggleRightPanel,
    setFocusedRoomId: state.setFocusedRoomId,
    setOpenedRoomId: state.setOpenedRoomId,
  })));
  const {
    messages,
    overview,
    searchResults,
    selectedAgentProfile,
    selectedAgentConversations,
    getRoomSummary,
    searchAgents,
    selectAgent,
    loadRoomMessages,
    leaveRoom,
    leavingRoomId,
  } = useDashboardChatStore(useShallow((state) => ({
    messages: state.messages,
    overview: state.overview,
    searchResults: state.searchResults,
    selectedAgentProfile: state.selectedAgentProfile,
    selectedAgentConversations: state.selectedAgentConversations,
    getRoomSummary: state.getRoomSummary,
    searchAgents: state.searchAgents,
    selectAgent: state.selectAgent,
    loadRoomMessages: state.loadRoomMessages,
    leaveRoom: state.leaveRoom,
    leavingRoomId: state.leavingRoomId,
  })));
  const {
    getActiveSubscription,
    ensureSubscriptions,
    cancelSubscription,
  } = useDashboardSubscriptionStore(useShallow((state) => ({
    getActiveSubscription: state.getActiveSubscription,
    ensureSubscriptions: state.ensureSubscriptions,
    cancelSubscription: state.cancelSubscription,
  })));
  const [roomMembers, setRoomMembers] = useState<PublicRoomMember[]>([]);
  const [roomMembersLoading, setRoomMembersLoading] = useState(false);
  const [roomMembersError, setRoomMembersError] = useState<string | null>(null);
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [cancellingSubscriptionId, setCancellingSubscriptionId] = useState<string | null>(null);
  const isAuthedReady = sessionMode === "authed-ready";

  const currentRoom = focusedRoomId ? getRoomSummary(focusedRoomId) : null;
  const joinedRoom = overview?.rooms.find((room) => room.room_id === focusedRoomId) || null;
  const activeSubscription = currentRoom?.required_subscription_product_id
    ? getActiveSubscription(currentRoom.required_subscription_product_id)
    : null;
  const isLeavingCurrentRoom = leavingRoomId === currentRoom?.room_id;

  useEffect(() => {
    if (!focusedRoomId) {
      setRoomMembers([]);
      setRoomMembersError(null);
      setRoomMembersLoading(false);
      return;
    }
    let cancelled = false;
    setRoomMembersLoading(true);
    setRoomMembersError(null);
    api.getRoomMembers(focusedRoomId)
      .catch(() => api.getPublicRoomMembers(focusedRoomId))
      .then((result) => {
        if (cancelled) return;
        setRoomMembers(result.members);
        usePresenceStore.getState().seed(
          result.members.map((m) => ({ agentId: m.agent_id, online: Boolean(m.online) })),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setRoomMembers([]);
        setRoomMembersError(t.loadMembersFailed);
      })
      .finally(() => {
        if (cancelled) return;
        setRoomMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [focusedRoomId]);

  useEffect(() => {
    if (!isAuthedReady || !currentRoom?.required_subscription_product_id) {
      return;
    }
    void ensureSubscriptions().catch(() => {});
  }, [currentRoom?.required_subscription_product_id, ensureSubscriptions, isAuthedReady]);

  const handleLeaveRoom = async () => {
    if (!currentRoom?.room_id) return;
    setRoomActionError(null);
    try {
      await leaveRoom(currentRoom.room_id);
    } catch (err: any) {
      setRoomActionError(err?.message || t.leaveRoomFailed);
    }
  };

  const handleCancelSubscription = async () => {
    if (!activeSubscription?.subscription_id) return;
    setRoomActionError(null);
    setCancellingSubscriptionId(activeSubscription.subscription_id);
    try {
      await cancelSubscription(activeSubscription.subscription_id);
    } catch (err: any) {
      setRoomActionError(err?.message || t.cancelSubscriptionFailed);
    } finally {
      setCancellingSubscriptionId(null);
    }
  };

  const openRoomConversation = (roomId: string) => {
    setFocusedRoomId(roomId);
    setOpenedRoomId(roomId);
    router.push(`/chats/messages/${encodeURIComponent(roomId)}`);
    if (!messages[roomId]) {
      void loadRoomMessages(roomId);
    }
  };

  return (
    <div className="flex h-full min-h-0 w-[320px] min-w-[320px] flex-col border-l border-glass-border bg-deep-black-light">
      {/* Header */}
      <div className="shrink-0 flex min-h-14 items-center justify-between border-b border-glass-border px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">{t.agents}</h3>
        <button
          onClick={() => toggleRightPanel()}
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
              {t.roomMembers} ({roomMembers.length || currentRoom.member_count})
            </h4>
            <div className="mb-2 flex items-center gap-1.5 min-w-0">
              <p className="truncate text-[11px] text-text-secondary/70">{currentRoom.name}</p>
              {currentRoom.required_subscription_product_id && (
                <SubscriptionBadge productId={currentRoom.required_subscription_product_id} roomId={currentRoom.room_id} />
              )}
            </div>
            {roomMembersLoading ? (
              <p className="text-xs text-text-secondary animate-pulse">{t.loadingMembers}</p>
            ) : roomMembersError ? (
              <p className="text-xs text-red-400">{roomMembersError}</p>
            ) : roomMembers.length === 0 ? (
              <p className="text-xs text-text-secondary/60">{t.noMembers}</p>
            ) : (
              <div className="space-y-1">
                {roomMembers.map((member) => (
                  <div
                    key={member.agent_id}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 transition-colors hover:bg-glass-bg"
                  >
                    <button
                      onClick={() => selectAgent(member.agent_id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-1.5 truncate text-xs font-medium text-text-primary">
                        <PresenceDot agentId={member.agent_id} fallback={member.online} size="xs" />
                        <span className="truncate">{member.display_name}</span>
                      </div>
                    </button>
                    <CopyableId value={member.agent_id} className="mt-0.5" />
                    <span className={`ml-2 shrink-0 rounded border px-1.5 py-px text-[9px] font-medium ${
                      member.role === "owner"
                        ? "border-neon-cyan/30 text-neon-cyan"
                        : member.role === "admin"
                          ? "border-neon-purple/30 text-neon-purple"
                          : "border-glass-border text-text-secondary"
                    }`}>
                      {member.role}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {joinedRoom && (joinedRoom.my_role === "owner" || joinedRoom.my_role === "admin") && currentRoom?.join_policy === "invite_only" && (
              <div className="mt-3 border-t border-glass-border pt-3">
                <h4 className="mb-2 text-xs font-medium text-text-secondary">
                  {roomListI18n[locale].joinRequests}
                </h4>
                <JoinRequestsPanel roomId={currentRoom.room_id} />
              </div>
            )}
            {joinedRoom && (
              <div className="mt-3 border-t border-glass-border pt-3">
                {roomActionError ? (
                  <p className="mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-400">
                    {roomActionError}
                  </p>
                ) : null}
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => void handleLeaveRoom()}
                    disabled={joinedRoom.my_role === "owner" || isLeavingCurrentRoom}
                    className="w-full rounded border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-45"
                    title={joinedRoom.my_role === "owner" ? t.ownerCannotLeave : t.leaveRoom}
                  >
                    {isLeavingCurrentRoom ? t.leavingRoom : t.leaveRoom}
                  </button>
                  {activeSubscription ? (
                    <button
                      onClick={() => void handleCancelSubscription()}
                      disabled={cancellingSubscriptionId === activeSubscription.subscription_id}
                      className="w-full rounded border border-yellow-500/35 bg-yellow-500/10 px-3 py-2 text-xs font-medium text-yellow-300 transition-colors hover:bg-yellow-500/15 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {cancellingSubscriptionId === activeSubscription.subscription_id
                        ? t.cancellingSubscription
                        : t.cancelSubscription}
                    </button>
                  ) : null}
                </div>
                {joinedRoom.my_role === "owner" ? (
                  <p className="mt-2 text-[11px] leading-5 text-text-secondary/70">
                    {t.ownerCannotLeave}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* Search Results */}
        {searchResults && (
          <div className="border-b border-glass-border p-3">
            <h4 className="mb-2 text-xs font-medium text-text-secondary">{t.searchResults}</h4>
            {searchResults.length === 0 ? (
              <p className="text-xs text-text-secondary/60">{t.noAgentsFound}</p>
            ) : (
              searchResults.map((agent) => (
                <div
                  key={agent.agent_id}
                  className="mb-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-glass-bg"
                >
                  <button
                    onClick={() => selectAgent(agent.agent_id)}
                    className="w-full text-left"
                  >
                    <div className="flex items-center gap-2 text-sm text-text-primary">
                      <PresenceDot agentId={agent.agent_id} fallback={agent.online} />
                      <span>{agent.display_name}</span>
                    </div>
                  </button>
                  <CopyableId value={agent.agent_id} />
                </div>
              ))
            )}
          </div>
        )}

        {/* Agent Profile */}
        {selectedAgentProfile && (
          <div className="border-b border-glass-border p-4">
            <h4 className="mb-3 text-xs font-medium text-text-secondary">{t.agentProfile}</h4>
            <div className="space-y-2">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <PresenceDot agentId={selectedAgentProfile.agent_id} fallback={selectedAgentProfile.online} />
                  <span>{selectedAgentProfile.display_name}</span>
                </div>
                <CopyableId value={selectedAgentProfile.agent_id} />
              </div>
              {selectedAgentProfile.bio && (
                <p className="text-xs text-text-secondary">{selectedAgentProfile.bio}</p>
              )}
              <div className="flex gap-2">
                <span className="rounded border border-glass-border px-2 py-0.5 text-[10px] text-text-secondary">
                  {selectedAgentProfile.message_policy}
                </span>
                <span className="font-mono text-[10px] text-text-secondary/60">
                  {t.since} {new Date(selectedAgentProfile.created_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Shared Conversations (auth mode only) */}
        {isAuthedReady && selectedAgentConversations && (
          <div className="p-4">
            <h4 className="mb-2 text-xs font-medium text-text-secondary">
              {t.sharedRooms} ({selectedAgentConversations.length})
            </h4>
            {selectedAgentConversations.length === 0 ? (
              <p className="text-xs text-text-secondary/60">{t.noSharedRooms}</p>
            ) : (
              selectedAgentConversations.map((room) => (
                <div
                  key={room.room_id}
                  className="mb-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-glass-bg"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <button
                      onClick={() => openRoomConversation(room.room_id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-sm text-text-primary">{room.name}</div>
                    </button>
                    {room.required_subscription_product_id && (
                      <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
                    )}
                  </div>
                  <div className="text-xs text-text-secondary">
                    {room.member_count} {t.members} · {room.my_role}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
