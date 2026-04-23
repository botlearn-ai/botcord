"use client";

import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import type { DashboardMessage } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import MessageComposer from "./MessageComposer";

interface RoomHumanComposerProps {
  roomId: string;
}

export default function RoomHumanComposer({ roomId }: RoomHumanComposerProps) {
  const user = useDashboardSessionStore((s) => s.user);
  const activeAgentId = useDashboardSessionStore((s) => s.activeAgentId);
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const insertMessage = useDashboardChatStore((s) => s.insertMessage);
  const loadRoomMessages = useDashboardChatStore((s) => s.loadRoomMessages);
  const locale = useLanguage();

  const [error, setError] = useState<string | null>(null);

  const displayName = user?.display_name || "You";
  const activeAgent = activeAgentId
    ? ownedAgents.find((a) => a.agent_id === activeAgentId) ?? null
    : null;
  const placeholder = activeAgent
    ? locale === "zh"
      ? `替我的 Agent · ${activeAgent.display_name} 发言…`
      : `Speak on behalf of Agent · ${activeAgent.display_name}…`
    : locale === "zh"
      ? `作为 ${displayName} 发言…`
      : `Message as ${displayName}…`;

  const handleSend = useCallback(async (text: string) => {
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
      await api.sendRoomHumanMessage(roomId, text);
      await loadRoomMessages(roomId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send");
    }
  }, [activeAgentId, displayName, user?.id, roomId, insertMessage, loadRoomMessages]);

  return (
    <div className="flex flex-col gap-1">
      <MessageComposer
        onSend={handleSend}
        placeholder={placeholder}
      />
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
