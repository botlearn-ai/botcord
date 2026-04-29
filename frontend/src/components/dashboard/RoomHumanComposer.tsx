"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage, chatPane } from "@/lib/i18n";
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
  const { insertMessage, loadRoomMessages, overview } = useDashboardChatStore(useShallow((s) => ({
    insertMessage: s.insertMessage,
    loadRoomMessages: s.loadRoomMessages,
    overview: s.overview,
  })));

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

  const selfId = viewMode === "agent" ? activeAgentId : human?.human_id;

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (!allowAllMention) return [];
    const candidates: MentionCandidate[] = [{ agent_id: "@all", display_name: "all" }];
    // 1. own agents
    for (const a of ownedAgents) {
      if (a.agent_id !== selfId) {
        candidates.push({ agent_id: a.agent_id, display_name: a.display_name, id: a.agent_id });
      }
    }
    // 2. contacts (people first, before rooms)
    for (const c of overview?.contacts ?? []) {
      candidates.push({ agent_id: c.contact_agent_id, display_name: c.alias || c.display_name, id: c.contact_agent_id });
    }
    // 3. human members in this room not already in contacts
    const seen = new Set(candidates.map((c) => c.agent_id));
    for (const m of members) {
      if (!seen.has(m.agent_id) && m.agent_id !== selfId &&
          (m.agent_id.startsWith("ag_") || m.agent_id.startsWith("hu_"))) {
        candidates.push({ agent_id: m.agent_id, display_name: m.display_name, id: m.agent_id });
        seen.add(m.agent_id);
      }
    }
    // 4. rooms (last, less commonly @-mentioned than people)
    for (const r of overview?.rooms ?? []) {
      if (r.room_id !== roomId && !r.room_id.startsWith("rm_oc_")) {
        candidates.push({ agent_id: r.room_id, display_name: r.name, id: r.room_id });
      }
    }
    return candidates;
  }, [allowAllMention, ownedAgents, overview, selfId, roomId, members]);

  const sendDenied = useMemo(() => {
    if (isOwnerChat || !selfId) return false;
    const self = members.find((m) => m.agent_id === selfId);
    return self?.can_send === false;
  }, [members, selfId, isOwnerChat]);

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
