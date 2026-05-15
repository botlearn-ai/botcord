"use client";

/**
 * [INPUT]: daemon store refresh state + DeviceConnectPanel shared onboarding UI
 * [OUTPUT]: AddDeviceDialog — standalone add-device modal using the same device binding panel as CreateAgentDialog
 * [POS]: My Bots devices page and sidebar Bots panel add-device actions
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useRef } from "react";
import { Cpu, X } from "lucide-react";
import { useDaemonStore } from "@/store/useDaemonStore";
import { useLanguage } from "@/lib/i18n";
import { DeviceConnectPanel } from "./HomePanel";

interface AddDeviceDialogProps {
  onClose: () => void;
}

export default function AddDeviceDialog({ onClose }: AddDeviceDialogProps) {
  const locale = useLanguage();
  const daemons = useDaemonStore((s) => s.daemons);
  const loading = useDaemonStore((s) => s.loading);
  const refresh = useDaemonStore((s) => s.refresh);
  const existingIdsRef = useRef<Set<string> | null>(null);

  if (existingIdsRef.current === null) {
    existingIdsRef.current = new Set(daemons.map((d) => d.id));
  }

  const connected = daemons.some(
    (d) => d.status === "online" && !existingIdsRef.current?.has(d.id),
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh({ quiet: true });
    }, 3_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-device-title"
        className="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-glass-border bg-deep-black-light shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-glass-border/40 px-4 py-3 sm:px-5">
          <h3
            id="add-device-title"
            className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold text-text-primary"
          >
            <Cpu className="h-4 w-4 shrink-0 text-neon-cyan" />
            {locale === "zh" ? "添加设备" : "Add Device"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={locale === "zh" ? "关闭" : "Close"}
            className="shrink-0 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {connected ? (
            <div className="mb-4 rounded-xl border border-neon-green/30 bg-neon-green/10 px-3 py-2 text-xs text-neon-green">
              {locale === "zh" ? "新设备已连接。" : "New device connected."}
            </div>
          ) : null}
          <DeviceConnectPanel
            connected={connected}
            daemonLoading={loading}
            onRefreshDaemons={() => void refresh()}
          />
        </div>
      </div>
    </div>
  );
}
