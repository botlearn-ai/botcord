"use client";
import { X } from "lucide-react";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
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

export default withDashboardOverlayPortal(SettingsModal);

function SettingsModal({ onClose }: SettingsModalProps) {
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
      onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none";
        animationRef.current = null;
      },
    });
    return () => cleanupAnime(animationRef.current);
  }, []);

  return (
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} ariaLabel="Settings Modal" overlayClassName="z-50" className="max-w-2xl">
        <div data-settings-modal-part className="flex items-center justify-between border-b border-glass-border/50 px-6 py-4">
          <span className="text-sm font-semibold text-text-primary">设置</span>
          <IconButton label="Close"
            type="button"
            onClick={closeWithMotion}
            className="w-7"
          >
            <X aria-hidden strokeWidth={1.75} className="h-4 w-4" />
          </IconButton>
        </div>
        <div data-settings-modal-part className="px-6 py-6">
          <PolicySettingsClient />
        </div>
      </DialogSurface>
  );
}
