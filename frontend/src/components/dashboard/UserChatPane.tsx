"use client";

import Badge from "@/components/ui/Badge";
import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
import MessageHistoryControl from "./MessageHistoryControl";
import { useMessageHistoryScroll } from "./useMessageHistoryScroll";

/**
 * Owner-chat pane — renders a 1:1 conversation between the user and a managed Bot.
 *
 * Architecture (post-refactor):
 *   - Single rendered source: useOwnerChatStore.messages[]; dashboard room
 *     history cache hydrates immediately and refreshes via a shared request.
 *   - Room discovery: shared with the shell; late account/target results are ignored.
 *   - WS lifecycle: useOwnerChatWs hook
 *   - Rendering: status-driven (optimistic / streaming / delivered / failed)
 */

import ChatMarkdown from "./ChatMarkdown";
import ParticipantAvatar from "./ParticipantAvatar";
import ComposerPopover from "./ComposerPopover";
import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo, memo } from "react";
import { ArrowDown, ArrowLeft, Check, Copy, CornerUpLeft, Forward, Loader2, MessageSquare, MoreHorizontal, AlertCircle, AlertTriangle, RotateCcw, Bell, Settings2, X } from "lucide-react";
import { useRouter } from "nextjs-toploader/app";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { formatMessageTimestamp } from "@/lib/message-time";
import type { Attachment, OwnerChatMessage } from "@/lib/types";
import type { WsAttachment } from "@/lib/owner-chat-ws";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useMentionCandidates } from "@/hooks/useMentionCandidates";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { findCachedOwnerChatRoom, useOwnerChatStore } from "@/store/useOwnerChatStore";
import { messageCacheOwnerKey, useDashboardChatStore } from "@/store/useDashboardChatStore";
import { resolveOwnerChatRoom } from "@/lib/owner-chat-room";
import { useOwnerChatWs } from "@/hooks/useOwnerChatWs";
import { messageList } from "@/lib/i18n/translations/dashboard";
import DashboardMessagePaneSkeleton, { MessageHistoryLoading } from "./DashboardMessagePaneSkeleton";
import { normalizeMessageContent, type MentionTextCandidate } from "@/components/ui/MarkdownContent";
import AttachmentItem, {
  attachmentGalleryIndex,
  getPreviewableImageAttachments,
  isImageAttachment,
  rememberFailedAttachmentImageUrl,
  resolveAttachmentUrl,
} from "@/components/ui/AttachmentItem";
import ImagePreviewOverlay from "@/components/ui/ImagePreviewOverlay";
import StreamBlocksView, { buildComposingText } from "./StreamBlocksView";
import DocumentPreviewPane from "./DocumentPreviewPane";
import RuntimeErrorDetailsDialog from "./RuntimeErrorDetailsDialog";
import MessageComposer from "./MessageComposer";
import ReplyQuoteBlock from "./ReplyQuoteBlock";
import ForwardModal from "./ForwardModal";
import {
  buildOwnerChatForwardQuote,
  buildOwnerChatReplyPreview,
  canReplyToOwnerChatMessage,
  canShowOwnerChatMessageActions,
  ownerChatReplyTargetId,
} from "@/lib/owner-chat-actions";
import {
  captureVisibleMessageScrollAnchor,
  isNearScrollBottom,
  restoreVisibleMessageScrollAnchor,
  scrollToLatestVisibleAfterScroll,
  shouldShowScrollToLatestForNewContent,
  type VisibleMessageScrollAnchor,
} from "./messageScroll";
import { animateFadeUp, animateIfMotion, animatePop, cleanupAnime } from "@/lib/anime";

const OWNER_CHAT_ENTRANCE_SETTLE_MS = 1200;
type AttachmentPreviewState =
  | { kind: "document"; attachment: Attachment }
  | { kind: "image"; attachments: Attachment[]; index: number };

// ---------------------------------------------------------------------------
// TypewriterText
// ---------------------------------------------------------------------------

function TypewriterText({
  text,
  onComplete,
  onTick,
  mentionCandidates,
}: {
  text: string;
  onComplete?: () => void;
  onTick?: () => void;
  mentionCandidates?: MentionTextCandidate[];
}) {
  const normalizedText = normalizeMessageContent(text);
  const tokens = normalizedText.split(/(\s+)/);
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

  return <ChatMarkdown content={tokens.slice(0, count).join("")} mentionCandidates={mentionCandidates} />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default memo(UserChatPane);

function UserChatPane({ agentId }: { agentId?: string | null }) {
  const locale = useLanguage();
  const router = useRouter();
  const activeAgentId = useDashboardSessionStore((s) => s.activeAgentId);
  const ownerHumanId = useDashboardSessionStore((s) => s.human?.human_id ?? null);
  const humanAvatarUrl = useDashboardSessionStore((s) => s.human?.avatar_url || s.user?.avatar_url || null);
  const hasSession = useDashboardSessionStore((s) => Boolean(s.token));
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const chatAgentId = agentId || activeAgentId || null;
  const setSelectedBotAgentId = useDashboardUIStore((s) => s.setSelectedBotAgentId);
  const setUserChatRoomId = useDashboardUIStore((s) => s.setUserChatRoomId);
  const setBotDetailAgentId = useDashboardUIStore((s) => s.setBotDetailAgentId);
  const ownedAgent = chatAgentId
    ? ownedAgents.find((a) => a.agent_id === chatAgentId) ?? null
    : null;

  const mentionCandidates = useMentionCandidates({ selfId: chatAgentId });

  const messageMentionCandidates = useMemo(() => mentionCandidates.map((candidate) => ({ id: candidate.agent_id, label: candidate.display_name })), [mentionCandidates]);

  // Owner-chat store
  const messages = useOwnerChatStore((s) => s.messages);
  const hasMore = useOwnerChatStore((s) => s.hasMore);
  const loading = useOwnerChatStore((s) => s.loading);
  const historyLoaded = useOwnerChatStore((s) => s.historyLoaded);
  const loadingMore = useOwnerChatStore((s) => s.loadingMore);
  const moreError = useOwnerChatStore((s) => s.moreError);
  const storeError = useOwnerChatStore((s) => s.error);
  const wsConnected = useOwnerChatStore((s) => s.wsConnected);
  const agentTyping = useOwnerChatStore((s) => s.agentTyping);
  const activeTraceId = useOwnerChatStore((s) => s.activeTraceId);
  const roomId = useOwnerChatStore((s) => s.roomId);
  const replyingTo = useOwnerChatStore((s) => s.replyingTo);

  const [chatRoomName, setChatRoomName] = useState("");
  const [initializingRoom, setInitializingRoom] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [errorDetailsId, setErrorDetailsId] = useState<string | null>(null);
  const [hoveredActionId, setHoveredActionId] = useState<string | null>(null);
  const actionAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [actionMenuOpenId, setActionMenuOpenId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [forwardQuote, setForwardQuote] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
  const settingsLabel = locale === "zh" ? "Bot 设置" : "Bot settings";
  const replyLabel = locale === "zh" ? "回复" : "Reply";
  const forwardLabel = locale === "zh" ? "转发" : "Forward";
  const copyLabel = locale === "zh" ? "复制" : "Copy";
  const copiedLabel = locale === "zh" ? "已复制" : "Copied";
  const tMessages = messageList[locale];
  const scrollToLatestLabel = tMessages.scrollToLatest;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollToBottomButtonElementRef = useRef<HTMLButtonElement>(null);
  const typingIndicatorRef = useRef<HTMLDivElement>(null);
  const animatedRef = useRef<Set<string>>(new Set());
  const entranceAnimatedRef = useRef<Set<string>>(new Set());
  const entrancePrimedRef = useRef(false);
  const roomOpenedAtRef = useRef(0);
  const previousStatusRef = useRef<Map<string, OwnerChatMessage["status"]>>(new Map());
  const motionHandlesRef = useRef<Set<ReturnType<typeof animateIfMotion>>>(new Set());
  const initialLoadRef = useRef(true);
  const isLoadingMore = useRef(false);
  const historyPrependAppliedRef = useRef(false);
  const historyAnchorRef = useRef<{
    roomId: string;
    oldestMessageKey: string | null;
    visibleMessage: VisibleMessageScrollAnchor | null;
  } | null>(null);
  const prevLengthRef = useRef(0);
  const prevMessageContentSignatureRef = useRef("");
  const wasNearBottomRef = useRef(true);
  const showScrollToBottomButtonRef = useRef(false);
  const [showScrollToBottomButton, setShowScrollToBottomButton] = useState(false);
  const [, forceRender] = useState(0);

  const registerMotion = useCallback((animation: ReturnType<typeof animateIfMotion>) => {
    if (!animation) return;
    motionHandlesRef.current.add(animation);
    window.setTimeout(() => {
      motionHandlesRef.current.delete(animation);
    }, 1600);
  }, []);

  useEffect(() => {
    return () => {
      motionHandlesRef.current.forEach(cleanupAnime);
      motionHandlesRef.current.clear();
    };
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    wasNearBottomRef.current = true;
    showScrollToBottomButtonRef.current = false;
    setShowScrollToBottomButton(false);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const scrollToBottomAfterLayout = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToBottom());
    });
  }, [scrollToBottom]);

  const scrollToBottomIfFollowing = useCallback(() => {
    if (wasNearBottomRef.current) {
      scrollToBottom();
    }
  }, [scrollToBottom]);

  const handlePreviewAttachment = useCallback((attachment: Attachment, previewAttachments?: Attachment[]) => {
    if (isImageAttachment(attachment)) {
      const gallery = getPreviewableImageAttachments(
        previewAttachments && previewAttachments.length > 0 ? previewAttachments : [attachment],
      );
      const index = attachmentGalleryIndex(gallery, attachment);
      setAttachmentPreview({
        kind: "image",
        attachments: gallery.length > 0 ? gallery : [attachment],
        index: index >= 0 ? index : 0,
      });
      return;
    }

    setAttachmentPreview({ kind: "document", attachment });
  }, []);

  // WS hook authenticates the selected owner-chat target explicitly.
  const { wsClientRef, streamedTraceIds } = useOwnerChatWs({
    activeAgentId: chatAgentId,
    roomId,
    agentName: chatRoomName || chatAgentId || "",
  });

  // ------ Initialize chat room and load messages ------
  useLayoutEffect(() => {
    if (!chatAgentId || !hasSession) return;
    let cancelled = false;
    const ownerKey = messageCacheOwnerKey();

    // Reset store for fresh agent
    setInitError(null);
    setChatRoomName("");
    setInitializingRoom(true);
    initialLoadRef.current = true;
    prevLengthRef.current = 0;
    prevMessageContentSignatureRef.current = "";
    wasNearBottomRef.current = true;
    entrancePrimedRef.current = false;
    roomOpenedAtRef.current = performance.now();
    historyAnchorRef.current = null;
    historyPrependAppliedRef.current = false;
    previousStatusRef.current = new Map();
    showScrollToBottomButtonRef.current = false;
    setShowScrollToBottomButton(false);
    animatedRef.current.clear();
    entranceAnimatedRef.current.clear();
    setAttachmentPreview(null);
    const cachedRoom = findCachedOwnerChatRoom(chatAgentId);
    if (!cachedRoom || useOwnerChatStore.getState().roomId !== cachedRoom.room_id) {
      useOwnerChatStore.getState().reset();
    }

    (async () => {
      try {
        const room = cachedRoom ?? await resolveOwnerChatRoom(chatAgentId);
        if (cancelled || messageCacheOwnerKey() !== ownerKey) return;
        useDashboardChatStore.getState().upsertOptimisticOwnerChatRoom({
          agent_id: chatAgentId,
          display_name: ownedAgent?.display_name || room.name || chatAgentId,
        }, room.room_id);
        setChatRoomName(room.name);
        setUserChatRoomId(room.room_id);
        useOwnerChatStore.getState().setRoom(room.room_id, room.name || chatAgentId);
        const initialRequest = useOwnerChatStore.getState().loadInitial(room.room_id);
        // loadInitial applies a prefetched (even empty) snapshot synchronously.
        // Expose it while the shared history request refreshes in the background.
        setInitializingRoom(false);
        for (const msg of useOwnerChatStore.getState().messages) {
          animatedRef.current.add(msg.clientId);
          entranceAnimatedRef.current.add(msg.clientId);
        }
        await initialRequest;
        if (cancelled || messageCacheOwnerKey() !== ownerKey) return;
        // Historical messages must not replay the typewriter animation. Populate
        // animatedRef synchronously here so the first render that sees them
        // already considers them animated.
        for (const msg of useOwnerChatStore.getState().messages) {
          animatedRef.current.add(msg.clientId);
          entranceAnimatedRef.current.add(msg.clientId);
        }
        entrancePrimedRef.current = true;
        previousStatusRef.current = new Map(
          useOwnerChatStore.getState().messages.map((msg) => [msg.clientId, msg.status]),
        );
        initialLoadRef.current = false;
        // Restore in-flight stream blocks for any user message still awaiting a
        // final reply (refresh/reconnect recovery). Best-effort; never throws.
        void useOwnerChatStore.getState().restoreActiveRuns(chatAgentId);
      } catch (err: any) {
        if (cancelled || messageCacheOwnerKey() !== ownerKey) return;
        setInitError(err?.message || "Failed to initialize chat");
      } finally {
        if (!cancelled && messageCacheOwnerKey() === ownerKey) setInitializingRoom(false);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatAgentId, ownerHumanId, hasSession]);

  // ------ Scroll to bottom once initial messages render ------
  useEffect(() => {
    if (!loading && messages.length > 0 && prevLengthRef.current === 0) {
      scrollToBottomAfterLayout();
    }
  }, [loading, messages.length, scrollToBottomAfterLayout]);

  // ------ Scroll helpers ------

  const messageContentSignature = useMemo(() => {
    return messages.map((msg) => {
      const blockSignature = msg.streamBlocks
        .map((entry) => `${entry.trace_id}:${entry.seq}:${entry.block.kind}`)
        .join(",");
      return [
        msg.clientId,
        msg.status,
        msg.text,
        msg.attachments?.length ?? 0,
        blockSignature,
      ].join(":");
    }).join("|");
  }, [messages]);
  const hasStreamingMsg = messages.some((m) => m.status === "streaming");

  // Apply a history anchor only when the oldest message changes. A live
  // append can land while pagination is pending; anchoring to the visible
  // message keeps that append from being mistaken for prepended history.
  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    const container = scrollContainerRef.current;
    if (!anchor || !container) return;
    // Restore after the loading indicator is replaced by the history control.
    if (loadingMore) return;
    if (anchor.roomId !== roomId) {
      historyAnchorRef.current = null;
      return;
    }
    const currentOldestMessageKey = messages[0]?.clientId ?? null;
    if (currentOldestMessageKey === anchor.oldestMessageKey) return;
    if (anchor.visibleMessage) {
      restoreVisibleMessageScrollAnchor(
        container,
        "[data-owner-msg-key]",
        "data-owner-msg-key",
        anchor.visibleMessage,
      );
    }
    historyPrependAppliedRef.current = true;
    historyAnchorRef.current = null;
  }, [messages, roomId, loadingMore]);

  useEffect(() => {
    const loadingMoreAtChange = isLoadingMore.current;
    if (messages.length > prevLengthRef.current && !loadingMoreAtChange) {
      if (wasNearBottomRef.current) scrollToBottom();
      else if (shouldShowScrollToLatestForNewContent({
        wasNearBottom: wasNearBottomRef.current,
        hadPreviousContent: prevLengthRef.current > 0,
        isLoadingMore: isLoadingMore.current,
      })) {
        showScrollToBottomButtonRef.current = true;
        setShowScrollToBottomButton(true);
      }
    }
    prevLengthRef.current = messages.length;
    if (historyPrependAppliedRef.current) {
      historyPrependAppliedRef.current = false;
      isLoadingMore.current = false;
    }
  }, [messages.length, scrollToBottom, loadingMore]);

  useLayoutEffect(() => {
    const previousSignature = prevMessageContentSignatureRef.current;
    prevMessageContentSignatureRef.current = messageContentSignature;
    if (!previousSignature || previousSignature === messageContentSignature || isLoadingMore.current) return;

    if (wasNearBottomRef.current) {
      scrollToBottomAfterLayout();
    } else if (shouldShowScrollToLatestForNewContent({
      wasNearBottom: wasNearBottomRef.current,
      hadPreviousContent: true,
      isLoadingMore: isLoadingMore.current,
    })) {
      showScrollToBottomButtonRef.current = true;
      setShowScrollToBottomButton(true);
    }
  }, [messageContentSignature, scrollToBottomAfterLayout]);

  useEffect(() => {
    if (messages.length === 0) return;
    const seenIds = entranceAnimatedRef.current;

    if (initialLoadRef.current || !entrancePrimedRef.current) {
      for (const msg of messages) seenIds.add(msg.clientId);
      entrancePrimedRef.current = true;
      return;
    }

    const newlyVisible = messages.filter((msg) => !seenIds.has(msg.clientId));
    for (const msg of messages) seenIds.add(msg.clientId);
    if (newlyVisible.length === 0 || isLoadingMore.current) return;
    if (performance.now() - roomOpenedAtRef.current < OWNER_CHAT_ENTRANCE_SETTLE_MS) return;

    const newlyVisibleIds = newlyVisible.map((msg) => msg.clientId);
    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      newlyVisibleIds.slice(-6).forEach((id, index) => {
        const el = container.querySelector<HTMLElement>(
          `[data-owner-msg-key="${CSS.escape(id)}"]`,
        );
        if (!el) return;
        registerMotion(animateIfMotion(el, {
          opacity: [0, 1],
          translateY: [10, 0],
          scale: [0.985, 1],
          duration: 340,
          delay: index * 24,
          ease: "out(3)",
        }));
      });
    });
  }, [messages, registerMotion]);

  useEffect(() => {
    if (messages.length === 0) {
      previousStatusRef.current = new Map();
      return;
    }

    const previousStatuses = previousStatusRef.current;
    const nextStatuses = new Map<string, OwnerChatMessage["status"]>();
    const newlyFailedIds: string[] = [];

    for (const msg of messages) {
      nextStatuses.set(msg.clientId, msg.status);
      if (msg.status === "failed" && previousStatuses.get(msg.clientId) !== "failed") {
        newlyFailedIds.push(msg.clientId);
      }
    }

    previousStatusRef.current = nextStatuses;
    if (initialLoadRef.current || newlyFailedIds.length === 0) return;

    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      newlyFailedIds.forEach((id) => {
        const el = container.querySelector<HTMLElement>(
          `[data-owner-msg-key="${CSS.escape(id)}"]`,
        );
        if (!el) return;
        registerMotion(animateIfMotion(el, {
          translateX: [0, -4, 4, -3, 3, 0],
          scale: [1, 1.012, 1],
          boxShadow: [
            "0 0 0 rgba(248, 113, 113, 0)",
            "0 0 16px rgba(248, 113, 113, 0.24)",
            "0 0 0 rgba(248, 113, 113, 0)",
          ],
          duration: 420,
          ease: "out(3)",
        }));
      });
    });
  }, [messages, registerMotion]);

  useEffect(() => {
    showScrollToBottomButtonRef.current = showScrollToBottomButton;
  }, [showScrollToBottomButton]);

  useEffect(() => {
    if (!showScrollToBottomButton || !scrollToBottomButtonElementRef.current) return;
    registerMotion(animatePop(scrollToBottomButtonElementRef.current));
  }, [showScrollToBottomButton, registerMotion]);

  useEffect(() => {
    if (!agentTyping || hasStreamingMsg || !typingIndicatorRef.current) return;
    registerMotion(animateFadeUp(typingIndicatorRef.current));
  }, [agentTyping, hasStreamingMsg, registerMotion]);

  const requestMoreMessages = useCallback(() => {
    const container = scrollContainerRef.current;
    const oldestMessage = messages[0];
    if (
      !container
      || !roomId
      || !hasMore
      || loadingMore
      || isLoadingMore.current
    ) {
      return;
    }

    const oldestMessageKey = oldestMessage?.clientId ?? null;
    const previousLength = messages.length;
    historyAnchorRef.current = {
      roomId,
      oldestMessageKey,
      visibleMessage: captureVisibleMessageScrollAnchor(
        container,
        "[data-owner-msg-key]",
        "data-owner-msg-key",
      ),
    };
    isLoadingMore.current = true;
    void useOwnerChatStore.getState().loadMore().finally(() => {
      const currentMessages = useOwnerChatStore.getState().messages;
      const currentOldestMessageKey = currentMessages[0]?.clientId ?? null;
      if (currentOldestMessageKey === oldestMessageKey || currentMessages.length === previousLength) {
        isLoadingMore.current = false;
        historyPrependAppliedRef.current = false;
        historyAnchorRef.current = null;
      }
    });
  }, [roomId, messages, hasMore, loadingMore]);

  useMessageHistoryScroll(scrollContainerRef, requestMoreMessages);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    wasNearBottomRef.current = isNearScrollBottom(el);
    const shouldShow = scrollToLatestVisibleAfterScroll(
      showScrollToBottomButtonRef.current,
      wasNearBottomRef.current,
    );
    if (showScrollToBottomButtonRef.current !== shouldShow) {
      showScrollToBottomButtonRef.current = shouldShow;
      setShowScrollToBottomButton(shouldShow);
    }
  }, []);

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

  const sendMessage = useCallback(async (
    text: string,
    clientId: string,
    attachments?: Attachment[],
    replyTo?: string | null,
  ) => {
    const wsAtts: WsAttachment[] | undefined = attachments?.map((a) => ({
      filename: a.filename, url: a.url, content_type: a.content_type, size_bytes: a.size_bytes,
    }));

    // Try WS first
    if (wsClientRef.current && wsConnected) {
      const sent = wsClientRef.current.send(text, wsAtts, clientId, replyTo);
      if (sent) return;
    }

    // HTTP fallback
    try {
      const result = await api.sendUserChatMessage(text, attachments, chatAgentId || undefined, replyTo);
      useOwnerChatStore.getState().confirmOptimistic(clientId, result.hub_msg_id, new Date().toISOString(), attachments);
    } catch (err: any) {
      useOwnerChatStore.getState().failOptimistic(clientId, err?.message || "Failed to send");
    }
  }, [wsClientRef, wsConnected, chatAgentId]);

  const handleSend = useCallback(async (text: string, rawFiles: File[]) => {
    if ((!text && rawFiles.length === 0) || !roomId) return;

    const clientId = crypto.randomUUID();
    const displayText = text || (rawFiles.length > 0 ? `[${rawFiles.length} file(s)]` : "");
    const replyTargetMsgId = replyingTo ? ownerChatReplyTargetId(replyingTo) : null;
    const optimisticReplyPreview = replyingTo && replyTargetMsgId
      ? buildOwnerChatReplyPreview(replyingTo)
      : null;

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
      retryReplyTo: replyTargetMsgId,
      replyPreview: optimisticReplyPreview ?? undefined,
    };
    useOwnerChatStore.getState().addOptimistic(optimisticMsg);
    if (replyTargetMsgId) {
      useOwnerChatStore.getState().setReplyingTo(null);
    }
    scrollToBottom();

    try {
      const attachments = rawFiles.length > 0 ? await uploadFiles(rawFiles) : undefined;
      await sendMessage(text, clientId, attachments, replyTargetMsgId);
    } catch (err: any) {
      useOwnerChatStore.getState().failOptimistic(clientId, err?.message || "Upload failed");
    }
  }, [roomId, replyingTo, sendMessage, uploadFiles, scrollToBottom]);

  const handleRetry = useCallback(async (msg: OwnerChatMessage) => {
    useOwnerChatStore.getState().resetForRetry(msg.clientId);
    try {
      let attachments = msg.attachments;
      if (!attachments && msg.retryFiles && msg.retryFiles.length > 0) {
        attachments = await uploadFiles(msg.retryFiles);
      }
      await sendMessage(msg.sendText || msg.text, msg.clientId, attachments, msg.retryReplyTo);
    } catch (err: any) {
      useOwnerChatStore.getState().failOptimistic(msg.clientId, err?.message || "Retry failed");
    }
  }, [sendMessage, uploadFiles]);

  const handleReply = useCallback((msg: OwnerChatMessage) => {
    setActionMenuOpenId(null);
    if (!canReplyToOwnerChatMessage(msg)) return;
    useOwnerChatStore.getState().setReplyingTo(msg);
  }, []);

  const handleForward = useCallback((msg: OwnerChatMessage) => {
    setActionMenuOpenId(null);
    if (!canShowOwnerChatMessageActions(msg)) return;
    setForwardQuote(buildOwnerChatForwardQuote(msg));
  }, []);

  const handleCopy = useCallback(async (msg: OwnerChatMessage) => {
    if (!canShowOwnerChatMessageActions(msg)) return;
    try {
      await navigator.clipboard.writeText(msg.text);
      setCopiedMessageId(msg.clientId);
      window.setTimeout(() => setCopiedMessageId((current) => current === msg.clientId ? null : current), 1600);
    } catch {
      /* clipboard not available */
    }
  }, []);

  const renderAgentHeaderContent = (senderName?: string) => (
    <>
      <ParticipantAvatar id={chatAgentId || "bot"} avatarUrl={ownedAgent?.avatar_url} isHuman={false} name={senderName || "Bot"} />
      <span className="text-xs font-medium text-text-primary">
        {senderName}
      </span>
    </>
  );

  const renderMessageActions = (msg: OwnerChatMessage) => {
    if (!canShowOwnerChatMessageActions(msg)) return null;
    const menuOpen = actionMenuOpenId === msg.clientId;
    const visible = hoveredActionId === msg.clientId || menuOpen;
    const copied = copiedMessageId === msg.clientId;
    const canReply = canReplyToOwnerChatMessage(msg);
    return (
      <div className="relative shrink-0 self-start pt-1">
        <IconButton size="sm" label="More actions"
          type="button"
          onClick={(event) => { actionAnchorRef.current = event.currentTarget; setActionMenuOpenId((current) => current === msg.clientId ? null : msg.clientId); }}
          aria-expanded={menuOpen}
          className={`flex items-center justify-center${visible ? "opacity-100" : "opacity-0 pointer-events-none focus:opacity-100 focus:pointer-events-auto"} `}
          aria-label="More actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </IconButton>
        {menuOpen && (
          <ComposerPopover anchorRef={actionAnchorRef} onClose={() => setActionMenuOpenId(null)} className="py-1">
            {canReply && (
              <Button variant="row"
                type="button"
                onClick={() => { handleReply(msg); }}
                className="flex w-full items-center gap-2"
              >
                <CornerUpLeft className="h-3.5 w-3.5 text-text-secondary" />
                {replyLabel}
              </Button>
            )}
            <Button variant="row"
              type="button"
              onClick={() => { handleForward(msg); }}
              className="flex w-full items-center gap-2"
            >
              <Forward className="h-3.5 w-3.5 text-text-secondary" />
              {forwardLabel}
            </Button>
            <Button variant="row"
              type="button"
              onClick={() => { void handleCopy(msg); }}
              className="flex w-full items-center gap-2"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-text-secondary" />
              )}
              {copied ? copiedLabel : copyLabel}
            </Button>
          </ComposerPopover>
        )}
      </div>
    );
  };

  const handleMobileBack = () => {
    if (agentId && useDashboardUIStore.getState().sidebarTab === "bots") {
      setSelectedBotAgentId(null);
      router.push("/chats/bots");
      return;
    }
    useDashboardUIStore.getState().returnToMessageList();
    router.push("/chats/messages");
  };

  const mobileBack = <Button variant="secondary" size="sm" type="button" onClick={handleMobileBack} aria-label="Back to messages" className="hidden shrink-0 items-center gap-2 max-md:flex"><ArrowLeft size={20} />{locale === "zh" ? "返回" : "Back"}</Button>;
  // ------ Render guards ------

  if (!chatAgentId) {
    return (
      <div className="flex h-full flex-col text-text-secondary">
        {mobileBack}<p className="m-auto">Select a Bot to start chatting</p>
      </div>
    );
  }

  if (initializingRoom || (loading && !historyLoaded && messages.length === 0)) {
    return (
      <div className="flex h-full min-h-0 flex-col">{mobileBack}<DashboardMessagePaneSkeleton
        headerIcon={<MessageSquare className="h-4 w-4" />}
        headerPaddingClassName="px-4 py-3"
        bodyPaddingClassName="px-4 py-4"
        composerPaddingClassName="px-4 py-3"
        messageMaxWidthClassName="max-w-[75%] max-md:max-w-[calc(100%-3.25rem)]"
        roundedClassName="rounded-lg"
      /></div>
    );
  }

  if (initError || (storeError && !historyLoaded && messages.length === 0)) {
    return (
      <div className="flex h-full flex-col text-danger">
        {mobileBack}<p className="m-auto">{initError || storeError}</p>
      </div>
    );
  }


  return (
    <div className="dashboard-main relative flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
      {storeError && (
        <div role="status" className="shrink-0 border-b border-warning/40 px-4 py-2 text-xs text-warning">
          {locale === "zh" ? "消息刷新失败，已保留当前内容。" : "Could not refresh messages. Current messages are still available."}
        </div>
      )}
      {/* Header */}
      <div className="liquid-toolbar flex shrink-0 items-center gap-2 border-b border-glass-border px-4 py-3 max-md:px-3">
        <IconButton size="sm" label="Back"
          type="button"
          onClick={handleMobileBack}
          className="hidden shrink-0 items-center justify-center max-md:inline-flex"
          aria-label="Back"
          title="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <MessageSquare className="w-4 h-4 text-accent-text" />
        <h2 className="min-w-0 truncate text-sm font-medium text-text-primary">
          {chatRoomName || "Agent"}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          {wsConnected && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Live" />
          )}
          {ownedAgent && (
            <Button variant="secondary" size="sm"
              type="button"
              onClick={() => setBotDetailAgentId(ownedAgent.agent_id)}
              title={settingsLabel}
              aria-label={settingsLabel}
              className="inline-flex items-center gap-1.5"
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span>{settingsLabel}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-3 space-y-3">
        {loadingMore ? (
          <MessageHistoryLoading label={tMessages.loadingEarlier} />
        ) : moreError ? (
          <div className="mb-1 flex items-center justify-center gap-2 text-xs text-text-secondary" role="status">
            <span>{tMessages.loadEarlierFailed}</span>
            <Button variant="inline"
              type="button"
              onClick={requestMoreMessages}

            >
              {locale === "zh" ? "重试" : "Retry"}
            </Button>
          </div>
        ) : hasMore ? (
          <MessageHistoryControl onLoad={requestMoreMessages} loadLabel={tMessages.loadEarlier} scrollLabel={tMessages.scrollUp} />
        ) : null}

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
              <div
                key={msg.clientId}
                data-owner-msg-key={msg.clientId}
                className="flex justify-center"
              >
                <div className="max-w-[85%] rounded-lg px-3 py-2 text-xs bg-warning-soft text-warning border border-warning/40 flex items-start gap-2">
                  <Bell className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <div>
                    <ChatMarkdown content={msg.text || ""} mentionCandidates={messageMentionCandidates} />
                    <div className="text-warning mt-1 text-right">
                      {formatMessageTimestamp(msg.createdAt)}
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          if (isErrorMessage) {
            return (
              <div
                key={msg.clientId}
                data-owner-msg-key={msg.clientId}
                className="space-y-1.5"
              >
                <div className="flex justify-start">
                  <div className="liquid-message liquid-message-error max-w-[75%] max-md:max-w-[calc(100%-3.25rem)] rounded-2xl border px-3 py-2 text-sm text-text-primary">
                    <div className="mb-1 flex items-center gap-1.5">
                      <ParticipantAvatar id={chatAgentId || "bot"} avatarUrl={ownedAgent?.avatar_url} isHuman={false} name={msg.senderName || "Bot"} />
                      <span className="text-xs font-medium text-text-secondary">{msg.senderName}</span>
                    </div>
                    <Button variant="row"
                      type="button"
                      onClick={() => setErrorDetailsId(msg.clientId)}
                      className="flex w-full items-start gap-2"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold uppercase tracking-wide text-warning">
                          Runtime error
                        </span>
                        <span className="mt-1 line-clamp-3 block break-words text-sm leading-relaxed text-warning">
                          {errorText}
                        </span>
                        <span className="mt-1 block text-xs text-warning">Details</span>
                      </span>
                    </Button>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className="text-xs text-text-secondary">
                        {formatMessageTimestamp(msg.createdAt)}
                      </span>
                      <Badge tone="warning" >
                        error
                      </Badge>
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
          // Same DOM shape as the delivered agent bubble below, so the bubble,
          // its process line and the streamed text stay in place on delivery.
          if (msg.status === "streaming") {
            const composingText = buildComposingText(msg.streamBlocks);
            return (
              <div
                key={msg.clientId}
                data-owner-msg-key={msg.clientId}
                className="space-y-1.5"
              >
                <div className="flex items-start gap-2 justify-start">
                  <div className="liquid-message liquid-message-peer max-w-[75%] max-md:max-w-[calc(100%-3.25rem)] rounded-2xl border px-3 py-2 text-sm text-text-primary">
                    <div className="mb-1 flex items-center gap-1.5">
                      {renderAgentHeaderContent(msg.senderName)}
                    </div>
                    <StreamBlocksView
                      blocks={msg.streamBlocks}
                      live
                      onScrollRequest={scrollToBottomIfFollowing}
                    />
                    {composingText && (
                      <ChatMarkdown content={composingText} mentionCandidates={messageMentionCandidates} />
                    )}
                  </div>
                </div>
              </div>
            );
          }

          // --- Optimistic / Failed user message ---
          if (msg.status === "optimistic" || msg.status === "failed") {
            return (
              <div
                key={msg.clientId}
                data-owner-msg-key={msg.clientId}
                className="flex items-start justify-end gap-2"
                onMouseEnter={() => setHoveredActionId(msg.clientId)}
                onMouseLeave={() => setHoveredActionId(null)}
              >
                {renderMessageActions(msg)}
                <div className="liquid-message liquid-message-own max-w-[75%] max-md:max-w-[calc(100%-3.25rem)] rounded-2xl border px-3 py-2 text-sm text-text-primary">
                  <div className="mb-1 flex items-center justify-end gap-1.5">
                    <span className="text-xs font-medium text-accent-text">
                      {msg.senderName}
                    </span>
                    <ParticipantAvatar id={ownerHumanId || "human"} avatarUrl={humanAvatarUrl} isHuman name={msg.senderName || "User"} />
                  </div>
                  <ChatMarkdown content={msg.text} mentionCandidates={messageMentionCandidates} />
                  <div className="flex items-center justify-end gap-1.5 mt-1">
                    {msg.status === "optimistic" && (
                      <Loader2 className="w-3 h-3 animate-spin text-accent-text" />
                    )}
                    {msg.status === "failed" && (
                      <>
                        <span className="relative group">
                          <span className="flex items-center gap-1 cursor-default">
                            <AlertCircle className="w-3 h-3 text-danger" />
                            <span className="text-xs text-danger">Failed</span>
                          </span>
                          {msg.error && (
                            <span className="absolute bottom-full right-0 mb-1 hidden group-hover:block px-2 py-1 text-xs text-text-primary bg-surface-sunken border border-border rounded shadow-lg whitespace-nowrap z-50">
                              {msg.error}
                            </span>
                          )}
                        </span>
                        <Button variant="inline"
                          onClick={() => handleRetry(msg)}
                          className="flex items-center gap-0.5 ml-1"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Retry
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          }

          // --- Confirmed / Delivered messages ---
          const hasText = msg.text.trim().length > 0;
          const hasAttachments = (msg.attachments?.length ?? 0) > 0;
          const hasProcess = !isUser && msg.streamBlocks.length > 0;
          const hasVisibleBubble = hasText || hasAttachments || isUser || hasProcess;
          if (!hasVisibleBubble && msg.streamBlocks.length === 0) {
            return null;
          }

          return (
            <div
              key={msg.clientId}
              data-owner-msg-key={msg.clientId}
              className="space-y-1.5"
            >
              {hasVisibleBubble && (
                <div
                  className={`flex items-start gap-2 ${isUser ? "justify-end" : "justify-start"}`}
                  onMouseEnter={() => setHoveredActionId(msg.clientId)}
                  onMouseLeave={() => setHoveredActionId(null)}
                >
                  {isUser && renderMessageActions(msg)}
                  <div
                    className={`liquid-message max-w-[75%] max-md:max-w-[calc(100%-3.25rem)] rounded-2xl border px-3 py-2 text-sm ${
                      isUser
                        ? "liquid-message-own text-text-primary"
                        : "liquid-message-peer text-text-primary"
                    }`}
                  >
                    <div className={`mb-1 flex items-center gap-1.5 ${isUser ? "justify-end" : ""}`}>
                      {isUser ? (
                        <>
                          <span className="text-xs font-medium text-accent-text">
                            {msg.senderName}
                          </span>
                          <ParticipantAvatar id={ownerHumanId || "human"} avatarUrl={humanAvatarUrl} isHuman name={msg.senderName || "User"} />
                        </>
                      ) : (
                        renderAgentHeaderContent(msg.senderName)
                      )}
                    </div>
                    {hasProcess && (
                      <StreamBlocksView
                        blocks={msg.streamBlocks}
                        onScrollRequest={scrollToBottomIfFollowing}
                      />
                    )}
                    {msg.replyPreview && (
                      <ReplyQuoteBlock preview={msg.replyPreview} />
                    )}
                    {/* Typewriter for new agent messages; skip if already animated or was streamed */}
                    {(() => {
                      // Prepended history must have its final height before we
                      // restore the reader's anchor, and never replay afterward.
                      if (isLoadingMore.current) animatedRef.current.add(msg.clientId);
                      const wasStreamed = msg.traceId && streamedTraceIds.current?.has(msg.traceId);
                      if (wasStreamed) {
                        // Mark as animated and clean up traceId to avoid memory leak
                        animatedRef.current.add(msg.clientId);
                        streamedTraceIds.current.delete(msg.traceId!);
                      }
                      const skipTypewriter = isUser || initialLoadRef.current || animatedRef.current.has(msg.clientId);
                      if (skipTypewriter) {
                        return <ChatMarkdown content={msg.text || ""} mentionCandidates={messageMentionCandidates} />;
                      }
                      return (
                        <TypewriterText
                          mentionCandidates={messageMentionCandidates}
                          text={msg.text || ""}
                          onTick={scrollToBottomIfFollowing}
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
                        {msg.attachments.map((att, idx) => (
                          <AttachmentItem
                            key={`${att.filename}-${att.url}-${idx}`}
                            attachment={att}
                            previewAttachments={getPreviewableImageAttachments(msg.attachments ?? [])}
                            onPreview={handlePreviewAttachment}
                          />
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-text-secondary mt-1 text-right">
                      {formatMessageTimestamp(msg.createdAt)}
                    </div>
                  </div>
                  {!isUser && renderMessageActions(msg)}
                </div>
              )}
            </div>
          );
        })}

        {/* Typing indicator (only when no streaming message exists) */}
        {agentTyping && !hasStreamingMsg && (
          <div ref={typingIndicatorRef} className="flex justify-start">
            <div className="liquid-message liquid-message-peer rounded-2xl border px-3 py-2">
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-surface-sunken animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-surface-sunken animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-surface-sunken animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}
        <div />
      </div>

      {/* Input */}
      <div className="liquid-toolbar border-t border-glass-border px-4 py-3">
        <div className="flex flex-col gap-1">
          {replyingTo && (
            <OwnerChatReplyingToBar
              target={replyingTo}
              locale={locale}
              onCancel={() => useOwnerChatStore.getState().setReplyingTo(null)}
            />
          )}
          <MessageComposer
            onSend={handleSend}
            allowAttachments
            placeholder="输入消息，@ 可引用联系人或房间..."
            mentionCandidates={mentionCandidates}
            actionLabels={{ mention: locale === "zh" ? "提及联系人或房间" : "Mention a contact or room" }}
          />
        </div>
      </div>
      {showScrollToBottomButton && (
        <IconButton size="sm" label={scrollToLatestLabel}
          ref={scrollToBottomButtonElementRef}
          type="button"
          onClick={() => scrollToBottom("auto")}
          aria-label={scrollToLatestLabel}
          title={scrollToLatestLabel}
          className="absolute bottom-[5.25rem] left-1/2 z-20 flex items-center justify-center max-md:bottom-[5.75rem]"
        >
          <ArrowDown className="h-4 w-4" />
        </IconButton>
      )}
      </div>
      {attachmentPreview?.kind === "document" && (
        <DocumentPreviewPane
          attachment={attachmentPreview.attachment}
          onClose={() => setAttachmentPreview(null)}
        />
      )}
      {attachmentPreview?.kind === "image" && (() => {
        const attachment = attachmentPreview.attachments[attachmentPreview.index];
        if (!attachment) return null;
        const src = resolveAttachmentUrl(attachment.url);
        const title = attachment.filename || "Image attachment";

        return (
          <ImagePreviewOverlay
            src={src}
            title={title}
            currentIndex={attachmentPreview.index}
            totalCount={attachmentPreview.attachments.length}
            onPrevious={attachmentPreview.index > 0
              ? () => setAttachmentPreview((preview) => (
                  preview?.kind === "image"
                    ? { ...preview, index: Math.max(0, preview.index - 1) }
                    : preview
                ))
              : undefined}
            onNext={attachmentPreview.index < attachmentPreview.attachments.length - 1
              ? () => setAttachmentPreview((preview) => (
                  preview?.kind === "image"
                    ? { ...preview, index: Math.min(preview.attachments.length - 1, preview.index + 1) }
                    : preview
                ))
              : undefined}
            onClose={() => setAttachmentPreview(null)}
            onImageError={() => {
              rememberFailedAttachmentImageUrl(src);
              setAttachmentPreview(null);
            }}
          />
        );
      })()}
      {forwardQuote && (
        <ForwardModal quoteText={forwardQuote} onClose={() => setForwardQuote(null)} />
      )}
    </div>
  );
}

interface OwnerChatReplyingToBarProps {
  target: OwnerChatMessage;
  locale: "zh" | "en";
  onCancel: () => void;
}

function OwnerChatReplyingToBar({ target, locale, onCancel }: OwnerChatReplyingToBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const name = target.senderName || (locale === "zh" ? "消息" : "Message");
  const preview = (target.text || "").slice(0, 80);
  const replyingLabel = locale === "zh" ? "正在回复" : "Replying to";
  const cancelLabel = locale === "zh" ? "取消引用" : "Cancel reply";

  useEffect(() => {
    if (!barRef.current) return;
    const animation = animateFadeUp(barRef.current);
    return () => cleanupAnime(animation);
  }, [target.clientId]);

  return (
    <div ref={barRef} className="mx-1 flex items-start gap-2 rounded-md border-l-2 border-neon-cyan/60 bg-glass-bg/60 pl-2 pr-1 py-1.5 text-xs">
      <CornerUpLeft className="mt-0.5 h-3 w-3 shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-accent-text">
          {replyingLabel} · {name}
        </div>
        {preview && (
          <div className="truncate text-xs text-text-secondary">{preview}</div>
        )}
      </div>
      <IconButton size="sm" label={cancelLabel}
        type="button"
        onClick={onCancel}

        aria-label={cancelLabel}
        title={cancelLabel}
      >
        <X className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}
