"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Loader2,
  MessageCircle,
  RefreshCw,
  Settings2,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { devBotActivities } from "@/lib/dev-bypass";
import BotAvatar from "./BotAvatar";

/**
 * Right-edge slide-out drawer for one device's details + settings.
 * Driven by `selectedDeviceId` in the UI store; close = set it to null.
 */
export default function DeviceDetailDrawer() {
  const daemons = useDaemonStore((s) => s.daemons);
  const { selectedDeviceId, setSelectedDeviceId } = useDashboardUIStore(
    useShallow((s) => ({
      selectedDeviceId: s.selectedDeviceId,
      setSelectedDeviceId: s.setSelectedDeviceId,
    })),
  );
  const { ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents })),
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
  const [copied, setCopied] = useState(false);
  /** Nested view — when set, drawer shows that bot's detail instead of device sections. */
  const [viewingBotId, setViewingBotId] = useState<string | null>(null);

  // Reset local state when the drawer opens against a different device.
  useEffect(() => {
    setEditingName(device?.label || "");
    setNameSaved(false);
    setConfirmRemove(false);
    setShowInstall(false);
    setShowLogs(false);
    setViewingBotId(null);
  }, [device?.id]);

  // Mock diagnostic log entries; in real impl this would come from /api/daemon/instances/{id}/logs.
  const logs = useMemo(() => {
    if (!device) return [];
    return [
      { ts: new Date(Date.now() - 60_000).toLocaleTimeString(), level: "info" as const, msg: "Heartbeat sent → Hub ACK 12ms" },
      { ts: new Date(Date.now() - 4 * 60_000).toLocaleTimeString(), level: "info" as const, msg: "Runtime probe complete: claude-code v1.2.3, codex v0.7.1" },
      { ts: new Date(Date.now() - 15 * 60_000).toLocaleTimeString(), level: "warn" as const, msg: "Inbox WS reconnect (transient): retry #2 ok" },
      { ts: new Date(Date.now() - 32 * 60_000).toLocaleTimeString(), level: "info" as const, msg: "Daemon started · pid 47291 · uptime 32m" },
      { ts: new Date(Date.now() - 8 * 3600_000).toLocaleTimeString(), level: "info" as const, msg: "Connected to Hub at api.botcord.chat" },
    ];
  }, [device?.id]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedDeviceId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setSelectedDeviceId]);

  if (!open || !device) return null;

  const online = device.status === "online";
  const statusLabel =
    device.status === "online" ? "在线"
    : device.status === "offline" ? "离线"
    : device.status === "revoked" ? "已撤销"
    : "待清理";
  const statusColor =
    device.status === "online" ? "text-neon-green"
    : device.status === "revoked" ? "text-red-400"
    : device.status === "removal_pending" ? "text-yellow-400"
    : "text-text-secondary/60";

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await new Promise((r) => setTimeout(r, 600));
    setIsRefreshing(false);
  };
  const handleRename = () => {
    if (!editingName.trim() || editingName.trim() === device.label) return;
    // Optimistically update the daemon list (mock; real impl calls /api/daemon/...).
    useDaemonStore.setState({
      daemons: daemons.map((d) =>
        d.id === device.id ? { ...d, label: editingName.trim() } : d,
      ),
    });
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  };

  const restartCmd = "curl -fsSL https://api.botcord.chat/daemon/install.sh | bash";
  const handleCopyCmd = async () => {
    try {
      await navigator.clipboard.writeText(restartCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard not available; silently ignore in dev */
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity"
        onClick={() => setSelectedDeviceId(null)}
        aria-hidden
      />
      {/* Drawer */}
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-glass-border bg-deep-black-light shadow-2xl shadow-black/50"
        role="dialog"
        aria-label="设备详情"
      >
        {/* Drawer header */}
        <div className="flex items-center gap-3 border-b border-glass-border px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-glass-bg/60 text-text-secondary">
            <Cpu className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-text-primary">
                {device.label || device.id}
              </h2>
              <span
                className={`flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] ${
                  online
                    ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                    : "border-glass-border bg-glass-bg text-text-secondary/70"
                }`}
            >
              <span className={`h-1 w-1 rounded-full ${online ? "bg-neon-green" : "bg-text-secondary/40"}`} />
              {online ? "Online" : "Offline"}
            </span>
          </div>
          <p className="mt-1 font-mono text-[11px] text-text-secondary/55">{device.id}</p>
        </div>
        <button
          onClick={() => void handleRefresh()}
          disabled={isRefreshing}
          title="刷新"
          aria-label="刷新设备状态"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={() => setSelectedDeviceId(null)}
          title="关闭"
          aria-label="关闭"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">

      {viewingBotId ? (
        <BotDetailNested
          agentId={viewingBotId}
          ownedAgents={ownedAgents}
          onBack={() => setViewingBotId(null)}
        />
      ) : (<>
      {/* Hosted bots */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
          托管的 Bots · {hostedBots.length}
        </h3>
        {hostedBots.length === 0 ? (
          <p className="text-xs text-text-secondary/55">这台设备还没有托管任何 Bot</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {hostedBots.map((bot) => (
              <button
                key={bot.agent_id}
                onClick={() => setViewingBotId(bot.agent_id)}
                className="flex items-center gap-2.5 rounded-lg border border-glass-border bg-glass-bg/60 px-2 py-1.5 text-left transition-colors hover:border-neon-cyan/40 hover:bg-neon-cyan/5"
              >
                <BotAvatar agentId={bot.agent_id} size={28} alt={bot.display_name} />
                <span className="flex-1 truncate text-sm text-text-primary">{bot.display_name}</span>
                {bot.is_default ? (
                  <span className="rounded-full border border-neon-purple/30 bg-neon-purple/10 px-1.5 py-px text-[9px] text-neon-purple">
                    默认
                  </span>
                ) : null}
                <ChevronRight className="h-3.5 w-3.5 text-text-secondary/45" />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Device info */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
          设备信息
        </h3>
        <div className="space-y-3 text-xs">
          <Row label="连接状态">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
              <button
                onClick={() => void handleRefresh()}
                disabled={isRefreshing}
                title="检查连接"
                className="flex h-6 w-6 items-center justify-center rounded text-text-secondary/55 transition-colors hover:bg-glass-bg hover:text-text-secondary disabled:opacity-40"
              >
                <RefreshCw className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`} />
              </button>
            </div>
          </Row>
          {device.last_seen_at ? (
            <Row label="最后在线">
              <span className="font-mono text-[11px] text-text-secondary/55">
                {new Date(device.last_seen_at).toLocaleString()}
              </span>
            </Row>
          ) : null}
          {device.created_at ? (
            <Row label="添加时间">
              <span className="font-mono text-[11px] text-text-secondary/55">
                {new Date(device.created_at).toLocaleDateString()}
              </span>
            </Row>
          ) : null}
        </div>
      </section>

      {/* Rename */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
          设备名称
        </h3>
        <div className="flex gap-2">
          <input
            value={editingName}
            onChange={(e) => {
              setEditingName(e.target.value);
              setNameSaved(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
            maxLength={64}
            placeholder={device.id.slice(0, 18)}
            className="flex-1 rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary placeholder-text-secondary/40 outline-none focus:border-neon-cyan/40"
          />
          <button
            disabled={!editingName.trim() || editingName.trim() === device.label}
            onClick={handleRename}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-glass-border bg-glass-bg/30 text-text-secondary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan disabled:opacity-40"
          >
            {nameSaved ? <Check className="h-4 w-4 text-neon-green" /> : <Check className="h-4 w-4" />}
          </button>
        </div>
      </section>

      {/* Restart command (collapsible) */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <button
          onClick={() => setShowInstall((v) => !v)}
          className="flex w-full items-center justify-between"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
            重新启动命令
          </span>
          <ChevronDown
            className={`h-4 w-4 text-text-secondary/60 transition-transform ${showInstall ? "rotate-180" : ""}`}
          />
        </button>
        {showInstall ? (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] leading-relaxed text-text-secondary/65">
              在这台同一设备的终端运行；daemon 会用本机保存的设备 ID 重新连接。
            </p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-lg border border-glass-border bg-deep-black px-3 py-2 pr-9 font-mono text-[11px] text-text-primary">{restartCmd}</pre>
              <button
                onClick={() => void handleCopyCmd()}
                title={copied ? "已复制" : "复制"}
                aria-label="复制命令"
                className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-neon-green" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Diagnostic log (collapsible) */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <button
          onClick={() => setShowLogs((v) => !v)}
          className="flex w-full items-center justify-between"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
            <Terminal className="h-3.5 w-3.5" />
            排障日志
          </span>
          <ChevronDown
            className={`h-4 w-4 text-text-secondary/60 transition-transform ${showLogs ? "rotate-180" : ""}`}
          />
        </button>
        {showLogs ? (
          <div className="mt-3 space-y-1.5">
            <p className="text-[11px] leading-relaxed text-text-secondary/65">
              最近的 daemon 事件 · 仅显示 10 条，更早可在本机 <span className="font-mono">~/.botcord/logs/</span> 查看。
            </p>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-glass-border bg-deep-black p-2 font-mono text-[10.5px] leading-relaxed">
              {logs.length === 0 ? (
                <p className="text-text-secondary/50">暂无日志</p>
              ) : (
                logs.map((entry, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="shrink-0 text-text-secondary/50">{entry.ts}</span>
                    <span
                      className={`shrink-0 ${
                        entry.level === "warn"
                          ? "text-yellow-400"
                          : entry.level === "info"
                            ? "text-neon-cyan/85"
                            : "text-text-secondary/70"
                      }`}
                    >
                      {entry.level.toUpperCase()}
                    </span>
                    <span className="text-text-primary/85">{entry.msg}</span>
                  </div>
                ))
              )}
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => alert("Download full log (TODO)")}
                className="text-[11px] text-text-secondary/60 transition-colors hover:text-neon-cyan"
              >
                导出完整日志 →
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Danger zone */}
      <section className="rounded-2xl border border-red-500/25 bg-red-500/5 p-5">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-red-300/85">
          危险操作
        </h3>
        {!confirmRemove ? (
          <button
            onClick={() => setConfirmRemove(true)}
            className="flex w-full items-center justify-between rounded-lg text-left text-xs text-red-300/85 transition-colors hover:text-red-200"
          >
            <span className="flex items-center gap-2">
              <Trash2 className="h-3.5 w-3.5" />
              移除此设备
            </span>
            <span className="text-text-secondary/55">
              {hostedBots.length > 0 ? `${hostedBots.length} 个 Bot 在运行` : ""}
            </span>
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-red-300">确认移除此设备？</p>
            <p className="text-[11px] leading-relaxed text-text-secondary/70">
              {hostedBots.length > 0
                ? `${hostedBots.length} 个 Bot 将移到「未关联设备」分组，云端身份和聊天记录都会保留。`
                : "此设备没有托管的 Bot。移除后云端记录会保留。"}
            </p>
            {online ? (
              <p className="text-[11px] leading-relaxed text-text-secondary/55">
                设备在线 — 本地凭据将立即清理。
              </p>
            ) : (
              <p className="text-[11px] leading-relaxed text-yellow-400/80">
                设备当前离线。本地凭据需等设备重新启动后才能清理。
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                onClick={() => setConfirmRemove(false)}
                className="rounded-lg border border-glass-border px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-glass-bg"
              >
                取消
              </button>
              <button
                onClick={() => {
                  alert("Remove device (TODO — connect to useDaemonStore.removeDevice)");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/60 bg-red-500/15 px-3 py-1.5 text-[11px] font-medium text-red-200 transition-colors hover:bg-red-500/25"
              >
                <Loader2 className="hidden h-3 w-3 animate-spin" />
                移除设备
              </button>
            </div>
          </div>
        )}
      </section>
      </>)}
      </div>
      </aside>
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
  const stats = devBotActivities.find((s) => s.agent_id === agentId);

  if (!bot) {
    return (
      <div className="space-y-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs text-neon-cyan hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 返回设备
        </button>
        <p className="text-sm text-text-secondary/70">Bot 不存在</p>
      </div>
    );
  }

  const online = stats?.online ?? bot.ws_online;
  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded-md text-xs text-text-secondary/75 transition-colors hover:text-neon-cyan"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> 返回设备详情
      </button>

      {/* Profile header */}
      <div className="flex flex-col items-center pt-2 text-center">
        <BotAvatar agentId={bot.agent_id} size={80} alt={bot.display_name} />
        <div className="mt-3 flex items-center gap-2">
          <h2 className="text-lg font-semibold text-text-primary">{bot.display_name}</h2>
          <span className="rounded-full border border-neon-cyan/40 bg-neon-cyan/10 px-1.5 py-px text-[10px] font-medium text-neon-cyan">
            {bot.is_default ? "My Bot · 默认" : "My Bot"}
          </span>
        </div>
        <p className={`mt-1 text-xs ${online ? "text-neon-green" : "text-text-secondary/60"}`}>
          ● {online ? "Online" : "Offline"}
        </p>
        <p className="mt-1 font-mono text-[11px] text-text-secondary/55">{bot.agent_id}</p>
        {bot.bio ? (
          <p className="mt-3 max-w-xs text-xs text-text-secondary/80">{bot.bio}</p>
        ) : null}
      </div>

      {/* Stats */}
      {stats ? (
        <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
            7 天活跃
          </h3>
          <div className="grid grid-cols-4 gap-2 text-center">
            <Stat label="消息" value={stats.messages_7d} />
            <Stat label="房间" value={stats.rooms_active} />
            <Stat label="话题" value={stats.topics_completed} />
            <Stat label="关注" value={stats.followers} delta={`+${stats.followers_delta_7d}`} />
          </div>
        </section>
      ) : null}

      {/* Actions */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <div className="flex gap-2">
          <button
            onClick={() => alert("Open chat (TODO)")}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            打开对话
          </button>
          <button
            onClick={() => alert("Bot settings (TODO)")}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-2 text-xs font-medium text-text-secondary/80 transition-colors hover:text-text-primary"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Bot 设置
          </button>
        </div>
      </section>

      {/* Detach */}
      <section className="rounded-2xl border border-red-500/25 bg-red-500/5 p-4">
        <button
          onClick={() => alert("Detach from device (TODO)")}
          className="flex w-full items-center justify-between rounded-lg text-left text-xs text-red-300/85 transition-colors hover:text-red-200"
        >
          <span className="flex items-center gap-2">
            <Trash2 className="h-3.5 w-3.5" />
            从此设备解除托管
          </span>
        </button>
      </section>
    </div>
  );
}

function Stat({ label, value, delta }: { label: string; value: number | string; delta?: string }) {
  return (
    <div className="rounded-lg bg-glass-bg/50 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-text-secondary/55">{label}</div>
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-sm font-semibold text-text-primary">{value}</span>
        {delta ? <span className="text-[9px] font-medium text-neon-green">{delta}</span> : null}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-secondary/60">{label}</span>
      {children}
    </div>
  );
}
