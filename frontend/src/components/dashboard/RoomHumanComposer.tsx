"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import type { DashboardMessage, PublicRoomMember } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useShallow } from "zustand/react/shallow";
import MessageComposer, { type MentionCandidate } from "./MessageComposer";

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
  const insertMessage = useDashboardChatStore((s) => s.insertMessage);
  const loadRoomMessages = useDashboardChatStore((s) => s.loadRoomMessages);

  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<PublicRoomMember[]>([]);

  const displayName = user?.display_name || "You";
  const isOwnerChat = roomId.startsWith("rm_oc_");
  const activeAgent = activeAgentId
    ? ownedAgents.find((a) => a.agent_id === activeAgentId) ?? null
    : null;
  const placeholder = (viewMode === "agent" && activeAgent)
    ? locale === "zh"
      ? `替我的 Agent · ${activeAgent.display_name} 发言…`
      : `Speak on behalf of Agent · ${activeAgent.display_name}…`
    : locale === "zh"
      ? `作为 ${displayName} 发言…`
      : `Message as ${displayName}…`;
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

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (isOwnerChat) return [];
    const selfId = viewMode === "agent" ? activeAgentId : human?.human_id;
    return members
      .filter((m) => m.agent_id !== selfId)
      .map((m) => ({ agent_id: m.agent_id, display_name: m.display_name }));
  }, [members, activeAgentId, human?.human_id, viewMode, isOwnerChat]);

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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send");
    }
  }, [senderId, displayName, user?.id, roomId, insertMessage, loadRoomMessages]);

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
