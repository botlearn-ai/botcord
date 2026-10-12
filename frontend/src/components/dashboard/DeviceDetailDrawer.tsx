"use client";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  Download,
  FileArchive,
  Loader2,
  RefreshCw,
  Send,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import DaemonInstallCommand from "@/components/daemon/DaemonInstallCommand";
import ForwardModal from "@/components/dashboard/ForwardModal";
import { downloadApiFile } from "@/lib/api";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";
import BotAvatar from "./BotAvatar";
import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";

/**
 * Right-edge slide-out drawer for one device's details + settings.
 * Driven by `selectedDeviceId` in the UI store; close = set it to null.
 */
export default memo(withDashboardOverlayPortal(DeviceDetailDrawer));

function DeviceDetailDrawer() {
  const {
    daemons,
    diagnosticResults,
    collectingDiagnosticsId,
    removingId,
    restartingId,
    refresh,
    rename,
    removeDevice,
    restartDevice,
    refreshRuntimes,
    collectDiagnostics,
  } = useDaemonStore(
    useShallow((s) => ({
      daemons: s.daemons,
      diagnosticResults: s.diagnosticResults,
      collectingDiagnosticsId: s.collectingDiagnosticsId,
      removingId: s.removingId,
      restartingId: s.restartingId,
      refresh: s.refresh,
      rename: s.rename,
      removeDevice: s.removeDevice,
      restartDevice: s.restartDevice,
      refreshRuntimes: s.refreshRuntimes,
      collectDiagnostics: s.collectDiagnostics,
    })),
  );
  const { selectedDeviceId, setSelectedDeviceId } = useDashboardUIStore(
    useShallow((s) => ({
      selectedDeviceId: s.selectedDeviceId,
      setSelectedDeviceId: s.setSelectedDeviceId,
    })),
  );
  const { ownedAgents, refreshUserProfile } = useDashboardSessionStore(
    useShallow((s) => ({
      ownedAgents: s.ownedAgents,
      refreshUserProfile: s.refreshUserProfile,
    })),
  );

  const open = selectedDeviceId !== null;
  const device = selectedDeviceId ? daemons.find((d) => d.id === selectedDeviceId) ?? null : null;
  const hostedBots = device ? ownedAgents.filter((a) => a.daemon_instance_id === device.id) : [];

  const [editingName, setEditingName] = useState(device?.label || "");
  const [nameSaved, setNameSaved] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [forwardLogs, setForwardLogs] = useState(false);
  /** Nested view — when set, drawer shows that bot's detail instead of device sections. */
  const [viewingBotId, setViewingBotId] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const motionRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const closingRef = useRef(false);

  const closeDrawer = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    cleanupAnime(motionRef.current);
    motionRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      direction: "right",
      contentSelector: "[data-overlay-section]",
      onComplete: () => setSelectedDeviceId(null),
    });
  }, [setSelectedDeviceId]);

  // Reset local state when the drawer opens against a different device.
  useEffect(() => {
    setEditingName(device?.label || "");
    setNameSaved(false);
    setConfirmRemove(false);
    setShowInstall(false);
    setShowLogs(false);
    setForwardLogs(false);
    setViewingBotId(null);
    closingRef.current = false;
  }, [device?.id]);

  // Close on Escape.

  useEffect(() => {
    if (!open || !device) return;
    motionRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; },
      direction: "right",
      contentSelector: "[data-overlay-section]",
    });
    return () => cleanupAnime(motionRef.current);
  }, [device?.id, open]);

  if (!open || !device) return null;

  const online = device.status === "online";
  const isCloud = device.kind === "cloud";
  const DeviceIcon = isCloud ? Cloud : Cpu;
  const statusLabel =
    device.status === "online" ? "在线"
    : device.status === "offline" ? "离线"
    : device.status === "revoked" ? "已撤销"
    : "待清理";
  const statusColor =
    device.status === "online" ? "text-neon-green"
    : device.status === "revoked" ? "text-danger"
    : device.status === "removal_pending" ? "text-warning"
    : "text-text-secondary";
  const diagnosticResult = diagnosticResults[device.id];
  const diagnosticDownloadPath = diagnosticResult
    ? `/daemon/diagnostics/${encodeURIComponent(diagnosticResult.bundle_id)}/download`
    : "";
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      if (isCloud) {
        await refresh({ quiet: true });
      } else {
        await refreshRuntimes(device.id);
      }
    } finally {
      setIsRefreshing(false);
    }
  };
  const handleRename = async () => {
    if (!editingName.trim() || editingName.trim() === device.label) return;
    const ok = await rename(device.id, editingName.trim());
    if (ok) {
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    }
  };
  const handleRemoveDevice = async () => {
    await removeDevice(device.id);
    await Promise.all([
      refresh({ quiet: true }),
      refreshUserProfile(),
    ]);
    setSelectedDeviceId(null);
  };
  const handleRestartDevice = async () => {
    const ok = await restartDevice(device.id);
    if (ok) {
      await Promise.all([
        refresh({ quiet: true }),
        refreshUserProfile(),
      ]);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeDrawer} ariaLabel="设备详情" placement="right" overlayClassName="z-40" className="max-w-md">
        {/* Drawer header */}
        <div className="liquid-toolbar flex items-center gap-3 border-b border-glass-border px-5 py-4" data-overlay-section>
          <div className="liquid-tool-surface flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-glass-border text-text-secondary">
            <DeviceIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-text-primary">
                {device.label || (isCloud ? "BotCord Cloud Device" : device.id)}
              </h2>
              {isCloud ? (
                <Badge tone="accent" >
                  Cloud
                </Badge>
              ) : null}
              <span
                className={`flex items-center gap-1 rounded-full border px-1.5 py-px text-xs ${
                  online
                    ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                    : "border-glass-border bg-glass-bg text-text-secondary"
                }`}
            >
              <span className={`h-1 w-1 rounded-full ${online ? "bg-neon-green" : "bg-text-secondary/40"}`} />
              {online ? "Online" : "Offline"}
            </span>
          </div>
          <p className="mt-1 font-mono text-xs text-text-secondary">{device.id}</p>
        </div>
        <IconButton label="刷新设备状态"
          onClick={() => void handleRefresh()}
          disabled={isRefreshing}
          title="刷新"
          aria-label="刷新设备状态"
          className="w-8 shrink-0"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
        </IconButton>
        <IconButton label="关闭"
          onClick={closeDrawer}
          title="关闭"
          aria-label="关闭"
          className="w-8 shrink-0"
        >
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4" data-overlay-section>

      {viewingBotId ? (
        <BotDetailNested
          agentId={viewingBotId}
          ownedAgents={ownedAgents}
          onBack={() => setViewingBotId(null)}
        />
      ) : (<>
      {/* Hosted bots */}
      <Card as="section" padding="none" className="p-4">
        <h3 className="mb-3 text-xs font-semibold text-text-secondary">
          托管的 Bots · {hostedBots.length}
        </h3>
        {hostedBots.length === 0 ? (
          <p className="text-xs text-text-secondary">这台设备还没有托管任何 Bot</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {hostedBots.map((bot) => (
              <Button variant="secondary"
                key={bot.agent_id}
                onClick={() => setViewingBotId(bot.agent_id)}

              >
                <BotAvatar
                  agentId={bot.agent_id}
                  avatarUrl={bot.avatar_url}
                  size={28}
                  alt={bot.display_name}
                />
                <span className="flex-1 truncate text-sm text-text-primary">{bot.display_name}</span>
                {bot.is_default ? (
                  <Badge tone="accent" >
                    默认
                  </Badge>
                ) : null}
                <ChevronRight className="h-3.5 w-3.5 text-text-secondary" />
              </Button>
            ))}
          </div>
        )}
      </Card>

      {/* Device info */}
      <Card as="section" padding="none" className="p-4">
        <h3 className="mb-3 text-xs font-semibold text-text-secondary">
          设备信息
        </h3>
        <div className="space-y-3 text-xs">
          <Row label="连接状态">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
              <IconButton label="检查连接"
                onClick={() => void handleRefresh()}
                disabled={isRefreshing}
                title="检查连接"
                className="w-6"
              >
                <RefreshCw className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`} />
              </IconButton>
            </div>
          </Row>
          {device.last_seen_at ? (
            <Row label="最后在线">
              <span className="font-mono text-xs text-text-secondary">
                {new Date(device.last_seen_at).toLocaleString()}
              </span>
            </Row>
          ) : null}
          {device.created_at ? (
            <Row label="添加时间">
              <span className="font-mono text-xs text-text-secondary">
                {new Date(device.created_at).toLocaleDateString()}
              </span>
            </Row>
          ) : null}
          {isCloud ? (
            <Row label="托管类型">
              <span className="text-xs text-neon-cyan">BotCord Cloud</span>
            </Row>
          ) : null}
        </div>
      </Card>

      <Card as="section" padding="none" className="p-4">
        <h3 className="mb-3 text-xs font-semibold text-text-secondary">
          {isCloud ? "云设备操作" : "设备操作"}
        </h3>
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-text-secondary">
            {isCloud
              ? "重启会重新启动这台云设备上的 daemon，并重新连接所有托管 Bot。"
              : "重启会让在线 daemon 拉取最新版本，然后重新连接所有托管 Bot。"}
          </p>
          <Button variant="primary"
            onClick={() => void handleRestartDevice()}
            disabled={restartingId === device.id || (!isCloud && !online)}

          >
            {restartingId === device.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {restartingId === device.id
              ? "重启中..."
              : isCloud
                ? "重启云设备"
                : "更新并重启 daemon"}
          </Button>
          {!isCloud && !online ? (
            <p className="text-xs text-text-secondary">
              设备离线时，请在该设备终端运行下方重新启动命令。
            </p>
          ) : null}
        </div>
      </Card>

      {/* Rename */}
      <Card as="section" padding="none" className="p-4">
        <h3 className="mb-3 text-xs font-semibold text-text-secondary">
          设备名称
        </h3>
        <div className="flex gap-2">
          <Input
            value={editingName}
            onChange={(e) => {
              setEditingName(e.target.value);
              setNameSaved(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
            }}
            maxLength={64}
            placeholder={device.id.slice(0, 18)}
            className="flex-1"
          />
          <Button variant="secondary"
            disabled={!editingName.trim() || editingName.trim() === device.label}
            onClick={() => void handleRename()}
            className="w-9 shrink-0"
          >
            {nameSaved ? <Check className="h-4 w-4 text-neon-green" /> : <Check className="h-4 w-4" />}
          </Button>
        </div>
      </Card>

      {/* Restart command (collapsible) */}
      {!isCloud ? (
      <Card as="section" padding="none" className="p-4">
        <Button variant="ghost"
          onClick={() => setShowInstall((v) => !v)}
          className="w-full"
        >
          <span className="text-xs font-semibold text-text-secondary">
            重新启动命令
          </span>
          <ChevronDown
            className={`h-4 w-4 text-text-secondary transition-transform ${showInstall ? "rotate-180" : ""}`}
          />
        </Button>
        {showInstall ? (
          <div className="mt-3">
            <DaemonInstallCommand
              targetDaemonId={device.id}
              labels={{
                title: "重新启动 BotCord Daemon",
                hint: "在这台设备的终端运行；此命令会恢复当前设备 ID，即使本机凭据已丢失。",
                copy: "复制",
                copied: "已复制",
                refresh: "刷新",
              }}
              onRefresh={() => void refresh({ quiet: true })}
            />
          </div>
        ) : null}
      </Card>
      ) : null}

      {/* Diagnostic log (collapsible) */}
      {!isCloud ? (
      <Card as="section" padding="none" className="p-4">
        <Button variant="ghost"
          onClick={() => setShowLogs((v) => !v)}
          className="w-full"
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
            <Terminal className="h-3.5 w-3.5" />
            排障日志
          </span>
          <ChevronDown
            className={`h-4 w-4 text-text-secondary transition-transform ${showLogs ? "rotate-180" : ""}`}
          />
        </Button>
        {showLogs ? (
          <div className="mt-3 space-y-1.5">
            <p className="text-xs leading-relaxed text-text-secondary">
              从真实 daemon API 收集诊断包。完整日志由后端生成并返回下载信息。
            </p>
            {diagnosticResult ? (
              <div className="flex items-center gap-2 rounded-lg border border-neon-green/20 bg-neon-green/10 px-2 py-2">
                <FileArchive className="h-4 w-4 shrink-0 text-neon-green" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-neon-green">{diagnosticResult.filename}</p>
                  <p className="text-xs text-neon-green/70">
                    日志文件已准备好 · {diagnosticResult.size_bytes} bytes
                  </p>
                  {diagnosticResult.local_path ? (
                    <p className="mt-1 truncate font-mono text-xs text-neon-green/55">
                      {diagnosticResult.local_path}
                    </p>
                  ) : null}
                </div>
                <IconButton label="转发日志到聊天"
                  type="button"
                  onClick={() => setForwardLogs(true)}
                  title="转发到聊天"
                  aria-label="转发日志到聊天"
                className="w-7 shrink-0"
                >
                  <Send className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton label="下载日志文件"
                  type="button"
                  onClick={() => void downloadApiFile(
                    diagnosticDownloadPath,
                    diagnosticResult.filename,
                  )}
                  title="下载日志文件"
                  aria-label="下载日志文件"
                  className="w-7 shrink-0"
                >
                  <Download className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button variant="ghost"
                onClick={() => void collectDiagnostics(device.id)}
                disabled={collectingDiagnosticsId === device.id}

              >
                {collectingDiagnosticsId === device.id ? "收集中..." : "收集诊断包 →"}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
      ) : null}

      {/* Danger zone */}
      {!isCloud ? (
      <section className="rounded-2xl border border-danger/25 bg-danger-soft p-5">
        <h3 className="mb-3 text-xs font-semibold text-danger">
          危险操作
        </h3>
        {!confirmRemove ? (
          <Button variant="danger"
            onClick={() => setConfirmRemove(true)}
            className="w-full"
          >
            <span className="flex items-center gap-2">
              <Trash2 className="h-3.5 w-3.5" />
              移除此设备
            </span>
            <span className="text-text-secondary">
              {hostedBots.length > 0 ? `${hostedBots.length} 个 Bot 在运行` : ""}
            </span>
          </Button>
        ) : (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-danger">确认移除此设备？</p>
            <p className="text-xs leading-relaxed text-text-secondary">
              {hostedBots.length > 0
                ? `${hostedBots.length} 个 Bot 将移到「未关联设备」分组，云端身份和聊天记录都会保留。`
                : "此设备没有托管的 Bot。移除后云端记录会保留。"}
            </p>
            {online ? (
              <p className="text-xs leading-relaxed text-text-secondary">
                设备在线 — 本地凭据将立即清理。
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-warning">
                设备当前离线。本地凭据需等设备重新启动后才能清理。
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="secondary"
                onClick={() => setConfirmRemove(false)}

              >
                取消
              </Button>
              <Button variant="danger"
                onClick={() => void handleRemoveDevice()}
                disabled={removingId === device.id}

              >
                {removingId === device.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {removingId === device.id ? "移除中..." : "移除设备"}
              </Button>
            </div>
          </div>
        )}
      </section>
      ) : null}
      </>)}
      </div>
      </DialogSurface>
      {forwardLogs && diagnosticResult ? (
        <ForwardModal
          quoteText=""
          sourceFile={{
            url: diagnosticDownloadPath,
            filename: diagnosticResult.filename,
            contentType: "application/zip",
            sizeBytes: diagnosticResult.size_bytes,
          }}
          onClose={() => setForwardLogs(false)}
        />
      ) : null}
    </>
  );
}

function BotDetailNested({
  agentId,
  ownedAgents,
  onBack,
}: {
  agentId: string;
  ownedAgents: ReturnType<typeof useDashboardSessionStore.getState>["ownedAgents"];
  onBack: () => void;
}) {
  const bot = ownedAgents.find((a) => a.agent_id === agentId);

  if (!bot) {
    return (
      <div className="space-y-3">
        <Button variant="ghost"
          onClick={onBack}

        >
          <ArrowLeft className="h-3.5 w-3.5" /> 返回设备
        </Button>
        <p className="text-sm text-text-secondary">Bot 不存在</p>
      </div>
    );
  }

  const online = bot.ws_online;
  return (
    <div className="space-y-4">
      <Button variant="ghost"
        onClick={onBack}

      >
        <ArrowLeft className="h-3.5 w-3.5" /> 返回设备详情
      </Button>

      {/* Profile header */}
      <div className="flex flex-col items-center pt-2 text-center">
        <BotAvatar agentId={bot.agent_id} avatarUrl={bot.avatar_url} size={80} alt={bot.display_name} />
        <div className="mt-3 flex items-center gap-2">
          <h2 className="text-lg font-semibold text-text-primary">{bot.display_name}</h2>
          <Badge tone="accent" >
            {bot.is_default ? "My Bot · 默认" : "My Bot"}
          </Badge>
        </div>
        <p className={`mt-1 text-xs ${online ? "text-neon-green" : "text-text-secondary"}`}>
          ● {online ? "Online" : "Offline"}
        </p>
        <p className="mt-1 font-mono text-xs text-text-secondary">{bot.agent_id}</p>
        {bot.bio ? (
          <p className="mt-3 max-w-xs text-xs text-text-secondary">{bot.bio}</p>
        ) : null}
      </div>

      <Card as="section" padding="none" className="p-4">
        此处只展示真实设备绑定关系。Bot 对话、策略和自主任务请在 Bot 详情中管理。
      </Card>
    </div>
  );
}

function Stat({ label, value, delta }: { label: string; value: number | string; delta?: string }) {
  return (
    <div className="liquid-tool-surface rounded-lg px-2 py-1.5">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-sm font-semibold text-text-primary">{value}</span>
        {delta ? <span className="text-xs font-medium text-neon-green">{delta}</span> : null}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-secondary">{label}</span>
      {children}
    </div>
  );
}
