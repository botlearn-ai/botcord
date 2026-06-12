"use client";

/**
 * [INPUT]: PolicySettingsClient for agent policy configuration
 * [OUTPUT]: SettingsModal — modal overlay for dashboard settings (对话与回复)
 * [POS]: triggered from AccountMenu "Settings" action; replaces full-page /settings navigation
 * [PROTOCOL]: update header on changes
 */

import PolicySettingsClient from "@/app/(dashboard)/settings/policy/PolicySettingsClient";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

  const closeWithMotion = useCallback(() => {
    if (closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [closing, onClose]);

  useLayoutEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, {
      contentSelector: "[data-settings-modal-part]",
      onComplete: () => {
        animationRef.current = null;
      },
    });
    return () => cleanupAnime(animationRef.current);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWithMotion();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeWithMotion]);

  return (
    <div
      ref={overlayRef}
      className={`fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm py-8 px-4 ${closing ? "pointer-events-none" : ""}`}
      onClick={closeWithMotion}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-2xl rounded-2xl border border-glass-border bg-deep-black-light shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div data-settings-modal-part className="flex items-center justify-between border-b border-glass-border/50 px-6 py-4">
          <span className="text-sm font-semibold text-text-primary">设置</span>
          <button
            type="button"
            onClick={closeWithMotion}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary/60 transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div data-settings-modal-part className="px-6 py-6">
          <PolicySettingsClient />
        </div>
      </div>
    </div>
  );
}
