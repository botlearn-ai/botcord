"use client";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import Button from "@/components/ui/Button";

import { withDashboardOverlayPortal } from "../DashboardOverlayPortal";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Loader2, Check, Trash2, FileArchive, Download, Send, ChevronDown, Monitor, X } from "lucide-react";
import DaemonInstallCommand from "@/components/daemon/DaemonInstallCommand";
import ForwardModal from "@/components/dashboard/ForwardModal";
import { downloadApiFile } from "@/lib/api";
import { animateOverlayPanelEnter, animateOverlayPanelExit, animatePop, cleanupAnime } from "@/lib/anime";
import type { DiagnosticBundleResult } from "@/store/useDaemonStore";

interface DeviceSettingsModalProps {
  daemonId: string;
  label: string;
  status: "online" | "offline" | "revoked" | "removal_pending";
  lastSeen: string | null;
  daemonVersion?: string | null;
  hostedAgentCount: number;
  isRenaming: boolean;
  isRefreshing: boolean;
  isRemoving: boolean;
  isCollectingDiagnostics: boolean;
  diagnosticResult?: DiagnosticBundleResult;
  diagnosticError?: string;
  locale: string;
  onClose: () => void;
  onRename: (label: string) => Promise<void>;
  onRefreshDaemons: () => void;
  onCollectDiagnostics: () => Promise<void>;
  onRemove: (forgetIfOffline: boolean) => Promise<void>;
}

export default withDashboardOverlayPortal(DeviceSettingsModal);

function DeviceSettingsModal({
  daemonId,
  label,
  status,
  lastSeen,
  daemonVersion,
  hostedAgentCount,
  isRenaming,
  isRefreshing,
  isRemoving,
  isCollectingDiagnostics,
  diagnosticResult,
  diagnosticError,
  locale,
  onClose,
  onRename,
  onRefreshDaemons,
  onCollectDiagnostics,
  onRemove,
}: DeviceSettingsModalProps) {
  const [editingName, setEditingName] = useState(label);
  const [nameSaved, setNameSaved] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [forwardLogs, setForwardLogs] = useState(false);
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameButtonRef = useRef<HTMLButtonElement>(null);
  const diagnosticResultRef = useRef<HTMLDivElement>(null);
  const removeErrorRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const feedbackAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  async function handleRename() {
    if (editingName.trim() === label) return;
    await onRename(editingName.trim());
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  }

  async function handleRemove(forgetIfOffline: boolean) {
    setRemoveError(null);
    try {
      await onRemove(forgetIfOffline);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    }
  }

  const closeWithMotion = useCallback(() => {
    if (isRemoving || closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [closing, isRemoving, onClose]);

  useEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; } });
    return () => cleanupAnime(animationRef.current);
  }, []);

  useEffect(() => {
    const target = nameSaved ? nameButtonRef.current : removeError ? removeErrorRef.current : diagnosticResult ? diagnosticResultRef.current : null;
    if (!target) return;
    cleanupAnime(feedbackAnimationRef.current);
    feedbackAnimationRef.current = animatePop(target);
    return () => cleanupAnime(feedbackAnimationRef.current);
  }, [diagnosticResult, nameSaved, removeError]);

  const statusColor =
    status === "online"
      ? "text-neon-green"
      : status === "revoked"
        ? "text-danger"
        : status === "removal_pending"
          ? "text-warning"
          : "text-text-secondary";
  const statusLabel =
    status === "online"
      ? locale === "zh" ? "在线" : "Online"
      : status === "revoked"
        ? locale === "zh" ? "已撤销" : "Revoked"
        : status === "removal_pending"
          ? locale === "zh" ? "待清理" : "Cleanup pending"
          : locale === "zh" ? "离线" : "Offline";

  const isOffline = status === "offline";
  const removeDisabled = isRemoving || status === "revoked" || status === "removal_pending";
  const diagnosticsDisabled = isCollectingDiagnostics || status !== "online";
  const diagnosticDownloadPath = diagnosticResult
    ? `/daemon/diagnostics/${encodeURIComponent(diagnosticResult.bundle_id)}/download`
    : "";
  return (
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} ariaLabel="Device Settings Modal" busy={isRemoving} overlayClassName="z-50" className="max-w-sm">
        {/* Header */}
        <div className="liquid-toolbar flex items-center gap-3 border-b border-glass-border/50 px-5 py-4">
          <Monitor aria-hidden strokeWidth={1.75} className="h-4 w-4 flex-shrink-0 text-text-secondary" />
          <span className="flex-1 text-sm font-semibold text-text-primary truncate">{label || daemonId.slice(0, 12)}</span>
          <IconButton label="Close" type="button" onClick={closeWithMotion} className="w-7">
            <X aria-hidden strokeWidth={1.75} className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Status row */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">{locale === "zh" ? "连接状态" : "Status"}</span>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
              <IconButton label={locale === "zh" ? "检查连接" : "Check connection"}
                ref={nameButtonRef}
                type="button"
                disabled={isRefreshing}
                onClick={onRefreshDaemons}
                title={locale === "zh" ? "检查连接" : "Check connection"}
                className="w-6"
              >
                <RefreshCw className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`} />
              </IconButton>
            </div>
          </div>

          {/* Last seen */}
          {lastSeen && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">{locale === "zh" ? "最后在线" : "Last seen"}</span>
              <span className="font-mono text-xs text-text-secondary">
                {new Date(lastSeen).toLocaleString()}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">
              {locale === "zh" ? "Daemon 版本" : "Daemon version"}
            </span>
            <span className="font-mono text-xs text-text-secondary">
              {daemonVersion || "--"}
            </span>
          </div>

          {/* Rename */}
          <div className="space-y-1.5">
            <label className="text-xs text-text-secondary">{locale === "zh" ? "设备名称" : "Device name"}</label>
            <div className="flex gap-2">
              <Input
                value={editingName}
                onChange={(e) => { setEditingName(e.target.value); setNameSaved(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); }}
                maxLength={64}
                placeholder={daemonId.slice(0, 12)}
                className="flex-1"
              />
              <Button variant="secondary"
                type="button"
                disabled={isRenaming || editingName.trim() === label}
                onClick={() => void handleRename()}
                className="w-8"
              >
                {isRenaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : nameSaved ? <Check className="h-3.5 w-3.5 text-neon-green" /> : <Check aria-hidden strokeWidth={1.75} className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>

          {/* Restart command toggle */}
          <div>
            <Button variant="secondary"
              type="button"
              onClick={() => setShowInstall((v) => !v)}
              className="w-full"
            >
              <span>{locale === "zh" ? "重新启动命令" : "Restart command"}</span>
              <ChevronDown aria-hidden strokeWidth={1.75} className={`h-3.5 w-3.5 transition-transform ${showInstall ? "rotate-180" : ""}`} />
            </Button>
            {showInstall && (
              <div className="mt-2">
                <DaemonInstallCommand
                  targetDaemonId={daemonId}
                  labels={{
                    title: locale === "zh" ? "重新启动 BotCord Daemon" : "Restart BotCord Daemon",
                    hint: locale === "zh"
                      ? "在这台设备的终端运行；此命令会恢复当前设备 ID，即使本机凭据已丢失。"
                      : "Run this in the terminal on this device; this command restores this device ID even if local credentials are missing.",
                    copy: locale === "zh" ? "复制" : "Copy",
                    copied: locale === "zh" ? "已复制" : "Copied",
                    refresh: locale === "zh" ? "刷新" : "Refresh",
                  }}
                  onRefresh={onRefreshDaemons}
                />
              </div>
            )}
          </div>

          {/* Diagnostics */}
          <div className="rounded-lg border border-glass-border/50 bg-glass-bg/20 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-text-primary">
                  {locale === "zh" ? "排障日志" : "Troubleshooting logs"}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                  {locale === "zh"
                    ? "收集这台设备最近的运行日志，便于排查问题。"
                    : "Collect recent logs from this device to help troubleshoot issues."}
                </p>
              </div>
              <Button variant="secondary"
                type="button"
                disabled={diagnosticsDisabled}
                onClick={() => void onCollectDiagnostics()}
                title={
                  status === "online"
                    ? locale === "zh" ? "收集诊断日志" : "Collect diagnostics"
                    : locale === "zh" ? "设备在线后才能收集诊断日志" : "Device must be online to collect diagnostics"
                }

              >
                {isCollectingDiagnostics ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <FileArchive className="h-3 w-3" />
                )}
                {locale === "zh" ? "收集日志" : "Collect logs"}
              </Button>
            </div>
            {diagnosticResult && (
              <div ref={diagnosticResultRef} className="mt-2 flex items-center gap-2 rounded-md border border-neon-green/20 bg-neon-green/10 px-2 py-2">
                <FileArchive className="h-4 w-4 shrink-0 text-neon-green" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-neon-green">
                    {diagnosticResult.filename}
                  </p>
                  <p className="text-xs text-neon-green/70">
                    {locale === "zh" ? "日志文件已准备好" : "Log file ready"} · {diagnosticResult.size_bytes} bytes
                  </p>
                </div>
                <IconButton label={locale === "zh" ? "转发到聊天" : "Send to a chat"}
                  type="button"
                  onClick={() => setForwardLogs(true)}
                  title={locale === "zh" ? "转发到聊天" : "Send to a chat"}
                  className="w-7 shrink-0"
                >
                  <Send className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton label={locale === "zh" ? "下载日志文件" : "Download log file"}
                  type="button"
                  onClick={() => void downloadApiFile(
                    diagnosticDownloadPath,
                    diagnosticResult.filename,
                  )}
                  title={locale === "zh" ? "下载日志文件" : "Download log file"}
                  className="w-7 shrink-0"
                >
                  <Download className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            )}
            {diagnosticError && (
              <Alert tone="danger" className="mt-2">
                {diagnosticError}
              </Alert>
            )}
          </div>

          {/* Danger zone — Remove Device */}
          <div className="rounded-lg border border-danger/20 bg-danger-soft p-3">
            {!confirmRemove ? (
              <Button variant="danger"
                type="button"
                disabled={removeDisabled}
                onClick={() => setConfirmRemove(true)}
                className="w-full"
              >
                <span className="flex items-center gap-2">
                  <Trash2 className="h-3.5 w-3.5" />
                  {locale === "zh" ? "移除此设备" : "Remove device"}
                </span>
                <span className="text-text-secondary">
                  {hostedAgentCount > 0
                    ? locale === "zh"
                      ? `${hostedAgentCount} 个 Agent`
                      : `${hostedAgentCount} agent${hostedAgentCount === 1 ? "" : "s"}`
                    : ""}
                </span>
              </Button>
            ) : (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-danger">
                  {locale === "zh"
                    ? "确认移除此设备？"
                    : "Remove this device?"}
                </p>
                <p className="text-xs leading-relaxed text-text-secondary">
                  {hostedAgentCount > 0
                    ? locale === "zh"
                      ? `${hostedAgentCount} 个 Agent 将移到「未关联设备」分组，云端身份和聊天记录都会保留。`
                      : `${hostedAgentCount} agent${hostedAgentCount === 1 ? "" : "s"} will move to "No Device". Cloud identities, rooms, and history are kept.`
                    : locale === "zh"
                      ? "此设备没有托管的 Agent。移除后云端记录会保留。"
                      : "No agents are hosted on this device. Cloud records will be kept."}
                </p>
                {isOffline ? (
                  <p className="text-xs leading-relaxed text-warning">
                    {locale === "zh"
                      ? "设备当前离线。本地凭据/状态需等设备重新启动后才能清理。"
                      : "Device is offline. Local credentials and state can't be cleaned until the daemon starts again."}
                  </p>
                ) : (
                  <p className="text-xs leading-relaxed text-text-secondary">
                    {locale === "zh"
                      ? "设备在线，本地凭据将立即清理。"
                      : "Device is online — local credentials will be cleaned now."}
                  </p>
                )}
                {removeError && (
                  <Alert tone="danger" ref={removeErrorRef} >{removeError}</Alert>
                )}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button variant="secondary"
                    type="button"
                    disabled={isRemoving}
                    onClick={() => {
                      setConfirmRemove(false);
                      setRemoveError(null);
                    }}

                  >
                    {locale === "zh" ? "取消" : "Cancel"}
                  </Button>
                  {isOffline && (
                    <Button variant="danger"
                      type="button"
                      disabled={isRemoving}
                      onClick={() => void handleRemove(true)}

                    >
                      {locale === "zh" ? "强制移除" : "Forget anyway"}
                    </Button>
                  )}
                  <Button variant="danger"
                    type="button"
                    disabled={isRemoving}
                    onClick={() => void handleRemove(false)}

                  >
                    {isRemoving && <Loader2 className="h-3 w-3 animate-spin" />}
                    {locale === "zh" ? "移除设备" : "Remove device"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogSurface>
  );
}
