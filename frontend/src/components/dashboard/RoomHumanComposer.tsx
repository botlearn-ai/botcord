"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type ActiveIdentity } from "@/lib/api";
import { useLanguage, chatPane } from "@/lib/i18n";
import { transferDialog } from "@/lib/i18n/translations/dashboard";
import type { Attachment, DashboardMessage, FileUploadResult, PublicRoomMember } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import { useShallow } from "zustand/react/shallow";
import MessageComposer from "./MessageComposer";
import { dashboardReplyTargetId } from "@/lib/dashboard-message-actions";
import { useMentionCandidates } from "@/hooks/useMentionCandidates";
import { CornerUpLeft, Loader2, X } from "lucide-react";
import DashboardSelect from "./DashboardSelect";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";

interface RoomHumanComposerProps {
  roomId: string;
  topicId?: string | null;
}

const ROOM_MENTION_SOURCES = ["roomMembers"] as const;
const PREFILL_ROOM_COMPOSER_EVENT = "botcord:prefill-room-composer";

interface RoomTransferDialogProps {
  roomId: string;
  members: PublicRoomMember[];
  senderIdentity: ActiveIdentity | null;
  onClose: () => void;
  onSuccess: () => void;
}

function RoomTransferDialog({ roomId, members, senderIdentity, onClose, onSuccess }: RoomTransferDialogProps) {
  const locale = useLanguage();
  const t = transferDialog[locale];
  const senderId = senderIdentity?.id ?? "";
  const [recipientId, setRecipientId] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

  const recipientOptions = useMemo(() => {
    const seen = new Set<string>();
    return members
      .filter((member) => member.agent_id && member.agent_id !== senderId)
      .filter((member) => {
        if (seen.has(member.agent_id)) return false;
        seen.add(member.agent_id);
        return true;
      })
      .map((member) => {
        const type = member.participant_type === "human" ? "Human" : "Bot";
        return {
          id: member.agent_id,
          label: `${member.display_name || member.agent_id} · ${type} · ${member.agent_id}`,
        };
      });
  }, [members, senderId]);

  const closeWithMotion = useCallback((afterClose?: () => void) => {
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: () => {
        onClose();
        afterClose?.();
      },
    });
  }, [onClose]);

  useEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWithMotion();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      cleanupAnime(animationRef.current);
    };
  }, [closeWithMotion]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");

    if (!senderIdentity) {
      setError(t.transferFailed);
      return;
    }
    if (!recipientId) {
      setError(t.recipientRequired);
      return;
    }
    if (recipientId === senderId) {
      setError(t.cannotTransferSelf);
      return;
    }

    const normalizedAmount = amount.trim();
    if (!/^[1-9]\d*$/.test(normalizedAmount)) {
      setError(t.amountMustBePositive);
      return;
    }
    const amountCoin = Number.parseInt(normalizedAmount, 10);

    setSubmitting(true);
    try {
      await api.createTransfer({
        to_agent_id: recipientId,
        amount_minor: String(amountCoin * 100),
        memo: memo.trim() || undefined,
        room_id: roomId,
        idempotency_key: crypto.randomUUID(),
      }, senderIdentity);
      closeWithMotion(onSuccess);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.transferFailed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={() => closeWithMotion()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-glass-border bg-glass-bg p-5 backdrop-blur-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => closeWithMotion()}
          className="absolute right-3 top-3 rounded p-1 text-text-secondary hover:text-text-primary"
          aria-label="Close transfer dialog"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-5">
          <h3 className="text-lg font-semibold text-text-primary">{t.transfer}</h3>
          <p className="text-xs text-text-secondary">{locale === "zh" ? "向当前群成员转账 COIN" : "Send COIN to a member in this group"}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              {locale === "zh" ? "接收方" : "Recipient"}
            </label>
            <DashboardSelect
              value={recipientId || null}
              onChange={(value) => setRecipientId(value ?? "")}
              placeholder={recipientOptions.length > 0 ? t.pickRecipientDefault : (locale === "zh" ? "当前群没有可选接收方" : "No eligible recipients in this group")}
              disabled={recipientOptions.length === 0}
              buttonClassName="min-h-11 bg-deep-black-light p-3"
              options={recipientOptions.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              {t.amountCoin}
            </label>
            <input
              type="number"
              step="1"
              min="1"
              inputMode="numeric"
              pattern="[0-9]*"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="1"
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-cyan/50"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              {t.memoOptional}
            </label>
            <input
              type="text"
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              placeholder={t.memoPlaceholder}
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-cyan/50"
            />
          </div>

          {error ? <p className="text-sm text-red-400">{error}</p> : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => closeWithMotion()}
              disabled={submitting}
              className="rounded-lg border border-glass-border px-4 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
            >
              {locale === "zh" ? "取消" : "Cancel"}
            </button>
            <button
              type="submit"
              disabled={submitting || recipientOptions.length === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-40"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {submitting ? t.sending : t.sendTransfer}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export async function uploadRoomAttachments(
  files: File[],
  uploadAgentId: string | null | undefined,
  uploadFile: (file: File, agentId?: string | null) => Promise<FileUploadResult> = api.uploadFile,
): Promise<Attachment[]> {
  if (files.length === 0) return [];
  const results: Attachment[] = [];
  for (const file of files) {
    const uploaded = await uploadFile(file, uploadAgentId ?? null);
    results.push({
      filename: uploaded.original_filename,
      url: uploaded.url,
      content_type: uploaded.content_type,
      size_bytes: uploaded.size_bytes,
    });
  }
  return results;
}

export default function RoomHumanComposer({ roomId, topicId = null }: RoomHumanComposerProps) {
  const locale = useLanguage();
  const { user, activeAgentId, activeIdentity, ownedAgents, human, viewMode } = useDashboardSessionStore(useShallow((s) => ({
    user: s.user,
    activeAgentId: s.activeAgentId,
    activeIdentity: s.activeIdentity,
    ownedAgents: s.ownedAgents,
    human: s.human,
    viewMode: s.viewMode,
  })));
  const { insertMessage, patchMessageIdentity, patchRoom, pollNewMessages, refreshOverview } = useDashboardChatStore(useShallow((s) => ({
    insertMessage: s.insertMessage,
    patchMessageIdentity: s.patchMessageIdentity,
    patchRoom: s.patchRoom,
    pollNewMessages: s.pollNewMessages,
    refreshOverview: s.refreshOverview,
  })));
  const replyingTo = useDashboardChatStore((s) => s.replyingTo[roomId] ?? null);
  const setReplyingTo = useDashboardChatStore((s) => s.setReplyingTo);
  const hasRoomInOverview = useDashboardChatStore(
    (s) => Boolean(s.overview?.rooms.some((r) => r.room_id === roomId)),
  );
  const refreshHumanRooms = useDashboardSessionStore((s) => s.refreshHumanRooms);
  const refreshWallet = useDashboardWalletStore((s) => s.loadWallet);
  const refreshWalletLedger = useDashboardWalletStore((s) => s.loadWalletLedger);
  const hasRoomInHumanRooms = useDashboardSessionStore(
    (s) => s.humanRooms.some((r) => r.room_id === roomId),
  );

  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<PublicRoomMember[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [prefillText, setPrefillText] = useState("");
  const [prefillNonce, setPrefillNonce] = useState(0);
  const roomMemberVersion = useDashboardChatStore(
    (s) => s.roomMemberVersions[roomId] ?? 0,
  );

  const displayName = user?.display_name || "You";
  const isOwnerChat = roomId.startsWith("rm_oc_");
  const isDirectMessage = roomId.startsWith("rm_dm_");
  const allowAllMention = !isOwnerChat && !isDirectMessage;
  const activeAgent = activeAgentId
    ? ownedAgents.find((a) => a.agent_id === activeAgentId) ?? null
    : null;
  const uploadAgentId = activeAgentId ?? ownedAgents[0]?.agent_id ?? null;
  const placeholder = (viewMode === "agent" && activeAgent)
    ? locale === "zh"
      ? `替我的 Agent · ${activeAgent.display_name} 发言，@ 可引用成员或房间…`
      : `Speak as Agent · ${activeAgent.display_name}… (@ to mention)`
    : locale === "zh"
      ? `作为 ${displayName} 发言，@ 可引用成员或房间…`
      : `Message as ${displayName}… (@ to mention)`;
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
  }, [roomId, isOwnerChat, roomMemberVersion]);

  const selfId = viewMode === "agent" ? activeAgentId : human?.human_id;
  const senderIdentity: ActiveIdentity | null = activeIdentity ?? (
    viewMode === "agent" && activeAgentId
      ? { type: "agent", id: activeAgentId }
      : human?.human_id
        ? { type: "human", id: human.human_id }
        : null
  );

  const mentionCandidates = useMentionCandidates({
    currentRoomId: roomId,
    includeAll: allowAllMention,
    roomMembers: members,
    selfId,
    sources: ROOM_MENTION_SOURCES,
  });

  const sendDenied = !isOwnerChat && !!selfId &&
    members.find((m) => m.agent_id === selfId)?.can_send === false;

  useEffect(() => {
    const handlePrefill = (event: Event) => {
      const detail = (event as CustomEvent<{ roomId?: string; text?: string }>).detail;
      if (detail?.roomId && detail.roomId !== roomId) return;
      if (!detail?.text) return;
      setPrefillText(detail.text);
      setPrefillNonce((value) => value + 1);
    };

    window.addEventListener(PREFILL_ROOM_COMPOSER_EVENT, handlePrefill);
    return () => window.removeEventListener(PREFILL_ROOM_COMPOSER_EVENT, handlePrefill);
  }, [roomId]);

  const handleSend = useCallback(async (text: string, files: File[], mentions?: string[]) => {
    if (!text && files.length === 0) return;

    setError(null);
    let attachments: Attachment[] | undefined;
    try {
      const uploaded = await uploadRoomAttachments(files, uploadAgentId);
      attachments = uploaded.length > 0 ? uploaded : undefined;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed");
      return;
    }

    const clientTempId = `tmp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const displayText = text || (attachments ? `[${attachments.length} file(s)]` : "");
    const replyTargetMsgId = replyingTo ? dashboardReplyTargetId(replyingTo) : null;
    const optimisticReplyPreview = replyingTo && replyTargetMsgId
      ? {
          msg_id: replyTargetMsgId,
          sender_id: replyingTo.sender_id,
          sender_display_name:
            replyingTo.display_sender_name || replyingTo.sender_name || null,
          text_preview: (replyingTo.text || "").slice(0, 120) || null,
          topic_id: replyingTo.topic_id,
          deleted: false,
        }
      : null;
    const optimistic: DashboardMessage = {
      hub_msg_id: clientTempId,
      msg_id: clientTempId,
      sender_id: senderId,
      sender_name: displayName,
      type: "message",
      text: displayText,
      payload: attachments ? { text, attachments } : { text },
      room_id: roomId,
      topic: null,
      topic_id: topicId,
      goal: null,
      state: "queued",
      state_counts: null,
      mentions: mentions ?? null,
      created_at: now,
      source_type: "dashboard_human_room",
      sender_kind: "human",
      display_sender_name: displayName,
      sender_avatar_url: human?.avatar_url ?? user?.avatar_url ?? null,
      source_user_id: user?.id ?? null,
      source_user_name: displayName,
      is_mine: true,
      reply_preview: optimisticReplyPreview,
    };

    insertMessage(roomId, optimistic);
    // Clear the quote bar as soon as the message is in flight — server-side
    // validation is mirrored in the optimistic preview already.
    if (replyTargetMsgId) setReplyingTo(roomId, null);

    try {
      const result = await api.sendRoomHumanMessage(
        roomId, text, mentions, topicId, attachments, replyTargetMsgId,
      );
      patchMessageIdentity(roomId, clientTempId, {
        hub_msg_id: result.hub_msg_id,
        msg_id: result.msg_id,
        topic_id: result.topic_id ?? topicId,
      });
      patchRoom(roomId, {
        last_message_preview: displayText,
        last_message_at: now,
        last_sender_name: displayName,
      });
      await pollNewMessages(roomId, { expectedHubMsgId: result.hub_msg_id, retries: 4 });
      // First send into a brand-new DM room (auto-created server-side) won't
      // show up in the sidebar until overview/humanRooms is re-fetched.
      if (roomId.startsWith("rm_dm_")) {
        if (viewMode === "human") {
          if (!hasRoomInHumanRooms) void refreshHumanRooms();
        } else if (!hasRoomInOverview) {
          void refreshOverview();
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send");
    }
  }, [uploadAgentId, senderId, displayName, user?.id, roomId, topicId, viewMode, insertMessage, patchMessageIdentity, patchRoom, pollNewMessages, refreshOverview, refreshHumanRooms, hasRoomInOverview, hasRoomInHumanRooms, replyingTo, setReplyingTo, human?.avatar_url, user?.avatar_url]);

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
      {replyingTo && (
        <ReplyingToBar
          target={replyingTo}
          locale={locale}
          onCancel={() => setReplyingTo(roomId, null)}
        />
      )}
      <MessageComposer
        key={`${roomId}:${prefillNonce}`}
        onSend={handleSend}
        onTransfer={() => setTransferOpen(true)}
        allowAttachments
        placeholder={placeholder}
        mentionCandidates={mentionCandidates}
        initialText={prefillText}
        autoFocus={prefillNonce > 0}
        actionLabels={{
          add: locale === "zh" ? "添加" : "Add",
          file: locale === "zh" ? "文件" : "File",
          transfer: locale === "zh" ? "转账" : "Transfer",
          close: locale === "zh" ? "关闭操作菜单" : "Close actions",
        }}
      />
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {transferOpen ? (
        <RoomTransferDialog
          roomId={roomId}
          members={members}
          senderIdentity={senderIdentity}
          onClose={() => setTransferOpen(false)}
          onSuccess={() => {
            setTransferOpen(false);
            void refreshWallet();
            void refreshWalletLedger();
          }}
        />
      ) : null}
    </div>
  );
}

interface ReplyingToBarProps {
  target: DashboardMessage;
  locale: "zh" | "en";
  onCancel: () => void;
}

function ReplyingToBar({ target, locale, onCancel }: ReplyingToBarProps) {
  const name = target.display_sender_name || target.sender_name || target.sender_id;
  const preview = (target.text || "").slice(0, 80);
  const replyingLabel = locale === "zh" ? "正在回复" : "Replying to";
  const cancelLabel = locale === "zh" ? "取消引用" : "Cancel reply";
  return (
    <div className="mx-1 flex items-start gap-2 rounded-md border-l-2 border-neon-cyan/60 bg-glass-bg/60 pl-2 pr-1 py-1.5 text-xs">
      <CornerUpLeft className="mt-0.5 h-3 w-3 shrink-0 text-neon-cyan/80" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-neon-cyan/90">
          {replyingLabel} · {name}
        </div>
        {preview && (
          <div className="truncate text-[11px] text-text-secondary/80">{preview}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="rounded p-0.5 text-text-secondary/60 hover:bg-glass-bg hover:text-text-secondary transition-colors"
        aria-label={cancelLabel}
        title={cancelLabel}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
