"use client";

import { useState } from "react";
import { RefreshCw, Loader2, Check } from "lucide-react";
import DaemonInstallCommand from "@/components/daemon/DaemonInstallCommand";

interface DeviceSettingsModalProps {
  daemonId: string;
  label: string;
  status: "online" | "offline" | "revoked";
  lastSeen: string | null;
  isRenaming: boolean;
  isRefreshing: boolean;
  locale: string;
  onClose: () => void;
  onRename: (label: string) => Promise<void>;
  onRefreshDaemons: () => void;
}

export default function DeviceSettingsModal({
  daemonId,
  label,
  status,
  lastSeen,
  isRenaming,
  isRefreshing,
  locale,
  onClose,
  onRename,
  onRefreshDaemons,
}: DeviceSettingsModalProps) {
  const [editingName, setEditingName] = useState(label);
  const [nameSaved, setNameSaved] = useState(false);
  const [showInstall, setShowInstall] = useState(false);

  async function handleRename() {
    if (editingName.trim() === label) return;
    await onRename(editingName.trim());
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  }

  const statusColor = status === "online" ? "text-neon-green" : status === "revoked" ? "text-red-400" : "text-text-secondary/50";
  const statusLabel = status === "online"
    ? (locale === "zh" ? "在线" : "Online")
    : status === "revoked"
    ? (locale === "zh" ? "已撤销" : "Revoked")
    : (locale === "zh" ? "离线" : "Offline");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-sm rounded-2xl border border-glass-border bg-deep-black-light shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-glass-border/50 px-5 py-4">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 flex-shrink-0 text-text-secondary/60">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0H3" />
          </svg>
          <span className="flex-1 text-sm font-semibold text-text-primary truncate">{label || daemonId.slice(0, 12)}</span>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary/60 transition-colors hover:bg-glass-bg hover:text-text-primary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Status row */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary/60">{locale === "zh" ? "连接状态" : "Status"}</span>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
              <button
                type="button"
                disabled={isRefreshing}
                onClick={onRefreshDaemons}
                title={locale === "zh" ? "检查连接" : "Check connection"}
                className="flex h-6 w-6 items-center justify-center rounded text-text-secondary/50 transition-colors hover:bg-glass-bg hover:text-text-secondary disabled:opacity-40"
              >
                <RefreshCw className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Last seen */}
          {lastSeen && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary/60">{locale === "zh" ? "最后在线" : "Last seen"}</span>
              <span className="font-mono text-[11px] text-text-secondary/50">
                {new Date(lastSeen).toLocaleString()}
              </span>
            </div>
          )}

          {/* Rename */}
          <div className="space-y-1.5">
            <label className="text-xs text-text-secondary/60">{locale === "zh" ? "设备名称" : "Device name"}</label>
            <div className="flex gap-2">
              <input
                value={editingName}
                onChange={(e) => { setEditingName(e.target.value); setNameSaved(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); }}
                maxLength={64}
                placeholder={daemonId.slice(0, 12)}
                className="flex-1 rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-1.5 text-xs text-text-primary placeholder-text-secondary/40 outline-none focus:border-neon-cyan/40"
              />
              <button
                type="button"
                disabled={isRenaming || editingName.trim() === label}
                onClick={() => void handleRename()}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-glass-border bg-glass-bg/30 text-text-secondary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan disabled:opacity-40"
              >
                {isRenaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : nameSaved ? <Check className="h-3.5 w-3.5 text-neon-green" /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>}
              </button>
            </div>
          </div>

          {/* Restart command toggle */}
          <div>
            <button
              type="button"
              onClick={() => setShowInstall((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg border border-glass-border/50 px-3 py-2 text-xs text-text-secondary/70 transition-colors hover:border-glass-border hover:text-text-secondary"
            >
              <span>{locale === "zh" ? "重新启动命令" : "Restart command"}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3.5 w-3.5 transition-transform ${showInstall ? "rotate-180" : ""}`}><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
            </button>
            {showInstall && (
              <div className="mt-2">
                <DaemonInstallCommand
                  labels={{
                    title: locale === "zh" ? "重新启动 BotCord Daemon" : "Restart BotCord Daemon",
                    hint: locale === "zh" ? "在设备终端运行以下命令重新连接" : "Run this command in your device terminal to reconnect",
                    copy: locale === "zh" ? "复制" : "Copy",
                    copied: locale === "zh" ? "已复制" : "Copied",
                    refresh: locale === "zh" ? "刷新" : "Refresh",
                  }}
                  onRefresh={onRefreshDaemons}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
