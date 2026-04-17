"use client";

/**
 * Owner-chat pane — renders a 1:1 conversation between user and their active agent.
 *
 * Architecture (post-refactor):
 *   - Single source of truth: useOwnerChatStore.messages[]
 *   - WS lifecycle: useOwnerChatWs hook
 *   - Rendering: status-driven (optimistic / streaming / delivered / failed)
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Send, Loader2, MessageSquare, AlertCircle, RotateCcw, Bell, Paperclip, X, FileText, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import type { Attachment, OwnerChatMessage } from "@/lib/types";
import type { WsAttachment } from "@/lib/owner-chat-ws";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useOwnerChatStore } from "@/store/useOwnerChatStore";
import { useOwnerChatWs } from "@/hooks/useOwnerChatWs";
import DashboardMessagePaneSkeleton from "./DashboardMessagePaneSkeleton";
import MarkdownContent from "@/components/ui/MarkdownContent";
import StreamBlocksView from "./StreamBlocksView";
import CopyableId from "@/components/ui/CopyableId";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

// ---------------------------------------------------------------------------
// TypewriterText
// ---------------------------------------------------------------------------

function TypewriterText({
  text,
  onComplete,
  onTick,
}: {
  text: string;
  onComplete?: () => void;
  onTick?: () => void;
}) {
  const tokens = text.split(/(\s+)/);
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

// ---------------------------------------------------------------------------
// File upload types
// ---------------------------------------------------------------------------

interface PendingAttachment {
  file: File;
  preview?: string;
  uploaded?: Attachment;
  uploading?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function UserChatPane() {
  const { activeAgentId } = useDashboardSessionStore();
  const { setUserChatRoomId } = useDashboardUIStore();

  // Owner-chat store
  const messages = useOwnerChatStore((s) => s.messages);
  const hasMore = useOwnerChatStore((s) => s.hasMore);
  const loading = useOwnerChatStore((s) => s.loading);
  const storeError = useOwnerChatStore((s) => s.error);
  const wsConnected = useOwnerChatStore((s) => s.wsConnected);
  const agentTyping = useOwnerChatStore((s) => s.agentTyping);
  const activeTraceId = useOwnerChatStore((s) => s.activeTraceId);
  const roomId = useOwnerChatStore((s) => s.roomId);

  const [chatRoomName, setChatRoomName] = useState("");
  const [inputText, setInputText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const [initError, setInitError] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const animatedRef = useRef<Set<string>>(new Set());
  const initialLoadRef = useRef(true);
  const isLoadingMore = useRef(false);
  const prevLengthRef = useRef(0);
  const wasNearBottomRef = useRef(true);
  const [, forceRender] = useState(0);

  // WS hook
  const { wsClientRef, streamedTraceIds } = useOwnerChatWs({
    activeAgentId,
    roomId,
    agentName: chatRoomName || activeAgentId || "",
  });

  // ------ Initialize chat room and load messages ------
  useEffect(() => {
    if (!activeAgentId) return;
    let cancelled = false;

    // Reset store for fresh agent
    useOwnerChatStore.getState().reset();

    api.getUserChatRoom()
      .then((room) => {
        if (cancelled) return;
        setChatRoomName(room.name);
        setUserChatRoomId(room.room_id);
        useOwnerChatStore.getState().setRoom(room.room_id, room.name || activeAgentId);
        return useOwnerChatStore.getState().loadInitial(room.room_id);
      })
      .catch((err) => {
        if (cancelled) return;
        setInitError(err?.message || "Failed to initialize chat");
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId]);

  // ------ Mark initial load messages as already animated ------
  useEffect(() => {
    if (!loading && initialLoadRef.current && messages.length > 0) {
      for (const msg of messages) {
        animatedRef.current.add(msg.clientId);
      }
      initialLoadRef.current = false;
      requestAnimationFrame(() => {
        const el = scrollContainerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [loading, messages]);

  // ------ Auto-focus input when empty (onboarding) ------
  useEffect(() => {
    if (!loading && messages.length === 0 && inputRef.current) {
      // Small delay so the welcome UI renders first
      const timer = setTimeout(() => inputRef.current?.focus(), 300);
      return () => clearTimeout(timer);
    }
  }, [loading, messages.length]);

  // ------ Scroll helpers ------

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (messages.length > prevLengthRef.current && !isLoadingMore.current) {
      if (wasNearBottomRef.current) scrollToBottom();
    }
    prevLengthRef.current = messages.length;
    isLoadingMore.current = false;
  }, [messages.length, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (hasMore && !isLoadingMore.current && el.scrollTop < 100) {
      isLoadingMore.current = true;
      useOwnerChatStore.getState().loadMore();
    }
  }, [hasMore]);

  // ------ Typing auto-dismiss ------
  useEffect(() => {
    if (!agentTyping) return;
    const timer = setTimeout(() => useOwnerChatStore.getState().setAgentTyping(false), 30_000);
    return () => clearTimeout(timer);
  }, [agentTyping]);

  // ------ File handling ------

  const uploadPendingFiles = useCallback(async (files: PendingAttachment[]): Promise<Attachment[]> => {
    const results: Attachment[] = [];
    for (const pf of files) {
      if (pf.uploaded) { results.push(pf.uploaded); continue; }
      const res = await api.uploadFile(pf.file);
      results.push({
        filename: res.original_filename,
        url: res.url,
        content_type: res.content_type,
        size_bytes: res.size_bytes,
      });
    }
    return results;
  }, []);

  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPendingFiles((prev) => {
      const remaining = 10 - prev.length;
      if (remaining <= 0) return prev;
      const toAdd = Array.from(files).slice(0, remaining);
      const newFiles: PendingAttachment[] = toAdd.map((file) => ({
        file,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      }));
      return [...prev, ...newFiles];
    });
  }, []);

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const removed = prev[index];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  useEffect(() => {
    return () => {
      setPendingFiles((prev) => {
        for (const pf of prev) { if (pf.preview) URL.revokeObjectURL(pf.preview); }
        return [];
      });
    };
  }, []);

  // ------ Send message ------

  const sendMessage = useCallback(async (text: string, clientId: string, attachments?: Attachment[]) => {
    const wsAtts: WsAttachment[] | undefined = attachments?.map((a) => ({
      filename: a.filename, url: a.url, content_type: a.content_type, size_bytes: a.size_bytes,
    }));

    // Try WS first
    if (wsClientRef.current && wsConnected) {
      const sent = wsClientRef.current.send(text, wsAtts, clientId);
      if (sent) return;
    }

    // HTTP fallback
    try {
      const result = await api.sendUserChatMessage(text, attachments);
      useOwnerChatStore.getState().confirmOptimistic(clientId, result.hub_msg_id, new Date().toISOString(), attachments);
    } catch (err: any) {
      useOwnerChatStore.getState().failOptimistic(clientId, err?.message || "Failed to send");
    }
  }, [wsClientRef, wsConnected]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || !roomId) return;

    const filesToUpload = [...pendingFiles];
    setInputText("");
    setPendingFiles([]);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }
    for (const pf of filesToUpload) { if (pf.preview) URL.revokeObjectURL(pf.preview); }

    const clientId = crypto.randomUUID();
    const rawFiles = filesToUpload.map((pf) => pf.file);
    const displayText = text || (rawFiles.length > 0 ? `[${rawFiles.length} file(s)]` : "");

    // Add optimistic message to store
    const optimisticMsg: OwnerChatMessage = {
      clientId,
      hubMsgId: null,
      sender: "user",
      text: displayText,
      streamBlocks: [],
      status: "optimistic",
      createdAt: new Date().toISOString(),
      senderName: "You",
      type: "message",
      sendText: text,
      retryFiles: rawFiles.length > 0 ? rawFiles : undefined,
    };
    useOwnerChatStore.getState().addOptimistic(optimisticMsg);
    scrollToBottom();

    try {
      const attachments = filesToUpload.length > 0 ? await uploadPendingFiles(filesToUpload) : undefined;
      await sendMessage(text, clientId, attachments);
    } catch (err: any) {
      useOwnerChatStore.getState().failOptimistic(clientId, err?.message || "Upload failed");
    }
  }, [inputText, pendingFiles, roomId, sendMessage, uploadPendingFiles, scrollToBottom]);

  const handleRetry = useCallback(async (msg: OwnerChatMessage) => {
    useOwnerChatStore.getState().resetForRetry(msg.clientId);
    try {
      let attachments = msg.attachments;
      if (!attachments && msg.retryFiles && msg.retryFiles.length > 0) {
        const pfs: PendingAttachment[] = msg.retryFiles.map((f) => ({ file: f }));
        attachments = await uploadPendingFiles(pfs);
      }
      await sendMessage(msg.sendText || msg.text, msg.clientId, attachments);
    } catch (err: any) {
      useOwnerChatStore.getState().failOptimistic(msg.clientId, err?.message || "Retry failed");
    }
  }, [sendMessage, uploadPendingFiles]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // ------ Render guards ------

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

  if (initError || storeError) {
    return (
      <div className="flex items-center justify-center h-full text-red-400">
        <p>{initError || storeError}</p>
      </div>
    );
  }

  const hasStreamingMsg = messages.some((m) => m.status === "streaming");

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
        <MessageSquare className="w-4 h-4 text-cyan-400" />
        <h2 className="text-sm font-medium text-zinc-200">
          {chatRoomName || "Chat with Agent"}
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
          <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
            {/* Glowing avatar */}
            <div className="relative">
              <div className="absolute inset-0 rounded-2xl bg-cyan-500/20 blur-xl animate-pulse" />
              <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-500/40 bg-cyan-500/10">
                <MessageSquare className="h-8 w-8 text-cyan-400" />
              </div>
            </div>

            {/* Welcome text */}
            <div className="text-center">
              <p className="text-base font-semibold text-zinc-100">
                {chatRoomName ? `${chatRoomName} is ready!` : "Your Bot is ready!"}
              </p>
              <p className="mt-1.5 text-sm text-zinc-400 max-w-sm">
                Send your first message to start the conversation.
              </p>
            </div>

            {/* Suggestion chips */}
            <div className="flex flex-wrap justify-center gap-2 max-w-md">
              {[
                { emoji: "👋", text: "Hey! What can you do?" },
                { emoji: "💡", text: "Tell me about yourself" },
                { emoji: "🚀", text: "Let's get started!" },
              ].map((suggestion) => (
                <button
                  key={suggestion.text}
                  onClick={() => {
                    const clientId = crypto.randomUUID();
                    const optimisticMsg: OwnerChatMessage = {
                      clientId,
                      hubMsgId: null,
                      sender: "user",
                      text: suggestion.text,
                      streamBlocks: [],
                      status: "optimistic",
                      createdAt: new Date().toISOString(),
                      senderName: "You",
                      type: "message",
                      sendText: suggestion.text,
                    };
                    useOwnerChatStore.getState().addOptimistic(optimisticMsg);
                    scrollToBottom();
                    void sendMessage(suggestion.text, clientId);
                  }}
                  className="group flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800/80 px-3.5 py-2 text-sm text-zinc-300 transition-all hover:border-cyan-500/50 hover:bg-cyan-500/10 hover:text-cyan-300 hover:shadow-[0_0_12px_rgba(0,240,255,0.15)]"
                >
                  <span>{suggestion.emoji}</span>
                  <span>{suggestion.text}</span>
                </button>
              ))}
            </div>

            {/* Bouncing arrow pointing to input */}
            <div className="mt-2 flex flex-col items-center gap-1 text-zinc-500">
              <span className="text-xs">or type your own message</span>
              <ChevronDown className="h-5 w-5 animate-bounce" />
            </div>
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.sender === "user";
          const isNotification = msg.type === "notification";

          // --- Notification ---
          if (isNotification) {
            return (
              <div key={msg.clientId} className="flex justify-center">
                <div className="max-w-[85%] rounded-lg px-3 py-2 text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20 flex items-start gap-2">
                  <Bell className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <div>
                    <MarkdownContent content={msg.text || ""} />
                    <div className="text-amber-500/60 mt-1 text-right">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          // --- Streaming agent message ---
          if (msg.status === "streaming") {
            return (
              <div key={msg.clientId} className="space-y-1.5">
                <StreamBlocksView
                  blocks={msg.streamBlocks}
                  defaultExpanded
                  onScrollRequest={wasNearBottomRef.current ? scrollToBottom : undefined}
                />
              </div>
            );
          }

          // --- Optimistic / Failed user message ---
          if (msg.status === "optimistic" || msg.status === "failed") {
            return (
              <div key={msg.clientId} className="flex justify-end">
                <div className="max-w-[75%] rounded-lg px-3 py-2 text-sm bg-cyan-500/20 text-cyan-100 border border-cyan-500/30">
                  <MarkdownContent content={msg.text} />
                  <div className="flex items-center justify-end gap-1.5 mt-1">
                    {msg.status === "optimistic" && (
                      <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
                    )}
                    {msg.status === "failed" && (
                      <>
                        <span className="relative group">
                          <span className="flex items-center gap-1 cursor-default">
                            <AlertCircle className="w-3 h-3 text-red-400" />
                            <span className="text-xs text-red-400">Failed</span>
                          </span>
                          {msg.error && (
                            <span className="absolute bottom-full right-0 mb-1 hidden group-hover:block px-2 py-1 text-xs text-zinc-200 bg-zinc-800 border border-zinc-600 rounded shadow-lg whitespace-nowrap z-50">
                              {msg.error}
                            </span>
                          )}
                        </span>
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
            );
          }

          // --- Confirmed / Delivered messages ---
          return (
            <div key={msg.clientId} className="space-y-1.5">
              {/* Finalized execution blocks above agent message */}
              {!isUser && msg.streamBlocks.length > 0 && (
                <StreamBlocksView blocks={msg.streamBlocks} />
              )}
              <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                    isUser
                      ? "bg-cyan-500/20 text-cyan-100 border border-cyan-500/30"
                      : "bg-zinc-800 text-zinc-200 border border-zinc-700"
                  }`}
                >
                  {!isUser && (
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="text-xs font-medium text-zinc-300">
                        {msg.senderName}
                      </span>
                      {activeAgentId && (
                        <CopyableId value={activeAgentId} className="text-zinc-500 hover:text-zinc-300" />
                      )}
                    </div>
                  )}
                  {/* Typewriter for new agent messages; skip if already animated or was streamed */}
                  {(() => {
                    const wasStreamed = msg.traceId && streamedTraceIds.current?.has(msg.traceId);
                    if (wasStreamed) {
                      // Mark as animated and clean up traceId to avoid memory leak
                      animatedRef.current.add(msg.clientId);
                      streamedTraceIds.current.delete(msg.traceId!);
                    }
                    const skipTypewriter = isUser || animatedRef.current.has(msg.clientId);
                    if (skipTypewriter) {
                      return <MarkdownContent content={msg.text || ""} />;
                    }
                    return (
                      <TypewriterText
                        text={msg.text || ""}
                        onTick={scrollToBottom}
                        onComplete={() => {
                          animatedRef.current.add(msg.clientId);
                          forceRender((n) => n + 1);
                        }}
                      />
                    );
                  })()}
                  {/* Attachments */}
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {msg.attachments.map((att, idx) => {
                        const fullUrl = att.url.startsWith("/") ? `${HUB_BASE_URL}${att.url}` : att.url;
                        const isImage = att.content_type?.startsWith("image/");
                        if (isImage) {
                          return (
                            <a key={idx} href={fullUrl} target="_blank" rel="noopener noreferrer" className="block">
                              <img
                                src={fullUrl}
                                alt={att.filename || "Image"}
                                className="max-h-48 max-w-full rounded border border-zinc-600 object-cover hover:opacity-80 transition-opacity"
                              />
                              <span className="mt-0.5 block text-[10px] text-zinc-500">{att.filename}</span>
                            </a>
                          );
                        }
                        return (
                          <a
                            key={idx}
                            href={fullUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                          >
                            <FileText className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{att.filename || "Attachment"}</span>
                          </a>
                        );
                      })}
                    </div>
                  )}
                  <div className="text-xs text-zinc-500 mt-1 text-right">
                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Typing indicator (only when no streaming message exists) */}
        {agentTyping && !hasStreamingMsg && (
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
        <div />
      </div>

      {/* Input */}
      <div className={`border-t px-4 py-3 transition-colors ${messages.length === 0 ? "border-cyan-500/30 bg-cyan-500/[0.03]" : "border-zinc-800"}`} onDrop={handleDrop} onDragOver={handleDragOver}>
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {pendingFiles.map((pf, idx) => (
              <div key={idx} className="relative group flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-300 max-w-[200px]">
                {pf.preview ? (
                  <img src={pf.preview} alt={pf.file.name} className="w-8 h-8 rounded object-cover shrink-0" />
                ) : (
                  <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
                )}
                <span className="truncate">{pf.file.name}</span>
                <button
                  onClick={() => removePendingFile(idx)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-600 text-zinc-200 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFileSelect(e.target.files);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center justify-center w-9 h-9 rounded-lg text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 transition-colors"
            title="Attach file"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <textarea
            ref={inputRef}
            className={`flex-1 bg-zinc-900 border rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:border-cyan-500/50 transition-all ${
              messages.length === 0
                ? "border-cyan-500/40 shadow-[0_0_8px_rgba(0,240,255,0.1)] animate-[pulse-border_2s_ease-in-out_infinite]"
                : "border-zinc-700"
            }`}
            placeholder={messages.length === 0 ? "Say something to your Bot..." : "Type a message..."}
            value={inputText}
            onChange={(e) => { setInputText(e.target.value); autoResize(); }}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!inputText.trim() && pendingFiles.length === 0}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
