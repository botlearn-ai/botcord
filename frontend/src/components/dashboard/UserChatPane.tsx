"use client";

/**
 * Owner-chat pane — renders a 1:1 conversation between the user and a managed Bot.
 *
 * Architecture (post-refactor):
 *   - Single source of truth: useOwnerChatStore.messages[]
 *   - WS lifecycle: useOwnerChatWs hook
 *   - Rendering: status-driven (optimistic / streaming / delivered / failed)
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowLeft, Bot, Loader2, MessageSquare, AlertCircle, AlertTriangle, RotateCcw, Bell, FileText, PanelLeftOpen, Settings2, User } from "lucide-react";
import { useRouter } from "nextjs-toploader/app";
import AgentSettingsDrawer from "./AgentSettingsDrawer";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import type { Attachment, OwnerChatMessage } from "@/lib/types";
import type { WsAttachment } from "@/lib/owner-chat-ws";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useMentionCandidates } from "@/hooks/useMentionCandidates";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useOwnerChatStore } from "@/store/useOwnerChatStore";
import { useOwnerChatWs } from "@/hooks/useOwnerChatWs";
import DashboardMessagePaneSkeleton from "./DashboardMessagePaneSkeleton";
import MarkdownContent from "@/components/ui/MarkdownContent";
import StreamBlocksView from "./StreamBlocksView";
import RuntimeErrorDetailsDialog from "./RuntimeErrorDetailsDialog";
import CopyableId from "@/components/ui/CopyableId";
import MessageComposer from "./MessageComposer";

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
// Main component
// ---------------------------------------------------------------------------

export default function UserChatPane({ agentId }: { agentId?: string | null }) {
  const locale = useLanguage();
  const router = useRouter();
  const { activeAgentId } = useDashboardSessionStore();
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const chatAgentId = agentId || activeAgentId || null;
  const { openMobileSidebar, setMessagesPane, setSelectedBotAgentId, setUserChatRoomId } = useDashboardUIStore();
  const ownedAgent = chatAgentId
    ? ownedAgents.find((a) => a.agent_id === chatAgentId) ?? null
    : null;

  const mentionCandidates = useMentionCandidates({ selfId: chatAgentId });

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
  const [initializingRoom, setInitializingRoom] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [errorDetailsId, setErrorDetailsId] = useState<string | null>(null);
  const settingsLabel = locale === "zh" ? "Bot 设置" : "Bot settings";

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const animatedRef = useRef<Set<string>>(new Set());
  const initialLoadRef = useRef(true);
  const isLoadingMore = useRef(false);
  const prevLengthRef = useRef(0);
  const wasNearBottomRef = useRef(true);
  const [, forceRender] = useState(0);

  // WS hook authenticates the selected owner-chat target explicitly.
  const { wsClientRef, streamedTraceIds } = useOwnerChatWs({
    activeAgentId: chatAgentId,
    roomId,
    agentName: chatRoomName || chatAgentId || "",
  });

  // ------ Initialize chat room and load messages ------
  useEffect(() => {
    if (!chatAgentId) return;
    let cancelled = false;

    // Reset store for fresh agent
    setInitError(null);
    setChatRoomName("");
    setInitializingRoom(true);
    initialLoadRef.current = true;
    prevLengthRef.current = 0;
    animatedRef.current.clear();
    useOwnerChatStore.getState().reset();

    (async () => {
      try {
        const room = await api.getUserChatRoom(chatAgentId);
        if (cancelled) return;
        setChatRoomName(room.name);
        setUserChatRoomId(room.room_id);
        useOwnerChatStore.getState().setRoom(room.room_id, room.name || chatAgentId);
        await useOwnerChatStore.getState().loadInitial(room.room_id);
        if (cancelled) return;
        // Historical messages must not replay the typewriter animation. Populate
        // animatedRef synchronously here so the first render that sees them
        // already considers them animated.
        for (const msg of useOwnerChatStore.getState().messages) {
          animatedRef.current.add(msg.clientId);
        }
        initialLoadRef.current = false;
      } catch (err: any) {
        if (cancelled) return;
        setInitError(err?.message || "Failed to initialize chat");
      } finally {
        if (!cancelled) setInitializingRoom(false);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatAgentId]);

  // ------ Scroll to bottom once initial messages render ------
  useEffect(() => {
    if (!loading && messages.length > 0 && prevLengthRef.current === 0) {
      requestAnimationFrame(() => {
        const el = scrollContainerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [loading, messages]);

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

  const uploadFiles = useCallback(async (rawFiles: File[]): Promise<Attachment[]> => {
    const results: Attachment[] = [];
    for (const file of rawFiles) {
      const res = await api.uploadFile(file, chatAgentId);
      results.push({
        filename: res.original_filename,
        url: res.url,
        content_type: res.content_type,
        size_bytes: res.size_bytes,
      });
    }
    return results;
  }, [chatAgentId]);

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
      const result = await api.sendUserChatMessage(text, attachments, chatAgentId || undefined);
      useOwnerChatStore.getState().confirmOptimistic(clientId, result.hub_msg_id, new Date().toISOString(), attachments);
    } catch (err: any) {
      useOwnerChatStore.getState().failOptimistic(clientId, err?.message || "Failed to send");
    }
  }, [wsClientRef, wsConnected, chatAgentId]);

  const handleSend = useCallback(async (text: string, rawFiles: File[]) => {
    if ((!text && rawFiles.length === 0) || !roomId) return;

    const clientId = crypto.randomUUID();
    const displayText = text || (rawFiles.length > 0 ? `[${rawFiles.length} file(s)]` : "");

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
      const attachments = rawFiles.length > 0 ? await uploadFiles(rawFiles) : undefined;
      await sendMessage(text, clientId, attachments);
    } catch (err: any) {
      useOwnerChatStore.getState().failOptimistic(clientId, err?.message || "Upload failed");
    }
  }, [roomId, sendMessage, uploadFiles, scrollToBottom]);

  const handleRetry = useCallback(async (msg: OwnerChatMessage) => {
    useOwnerChatStore.getState().resetForRetry(msg.clientId);
    try {
      let attachments = msg.attachments;
      if (!attachments && msg.retryFiles && msg.retryFiles.length > 0) {
        attachments = await uploadFiles(msg.retryFiles);
      }
      await sendMessage(msg.sendText || msg.text, msg.clientId, attachments);
    } catch (err: any) {
      useOwnerChatStore.getState().failOptimistic(msg.clientId, err?.message || "Retry failed");
    }
  }, [sendMessage, uploadFiles]);

  // ------ Render guards ------

  if (!chatAgentId) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <p>Select a Bot to start chatting</p>
      </div>
    );
  }

  if (initializingRoom || loading) {
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
  const handleMobileBack = () => {
    if (agentId) {
      setSelectedBotAgentId(null);
      router.push("/chats/bots");
      return;
    }
    setMessagesPane("room");
    router.push("/chats/messages");
  };

  return (
    <div className="relative flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 max-md:px-3">
        <button
          type="button"
          onClick={handleMobileBack}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary max-md:inline-flex"
          aria-label="Back"
          title="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={openMobileSidebar}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary max-md:inline-flex"
          aria-label={agentId ? "Open bot list" : "Open message list"}
          title={agentId ? "Open bot list" : "Open message list"}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <MessageSquare className="w-4 h-4 text-cyan-400" />
        <h2 className="min-w-0 truncate text-sm font-medium text-zinc-200">
          {chatRoomName || "Agent"}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          {wsConnected && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Live" />
          )}
          {ownedAgent && (
            <button
              type="button"
              onClick={() => setAgentSettingsOpen(true)}
              title={settingsLabel}
              aria-label={settingsLabel}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-2.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span>{settingsLabel}</span>
            </button>
          )}
        </div>
      </div>

      {agentSettingsOpen && ownedAgent && (
        <AgentSettingsDrawer
          agentId={ownedAgent.agent_id}
          displayName={ownedAgent.display_name}
          bio={ownedAgent.bio ?? null}
          onClose={() => setAgentSettingsOpen(false)}
        />
      )}

      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {hasMore && (
          <div className="mb-1 text-center text-xs text-zinc-500 animate-pulse">
            Scroll up for older messages
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.sender === "user";
          const isNotification = msg.type === "notification";
          const isErrorMessage = msg.type === "error";
          const errorPayload =
            msg.payload?.error && typeof msg.payload.error === "object"
              ? msg.payload.error as Record<string, unknown>
              : null;
          const errorCode = typeof errorPayload?.code === "string" ? errorPayload.code : null;
          const errorText =
            typeof errorPayload?.message === "string"
              ? errorPayload.message
              : msg.text || "Runtime error";

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

          if (isErrorMessage) {
            return (
              <div key={msg.clientId} className="space-y-1.5">
                <div className="flex justify-start">
                  <div className="max-w-[75%] rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-purple-400/30 bg-purple-400/10 text-purple-300">
                        <Bot className="h-2.5 w-2.5" />
                      </span>
                      <span className="text-xs font-medium text-zinc-300">{msg.senderName}</span>
                      {chatAgentId && (
                        <CopyableId value={chatAgentId} className="text-zinc-500 hover:text-zinc-300" />
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setErrorDetailsId(msg.clientId)}
                      className="flex w-full items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/10 px-2.5 py-2 text-left transition-colors hover:bg-amber-400/15"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold uppercase tracking-wide text-amber-300">
                          Runtime error
                        </span>
                        <span className="mt-1 line-clamp-3 block break-words text-sm leading-relaxed text-amber-100">
                          {errorText}
                        </span>
                        <span className="mt-1 block text-xs text-amber-300/70">Details</span>
                      </span>
                    </button>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500">
                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className="rounded bg-amber-400/10 px-1 font-mono text-[10px] text-amber-300/80">
                        error
                      </span>
                    </div>
                  </div>
                </div>
                {errorDetailsId === msg.clientId && (
                  <RuntimeErrorDetailsDialog
                    message={errorText}
                    code={errorCode}
                    payload={msg.payload}
                    onClose={() => setErrorDetailsId(null)}
                  />
                )}
              </div>
            );
          }

          // --- Streaming agent message ---
          if (msg.status === "streaming") {
            return (
              <div key={msg.clientId} className="space-y-1.5">
                <StreamBlocksView
                  key={`${msg.clientId}-streaming`}
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
                  <div className="mb-1 flex items-center justify-end gap-1.5">
                    <span className="text-xs font-medium text-cyan-100/90">
                      {msg.senderName}
                    </span>
                    <span
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10 text-cyan-200"
                      title="Human"
                      aria-label="Human sender"
                    >
                      <User className="h-2.5 w-2.5" />
                    </span>
                  </div>
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
                <StreamBlocksView key={`${msg.clientId}-delivered`} blocks={msg.streamBlocks} />
              )}
              <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                    isUser
                      ? "bg-cyan-500/20 text-cyan-100 border border-cyan-500/30"
                      : "bg-zinc-800 text-zinc-200 border border-zinc-700"
                  }`}
                >
                  <div className={`mb-1 flex items-center gap-1.5 ${isUser ? "justify-end" : ""}`}>
                    {isUser ? (
                      <>
                        <span className="text-xs font-medium text-cyan-100/90">
                          {msg.senderName}
                        </span>
                        <span
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10 text-cyan-200"
                          title="Human"
                          aria-label="Human sender"
                        >
                          <User className="h-2.5 w-2.5" />
                        </span>
                      </>
                    ) : (
                      <>
                        <span
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-purple-400/30 bg-purple-400/10 text-purple-300"
                          title="Bot"
                          aria-label="Bot sender"
                        >
                          <Bot className="h-2.5 w-2.5" />
                        </span>
                      <span className="text-xs font-medium text-zinc-300">
                        {msg.senderName}
                      </span>
                      {chatAgentId && (
                        <CopyableId value={chatAgentId} className="text-zinc-500 hover:text-zinc-300" />
                      )}
                      </>
                    )}
                  </div>
                  {/* Typewriter for new agent messages; skip if already animated or was streamed */}
                  {(() => {
                    const wasStreamed = msg.traceId && streamedTraceIds.current?.has(msg.traceId);
                    if (wasStreamed) {
                      // Mark as animated and clean up traceId to avoid memory leak
                      animatedRef.current.add(msg.clientId);
                      streamedTraceIds.current.delete(msg.traceId!);
                    }
                    const skipTypewriter = isUser || initialLoadRef.current || animatedRef.current.has(msg.clientId);
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
      <div className="border-t border-zinc-800 px-4 py-3">
        <MessageComposer
          onSend={handleSend}
          allowAttachments
          placeholder="输入消息，@ 可引用联系人或房间..."
          mentionCandidates={mentionCandidates}
        />
      </div>
    </div>
  );
}
