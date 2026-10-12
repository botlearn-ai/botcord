"use client";

/**
 * [INPUT]: 依赖 ui/chat/session/subscription store 的会话/联系人/订阅状态，依赖 api 层拉取成员与 agent 详情
 * [OUTPUT]: 对外提供右侧 agent 浏览器、成员点击后卡片入口与成员面板底部的退出/退订动作
 * [POS]: dashboard 右侧信息面板，连接成员列表、搜索结果与 agent 详情弹层
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
import { memo, useEffect, useState } from "react";
import SubscriptionBadge from "./SubscriptionBadge";
import { useLanguage } from '@/lib/i18n';
import { agentBrowser } from '@/lib/i18n/translations/dashboard';
import SearchBar from "./SearchBar";
import CopyableId from "@/components/ui/CopyableId";
import { MobileBotCordLoading } from "@/components/ui/BotCordLoader";
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { api, humansApi } from "@/lib/api";
import type { PublicRoomMember } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { usePresenceStore } from "@/store/usePresenceStore";
import { PresenceDot } from "./PresenceDot";
import JoinRequestsPanel from "./JoinRequestsPanel";
import MemberActionsMenu from "./MemberActionsMenu";
import AddRoomMemberModal from "./AddRoomMemberModal";
import TransferOwnershipDialog from "./TransferOwnershipDialog";
import { roomList as roomListI18n } from "@/lib/i18n/translations/dashboard";

export default memo(AgentBrowser);

function AgentBrowser() {
  const router = useRouter();
  const locale = useLanguage();
  const t = agentBrowser[locale];
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const activeIdentity = useDashboardSessionStore((state) => state.activeIdentity);
  const humanId = useDashboardSessionStore((state) => state.human?.human_id ?? null);
  const {
    focusedRoomId,
    toggleRightPanel,
    setFocusedRoomId,
    setOpenedRoomId,
    setMessagesPane,
  } = useDashboardUIStore(useShallow((state) => ({
    focusedRoomId: state.focusedRoomId,
    toggleRightPanel: state.toggleRightPanel,
    setFocusedRoomId: state.setFocusedRoomId,
    setOpenedRoomId: state.setOpenedRoomId,
    setMessagesPane: state.setMessagesPane,
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
    refreshOverview,
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
    refreshOverview: state.refreshOverview,
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
  const [memberRefetchTick, setMemberRefetchTick] = useState(0);
  const [mutingRoom, setMutingRoom] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const refetchMembers = () => setMemberRefetchTick((t) => t + 1);
  const [roomMembersError, setRoomMembersError] = useState<string | null>(null);
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [cancellingSubscriptionId, setCancellingSubscriptionId] = useState<string | null>(null);
  const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
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
  }, [focusedRoomId, memberRefetchTick]);

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
      router.push("/chats/messages");
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
    setMessagesPane("room");
    setFocusedRoomId(roomId);
    setOpenedRoomId(roomId);
    router.push("/chats/messages");
    if (!messages[roomId]) {
      void loadRoomMessages(roomId);
    }
  };

  return (
    <div className="liquid-panel flex h-full min-h-0 w-[320px] min-w-[320px] flex-col border-l border-glass-border">
      {/* Header */}
      <div className="liquid-toolbar shrink-0 flex min-h-14 items-center justify-between border-b border-glass-border px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">{t.agents}</h3>
        <IconButton label="Close" size="sm"
          onClick={() => toggleRightPanel()}

        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </IconButton>
      </div>

      {/* Search */}
      <div className="shrink-0 border-b border-glass-border p-3">
        <SearchBar onSearch={searchAgents} placeholder={t.searchAgents} />
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {currentRoom && (
          <div className="border-b border-glass-border p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h4 className="text-xs font-medium text-text-secondary">
                {t.roomMembers} ({roomMembers.length || currentRoom.member_count})
              </h4>
              {activeIdentity?.type === "human" && joinedRoom && (joinedRoom.my_role === "owner" || joinedRoom.my_role === "admin") ? (
                <Button variant="secondary" size="sm"
                  onClick={() => setAddMemberModalOpen(true)}

                >
                  {t.addMembersEntry}
                </Button>
              ) : null}
            </div>
            <div className="mb-2 flex items-center gap-1.5 min-w-0">
              <p className="truncate text-xs text-text-secondary">{currentRoom.name}</p>
              {currentRoom.required_subscription_product_id && (
                <SubscriptionBadge productId={currentRoom.required_subscription_product_id} roomId={currentRoom.room_id} />
              )}
            </div>
            {roomMembersLoading ? (
              <MobileBotCordLoading
                label={t.loadingMembers}
                className="justify-start"
                textClassName="text-xs text-text-secondary animate-pulse"
              />
            ) : roomMembersError ? (
              <p className="text-xs text-danger">{roomMembersError}</p>
            ) : roomMembers.length === 0 ? (
              <p className="text-xs text-text-secondary">{t.noMembers}</p>
            ) : (
              <div className="space-y-1">
                {roomMembers.map((member) => {
                  const ptype: "human" | "agent" = member.participant_type
                    ?? (member.agent_id.startsWith("hu_") ? "human" : "agent");
                  const isHumanViewer = activeIdentity?.type === "human";
                  const viewerIsModerator = joinedRoom?.my_role === "owner" || joinedRoom?.my_role === "admin";
                  const isSelf = isHumanViewer ? member.agent_id === humanId : false;
                  return (
                    <Card padding="sm"
                      key={member.agent_id}
                      className="flex items-center justify-between"
                    >
                      <Button variant="row"
                        onClick={() => selectAgent(member.agent_id)}
                        className="min-w-0 flex-1"
                      >
                        <div className="flex items-center gap-1.5 truncate text-xs font-medium text-text-primary">
                          <PresenceDot agentId={member.agent_id} fallback={member.online} size="xs" />
                          <span className="truncate">{member.display_name}</span>
                          <Badge tone="success"
                            title={ptype === "human" ? t.participantHuman : t.participantAgent}

                          >
                            {ptype === "human" ? "H" : "A"}
                          </Badge>
                        </div>
                      </Button>
                      <CopyableId value={member.agent_id} className="mt-0.5" />
                      <Badge tone="accent" >
                        {member.role}
                      </Badge>
                      {isHumanViewer && viewerIsModerator && !isSelf && currentRoom?.room_id && (
                        <MemberActionsMenu
                          roomId={currentRoom.room_id}
                          member={member}
                          viewerRole={joinedRoom?.my_role ?? "member"}
                          onMutated={refetchMembers}
                          onError={(msg) => setRoomActionError(msg)}
                        />
                      )}
                    </Card>
                  );
                })}
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
                  <Alert tone="danger" className="mb-2">
                    {roomActionError}
                  </Alert>
                ) : null}
                <div className="flex flex-col gap-2">
                  <Button variant="danger" size="sm"
                    onClick={() => void handleLeaveRoom()}
                    disabled={joinedRoom.my_role === "owner" || isLeavingCurrentRoom}
                    className="w-full disabled:cursor-not-allowed disabled:opacity-45"
                    title={joinedRoom.my_role === "owner" ? t.ownerCannotLeave : t.leaveRoom}
                  >
                    {isLeavingCurrentRoom ? t.leavingRoom : t.leaveRoom}
                  </Button>
                  {activeSubscription ? (
                    <Button variant="secondary" size="sm"
                      onClick={() => void handleCancelSubscription()}
                      disabled={cancellingSubscriptionId === activeSubscription.subscription_id}
                      className="w-full disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {cancellingSubscriptionId === activeSubscription.subscription_id
                        ? t.cancellingSubscription
                        : t.cancelSubscription}
                    </Button>
                  ) : null}
                  {activeIdentity?.type === "human" && currentRoom?.room_id && (() => {
                    const selfRow = roomMembers.find((m) => m.agent_id === humanId);
                    const isMuted = Boolean((selfRow as any)?.muted);
                    return (
                      <Button variant="secondary" size="sm"
                        onClick={async () => {
                          if (mutingRoom || !currentRoom.room_id) return;
                          setMutingRoom(true);
                          setRoomActionError(null);
                          try {
                            await humansApi.setRoomMute(currentRoom.room_id, !isMuted);
                            refetchMembers();
                          } catch (err: any) {
                            setRoomActionError(err?.message || t.muteFailed);
                          } finally {
                            setMutingRoom(false);
                          }
                        }}
                        disabled={mutingRoom}
                        className="w-full disabled:opacity-50"
                      >
                        {isMuted ? t.unmuteRoom : t.muteRoom}
                      </Button>
                    );
                  })()}
                  {activeIdentity?.type === "human" && joinedRoom.my_role === "owner" && currentRoom?.room_id && (
                    <Button variant="secondary" size="sm"
                      onClick={() => {
                        setRoomActionError(null);
                        setTransferDialogOpen(true);
                      }}
                      className="w-full"
                    >
                      {t.transferOwnership}
                    </Button>
                  )}
                </div>
                {joinedRoom.my_role === "owner" ? (
                  <p className="mt-2 text-xs leading-5 text-text-secondary">
                    {t.ownerCannotLeave}
                  </p>
                ) : null}
              </div>
            )}
            {transferDialogOpen && currentRoom?.room_id && humanId && (
              <TransferOwnershipDialog
                roomId={currentRoom.room_id}
                roomName={currentRoom.name}
                viewerHumanId={humanId}
                members={roomMembers}
                onClose={() => setTransferDialogOpen(false)}
                onSuccess={refetchMembers}
                onError={(msg) => setRoomActionError(msg)}
              />
            )}
            {addMemberModalOpen && currentRoom?.room_id ? (
              <AddRoomMemberModal
                roomId={currentRoom.room_id}
                existingMemberIds={roomMembers.map((member) => member.agent_id)}
                onClose={() => setAddMemberModalOpen(false)}
                onAdded={async () => {
                  await refreshOverview().catch(() => {});
                  refetchMembers();
                }}
              />
            ) : null}
          </div>
        )}

        {/* Search Results */}
        {searchResults && (
          <div className="border-b border-glass-border p-3">
            <h4 className="mb-2 text-xs font-medium text-text-secondary">{t.searchResults}</h4>
            {searchResults.length === 0 ? (
              <p className="text-xs text-text-secondary">{t.noAgentsFound}</p>
            ) : (
              searchResults.map((agent) => (
                <Card padding="sm"
                  key={agent.agent_id}
                  className="mb-1"
                >
                  <Button variant="row"
                    onClick={() => selectAgent(agent.agent_id)}
                    className="w-full"
                  >
                    <div className="flex items-center gap-2 text-sm text-text-primary">
                      <PresenceDot agentId={agent.agent_id} fallback={agent.online} />
                      <span>{agent.display_name}</span>
                    </div>
                  </Button>
                  <CopyableId value={agent.agent_id} />
                </Card>
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
                <Badge tone="neutral" >
                  {selectedAgentProfile.message_policy}
                </Badge>
                <span className="font-mono text-xs text-text-secondary">
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
              <p className="text-xs text-text-secondary">{t.noSharedRooms}</p>
            ) : (
              selectedAgentConversations.map((room) => (
                <Card padding="sm"
                  key={room.room_id}
                  className="mb-1"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Button variant="row"
                      onClick={() => openRoomConversation(room.room_id)}
                      className="min-w-0 flex-1"
                    >
                      <div className="truncate text-sm text-text-primary">{room.name}</div>
                    </Button>
                    {room.required_subscription_product_id && (
                      <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
                    )}
                  </div>
                  <div className="text-xs text-text-secondary">
                    {room.member_count} {t.members} · {room.my_role}
                  </div>
                </Card>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
