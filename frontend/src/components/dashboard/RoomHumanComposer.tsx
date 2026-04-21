"use client";

import { useCallback, useRef, useState } from "react";
import { Send, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { DashboardMessage } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

interface RoomHumanComposerProps {
  roomId: string;
}

export default function RoomHumanComposer({ roomId }: RoomHumanComposerProps) {
  const user = useDashboardSessionStore((s) => s.user);
  const activeAgentId = useDashboardSessionStore((s) => s.activeAgentId);
  const insertMessage = useDashboardChatStore((s) => s.insertMessage);
  const loadRoomMessages = useDashboardChatStore((s) => s.loadRoomMessages);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const displayName = user?.display_name || "You";

  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const body = text.trim();
    if (!body || sending || !activeAgentId) return;

    const clientTempId = `tmp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const optimistic: DashboardMessage = {
      hub_msg_id: clientTempId,
      msg_id: clientTempId,
      sender_id: activeAgentId,
      sender_name: displayName,
      type: "message",
      text: body,
      payload: { text: body },
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
    setText("");
    setError(null);
    setSending(true);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }

    try {
      await api.sendRoomHumanMessage(roomId, body);
      await loadRoomMessages(roomId);
    } catch (err: any) {
      setError(err?.message || "Failed to send");
    } finally {
      setSending(false);
    }
  }, [text, sending, activeAgentId, displayName, user?.id, roomId, insertMessage, loadRoomMessages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => { setText(e.target.value); autoResize(); }}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={`Message as ${displayName}...`}
          className="flex-1 resize-none rounded-lg border border-glass-border bg-deep-black-light px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 focus:outline-none focus:border-neon-cyan/50"
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!text.trim() || sending}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Send message"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
      {error && (
        <p className="text-[11px] text-red-400">{error}</p>
      )}
    </div>
  );
}
