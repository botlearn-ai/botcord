"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Check, Cpu, Loader2, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import { useShallow } from "zustand/shallow";
import BotAvatar from "./BotAvatar";
import { useDaemonStore } from "@/store/useDaemonStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import type { UserAgent } from "@/lib/types";

function statusText(status: string) {
  if (status === "online") return "在线";
  if (status === "offline") return "离线";
  if (status === "revoked") return "已撤销";
  if (status === "removal_pending") return "待清理";
  return status;
}

export default function DeviceDetailDrawer() {
  const daemons = useDaemonStore((s) => s.daemons);
  const rename = useDaemonStore((s) => s.rename);
  const renamingId = useDaemonStore((s) => s.renamingId);
  const removeDevice = useDaemonStore((s) => s.removeDevice);
  const removingId = useDaemonStore((s) => s.removingId);
  const refresh = useDaemonStore((s) => s.refresh);
  const collectDiagnostics = useDaemonStore((s) => s.collectDiagnostics);
  const collectingDiagnosticsId = useDaemonStore((s) => s.collectingDiagnosticsId);
  const diagnosticResults = useDaemonStore((s) => s.diagnosticResults);
  const diagnosticErrors = useDaemonStore((s) => s.diagnosticErrors);
  const { selectedDeviceId, setSelectedDeviceId, setBotDetailAgentId } = useDashboardUIStore(
    useShallow((s) => ({
      selectedDeviceId: s.selectedDeviceId,
      setSelectedDeviceId: s.setSelectedDeviceId,
      setBotDetailAgentId: s.setBotDetailAgentId,
    })),
  );
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);

  const device = selectedDeviceId ? daemons.find((d) => d.id === selectedDeviceId) ?? null : null;
  const hostedBots = device ? ownedAgents.filter((agent) => agent.daemon_instance_id === device.id) : [];
  const [editingName, setEditingName] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [viewingBot, setViewingBot] = useState<UserAgent | null>(null);

  useEffect(() => {
    setEditingName(device?.label ?? "");
    setSaved(false);
    setConfirmRemove(false);
    setViewingBot(null);
  }, [device?.id, device?.label]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedDeviceId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedDeviceId, setSelectedDeviceId]);

  if (!selectedDeviceId || !device) return null;

  const online = device.status === "online";
  const diagnostic = diagnosticResults[device.id];
  const diagnosticError = diagnosticErrors[device.id];

  const handleRename = async () => {
    const next = editingName.trim() || null;
    if ((next ?? "") === (device.label ?? "")) return;
    const ok = await rename(device.id, next);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    }
  };

  const handleRemove = async () => {
    await removeDevice(device.id, { forgetIfOffline: !online });
    await refresh({ quiet: true });
    setSelectedDeviceId(null);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" onClick={() => setSelectedDeviceId(null)} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-glass-border bg-deep-black-light shadow-2xl shadow-black/50" role="dialog" aria-label="设备详情">
        <div className="flex items-center gap-3 border-b border-glass-border px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-glass-bg/60 text-text-secondary">
            <Cpu className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-text-primary">{device.label || device.id}</h2>
              <span className={`flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] ${online ? "border-neon-green/40 bg-neon-green/10 text-neon-green" : "border-glass-border bg-glass-bg text-text-secondary/70"}`}>
                <span className={`h-1 w-1 rounded-full ${online ? "bg-neon-green" : "bg-text-secondary/40"}`} />
                {online ? "Online" : "Offline"}
              </span>
            </div>
            <p className="mt-1 font-mono text-[11px] text-text-secondary/55">{device.id}</p>
          </div>
          <button onClick={() => void refresh({ quiet: true })} title="刷新" aria-label="刷新设备状态" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary">
            <RefreshCw className="h-4 w-4" />
          </button>
          <button onClick={() => setSelectedDeviceId(null)} title="关闭" aria-label="关闭" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {viewingBot ? (
            <BotSummary bot={viewingBot} onBack={() => setViewingBot(null)} onOpenDetail={() => { setSelectedDeviceId(null); setBotDetailAgentId(viewingBot.agent_id); }} />
          ) : (
            <>
              <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">托管的 Bots · {hostedBots.length}</h3>
                {hostedBots.length === 0 ? (
                  <p className="text-xs text-text-secondary/55">这台设备还没有托管任何 Bot</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {hostedBots.map((bot) => (
                      <button key={bot.agent_id} onClick={() => setViewingBot(bot)} className="flex items-center gap-2.5 rounded-lg border border-glass-border bg-glass-bg/60 px-2 py-1.5 text-left transition-colors hover:border-neon-cyan/40 hover:bg-neon-cyan/5">
                        <BotAvatar agentId={bot.agent_id} avatarUrl={bot.avatar_url} size={28} alt={bot.display_name} />
                        <span className="flex-1 truncate text-sm text-text-primary">{bot.display_name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">设备信息</h3>
                <div className="space-y-3 text-xs">
                  <Row label="连接状态"><span className={online ? "text-neon-green" : "text-text-secondary/70"}>{statusText(device.status)}</span></Row>
                  {device.last_seen_at ? <Row label="最后在线"><span className="font-mono text-[11px] text-text-secondary/55">{new Date(device.last_seen_at).toLocaleString()}</span></Row> : null}
                  {device.created_at ? <Row label="添加时间"><span className="font-mono text-[11px] text-text-secondary/55">{new Date(device.created_at).toLocaleString()}</span></Row> : null}
                </div>
              </section>

              <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">设备名称</h3>
                <div className="flex gap-2">
                  <input value={editingName} onChange={(e) => { setEditingName(e.target.value); setSaved(false); }} onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); }} maxLength={64} placeholder={device.id.slice(0, 18)} className="flex-1 rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary placeholder-text-secondary/40 outline-none focus:border-neon-cyan/40" />
                  <button disabled={renamingId === device.id || (editingName.trim() || "") === (device.label ?? "")} onClick={() => void handleRename()} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-glass-border bg-glass-bg/30 text-text-secondary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan disabled:opacity-40">
                    {saved ? <Check className="h-4 w-4 text-neon-green" /> : <Check className="h-4 w-4" />}
                  </button>
                </div>
              </section>

              <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">诊断包</h3>
                    <p className="mt-1 text-[11px] text-text-secondary/60">从 daemon 收集真实诊断结果。</p>
                  </div>
                  <button onClick={() => void collectDiagnostics(device.id)} disabled={collectingDiagnosticsId === device.id} className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan disabled:opacity-50">
                    {collectingDiagnosticsId === device.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Settings2 className="h-3 w-3" />}
                    收集
                  </button>
                </div>
                {diagnostic ? <p className="mt-3 rounded-lg border border-neon-green/25 bg-neon-green/10 px-3 py-2 text-[11px] text-neon-green">{diagnostic.filename} · {diagnostic.size_bytes} bytes</p> : null}
                {diagnosticError ? <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">{diagnosticError}</p> : null}
              </section>

              <section className="rounded-2xl border border-red-500/25 bg-red-500/5 p-5">
                {!confirmRemove ? (
                  <button onClick={() => setConfirmRemove(true)} className="flex w-full items-center justify-between rounded-lg text-left text-xs text-red-300/85 transition-colors hover:text-red-200">
                    <span className="flex items-center gap-2"><Trash2 className="h-3.5 w-3.5" />移除此设备</span>
                    <span className="text-text-secondary/55">{hostedBots.length > 0 ? `${hostedBots.length} 个 Bot 在运行` : ""}</span>
                  </button>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-red-300">确认移除此设备？</p>
                    <p className="text-[11px] leading-relaxed text-text-secondary/70">云端 Bot 身份和聊天记录会保留；离线设备将在下次启动后清理本地凭据。</p>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setConfirmRemove(false)} className="rounded-lg border border-glass-border px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-glass-bg">取消</button>
                      <button onClick={() => void handleRemove()} disabled={removingId === device.id} className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/60 bg-red-500/15 px-3 py-1.5 text-[11px] font-medium text-red-200 transition-colors hover:bg-red-500/25 disabled:opacity-50">
                        {removingId === device.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        移除设备
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function BotSummary({ bot, onBack, onOpenDetail }: { bot: UserAgent; onBack: () => void; onOpenDetail: () => void }) {
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 rounded-md text-xs text-text-secondary/75 transition-colors hover:text-neon-cyan">
        <ArrowLeft className="h-3.5 w-3.5" /> 返回设备详情
      </button>
      <div className="flex flex-col items-center pt-2 text-center">
        <BotAvatar agentId={bot.agent_id} avatarUrl={bot.avatar_url} size={80} alt={bot.display_name} />
        <h2 className="mt-3 text-lg font-semibold text-text-primary">{bot.display_name}</h2>
        <p className={`mt-1 text-xs ${bot.ws_online ? "text-neon-green" : "text-text-secondary/60"}`}>● {bot.ws_online ? "Online" : "Offline"}</p>
        <p className="mt-1 font-mono text-[11px] text-text-secondary/55">{bot.agent_id}</p>
        {bot.bio ? <p className="mt-3 max-w-xs text-xs text-text-secondary/80">{bot.bio}</p> : null}
      </div>
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <button onClick={onOpenDetail} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20">
          <Settings2 className="h-3.5 w-3.5" />
          打开 Bot 详情
        </button>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-secondary/60">{label}</span>
      {children}
    </div>
  );
}
