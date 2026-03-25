"use client";

/**
 * [INPUT]: 依赖 dashboard session/chat/ui store 与 user-chat API，维护“用户 <-> 当前 active agent”私聊房间的初始化、消息发送与轻量流式感知
 * [OUTPUT]: 对外提供 UserChatPane 组件，渲染固定私聊入口对应的一对一会话正文与输入框
 * [POS]: dashboard messages 视图里的特殊会话面板，被 `messages/__user-chat__` 深链与左侧固定入口消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Send, Loader2, MessageSquare, AlertCircle, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import type { DashboardMessage, UserChatRoom } from "@/lib/types";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import MarkdownContent from "@/components/ui/MarkdownContent";
import { useShallow } from "zustand/react/shallow";

interface PendingMessage {
  id: string;
  text: string;
  status: "sending" | "failed";
  error?: string;
}

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`dashboard-skeleton-block rounded ${className}`} />;
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

export default function UserChatPane() {
  const { activeAgentId } = useDashboardSessionStore();
  const { setUserChatRoomId, userChatAgentTyping, setUserChatAgentTyping } = useDashboardUIStore();
  const { messages: storeMessages, loadRoomMessages } = useDashboardChatStore(useShallow((s) => ({
    messages: s.messages,
    loadRoomMessages: s.loadRoomMessages,
  })));

  const [chatRoom, setChatRoom] = useState<UserChatRoom | null>(null);
  const [inputText, setInputText] = useState("");
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Track which messages have already been animated (or were present on initial load)
  const animatedRef = useRef<Set<string>>(new Set());
  const initialLoadRef = useRef(true);
  const [, forceRender] = useState(0);

  // Initialize chat room and register userChatRoomId for realtime sync
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
      setUserChatRoomId(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId]);

  // Derive messages from the chat store (populated by loadRoomMessages + realtime sync)
  const roomId = chatRoom?.room_id;
  const messages: DashboardMessage[] = roomId ? (storeMessages[roomId] ?? []) : [];

  // Mark messages from initial load as already animated (skip typewriter)
  useEffect(() => {
    if (initialLoadRef.current && messages.length > 0) {
      for (const msg of messages) {
        animatedRef.current.add(msg.hub_msg_id);
      }
      initialLoadRef.current = false;
    }
  }, [messages]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    scrollToBottom();
  }, [messages, pending, scrollToBottom]);

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
    try {
      await api.sendUserChatMessage(text);
      // Remove pending message on success; realtime sync will bring the real one
      setPending((prev) => prev.filter((m) => m.id !== msgId));
      if (roomId) await loadRoomMessages(roomId);
    } catch (err: any) {
      setPending((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? { ...m, status: "failed" as const, error: err?.message || "Failed to send" }
            : m
        )
      );
    }
  }, [roomId, loadRoomMessages]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !roomId) return;

    const msgId = crypto.randomUUID();
    const pendingMsg: PendingMessage = { id: msgId, text, status: "sending" };
    setPending((prev) => [...prev, pendingMsg]);
    setInputText("");

    await sendMessage(text, msgId);
  }, [inputText, roomId, sendMessage]);

  const handleRetry = useCallback(async (msg: PendingMessage) => {
    setPending((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, status: "sending" as const, error: undefined } : m))
    );
    await sendMessage(msg.text, msg.id);
  }, [sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
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
      <div className="flex h-full min-w-0 flex-1 flex-col bg-deep-black">
        <div className="border-b border-glass-border px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-neon-cyan/20 bg-neon-cyan/5 text-neon-cyan/70">
              <MessageSquare className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="mt-2 h-3 w-48 bg-glass-border/40" />
            </div>
          </div>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {Array.from({ length: 6 }).map((_, idx) => {
            const isOwner = idx % 2 === 1;
            return (
              <div key={idx} className={`flex ${isOwner ? "justify-end" : "justify-start"}`}>
                <div className="w-full max-w-[75%] rounded-lg border border-glass-border bg-deep-black-light px-3 py-3">
                  {!isOwner && <SkeletonBlock className="mb-2 h-3 w-20" />}
                  <SkeletonBlock className="h-3 w-5/6 bg-glass-border/40" />
                  <SkeletonBlock className="mt-2 h-3 w-2/3 bg-glass-border/40" />
                  <SkeletonBlock className="mt-3 ml-auto h-2.5 w-12 bg-glass-border/30" />
                </div>
              </div>
            );
          })}
        </div>
        <div className="border-t border-glass-border px-4 py-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 rounded-lg border border-glass-border bg-deep-black-light px-3 py-3">
              <SkeletonBlock className="h-4 w-1/3" />
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-neon-cyan/20 bg-neon-cyan/10 text-neon-cyan/70">
              <Send className="h-4 w-4" />
            </div>
          </div>
        </div>
      </div>
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
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
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
                  <div className="text-xs text-zinc-400 mb-1 font-medium">
                    {msg.sender_name}
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
        {pending.map((msg) => (
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
        {userChatAgentTyping && (
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
