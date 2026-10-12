"use client";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";

import Button from "@/components/ui/Button";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { useLanguage } from "@/lib/i18n";
import { roomMemberSettingsModal } from "@/lib/i18n/translations/dashboard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";

interface RoomMemberSettingsModalProps {
  roomId: string;
  roomName: string;
  roomDescription?: string | null;
  roomRule?: string | null;
  myRole: string;
  requiredSubscriptionProductId?: string | null;
  onClose: () => void;
}

export default withDashboardOverlayPortal(RoomMemberSettingsModal, "nested");

function RoomMemberSettingsModal({
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
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

  const isOwner = myRole === "owner";
  const isLeaving = leavingRoomId === roomId;
  const activeSubscription = requiredSubscriptionProductId
    ? getActiveSubscription(requiredSubscriptionProductId)
    : null;
  const isSubscriptionRoom = Boolean(requiredSubscriptionProductId);

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
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; } });

    return () => {

      cleanupAnime(animationRef.current);
    };
  }, [closeWithMotion]);

  const handleLeave = async () => {
    if (isOwner) return;
    if (!confirmingLeave) {
      setConfirmingLeave(true);
      return;
    }
    setError(null);
    try {
      await leaveRoom(roomId);
      closeWithMotion(() => router.push("/chats/messages"));
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
      closeWithMotion();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.cancelSubscriptionFailed);
    } finally {
      setCancellingSubscription(false);
    }
  };

  return (
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} title={<>{t.title}</>} overlayClassName="z-50" className="max-w-sm overflow-hidden">
        <div className="border-b border-glass-border px-6 py-4">
          <h2 className="text-lg font-semibold text-text-primary">{t.title}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <Alert tone="danger" >
              {error}
            </Alert>
          )}

          <Card padding="none" className="p-3">
            <p className="mb-1 text-xs font-semibold text-text-secondary">
              {t.name}
            </p>
            <p className="text-sm text-text-primary">{roomName}</p>
          </Card>

          {roomDescription && (
            <Card padding="none" className="p-3">
              <p className="mb-1 text-xs font-semibold text-text-secondary">
                {t.description}
              </p>
              <p className="text-sm text-text-primary leading-relaxed">{roomDescription}</p>
            </Card>
          )}

          {roomRule && (
            <Card padding="none" className="p-3">
              <p className="mb-1 text-xs font-semibold text-text-secondary">
                {t.rule}
              </p>
              <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">{roomRule}</p>
            </Card>
          )}

          {isOwner && (
            <p className="rounded border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
              {t.ownerCannotLeave}
            </p>
          )}
        </div>

        <div className="flex justify-between gap-2 border-t border-glass-border px-6 py-3">
          {!isOwner && (
            isSubscriptionRoom ? (
              <Button variant="danger"
                onClick={() => void handleCancelSubscription()}
                disabled={cancellingSubscription}

              >
                {cancellingSubscription && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {cancellingSubscription ? t.cancellingSubscription : t.cancelSubscription}
              </Button>
            ) : (
              <Button variant="danger"
                onClick={() => void handleLeave()}
                disabled={isLeaving}

              >
                {isLeaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {confirmingLeave
                  ? isLeaving ? t.leavingRoom : t.leaveRoom
                  : t.leaveRoom}
              </Button>
            )
          )}
          <Button variant="secondary"
            onClick={() => closeWithMotion()}
            className="ml-auto"
          >
            {t.close}
          </Button>
        </div>
      </DialogSurface>
  );
}
