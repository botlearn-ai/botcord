"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage, chatPane } from "@/lib/i18n";
import type { DashboardMessage, PublicRoomMember } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useShallow } from "zustand/react/shallow";
import MessageComposer from "./MessageComposer";
import { useMentionCandidates } from "@/hooks/useMentionCandidates";

interface RoomHumanComposerProps {
  roomId: string;
}

export default function RoomHumanComposer({ roomId }: RoomHumanComposerProps) {
  const locale = useLanguage();
  const { user, activeAgentId, ownedAgents, human, viewMode } = useDashboardSessionStore(useShallow((s) => ({
    user: s.user,
    activeAgentId: s.activeAgentId,
    ownedAgents: s.ownedAgents,
    human: s.human,
    viewMode: s.viewMode,
  })));
  const { insertMessage, loadRoomMessages, refreshOverview } = useDashboardChatStore(useShallow((s) => ({
    insertMessage: s.insertMessage,
    loadRoomMessages: s.loadRoomMessages,
    refreshOverview: s.refreshOverview,
  })));
  const hasRoomInOverview = useDashboardChatStore(
    (s) => Boolean(s.overview?.rooms.some((r) => r.room_id === roomId)),
  );
  const refreshHumanRooms = useDashboardSessionStore((s) => s.refreshHumanRooms);
  const hasRoomInHumanRooms = useDashboardSessionStore(
    (s) => s.humanRooms.some((r) => r.room_id === roomId),
  );

  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<PublicRoomMember[]>([]);

  const displayName = user?.display_name || "You";
  const isOwnerChat = roomId.startsWith("rm_oc_");
  const isDirectMessage = roomId.startsWith("rm_dm_");
  const allowAllMention = !isOwnerChat && !isDirectMessage;
  const activeAgent = activeAgentId
    ? ownedAgents.find((a) => a.agent_id === activeAgentId) ?? null
    : null;
  const placeholder = (viewMode === "agent" && activeAgent)
    ? locale === "zh"
      ? `替我的 Agent · ${activeAgent.display_name} 发言，@ 可引用成员或群…`
      : `Speak as Agent · ${activeAgent.display_name}… (@ to mention)`
    : locale === "zh"
      ? `作为 ${displayName} 发言，@ 可引用成员或群…`
      : `Message as ${displayName}… (@ to mention)`;
  const senderId = human?.human_id ?? activeAgentId ?? "pending";
  const isObserverMode = viewMode === "agent";

  useEffect(() => {
    if (isOwnerChat) { setMembers([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getRoomMembers(roomId);
        if (!cancelled) setMembers(res.members);
      } catch {
        if (!cancelled) setMembers([]);
      }
    })();
    return () => { cancelled = true; };
  }, [roomId, isOwnerChat]);

  const selfId = viewMode === "agent" ? activeAgentId : human?.human_id;

  const mentionCandidates = useMentionCandidates({
    currentRoomId: roomId,
    includeAll: allowAllMention,
    roomMembers: members,
    selfId,
  });

  const sendDenied = !isOwnerChat && !!selfId &&
    members.find((m) => m.agent_id === selfId)?.can_send === false;

  const handleSend = useCallback(async (text: string, _files: File[], mentions?: string[]) => {
    if (!text) return;

    const clientTempId = `tmp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const optimistic: DashboardMessage = {
      hub_msg_id: clientTempId,
      msg_id: clientTempId,
      sender_id: senderId,
      sender_name: displayName,
      type: "message",
      text,
      payload: { text },
      room_id: roomId,
      topic: null,
      topic_id: null,
      goal: null,
      state: "queued",
      state_counts: null,
      created_at: now,
      source_type: "dashboard_human_room",
      sender_kind: "human",
      display_sender_name: displayName,
      source_user_id: user?.id ?? null,
      source_user_name: displayName,
      is_mine: true,
    };

    insertMessage(roomId, optimistic);
    setError(null);

    try {
      await api.sendRoomHumanMessage(roomId, text, mentions);
      await loadRoomMessages(roomId);
      // First send into a brand-new DM room (auto-created server-side) won't
      // show up in the sidebar until overview/humanRooms is re-fetched.
      if (roomId.startsWith("rm_dm_")) {
        if (viewMode === "human") {
          if (!hasRoomInHumanRooms) void refreshHumanRooms();
        } else if (!hasRoomInOverview) {
          void refreshOverview();
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send");
    }
  }, [senderId, displayName, user?.id, roomId, viewMode, insertMessage, loadRoomMessages, refreshOverview, refreshHumanRooms, hasRoomInOverview, hasRoomInHumanRooms]);

  if (sendDenied) {
    return (
      <p className="text-center text-xs text-text-secondary/50">
        {chatPane[locale].memberSendDenied}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {isObserverMode && activeAgentId && (
        <p className="text-[10px] text-text-secondary/60 px-1">
          {locale === "zh"
            ? `代 ${activeAgentId} 发言（以你的 Human 身份）`
            : `Speaking on behalf of ${activeAgentId} (as you, the Human)`}
        </p>
      )}
      <MessageComposer
        onSend={handleSend}
        placeholder={placeholder}
        mentionCandidates={mentionCandidates}
      />
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
