"use client";

/**
 * [INPUT]: 依赖 dashboard session/chat/ui store 与 user-chat API，维护"用户 <-> 当前 active agent"私聊房间的初始化、消息发送与轻量流式感知
 * [OUTPUT]: 对外提供 UserChatPane 组件，渲染固定私聊入口对应的一对一会话正文与输入框
 * [POS]: dashboard messages 视图里的特殊会话面板，被 `messages/__user-chat__` 深链与左侧固定入口消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Send, Loader2, MessageSquare, AlertCircle, RotateCcw, ChevronDown, ChevronRight, Wrench, Brain, Bot, Search, FileText, CheckCircle2, Code2, HelpCircle, Bell, Paperclip, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Attachment, DashboardMessage, UserChatRoom, StreamBlockEntry } from "@/lib/types";
import { createOwnerChatWs, type OwnerChatWsClient, type WsAttachment } from "@/lib/owner-chat-ws";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useOwnerChatStreamStore } from "@/store/useOwnerChatStreamStore";
import DashboardMessagePaneSkeleton from "./DashboardMessagePaneSkeleton";
import MarkdownContent from "@/components/ui/MarkdownContent";
import ToolResultContent from "./ToolResultContent";
import CopyableId from "@/components/ui/CopyableId";
import { useShallow } from "zustand/react/shallow";
import { createClient } from "@/lib/supabase/client";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

interface PendingAttachment {
  file: File;
  preview?: string; // Object URL for image preview
  uploaded?: Attachment; // Populated after upload completes
  uploading?: boolean;
  error?: string;
}

interface PendingMessage {
  id: string;
  /** Display text shown in the UI bubble */
  text: string;
  /** Actual text sent in the message payload (may be empty for file-only sends) */
  sendText: string;
  /** Uploaded attachment metadata (set after successful upload) */
  attachments?: Attachment[];
  /** Original files for retry if upload failed */
  retryFiles?: File[];
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

/** Icon for a tool_call based on tool name heuristics. */
function ToolCallIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  if (n.includes("search") || n.includes("find") || n.includes("query")) {
    return <Search className="w-3 h-3 text-cyan-400 shrink-0" />;
  }
  if (n.includes("read") || n.includes("get") || n.includes("fetch") || n.includes("list")) {
    return <FileText className="w-3 h-3 text-cyan-400 shrink-0" />;
  }
  return <Code2 className="w-3 h-3 text-cyan-400 shrink-0" />;
}

/** Summarize tool_call params into a short one-liner. */
function summarizeParams(params: Record<string, unknown> | undefined): string | null {
  if (!params || Object.keys(params).length === 0) return null;
  // Show the first meaningful string param value, truncated
  for (const v of Object.values(params)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 60 ? v.slice(0, 60) + "..." : v;
    }
  }
  return null;
}

/** Truncate a tool_result to a short inline preview. */
function summarizeResult(result: string): string {
  // Try to extract text content from JSON results (only if it looks like JSON)
  if (result.startsWith("{") || result.startsWith("[")) {
    try {
      const parsed = JSON.parse(result);
      if (parsed?.content?.[0]?.text) {
        const text = parsed.content[0].text as string;
        return text.length > 120 ? text.slice(0, 120) + "..." : text;
      }
    } catch { /* not valid JSON, use raw */ }
  }
  return result.length > 120 ? result.slice(0, 120) + "..." : result;
}

/** Render a single execution block with type-specific styling. */
function StreamBlockItem({ block }: { block: StreamBlockEntry }) {
  const { kind, payload } = block.block;
  const [resultExpanded, setResultExpanded] = useState(false);

  // Extract result string for tool_result blocks; empty for other kinds.
  const resultStr = kind === "tool_result" ? String(payload?.result ?? "") : "";

  if (kind === "tool_call") {
    const name = (payload?.name as string) || "tool";
    const params = payload?.params as Record<string, unknown> | undefined;
    const paramHint = summarizeParams(params);
    return (
      <div className="flex items-start gap-2 py-1">
        <ToolCallIcon name={name} />
        <div className="min-w-0">
          <span className="text-xs font-mono text-cyan-400">{name}</span>
          {paramHint && (
            <p className="text-[10px] text-zinc-500 truncate mt-0.5">{paramHint}</p>
          )}
        </div>
      </div>
    );
  }

  if (kind === "tool_result") {
    const name = (payload?.name as string) || "tool";
    return (
      <div className="py-1">
        <button
          onClick={() => resultStr && setResultExpanded(!resultExpanded)}
          className="flex items-center gap-2 group"
        >
          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
          <span className="text-xs font-mono text-emerald-400">{name}</span>
          <span className="text-[10px] text-zinc-500">returned</span>
          {resultStr && (
            resultExpanded
              ? <ChevronDown className="w-2.5 h-2.5 text-zinc-500" />
              : <ChevronRight className="w-2.5 h-2.5 text-zinc-500" />
          )}
        </button>
        {resultStr && !resultExpanded && (
          <p className="mt-0.5 ml-5 text-[10px] text-zinc-500 truncate max-w-[400px]">
            {summarizeResult(resultStr)}
          </p>
        )}
        {resultStr && resultExpanded && (
          <ToolResultContent result={resultStr} toolName={name} />
        )}
      </div>
    );
  }

  if (kind === "reasoning") {
    const text = (payload?.text as string) || "";
    return (
      <div className="flex items-start gap-2 py-1">
        <Brain className="w-3 h-3 text-purple-400 shrink-0 mt-0.5" />
        <p className="text-xs text-purple-300/70 italic leading-relaxed line-clamp-3">
          {text}
        </p>
      </div>
    );
  }

  // Unknown kind fallback
  return (
    <div className="flex items-center gap-2 py-1">
      <HelpCircle className="w-3 h-3 text-zinc-500 shrink-0" />
      <span className="text-xs text-zinc-500 font-mono">{kind}</span>
    </div>
  );
}

/** Collapsible execution block group — used for both active and finalized blocks. */
function StreamBlocksView({
  blocks,
  defaultExpanded,
  onScrollRequest,
}: {
  blocks: StreamBlockEntry[];
  /** When true, starts expanded (for active/in-progress blocks). */
  defaultExpanded?: boolean;
  onScrollRequest?: () => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  // Separate assistant-visible text from execution blocks
  const executionBlocks = blocks.filter(
    (b) => b.block.kind !== "assistant",
  );
  const assistantBlocks = blocks.filter(
    (b) => b.block.kind === "assistant",
  );

  // Count tool calls for summary
  const toolCallCount = executionBlocks.filter((b) => b.block.kind === "tool_call").length;
  const reasoningCount = executionBlocks.filter((b) => b.block.kind === "reasoning").length;

  useEffect(() => {
    onScrollRequest?.();
  }, [blocks.length, onScrollRequest]);

  if (blocks.length === 0) return null;

  // Build summary text
  const summaryParts: string[] = [];
  if (toolCallCount > 0) summaryParts.push(`${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}`);
  if (reasoningCount > 0) summaryParts.push(`${reasoningCount} reasoning`);
  if (summaryParts.length === 0) summaryParts.push(`${executionBlocks.length} step${executionBlocks.length !== 1 ? "s" : ""}`);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        {/* Execution blocks (tool_call, tool_result, reasoning) */}
        {executionBlocks.length > 0 && (
          <div className="rounded-lg border border-zinc-700/40 bg-zinc-900/40 overflow-hidden">
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
              <span>{summaryParts.join(", ")}</span>
            </button>
            {expanded && (
              <div className="border-t border-zinc-800/60 px-3 py-1 divide-y divide-zinc-800/40">
                {executionBlocks.map((block) => (
                  <StreamBlockItem key={`${block.trace_id}-${block.seq}`} block={block} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Streamed assistant text (inline, only during active execution) */}
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
  const { activeBlocks, finalizedBlocks, addStreamBlock, finalizeTrace, clearTrace, setWsConnected, wsConnected } = useOwnerChatStreamStore();

  const [chatRoom, setChatRoom] = useState<UserChatRoom | null>(null);
  const [inputText, setInputText] = useState("");
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  // Grace period: suppress stale typing events arriving shortly after an agent message.
  // Scoped to room_id so a room rebind via onAuthOk doesn't carry over stale state.
  const lastAgentMsgRef = useRef<{ roomId: string; at: number } | null>(null);
  // Track trace_ids that received assistant stream blocks (text already shown to user)
  const streamedTraceIds = useRef<Set<string>>(new Set());

  // Initialize chat room and load messages (userChatRoomId is set eagerly by DashboardApp)
  useEffect(() => {
    if (!activeAgentId) return;

    // Reset grace period when switching agents to avoid cross-session suppression
    lastAgentMsgRef.current = null;

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
      onTyping: () => {
        // Suppress stale typing events that arrive shortly after an agent
        // message (e.g. from a keepalive tick race in the SDK).
        const grace = lastAgentMsgRef.current;
        if (grace && grace.roomId === chatRoom.room_id && Date.now() - grace.at < 5_000) return;
        setUserChatAgentTyping(true);
      },
      onMessage: (msg) => {
        const roomId = msg.room_id || chatRoom.room_id;

        // Finalize stream blocks when final agent message arrives (keep them collapsed)
        if (msg.sender === "agent" && msg.ext?.trace_id) {
          // If assistant text was already streamed (shown in "Composing..." panel),
          // skip the typewriter animation — user has already read the content.
          if (streamedTraceIds.current.has(msg.ext.trace_id as string)) {
            animatedRef.current.add(msg.hub_msg_id);
            streamedTraceIds.current.delete(msg.ext.trace_id as string);
          }
          finalizeTrace(msg.ext.trace_id as string, msg.hub_msg_id);
          activeTraceRef.current = null;
        }

        // Dismiss typing indicator on agent message
        if (msg.sender === "agent") {
          lastAgentMsgRef.current = { roomId: roomId, at: Date.now() };
          setUserChatAgentTyping(false);
        }

        // Insert directly into chat store
        const payload: Record<string, unknown> = {};
        if (msg.ext?.attachments) {
          payload.attachments = msg.ext.attachments;
        }
        const dashMsg: DashboardMessage = {
          hub_msg_id: msg.hub_msg_id,
          msg_id: msg.hub_msg_id,
          sender_id: activeAgentId,
          sender_name: msg.sender === "user" ? "You" : (chatRoom.name || activeAgentId),
          type: "message",
          text: msg.text,
          payload,
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

        // Remove matching pending message (prefer client_msg_id, fall back to sendText)
        if (msg.sender === "user") {
          setPending((prev) => {
            const clientMsgId = (msg as any).client_msg_id as string | undefined;
            const match = clientMsgId
              ? prev.find((p) => p.id === clientMsgId)
              : prev.find((p) => p.sendText === msg.text);
            return match ? prev.filter((p) => p.id !== match.id) : prev;
          });
        }
      },
      onStreamBlock: (block) => {
        addStreamBlock(block);
        activeTraceRef.current = block.trace_id;
        if (block.block.kind === "assistant") {
          streamedTraceIds.current.add(block.trace_id);
        }
      },
      onNotification: (notif) => {
        const roomId = chatRoom.room_id;
        const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const dashMsg: DashboardMessage = {
          hub_msg_id: notifId,
          msg_id: notifId,
          sender_id: activeAgentId,
          sender_name: chatRoom.name || activeAgentId,
          type: "notification",
          text: notif.text,
          payload: {},
          room_id: roomId,
          topic: null,
          topic_id: null,
          goal: null,
          state: "delivered",
          state_counts: null,
          created_at: notif.created_at,
        };
        insertMessage(roomId, dashMsg);
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
          setUserChatAgentTyping(false);
        }
      },
      onSendFailed: (_text: string, clientMsgId?: string) => {
        // Mark the identified (or most recent) "sending" pending message as failed
        setPending((prev) => {
          const target = clientMsgId
            ? prev.find((p) => p.id === clientMsgId && p.status === "sending")
            : [...prev].reverse().find((p) => p.status === "sending");
          if (!target) return prev;
          return prev.map((p) =>
            p.id === target.id ? { ...p, status: "failed" as const, error: "WebSocket send failed" } : p
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
      && (message.text || "") === item.sendText
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

  // Revoke pending file object URLs on unmount
  useEffect(() => {
    return () => {
      setPendingFiles((prev) => {
        for (const pf of prev) {
          if (pf.preview) URL.revokeObjectURL(pf.preview);
        }
        return [];
      });
    };
  }, []);

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

  const sendMessage = useCallback(async (text: string, msgId: string, attachments?: Attachment[]) => {
    const wsAtts: WsAttachment[] | undefined = attachments?.map((a) => ({
      filename: a.filename,
      url: a.url,
      content_type: a.content_type,
      size_bytes: a.size_bytes,
    }));

    // If WS is connected, send via WS (no polling needed — WS delivers echo)
    if (wsClientRef.current && wsConnected) {
      const sent = wsClientRef.current.send(text, wsAtts, msgId);
      if (sent) {
        // WS echo will remove the pending message via onMessage callback.
        // onSendFailed callback handles the case where the socket closes after send.
        return;
      }
      // WS send failed — fall through to HTTP fallback
    }

    // Fallback to HTTP
    try {
      const result = await api.sendUserChatMessage(text, attachments);
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

  // Upload pending files and return Attachment array
  const uploadPendingFiles = useCallback(async (files: PendingAttachment[]): Promise<Attachment[]> => {
    const results: Attachment[] = [];
    for (const pf of files) {
      if (pf.uploaded) {
        results.push(pf.uploaded);
        continue;
      }
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

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || !roomId) return;

    // Snapshot and clear input immediately
    const filesToUpload = [...pendingFiles];
    setInputText("");
    setPendingFiles([]);
    if (inputRef.current) inputRef.current.value = "";
    // Revoke object URLs
    for (const pf of filesToUpload) {
      if (pf.preview) URL.revokeObjectURL(pf.preview);
    }

    const msgId = crypto.randomUUID();
    const rawFiles = filesToUpload.map((pf) => pf.file);
    const displayText = text || (rawFiles.length > 0 ? `[${rawFiles.length} file(s)]` : "");
    const pendingMsg: PendingMessage = {
      id: msgId,
      text: displayText,
      sendText: text,
      retryFiles: rawFiles.length > 0 ? rawFiles : undefined,
      createdAt: Date.now(),
      status: "sending",
    };
    setPending((prev) => [...prev, pendingMsg]);

    try {
      // Upload files first
      const attachments = filesToUpload.length > 0
        ? await uploadPendingFiles(filesToUpload)
        : undefined;
      // Persist attachments on the pending message so retry can resend them
      if (attachments) {
        setPending((prev) =>
          prev.map((m) => m.id === msgId ? { ...m, attachments, retryFiles: undefined } : m)
        );
      }
      await sendMessage(text, msgId, attachments);
    } catch (err: any) {
      setPending((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? { ...m, status: "failed" as const, error: err?.message || "Upload failed" }
            : m
        )
      );
    }
  }, [inputText, pendingFiles, roomId, sendMessage, uploadPendingFiles]);

  const handleRetry = useCallback(async (msg: PendingMessage) => {
    setPending((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, status: "sending" as const, error: undefined } : m))
    );
    try {
      // If upload never completed, re-upload from retryFiles
      let attachments = msg.attachments;
      if (!attachments && msg.retryFiles && msg.retryFiles.length > 0) {
        const pfs: PendingAttachment[] = msg.retryFiles.map((f) => ({ file: f }));
        attachments = await uploadPendingFiles(pfs);
        setPending((prev) =>
          prev.map((m) => m.id === msg.id ? { ...m, attachments, retryFiles: undefined } : m)
        );
      }
      await sendMessage(msg.sendText, msg.id, attachments);
    } catch (err: any) {
      setPending((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? { ...m, status: "failed" as const, error: err?.message || "Retry failed" }
            : m
        )
      );
    }
  }, [sendMessage, uploadPendingFiles]);

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  // Handle drag and drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    handleFileSelect(e.dataTransfer.files);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

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
          const isNotification = msg.type === "notification";
          const msgFinalizedBlocks = finalizedBlocks[msg.hub_msg_id];

          if (isNotification) {
            return (
              <div key={msg.hub_msg_id} className="flex justify-center">
                <div className="max-w-[85%] rounded-lg px-3 py-2 text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20 flex items-start gap-2">
                  <Bell className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <div>
                    <MarkdownContent content={msg.text || ""} />
                    <div className="text-amber-500/60 mt-1 text-right">
                      {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div key={msg.hub_msg_id} className="space-y-1.5">
              {/* Finalized execution blocks above agent message */}
              {!isOwner && msgFinalizedBlocks && msgFinalizedBlocks.length > 0 && (
                <StreamBlocksView blocks={msgFinalizedBlocks} />
              )}
              <div className={`flex ${isOwner ? "justify-end" : "justify-start"}`}>
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
                    const atts = msg.payload?.attachments as Array<{ url: string; filename?: string; content_type?: string; size_bytes?: number }> | undefined;
                    if (!atts || atts.length === 0) return null;
                    return (
                      <div className="mt-2 space-y-1.5">
                        {atts.map((att, idx) => {
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
                    );
                  })()}
                  <div className="text-xs text-zinc-500 mt-1 text-right">
                    {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Stream blocks (active execution in progress) */}
        {currentStreamBlocks.length > 0 && (
          <StreamBlocksView
            blocks={currentStreamBlocks}
            defaultExpanded
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
      <div className="border-t border-zinc-800 px-4 py-3" onDrop={handleDrop} onDragOver={handleDragOver}>
        {/* Pending file previews */}
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
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:border-cyan-500/50 min-h-[40px] max-h-[120px]"
            placeholder="Type a message..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
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
