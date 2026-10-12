"use client";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
/**
 * [INPUT]: daemon store refresh state + DeviceConnectPanel shared onboarding UI
 * [OUTPUT]: AddDeviceDialog — standalone add-device modal using the same device binding panel as CreateAgentDialog
 * [POS]: My Bots devices page and sidebar Bots panel add-device actions
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useRef } from "react";
import { Cpu } from "lucide-react";
import DialogShell from "@/components/ui/DialogShell";
import { useDaemonStore } from "@/store/useDaemonStore";
import { useLanguage } from "@/lib/i18n";
import { DeviceConnectPanel } from "./HomePanel";

interface AddDeviceDialogProps {
  onClose: () => void;
}

export default withDashboardOverlayPortal(AddDeviceDialog);

function AddDeviceDialog({ onClose }: AddDeviceDialogProps) {
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

  return (
    <DialogShell
      title={locale === "zh" ? "添加设备" : "Add Device"}
      icon={<Cpu className="h-4 w-4 shrink-0 text-accent-text" />}
      onClose={onClose}
      closeLabel={locale === "zh" ? "关闭" : "Close"}
      className="max-w-xl overflow-hidden"
      bodyClassName="overflow-x-hidden overscroll-contain"
    >
      {connected ? (
        <div className="mb-4 rounded-xl border border-success/30 bg-success-soft px-3 py-2 text-xs text-success">
          {locale === "zh" ? "新设备已连接。" : "New device connected."}
        </div>
      ) : null}
      <DeviceConnectPanel
        connected={connected}
        daemonLoading={loading}
        onRefreshDaemons={() => void refresh()}
      />
    </DialogShell>
  );
}
