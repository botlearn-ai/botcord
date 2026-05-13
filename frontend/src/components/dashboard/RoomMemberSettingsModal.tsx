"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { useLanguage } from "@/lib/i18n";
import { roomMemberSettingsModal } from "@/lib/i18n/translations/dashboard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";

interface RoomMemberSettingsModalProps {
  roomId: string;
  roomName: string;
  roomDescription?: string | null;
  roomRule?: string | null;
  myRole: string;
  requiredSubscriptionProductId?: string | null;
  onClose: () => void;
}

export default function RoomMemberSettingsModal({
  roomId,
  roomName,
  roomDescription,
  roomRule,
  myRole,
  requiredSubscriptionProductId,
  onClose,
}: RoomMemberSettingsModalProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = roomMemberSettingsModal[locale];

  const { leaveRoom, leavingRoomId } = useDashboardChatStore(useShallow((state) => ({
    leaveRoom: state.leaveRoom,
    leavingRoomId: state.leavingRoomId,
  })));
  const { getActiveSubscription, cancelSubscription } = useDashboardSubscriptionStore(useShallow((state) => ({
    getActiveSubscription: state.getActiveSubscription,
    cancelSubscription: state.cancelSubscription,
  })));

  const [error, setError] = useState<string | null>(null);
  const [cancellingSubscription, setCancellingSubscription] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const isOwner = myRole === "owner";
  const isLeaving = leavingRoomId === roomId;
  const activeSubscription = requiredSubscriptionProductId
    ? getActiveSubscription(requiredSubscriptionProductId)
    : null;
  const isSubscriptionRoom = Boolean(requiredSubscriptionProductId);

  const handleLeave = async () => {
    if (isOwner) return;
    if (!confirmingLeave) {
      setConfirmingLeave(true);
      return;
    }
    setError(null);
    try {
      await leaveRoom(roomId);
      onClose();
      router.push("/chats/messages");
    } catch (err) {
      setError(err instanceof Error ? err.message : t.leaveRoomFailed);
      setConfirmingLeave(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!activeSubscription?.subscription_id) return;
    setError(null);
    setCancellingSubscription(true);
    try {
      await cancelSubscription(activeSubscription.subscription_id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.cancelSubscriptionFailed);
    } finally {
      setCancellingSubscription(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-glass-border bg-deep-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-glass-border px-6 py-4">
          <h2 className="text-lg font-semibold text-text-primary">{t.title}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.name}
            </p>
            <p className="text-sm text-text-primary">{roomName}</p>
          </div>

          {roomDescription && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                {t.description}
              </p>
              <p className="text-sm text-text-primary leading-relaxed">{roomDescription}</p>
            </div>
          )}

          {roomRule && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                {t.rule}
              </p>
              <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">{roomRule}</p>
            </div>
          )}

          {isOwner && (
            <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
              {t.ownerCannotLeave}
            </p>
          )}
        </div>

        <div className="flex justify-between gap-2 border-t border-glass-border px-6 py-3">
          {!isOwner && (
            isSubscriptionRoom ? (
              <button
                onClick={() => void handleCancelSubscription()}
                disabled={cancellingSubscription}
                className="inline-flex items-center gap-1.5 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400 hover:bg-red-500/20 disabled:opacity-50"
              >
                {cancellingSubscription && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {cancellingSubscription ? t.cancellingSubscription : t.cancelSubscription}
              </button>
            ) : (
              <button
                onClick={() => void handleLeave()}
                disabled={isLeaving}
                className="inline-flex items-center gap-1.5 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400 hover:bg-red-500/20 disabled:opacity-50"
              >
                {isLeaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {confirmingLeave
                  ? isLeaving ? t.leavingRoom : t.leaveRoom
                  : t.leaveRoom}
              </button>
            )
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
