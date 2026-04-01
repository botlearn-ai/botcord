"use client";

/**
 * [INPUT]: 依赖 dashboard session/chat/ui store 与 user-chat API，维护"用户 <-> 当前 active agent"私聊房间的初始化、消息发送与轻量流式感知
 * [OUTPUT]: 对外提供 UserChatPane 组件，渲染固定私聊入口对应的一对一会话正文与输入框
 * [POS]: dashboard messages 视图里的特殊会话面板，被 `messages/__user-chat__` 深链与左侧固定入口消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Send, Loader2, MessageSquare, AlertCircle, RotateCcw, ChevronDown, ChevronRight, Wrench, Brain, Bot } from "lucide-react";
import { api } from "@/lib/api";
import type { DashboardMessage, UserChatRoom, StreamBlockEntry } from "@/lib/types";
import { createOwnerChatWs, type OwnerChatWsClient } from "@/lib/owner-chat-ws";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useOwnerChatStreamStore } from "@/store/useOwnerChatStreamStore";
import DashboardMessagePaneSkeleton from "./DashboardMessagePaneSkeleton";
import MarkdownContent from "@/components/ui/MarkdownContent";
import CopyableId from "@/components/ui/CopyableId";
import { useShallow } from "zustand/react/shallow";
import { createClient } from "@/lib/supabase/client";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

interface PendingMessage {
  id: string;
  text: string;
  createdAt: number;
  status: "sending" | "failed";
  error?: string;
}

/** Simulated streaming: renders text word-by-word then swaps to full markdown. */
function TypewriterText({
  text,
  onComplete,
  onTick,
}: {
  text: string;
  onComplete?: () => void;
  onTick?: () => void;
}) {
  const tokens = text.split(/(\s+)/); // preserve whitespace
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (count >= tokens.length) {
      onComplete?.();
      return;
    }
    const timer = setTimeout(() => {
      setCount((c) => c + 1);
      onTick?.();
    }, 30);
    return () => clearTimeout(timer);
  }, [count, tokens.length, onComplete, onTick]);

  return <>{tokens.slice(0, count).join("")}</>;
}

function isOwnerMessage(msg: DashboardMessage): boolean {
  return msg.source_type === "dashboard_user_chat";
}

// ---------------------------------------------------------------------------
// Stream block rendering
// ---------------------------------------------------------------------------

function StreamBlocksView({
  blocks,
  onScrollRequest,
}: {
  blocks: StreamBlockEntry[];
  onScrollRequest?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Separate assistant-visible text from execution blocks
  const executionBlocks = blocks.filter(
    (b) => b.block.kind !== "assistant",
  );
  const assistantBlocks = blocks.filter(
    (b) => b.block.kind === "assistant",
  );

  useEffect(() => {
    onScrollRequest?.();
  }, [blocks.length, onScrollRequest]);

  if (blocks.length === 0) return null;

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        {/* Execution blocks (tool_call, tool_result, reasoning) */}
        {executionBlocks.length > 0 && (
          <div className="rounded-lg border border-zinc-700/50 bg-zinc-900/50 overflow-hidden">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
            >
              {expanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Wrench className="w-3 h-3" />
              <span>{executionBlocks.length} execution step{executionBlocks.length !== 1 ? "s" : ""}</span>
            </button>
            {expanded && (
              <div className="border-t border-zinc-800 px-3 py-2 space-y-1.5">
                {executionBlocks.map((block) => (
                  <StreamBlockItem key={`${block.trace_id}-${block.seq}`} block={block} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Streamed assistant text (inline) */}
        {assistantBlocks.length > 0 && (
          <div className="rounded-lg px-3 py-2 bg-zinc-800 border border-zinc-700 text-sm text-zinc-200">
            <div className="mb-1 flex items-center gap-1.5">
              <Bot className="w-3 h-3 text-zinc-400" />
              <span className="text-xs text-zinc-400">Composing...</span>
            </div>
            <MarkdownContent
              content={
                assistantBlocks
                  .map((b) => (b.block.payload?.text as string) || "")
                  .join("")
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

function StreamBlockItem({ block }: { block: StreamBlockEntry }) {
  const { kind, payload } = block.block;

  if (kind === "tool_call") {
    const name = (payload?.name as string) || "tool";
    return (
      <div className="text-xs">
        <span className="text-cyan-400 font-mono">{name}</span>
        <span className="text-zinc-500 ml-1">called</span>
      </div>
    );
  }

  if (kind === "tool_result") {
    const name = (payload?.name as string) || "tool";
    const result = (payload?.result as string) || "";
    return (
      <div className="text-xs">
        <span className="text-emerald-400 font-mono">{name}</span>
        <span className="text-zinc-500 ml-1">returned</span>
        {result && (
          <div className="mt-0.5 text-zinc-500 font-mono text-[10px] truncate max-w-[300px]">
            {result}
          </div>
        )}
      </div>
    );
  }

  if (kind === "reasoning") {
    const text = (payload?.text as string) || "";
    return (
      <div className="text-xs text-zinc-500 italic flex items-start gap-1">
        <Brain className="w-3 h-3 mt-0.5 shrink-0" />
        <span className="truncate">{text}</span>
      </div>
    );
  }

  return (
    <div className="text-xs text-zinc-500">
      <span className="font-mono">{kind}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function UserChatPane() {
  const { activeAgentId } = useDashboardSessionStore();
  const { setUserChatRoomId, userChatAgentTyping, setUserChatAgentTyping } = useDashboardUIStore();
  const { messages: storeMessages, messagesHasMore, loadRoomMessages, loadMoreMessages, pollNewMessages, insertMessage } = useDashboardChatStore(useShallow((s) => ({
    messages: s.messages,
    messagesHasMore: s.messagesHasMore,
    loadRoomMessages: s.loadRoomMessages,
    loadMoreMessages: s.loadMoreMessages,
    pollNewMessages: s.pollNewMessages,
    insertMessage: s.insertMessage,
  })));
  const { activeBlocks, addStreamBlock, clearTrace, setWsConnected, wsConnected } = useOwnerChatStreamStore();

  const [chatRoom, setChatRoom] = useState<UserChatRoom | null>(null);
  const [inputText, setInputText] = useState("");
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Track which messages have already been animated (or were present on initial load)
  const animatedRef = useRef<Set<string>>(new Set());
  const initialLoadRef = useRef(true);
  const isLoadingMore = useRef(false);
  const prevLengthRef = useRef(0);
  const wasNearBottomRef = useRef(true);
  const [, forceRender] = useState(0);

  // WS client ref
  const wsClientRef = useRef<OwnerChatWsClient | null>(null);
  // Track the last trace_id so we can clear stream blocks when final message arrives
  const activeTraceRef = useRef<string | null>(null);

  // Initialize chat room and load messages (userChatRoomId is set eagerly by DashboardApp)
  useEffect(() => {
    if (!activeAgentId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    api.getUserChatRoom()
      .then((room) => {
        if (cancelled) return;
        setChatRoom(room);
        setUserChatRoomId(room.room_id);
        return loadRoomMessages(room.room_id);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Failed to initialize chat");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId]);

  // --- Owner-chat WebSocket lifecycle ---
  useEffect(() => {
    if (!activeAgentId || !chatRoom) return;

    const supabase = createClient();

    const wsClient = createOwnerChatWs({
      hubBaseUrl: HUB_BASE_URL,
      getToken: async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token || "";
      },
      agentId: activeAgentId,
      onAuthOk: (data) => {
        // Room ID confirmed by server
        if (data.room_id && data.room_id !== chatRoom.room_id) {
          setChatRoom((prev) => prev ? { ...prev, room_id: data.room_id } : prev);
          setUserChatRoomId(data.room_id);
        }
      },
      onMessage: (msg) => {
        const roomId = msg.room_id || chatRoom.room_id;

        // Clear stream blocks when final agent message arrives
        if (msg.sender === "agent" && msg.ext?.trace_id) {
          clearTrace(msg.ext.trace_id as string);
          activeTraceRef.current = null;
        }

        // Dismiss typing indicator on agent message
        if (msg.sender === "agent") {
          setUserChatAgentTyping(false);
        }

        // Insert directly into chat store
        const dashMsg: DashboardMessage = {
          hub_msg_id: msg.hub_msg_id,
          msg_id: msg.hub_msg_id,
          sender_id: activeAgentId,
          sender_name: msg.sender === "user" ? "You" : (chatRoom.name || activeAgentId),
          type: "message",
          text: msg.text,
          payload: {},
          room_id: roomId,
          topic: null,
          topic_id: null,
          goal: null,
          state: "delivered",
          state_counts: null,
          created_at: msg.created_at,
          source_type: msg.sender === "user" ? "dashboard_user_chat" : undefined,
        };
        insertMessage(roomId, dashMsg);

        // Remove matching pending message
        if (msg.sender === "user") {
          setPending((prev) => {
            const match = prev.find((p) => p.text === msg.text);
            return match ? prev.filter((p) => p.id !== match.id) : prev;
          });
        }
      },
      onStreamBlock: (block) => {
        addStreamBlock(block);
        activeTraceRef.current = block.trace_id;
      },
      onStatusChange: (connected) => {
        setWsConnected(connected);
        if (!connected) {
          // On disconnect: mark all "sending" pending messages as failed so
          // they can be retried via HTTP, and clear stale stream blocks.
          setPending((prev) =>
            prev.map((p) =>
              p.status === "sending"
                ? { ...p, status: "failed" as const, error: "Connection lost" }
                : p
            )
          );
          // Clear all ephemeral stream blocks — they cannot be recovered after
          // disconnect (Phase 1 design: no replay).
          useOwnerChatStreamStore.getState().reset();
          activeTraceRef.current = null;
        }
      },
      onSendFailed: () => {
        // Mark the most recent "sending" pending message as failed
        setPending((prev) => {
          const last = [...prev].reverse().find((p) => p.status === "sending");
          if (!last) return prev;
          return prev.map((p) =>
            p.id === last.id ? { ...p, status: "failed" as const, error: "WebSocket send failed" } : p
          );
        });
      },
    });

    wsClientRef.current = wsClient;

    return () => {
      wsClient.close();
      wsClientRef.current = null;
      setWsConnected(false);
      // Clear stream blocks on cleanup too
      useOwnerChatStreamStore.getState().reset();
      activeTraceRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId, chatRoom?.room_id]);

  // Derive messages from the chat store (populated by loadRoomMessages + realtime sync)
  const roomId = chatRoom?.room_id;
  const messages: DashboardMessage[] = roomId ? (storeMessages[roomId] ?? []) : [];
  const hasMore = roomId ? messagesHasMore[roomId] ?? false : false;
  const visiblePending = pending.filter((item) => {
    const matchingOwnerMessage = messages.find((message) => (
      isOwnerMessage(message)
      && (message.text || "") === item.text
      && Date.parse(message.created_at) >= item.createdAt - 5_000
    ));
    return !matchingOwnerMessage;
  });

  // Collect stream blocks for the active trace
  const currentStreamBlocks: StreamBlockEntry[] = activeTraceRef.current
    ? (activeBlocks[activeTraceRef.current] || [])
    : [];

  // Mark messages from initial load as already animated (skip typewriter) and scroll to bottom.
  // Must wait for loading=false so the real scroll container is in the DOM.
  useEffect(() => {
    if (!loading && initialLoadRef.current && messages.length > 0) {
      for (const msg of messages) {
        animatedRef.current.add(msg.hub_msg_id);
      }
      initialLoadRef.current = false;
      requestAnimationFrame(() => {
        const el = scrollContainerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [loading, messages]);

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Auto-scroll when new messages arrive (only if near bottom, not when loading history)
  useEffect(() => {
    if (messages.length > prevLengthRef.current && !isLoadingMore.current) {
      if (wasNearBottomRef.current) {
        scrollToBottom();
      }
    }
    prevLengthRef.current = messages.length;
    isLoadingMore.current = false;
  }, [messages.length, scrollToBottom]);

  // Auto-scroll when pending messages change (user just sent)
  useEffect(() => {
    if (pending.length > 0) {
      scrollToBottom();
    }
  }, [pending, scrollToBottom]);

  // Scroll handler: infinite scroll up + track position
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || !roomId) return;

    wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;

    if (hasMore && !isLoadingMore.current && el.scrollTop < 100) {
      isLoadingMore.current = true;
      loadMoreMessages(roomId);
    }
  }, [roomId, hasMore, loadMoreMessages]);

  // Auto-dismiss typing indicator after 30 seconds
  useEffect(() => {
    if (!userChatAgentTyping) return;
    const timer = setTimeout(() => setUserChatAgentTyping(false), 30_000);
    return () => clearTimeout(timer);
  }, [userChatAgentTyping, setUserChatAgentTyping]);

  // Clear typing when new agent messages arrive
  const prevMessageCountRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && userChatAgentTyping) {
      const hasNewAgentMsg = messages
        .slice(prevMessageCountRef.current)
        .some((m) => !isOwnerMessage(m));
      if (hasNewAgentMsg) {
        setUserChatAgentTyping(false);
      }
    }
    prevMessageCountRef.current = messages.length;
  }, [messages, userChatAgentTyping, setUserChatAgentTyping]);

  const sendMessage = useCallback(async (text: string, msgId: string) => {
    // If WS is connected, send via WS (no polling needed — WS delivers echo)
    if (wsClientRef.current && wsConnected) {
      const sent = wsClientRef.current.send(text);
      if (sent) {
        // WS echo will remove the pending message via onMessage callback.
        // onSendFailed callback handles the case where the socket closes after send.
        return;
      }
      // WS send failed — fall through to HTTP fallback
    }

    // Fallback to HTTP
    try {
      const result = await api.sendUserChatMessage(text);
      if (roomId) {
        await pollNewMessages(roomId, {
          expectedHubMsgId: result.hub_msg_id,
          retries: 2,
        });
      }
      setPending((prev) => prev.filter((m) => m.id !== msgId));
    } catch (err: any) {
      setPending((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? { ...m, status: "failed" as const, error: err?.message || "Failed to send" }
            : m
        )
      );
    }
  }, [roomId, pollNewMessages, wsConnected]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !roomId) return;

    // Clear input immediately via both state and DOM to avoid stale-closure race
    setInputText("");
    if (inputRef.current) inputRef.current.value = "";

    const msgId = crypto.randomUUID();
    const pendingMsg: PendingMessage = {
      id: msgId,
      text,
      createdAt: Date.now(),
      status: "sending",
    };
    setPending((prev) => [...prev, pendingMsg]);

    await sendMessage(text, msgId);
  }, [inputText, roomId, sendMessage]);

  const handleRetry = useCallback(async (msg: PendingMessage) => {
    setPending((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, status: "sending" as const, error: undefined } : m))
    );
    await sendMessage(msg.text, msg.id);
  }, [sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!activeAgentId) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <p>Select an agent to start chatting</p>
      </div>
    );
  }

  if (loading) {
    return (
      <DashboardMessagePaneSkeleton
        headerIcon={<MessageSquare className="h-4 w-4" />}
        headerPaddingClassName="px-4 py-3"
        bodyPaddingClassName="px-4 py-4"
        composerPaddingClassName="px-4 py-3"
        messageMaxWidthClassName="max-w-[75%]"
        roundedClassName="rounded-lg"
      />
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400">
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
        <MessageSquare className="w-4 h-4 text-cyan-400" />
        <h2 className="text-sm font-medium text-zinc-200">
          {chatRoom?.name || "Chat with Agent"}
        </h2>
        {wsConnected && (
          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400" title="Live" />
        )}
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {hasMore && (
          <div className="mb-1 text-center text-xs text-zinc-500 animate-pulse">
            Scroll up for older messages
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
            <p>Send a message to start the conversation</p>
          </div>
        )}
        {messages.map((msg) => {
          const isOwner = isOwnerMessage(msg);
          return (
            <div
              key={msg.hub_msg_id}
              className={`flex ${isOwner ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                  isOwner
                    ? "bg-cyan-500/20 text-cyan-100 border border-cyan-500/30"
                    : "bg-zinc-800 text-zinc-200 border border-zinc-700"
                }`}
              >
                {!isOwner && (
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-xs font-medium text-zinc-300">
                      {msg.sender_name || msg.sender_id}
                    </span>
                    <CopyableId value={msg.sender_id} className="text-zinc-500 hover:text-zinc-300" />
                  </div>
                )}
                {!isOwner && !animatedRef.current.has(msg.hub_msg_id) ? (
                  <TypewriterText
                    text={msg.text || ""}
                    onTick={scrollToBottom}
                    onComplete={() => {
                      animatedRef.current.add(msg.hub_msg_id);
                      forceRender((n) => n + 1);
                    }}
                  />
                ) : (
                  <MarkdownContent content={msg.text || ""} />
                )}
                {(() => {
                  const atts = msg.payload?.attachments as Array<{ url: string; filename?: string }> | undefined;
                  if (!atts || atts.length === 0) return null;
                  return (
                    <div className="mt-2 space-y-1">
                      {atts.map((att, idx) => (
                        <a
                          key={idx}
                          href={att.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-xs text-cyan-400 underline truncate"
                        >
                          {att.filename || "Attachment"}
                        </a>
                      ))}
                    </div>
                  );
                })()}
                <div className="text-xs text-zinc-500 mt-1 text-right">
                  {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            </div>
          );
        })}

        {/* Stream blocks (ephemeral execution activity) */}
        {currentStreamBlocks.length > 0 && (
          <StreamBlocksView
            blocks={currentStreamBlocks}
            onScrollRequest={wasNearBottomRef.current ? scrollToBottom : undefined}
          />
        )}

        {visiblePending.map((msg) => (
          <div key={msg.id} className="flex justify-end">
            <div className="max-w-[75%] rounded-lg px-3 py-2 text-sm bg-cyan-500/20 text-cyan-100 border border-cyan-500/30">
              <MarkdownContent content={msg.text} />
              <div className="flex items-center justify-end gap-1.5 mt-1">
                {msg.status === "sending" && (
                  <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
                )}
                {msg.status === "failed" && (
                  <>
                    <AlertCircle className="w-3 h-3 text-red-400" />
                    <span className="text-xs text-red-400">Failed</span>
                    <button
                      onClick={() => handleRetry(msg)}
                      className="flex items-center gap-0.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors ml-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Retry
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
        {userChatAgentTyping && currentStreamBlocks.length === 0 && (
          <div className="flex justify-start">
            <div className="rounded-lg px-3 py-2 bg-zinc-800 border border-zinc-700">
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:border-cyan-500/50 min-h-[40px] max-h-[120px]"
            placeholder="Type a message..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!inputText.trim()}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
