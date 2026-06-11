"use client";

/**
 * [INPUT]: 依赖 human 资料与联系人关系状态，依赖 i18n 提供文案
 * [OUTPUT]: 对外提供带 animejs 进出场动效的 HumanCardModal 统一 human 详情模态框
 * [POS]: dashboard 通用弹层组件，被 Explore humans 目录复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useLanguage } from "@/lib/i18n";
import { MobileBotCordLoading } from "@/components/ui/BotCordLoader";
import { animeStagger, cleanupAnime, createTimelineIfMotion } from "@/lib/anime";
import { exploreUi } from "@/lib/i18n/translations/dashboard";
import type { PublicHumanProfile } from "@/lib/types";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface HumanCardModalProps {
  isOpen: boolean;
  human: PublicHumanProfile | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  isSelf?: boolean;
  alreadyInContacts: boolean;
  requestAlreadyPending: boolean;
  requestSent?: boolean;
  sendingFriendRequest?: boolean;
  onSendFriendRequest: () => void;
  onSendMessage?: () => void;
  onRetry?: () => void;
}

const PROFILE_MODAL_PART_SELECTOR = "[data-profile-modal-part]";

function getModalParts(panel: HTMLElement | null): HTMLElement[] {
  return panel ? Array.from(panel.querySelectorAll<HTMLElement>(PROFILE_MODAL_PART_SELECTOR)) : [];
}

export default function HumanCardModal({
  isOpen,
  human,
  loading = false,
  error = null,
  onClose,
  isSelf = false,
  alreadyInContacts,
  requestAlreadyPending,
  requestSent = false,
  sendingFriendRequest = false,
  onSendFriendRequest,
  onSendMessage,
  onRetry,
}: HumanCardModalProps) {
  const locale = useLanguage();
  const t = exploreUi[locale];
  const [shouldRender, setShouldRender] = useState(isOpen);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof createTimelineIfMotion>>(null);
  const closingRef = useRef(false);
  const closeRequestedRef = useRef(false);

  const playExit = useCallback((afterClose?: () => void) => {
    if (closingRef.current) return;

    const overlay = overlayRef.current;
    const panel = panelRef.current;
    const parts = getModalParts(panel);

    const finishClose = () => {
      closingRef.current = false;
      animationRef.current = null;
      setShouldRender(false);
      afterClose?.();
    };

    if (!panel) {
      finishClose();
      return;
    }

    closingRef.current = true;
    animationRef.current?.pause();

    const timeline = createTimelineIfMotion({
      onComplete: finishClose,
    });
    animationRef.current = timeline;

    if (!timeline) {
      finishClose();
      return;
    }

    if (parts.length) {
      timeline.add(parts, {
        opacity: 0,
        translateY: -4,
        duration: 110,
        delay: animeStagger(10, { reversed: true }),
        ease: "in(2)",
      }, 0);
    }

    timeline.add(panel, {
      opacity: 0,
      scale: 0.98,
      translateY: 8,
      duration: 170,
      ease: "in(2)",
    }, parts.length ? 35 : 0);

    if (overlay) {
      timeline.add(overlay, {
        opacity: 0,
        duration: 140,
        ease: "linear",
      }, parts.length ? 35 : 0);
    }
  }, []);

  const handleClose = useCallback(() => {
    closeRequestedRef.current = true;
    playExit(onClose);
  }, [onClose, playExit]);

  useLayoutEffect(() => {
    if (isOpen && !shouldRender && !closeRequestedRef.current) {
      setShouldRender(true);
    }
  }, [isOpen, shouldRender]);

  useLayoutEffect(() => {
    if (!shouldRender || !isOpen || closeRequestedRef.current) return;

    closingRef.current = false;
    cleanupAnime(animationRef.current);

    const overlay = overlayRef.current;
    const panel = panelRef.current;
    const parts = getModalParts(panel);
    if (!panel) return;

    if (overlay) overlay.style.opacity = "0";
    panel.style.opacity = "0";
    panel.style.transform = "translateY(14px) scale(0.96)";
    parts.forEach((part) => {
      part.style.opacity = "0";
      part.style.transform = "translateY(8px)";
    });

    const timeline = createTimelineIfMotion({
      onComplete: () => {
        if (animationRef.current === timeline) animationRef.current = null;
      },
    });
    animationRef.current = timeline;

    if (!timeline) {
      if (overlay) overlay.style.opacity = "1";
      panel.style.opacity = "1";
      panel.style.transform = "translateY(0px) scale(1)";
      parts.forEach((part) => {
        part.style.opacity = "1";
        part.style.transform = "translateY(0px)";
      });
      return;
    }

    if (overlay) {
      timeline.add(overlay, {
        opacity: [0, 1],
        duration: 180,
        ease: "linear",
      }, 0);
    }

    timeline.add(panel, {
      opacity: [0, 1],
      scale: [0.96, 1],
      translateY: [14, 0],
      duration: 260,
      ease: "out(3)",
    }, 0);

    if (parts.length) {
      timeline.add(parts, {
        opacity: [0, 1],
        translateY: [8, 0],
        duration: 210,
        delay: animeStagger(24),
        ease: "out(3)",
      }, 75);
    }

    return () => cleanupAnime(timeline);
  }, [shouldRender, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      closeRequestedRef.current = false;
      if (shouldRender) playExit();
    }
  }, [isOpen, playExit, shouldRender]);

  useEffect(() => {
    if (!shouldRender) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose, shouldRender]);

  useEffect(() => () => cleanupAnime(animationRef.current), []);

  if (!shouldRender) return null;

  const initials = human?.display_name?.slice(0, 1).toUpperCase() ?? "H";

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div data-profile-modal-part className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-3">
            {human?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={human.avatar_url}
                alt={human.display_name}
                className="h-9 w-9 shrink-0 rounded-full border border-neon-green/30 object-cover"
              />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neon-green/30 bg-neon-green/10 text-xs font-semibold text-neon-green">
                {initials}
              </div>
            )}
            <div>
              <h3 className="text-base font-semibold text-text-primary">{human?.display_name || "Human"}</h3>
              <p className="mt-0.5 text-xs text-neon-green/80">{t.personaHuman}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="rounded border border-glass-border px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary"
          >
            {t.close}
          </button>
        </div>

        {loading ? (
          <div data-profile-modal-part className="space-y-3 py-2">
            <MobileBotCordLoading
              label="Loading profile..."
              className="justify-start"
              textClassName="text-xs text-text-secondary animate-pulse"
            />
          </div>
        ) : error ? (
          <div data-profile-modal-part className="space-y-3 py-2">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={onRetry}
              className="w-full rounded-lg border border-glass-border py-2 text-xs text-text-primary transition-colors hover:bg-glass-bg"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {isSelf ? (
              <p data-profile-modal-part className="text-xs text-text-secondary">{t.thisIsYou}</p>
            ) : requestSent ? (
              <p data-profile-modal-part className="text-xs text-neon-green">{t.friendRequestSent}</p>
            ) : alreadyInContacts ? (
              <button
                data-profile-modal-part
                onClick={onSendMessage}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neon-green/40 bg-neon-green/10 py-2 text-xs font-medium text-neon-green transition-colors hover:bg-neon-green/20"
              >
                {t.sendMessage}
              </button>
            ) : requestAlreadyPending ? (
              <p data-profile-modal-part className="text-xs text-neon-cyan">{t.friendRequestAlreadyPending}</p>
            ) : (
              <button
                data-profile-modal-part
                onClick={onSendFriendRequest}
                disabled={sendingFriendRequest}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neon-green/40 bg-neon-green/10 py-2 text-xs font-medium text-neon-green transition-colors hover:bg-neon-green/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendingFriendRequest ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {sendingFriendRequest ? t.sendingFriendRequest : t.sendFriendRequest}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
