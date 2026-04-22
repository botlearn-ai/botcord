"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { DashboardMessage, PublicRoomMember } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import MessageComposer, { type MentionCandidate } from "./MessageComposer";

interface RoomHumanComposerProps {
  roomId: string;
}

export default function RoomHumanComposer({ roomId }: RoomHumanComposerProps) {
  const user = useDashboardSessionStore((s) => s.user);
  const activeAgentId = useDashboardSessionStore((s) => s.activeAgentId);
  const insertMessage = useDashboardChatStore((s) => s.insertMessage);
  const loadRoomMessages = useDashboardChatStore((s) => s.loadRoomMessages);

  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<PublicRoomMember[]>([]);

  const displayName = user?.display_name || "You";
  const isOwnerChat = roomId.startsWith("rm_oc_");

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
    return members
      .filter((m) => m.agent_id !== activeAgentId)
      .map((m) => ({ agent_id: m.agent_id, display_name: m.display_name }));
  }, [members, activeAgentId, isOwnerChat]);

  const handleSend = useCallback(async (text: string, _files: File[], mentions?: string[]) => {
    if (!text || !activeAgentId) return;

    const clientTempId = `tmp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const optimistic: DashboardMessage = {
      hub_msg_id: clientTempId,
      msg_id: clientTempId,
      sender_id: activeAgentId,
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
  }, [activeAgentId, displayName, user?.id, roomId, insertMessage, loadRoomMessages]);

  return (
    <div className="flex flex-col gap-1">
      <MessageComposer
        onSend={handleSend}
        placeholder={`Message as ${displayName}...`}
        mentionCandidates={mentionCandidates}
      />
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
