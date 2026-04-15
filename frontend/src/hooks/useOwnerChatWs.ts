/**
 * Custom hook that manages the owner-chat WebSocket lifecycle
 * and routes all events to the unified useOwnerChatStore.
 */

import { useEffect, useRef } from "react";
import {
  createOwnerChatWs,
  type OwnerChatWsClient,
} from "@/lib/owner-chat-ws";
import { createClient } from "@/lib/supabase/client";
import { useOwnerChatStore } from "@/store/useOwnerChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import type { Attachment, OwnerChatMessage } from "@/lib/types";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

export interface UseOwnerChatWsOptions {
  activeAgentId: string | null;
  roomId: string | null;
  agentName: string;
}

export interface UseOwnerChatWsReturn {
  wsClientRef: React.RefObject<OwnerChatWsClient | null>;
  /** Set of trace_ids whose assistant text was already streamed (skip typewriter). */
  streamedTraceIds: React.RefObject<Set<string>>;
}

export function useOwnerChatWs({
  activeAgentId,
  roomId,
  agentName,
}: UseOwnerChatWsOptions): UseOwnerChatWsReturn {
  const wsClientRef = useRef<OwnerChatWsClient | null>(null);
  // Grace period: suppress stale typing events arriving shortly after an agent message.
  const lastAgentMsgRef = useRef<{ roomId: string; at: number } | null>(null);
  // Track trace_ids that received assistant stream blocks (text already shown to user)
  const streamedTraceIds = useRef<Set<string>>(new Set());

  const store = useOwnerChatStore;
  const { setUserChatRoomId } = useDashboardUIStore();

  useEffect(() => {
    if (!activeAgentId || !roomId) return;

    // Reset grace period when switching agents
    lastAgentMsgRef.current = null;

    const supabase = createClient();

    const wsClient = createOwnerChatWs({
      hubBaseUrl: HUB_BASE_URL,
      getToken: async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token || "";
      },
      agentId: activeAgentId,

      onAuthOk: (data) => {
        if (data.room_id && data.room_id !== roomId) {
          setUserChatRoomId(data.room_id);
          // Re-initialize the store for the corrected room
          store.getState().setRoom(data.room_id, agentName);
          void store.getState().loadInitial(data.room_id);
        }
      },

      onTyping: () => {
        const grace = lastAgentMsgRef.current;
        if (grace && grace.roomId === roomId && Date.now() - grace.at < 5_000) return;
        store.getState().setAgentTyping(true);
      },

      onMessage: (msg) => {
        const msgRoomId = msg.room_id || roomId;

        // Agent message with trace_id → finalize the streaming placeholder
        if (msg.sender === "agent" && msg.ext?.trace_id) {
          const traceId = msg.ext.trace_id as string;

          // Keep traceId in streamedTraceIds so the pane can skip typewriter
          // (it will be checked during render and cleaned up after animation skip)

          store.getState().finalizeStream(traceId, {
            hubMsgId: msg.hub_msg_id,
            text: msg.text,
            senderName: agentName,
            createdAt: msg.created_at,
            attachments: msg.ext?.attachments as Attachment[] | undefined,
          });
        } else if (msg.sender === "agent") {
          // Agent message without trace_id — insert directly
          lastAgentMsgRef.current = { roomId: msgRoomId, at: Date.now() };
          store.getState().setAgentTyping(false);

          const agentMsg: OwnerChatMessage = {
            clientId: msg.hub_msg_id,
            hubMsgId: msg.hub_msg_id,
            sender: "agent",
            text: msg.text,
            attachments: msg.ext?.attachments as Attachment[] | undefined,
            streamBlocks: [],
            status: "delivered",
            createdAt: msg.created_at,
            senderName: agentName,
            type: "message",
          };
          store.getState().upsertMessage(agentMsg);
        } else {
          // User echo — upsert to confirm optimistic message
          const clientMsgId = (msg as any).client_msg_id as string | undefined;
          const userMsg: OwnerChatMessage = {
            clientId: clientMsgId || msg.hub_msg_id,
            hubMsgId: msg.hub_msg_id,
            sender: "user",
            text: msg.text,
            attachments: msg.ext?.attachments as Attachment[] | undefined,
            streamBlocks: [],
            status: "confirmed",
            createdAt: msg.created_at,
            senderName: "You",
            type: "message",
          };
          store.getState().upsertMessage(userMsg);
        }

        // Dismiss typing indicator on any agent message
        if (msg.sender === "agent") {
          lastAgentMsgRef.current = { roomId: msgRoomId, at: Date.now() };
          store.getState().setAgentTyping(false);
        }
      },

      onStreamBlock: (block) => {
        store.getState().appendStreamBlock(block);
        if (block.block.kind === "assistant") {
          streamedTraceIds.current.add(block.trace_id);
        }
      },

      onNotification: (notif) => {
        const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const notifMsg: OwnerChatMessage = {
          clientId: notifId,
          hubMsgId: notifId,
          sender: "agent",
          text: notif.text,
          streamBlocks: [],
          status: "delivered",
          createdAt: notif.created_at,
          senderName: agentName,
          type: "notification",
        };
        store.getState().upsertMessage(notifMsg);
      },

      onStatusChange: (connected) => {
        if (connected) {
          store.getState().setWsConnected(true);
          // Reconcile failed/partial messages against server state after reconnect
          void store.getState().reconcileAfterReconnect();
        } else {
          store.getState().onDisconnect();
        }
      },

      onSendFailed: (_text: string, clientMsgId?: string) => {
        if (clientMsgId) {
          store.getState().failOptimistic(clientMsgId, "WebSocket send failed");
        } else {
          // Fail the most recent optimistic message
          const msgs = store.getState().messages;
          const target = [...msgs].reverse().find((m) => m.status === "optimistic");
          if (target) {
            store.getState().failOptimistic(target.clientId, "WebSocket send failed");
          }
        }
      },
    });

    wsClientRef.current = wsClient;

    return () => {
      wsClient.close();
      wsClientRef.current = null;
      store.getState().setWsConnected(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId, roomId]);

  return { wsClientRef, streamedTraceIds };
}
