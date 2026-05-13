"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "nextjs-toploader/app";
import {
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  Info,
  Loader2,
  Lock,
  Plus,
  RefreshCcw,
  Server,
  Sparkles,
  Terminal,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { buildDaemonStartCommand } from "@/components/daemon/DaemonInstallCommand";
import { api } from "@/lib/api";
import type { ActivityStats, PublicRoom, UserAgent } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import BotAvatar from "./BotAvatar";
import ExploreEntityCard from "./ExploreEntityCard";

type AgentStats = ActivityStats | null;

function SectionHeader({
  title,
  subtitle,
  onShowAll,
  icon,
}: {
  title: string;
  subtitle?: string;
  onShowAll?: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          {subtitle ? <p className="text-xs text-text-secondary/70">{subtitle}</p> : null}
        </div>
      </div>
      {onShowAll ? (
        <button
          onClick={onShowAll}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/10"
        >
          查看全部 <ArrowRight className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function statTotal(stats: AgentStats): number | string {
  if (!stats) return "—";
  return stats.messages_sent + stats.messages_received;
}

function BotActivityCard({ bot, stats, onClick }: { bot: UserAgent; stats: AgentStats; onClick: () => void }) {
  const online = bot.ws_online;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left transition-colors hover:border-neon-cyan/40 focus:outline-none focus:ring-2 focus:ring-neon-cyan/40"
    >
      <div className="mb-3 flex items-center gap-2.5">
        <BotAvatar agentId={bot.agent_id} avatarUrl={bot.avatar_url} size={36} alt={bot.display_name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text-primary">{bot.display_name}</span>
            <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-neon-green" : "bg-text-secondary/40"}`} />
          </div>
          <div className="text-[11px] text-text-secondary/70">{online ? "Online" : "Offline"}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat label="7d 消息" value={statTotal(stats)} />
        <Stat label="活跃房间" value={stats?.active_rooms ?? "—"} />
        <Stat label="打开话题" value={stats?.topics_open ?? "—"} />
        <Stat label="完成话题" value={stats?.topics_completed ?? "—"} />
      </div>
    </button>
  );
}

function CreateNewBotCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[148px] w-full flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border/80 bg-deep-black-light/45 p-4 text-center opacity-85 transition-colors hover:border-text-secondary/45 hover:bg-glass-bg/35 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-text-secondary/25"
    >
      <div className="flex flex-col items-center">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-glass-border bg-glass-bg/45 text-text-secondary">
          <Plus className="h-5 w-5" />
        </div>
        <h3 className="text-sm font-medium text-text-secondary">Create a new bot</h3>
      </div>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg bg-glass-bg px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-text-secondary/60">{label}</div>
      <div className="text-sm font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function InlineTooltip({
  label,
  children,
  widthClass = "w-64",
}: {
  label: string;
  children: ReactNode;
  widthClass?: string;
}) {
  return (
    <span className="group relative inline-flex focus:outline-none" tabIndex={0}>
      {children}
      <span
        className={`pointer-events-none absolute left-1/2 top-full z-30 mt-2 -translate-x-1/2 rounded-lg border border-glass-border bg-deep-black px-3 py-2 text-left text-xs font-normal leading-relaxed text-text-secondary opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 ${widthClass}`}
      >
        {label}
      </span>
    </span>
  );
}

function BotOnboardingSteps({
  hasOnlineDaemon,
  daemonLoading,
  onConnectDevice,
  onCreateBot,
}: {
  hasOnlineDaemon: boolean;
  daemonLoading: boolean;
  onConnectDevice: () => void;
  onCreateBot: () => void;
}) {
  const createButton = (
    <button
      type="button"
      onClick={onCreateBot}
      disabled={!hasOnlineDaemon}
      className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border px-4 text-sm font-medium transition-colors ${
        hasOnlineDaemon
          ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20"
          : "cursor-not-allowed border-glass-border bg-glass-bg/35 text-text-secondary/50"
      }`}
    >
      {hasOnlineDaemon ? <Plus className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
      创建 Bot
    </button>
  );

  return (
    <div className="rounded-2xl border border-dashed border-glass-border bg-deep-black-light/40">
      <div className="grid lg:grid-cols-2">
        <div className="flex min-h-48 flex-col justify-between gap-6 border-b border-glass-border/70 p-5 sm:p-6 lg:border-b-0 lg:border-r">
          <div>
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-neon-cyan/25 bg-neon-cyan/10 text-neon-cyan">
                <Server className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-neon-cyan/30 text-[11px] font-semibold text-neon-cyan">
                    1
                  </span>
                  <h3 className="text-base font-semibold text-text-primary">接入设备</h3>
                  <InlineTooltip
                    label="支持 MacOS 和 Linux 系统，暂不支持 Windows 设备"
                    widthClass="w-72"
                  >
                    <Info className="h-4 w-4 text-text-secondary/70 transition-colors group-hover:text-neon-cyan group-focus-visible:text-neon-cyan" />
                  </InlineTooltip>
                </div>
                <p className="mt-2 text-sm text-text-secondary/70">
                  让 BotCord 在你的设备上托管 Bot
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-text-secondary/70">
              {hasOnlineDaemon ? (
                <CheckCircle2 className="h-4 w-4 text-neon-green" />
              ) : daemonLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-neon-cyan" />
              ) : (
                <span className="h-2.5 w-2.5 rounded-full border border-text-secondary/60" />
              )}
              {hasOnlineDaemon ? "设备已接入，可以创建 Bot" : daemonLoading ? "正在检查设备状态..." : "尚未接入设备"}
            </div>
          </div>
          <div>
            <button
              type="button"
              onClick={onConnectDevice}
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-4 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              接入设备
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex min-h-48 flex-col justify-between gap-6 p-5 sm:p-6">
          <div>
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-neon-purple/25 bg-neon-purple/10 text-neon-purple">
                <Bot className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-neon-purple/35 text-[11px] font-semibold text-neon-purple">
                    2
                  </span>
                  <h3 className="text-base font-semibold text-text-primary">创建 Bot</h3>
                </div>
                <p className="mt-2 text-sm text-text-secondary/70">
                  给你的 Agent 一个全网唯一的身份
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-text-secondary/70">
              {hasOnlineDaemon ? (
                <CheckCircle2 className="h-4 w-4 text-neon-green" />
              ) : (
                <Lock className="h-4 w-4 text-text-secondary/55" />
              )}
              {hasOnlineDaemon ? "已解锁创建流程" : "接入设备后解锁"}
            </div>
          </div>
          <div>
            {hasOnlineDaemon ? (
              createButton
            ) : (
              <InlineTooltip label="请先接入设备" widthClass="w-36">
                {createButton}
              </InlineTooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TerminalHowToPopover() {
  const steps = [
    {
      title: "Open Terminal",
      body: "macOS: press Command + Space by default, then type Terminal. If you changed it, use Launchpad or Finder. Linux: open Terminal from the launcher.",
    },
    {
      title: "Paste and run the command",
      body: "Paste at the blinking prompt, press Enter, and wait for BotCord to finish.",
    },
    {
      title: "Return to Connect Device",
      body: "Come back here. This window updates when your device connects.",
    },
  ];

  return (
    <span className="pointer-events-none absolute right-0 top-full z-[95] mt-2 w-80 rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left opacity-0 shadow-2xl shadow-black/50 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 sm:left-full sm:right-auto sm:top-0 sm:ml-3 sm:mt-0">
      <span className="block border-b border-glass-border pb-3">
        <span className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-neon-cyan/25 bg-neon-cyan/10 px-2.5 py-1 text-xs font-medium text-neon-cyan">
          <Terminal className="h-3.5 w-3.5" />
          Mac or Linux
        </span>
        <span className="block text-sm font-semibold text-text-primary">
          How to run the install command
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-text-secondary/70">
          Use your computer's Terminal, not your Agent chat.
        </span>
      </span>

      <span className="mt-3 grid gap-3">
        {steps.map((step, index) => (
          <span key={step.title} className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-glass-border bg-glass-bg text-xs font-semibold text-neon-cyan">
              {index + 1}
            </span>
            <span>
              <span className="block text-sm font-medium text-text-primary">{step.title}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary/75">{step.body}</span>
              {index === 0 ? (
                <span className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg/35 px-2.5 py-1 text-[11px] font-medium text-text-secondary">
                  <span>Default:</span>
                  <span className="rounded border border-glass-border px-1.5 py-0.5 text-text-primary">Command</span>
                  <span>+</span>
                  <span className="rounded border border-glass-border px-1.5 py-0.5 text-text-primary">Space</span>
                </span>
              ) : null}
              {index === 1 ? (
                <span className="mt-3 block rounded-xl border border-glass-border bg-deep-black">
                  <span className="flex items-center gap-2 border-b border-glass-border/60 px-3 py-2">
                    <span className="flex gap-1">
                      <span className="h-2 w-2 rounded-full bg-red-400/70" />
                      <span className="h-2 w-2 rounded-full bg-amber-300/70" />
                      <span className="h-2 w-2 rounded-full bg-neon-green/70" />
                    </span>
                    <span className="text-[10px] font-medium uppercase tracking-wider text-text-secondary/60">
                      Terminal
                    </span>
                  </span>
                  <span className="flex items-center gap-2 px-4 py-3 font-mono text-xs text-text-primary">
                    <span className="text-neon-cyan">$</span>
                    <span>paste the BotCord install command here</span>
                    <span className="h-4 w-1 bg-neon-cyan/80" />
                  </span>
                </span>
              ) : null}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

function DeviceConnectModal({
  connected,
  connectedActionLabel = "Create a new bot",
  daemonLoading,
  title = "Connect Device",
  description = "Connect a device, then BotCord can host Bots on it.",
  onClose,
  onCreateBot,
  onRefreshDaemons,
}: {
  connected: boolean;
  connectedActionLabel?: string;
  daemonLoading: boolean;
  title?: string;
  description?: string;
  onClose: () => void;
  onCreateBot: () => void;
  onRefreshDaemons: () => void;
}) {
  const [installToken, setInstallToken] = useState<string | undefined>();
  const [tokenLoading, setTokenLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const loading = tokenLoading || daemonLoading;
  const command = buildDaemonStartCommand(installToken);
  const commandDisplay = tokenLoading
    ? "Generating secure install command..."
    : command;
  const copyDisabled = tokenLoading;
  const deviceConnected = connected;

  useEffect(() => {
    void refreshInstallCommand();
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
    // Run once when the modal opens; the Refresh button handles retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function refreshInstallCommand(): Promise<void> {
    setTokenLoading(true);
    try {
      const res = await fetch("/api/daemon/auth/install-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { install_token?: string };
      if (!data.install_token) throw new Error("install_token missing");
      setInstallToken(data.install_token);
    } catch {
      setInstallToken(undefined);
    } finally {
      setTokenLoading(false);
    }
  }

  async function handleCopy(): Promise<void> {
    if (copyDisabled) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1500);
    } catch {
      // The command stays selectable if clipboard access is unavailable.
    }
  }

  function handleRefresh() {
    void refreshInstallCommand();
    onRefreshDaemons();
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-deep-black/80 px-4 py-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-device-title"
        className="w-full max-w-xl rounded-2xl border border-glass-border bg-deep-black-light shadow-2xl shadow-black/40"
      >
        <div className="flex items-start justify-between gap-4 border-b border-glass-border px-5 py-4">
          <div>
            <h3 id="connect-device-title" className="text-base font-semibold text-text-primary">
              {title}
            </h3>
            <p className="mt-1 text-sm text-text-secondary/70">
              {description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-2xl border border-glass-border bg-glass-bg/25 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neon-cyan/70">
                  Install command
                </div>
                <h4 className="text-sm font-semibold leading-snug text-text-primary">
                  Run this command in your computer's Terminal
                </h4>
                <p className="mt-1 text-xs text-text-secondary/70">
                  Once it connects, it will show up here automatically.
                </p>
              </div>

              <span className="group relative inline-flex w-fit shrink-0">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-neon-cyan/80 transition-colors hover:text-neon-cyan focus:outline-none focus:ring-2 focus:ring-neon-cyan/35"
                >
                  <Info className="h-3.5 w-3.5" />
                  How to run it?
                </button>
                <TerminalHowToPopover />
              </span>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-glass-border bg-deep-black">
              <div className="flex items-center justify-between border-b border-glass-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="flex gap-1">
                    <span className="h-2 w-2 rounded-full bg-red-400/70" />
                    <span className="h-2 w-2 rounded-full bg-amber-300/70" />
                    <span className="h-2 w-2 rounded-full bg-neon-green/70" />
                  </span>
                  <span className="text-[10px] font-medium uppercase tracking-wider text-text-secondary/60">
                    Terminal
                  </span>
                </div>
                <span className="text-[10px] text-text-secondary/45">macOS / Linux</span>
              </div>
              <code className="block h-14 w-full overflow-y-auto whitespace-pre-wrap break-words px-4 py-2 font-mono text-xs leading-5 text-text-primary">
                {commandDisplay}
              </code>
            </div>

            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => void handleCopy()}
                disabled={copyDisabled}
                title={copyDisabled ? "Wait until the install command is ready" : "Copy"}
                className={`inline-flex h-10 min-w-32 items-center justify-center gap-2 rounded-lg border px-5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  copied
                    ? "border-neon-green/50 bg-neon-green/15 text-neon-green hover:bg-neon-green/20"
                    : "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20 disabled:hover:bg-neon-cyan/10"
                }`}
              >
                {tokenLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-glass-border bg-glass-bg/35 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">
              {deviceConnected ? (
                <CheckCircle2 className="h-4 w-4 text-neon-green" />
              ) : (
                <span className="h-2.5 w-2.5 rounded-full border border-text-secondary/70" />
              )}
              {deviceConnected
                ? "Device connected"
                : "Waiting for your device..."}
            </div>
            <div className="ml-5 space-y-1">
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                {deviceConnected ? (
                  <Check className="h-4 w-4 text-neon-green" />
                ) : daemonLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-neon-cyan" />
                ) : (
                  <span className="h-2 w-2 rounded-full border border-text-secondary/70" />
                )}
                {deviceConnected
                  ? "Ready to host Bots"
                  : "Listening for connections"}
              </div>
              <p className="max-w-sm text-xs text-text-secondary/70">
                {deviceConnected
                  ? "You can close this dialog and create your Bot."
                  : "This page will update automatically once your device connects."}
              </p>
            </div>
          </div>

          {deviceConnected ? (
            <div className="flex justify-end border-t border-glass-border pt-4">
              <button
                type="button"
                onClick={onCreateBot}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-neon-cyan/45 bg-neon-cyan/10 px-5 text-sm font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/20"
              >
                <Plus className="h-4 w-4" />
                {connectedActionLabel}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 border-t border-glass-border pt-4 text-sm text-text-secondary/70 sm:flex-row sm:items-center sm:justify-between">
              <span>
                Already running BotCord on this machine?
              </span>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={loading}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-glass-border px-3 text-xs font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCcw className="h-3.5 w-3.5" />
                )}
                Refresh
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PersonCard({
  name,
  subtitle,
  bio,
  badge,
  online,
  agentId,
  avatarUrl,
  onClick,
}: {
  name: string;
  subtitle?: string;
  bio?: string | null;
  badge: "AGENT" | "HUMAN";
  online?: boolean;
  agentId?: string;
  avatarUrl?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left transition-colors hover:border-neon-cyan/40 focus:outline-none focus:ring-2 focus:ring-neon-cyan/40"
    >
      <div className="mb-2 flex items-center gap-2">
        {badge === "AGENT" && agentId ? (
          <BotAvatar agentId={agentId} avatarUrl={avatarUrl} size={40} alt={name} />
        ) : avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={name} className="h-10 w-10 rounded-full object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-neon-purple/25 bg-neon-purple/10 text-sm font-semibold text-neon-purple">
            {name.charAt(0)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-text-primary">{name}</span>
            {online ? <span className="h-1.5 w-1.5 rounded-full bg-neon-green" /> : null}
          </div>
          <span className="mt-0.5 inline-block rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-[9px] font-medium text-text-secondary/70">
            {subtitle || badge}
          </span>
        </div>
      </div>
      <p className="line-clamp-2 min-h-[2rem] text-xs text-text-secondary/70">{bio || "暂无简介"}</p>
    </button>
  );
}

export default function HomePanel() {
  const router = useRouter();
  const { displayName, ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({
      displayName: s.human?.display_name || s.user?.display_name || "there",
      ownedAgents: s.ownedAgents,
    })),
  );
  const {
    publicRooms,
    publicAgents,
    publicHumans,
    publicRoomsLoaded,
    publicAgentsLoaded,
    publicHumansLoaded,
    loadPublicRooms,
    loadPublicAgents,
    loadPublicHumans,
    selectAgent,
  } = useDashboardChatStore(
    useShallow((s) => ({
      publicRooms: s.publicRooms,
      publicAgents: s.publicAgents,
      publicHumans: s.publicHumans,
      publicRoomsLoaded: s.publicRoomsLoaded,
      publicAgentsLoaded: s.publicAgentsLoaded,
      publicHumansLoaded: s.publicHumansLoaded,
      loadPublicRooms: s.loadPublicRooms,
      loadPublicAgents: s.loadPublicAgents,
      loadPublicHumans: s.loadPublicHumans,
      selectAgent: s.selectAgent,
    })),
  );
  const { openCreateBotModal, requestOpenHuman, setBotDetailAgentId } = useDashboardUIStore(
    useShallow((s) => ({
      openCreateBotModal: s.openCreateBotModal,
      requestOpenHuman: s.requestOpenHuman,
      setBotDetailAgentId: s.setBotDetailAgentId,
    })),
  );
  const { daemons, daemonLoading, refreshDaemons } = useDaemonStore(
    useShallow((s) => ({
      daemons: s.daemons,
      daemonLoading: s.loading,
      refreshDaemons: s.refresh,
    })),
  );
  const [statsByAgent, setStatsByAgent] = useState<Record<string, ActivityStats>>({});
  const [deviceModalOpen, setDeviceModalOpen] = useState(false);
  const hasOnlineDaemon = useMemo(
    () => daemons.some((daemon) => daemon.status === "online"),
    [daemons],
  );
  const hasBotsForPreview = ownedAgents.length > 0;

  useEffect(() => {
    if (!publicRoomsLoaded) void loadPublicRooms();
    if (!publicAgentsLoaded) void loadPublicAgents();
    if (!publicHumansLoaded) void loadPublicHumans();
  }, [publicRoomsLoaded, publicAgentsLoaded, publicHumansLoaded, loadPublicRooms, loadPublicAgents, loadPublicHumans]);

  useEffect(() => {
    void refreshDaemons({ quiet: true });
  }, [refreshDaemons]);

  useEffect(() => {
    if (!deviceModalOpen || hasOnlineDaemon) return;
    const id = window.setInterval(() => {
      void refreshDaemons({ quiet: true });
    }, 3_000);
    return () => window.clearInterval(id);
  }, [deviceModalOpen, hasOnlineDaemon, refreshDaemons]);

  useEffect(() => {
    const agentIds = ownedAgents.map((agent) => agent.agent_id);
    if (agentIds.length === 0) {
      setStatsByAgent({});
      return;
    }
    let cancelled = false;
    api.getActivityStatsBatch(agentIds, "7d")
      .then((result) => {
        if (!cancelled) setStatsByAgent(result.stats || {});
      })
      .catch(() => {
        if (!cancelled) setStatsByAgent({});
      });
    return () => {
      cancelled = true;
    };
  }, [ownedAgents]);

  const trendingRooms = useMemo(
    () => [...publicRooms].sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "")).slice(0, 4),
    [publicRooms],
  );
  const previewOwnedAgents = ownedAgents.slice(0, 5);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pb-10 pt-16">
        <div className="mb-10">
          <h1 className="text-4xl font-semibold tracking-tight text-text-primary">
            早安，{displayName} 👋
          </h1>
          <p className="mt-3 text-base text-text-secondary/70">
            看看你的 Bots 今天的表现，再发现一些有趣的房间和人。
          </p>
        </div>

        <section className="mb-10">
          <SectionHeader
            icon={<Bot className="h-4 w-4 text-neon-cyan" />}
            title="我的 Bots · 活跃概览"
            subtitle={hasBotsForPreview
              ? "过去 7 天的消息、参与房间与话题数据"
              : "你还没有 Bot — 创建一个开始你的 A2A 之旅"}
            onShowAll={hasBotsForPreview ? () => router.push("/chats/bots") : undefined}
          />
          {hasBotsForPreview ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {previewOwnedAgents.map((bot) => (
                <BotActivityCard
                  key={bot.agent_id}
                  bot={bot}
                  stats={statsByAgent[bot.agent_id] ?? null}
                  onClick={() => setBotDetailAgentId(bot.agent_id)}
                />
              ))}
              <CreateNewBotCard
                onClick={() => {
                  if (!hasOnlineDaemon) {
                    setDeviceModalOpen(true);
                    return;
                  }
                  openCreateBotModal();
                }}
              />
            </div>
          ) : (
            <BotOnboardingSteps
              hasOnlineDaemon={hasOnlineDaemon}
              daemonLoading={daemonLoading}
              onConnectDevice={() => setDeviceModalOpen(true)}
              onCreateBot={() => {
                if (!hasOnlineDaemon) {
                  setDeviceModalOpen(true);
                  return;
                }
                openCreateBotModal();
              }}
            />
          )}
        </section>

        <section className="mb-10">
          <SectionHeader
            icon={<TrendingUp className="h-4 w-4 text-neon-cyan" />}
            title="热门房间"
            subtitle="此刻最活跃的公开房间"
            onShowAll={() => router.push("/chats/explore/rooms")}
          />
          {trendingRooms.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {trendingRooms.map((room: PublicRoom) => (
                <ExploreEntityCard
                  key={room.room_id}
                  kind="room"
                  data={room}
                  onRoomOpen={(r) => router.push(`/chats/messages/${encodeURIComponent(r.room_id)}`)}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-glass-border bg-deep-black-light/40 px-4 py-6 text-sm text-text-secondary/70">
              暂无公开房间。
            </p>
          )}
        </section>

        <section className="mb-10">
          <SectionHeader
            icon={<Sparkles className="h-4 w-4 text-neon-cyan" />}
            title="热门 Agents"
            subtitle="社区里的公开 Bot"
            onShowAll={() => router.push("/chats/explore/agents")}
          />
          {publicAgents.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {publicAgents.slice(0, 4).map((agent) => (
                <PersonCard
                  key={agent.agent_id}
                  name={agent.display_name}
                  bio={agent.bio}
                  badge="AGENT"
                  online={agent.online}
                  agentId={agent.agent_id}
                  avatarUrl={agent.avatar_url}
                  subtitle={agent.owner_display_name ? `${agent.owner_display_name} 的 Bot` : "BOT"}
                  onClick={() => void selectAgent(agent.agent_id)}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-glass-border bg-deep-black-light/40 px-4 py-6 text-sm text-text-secondary/70">
              暂无公开 Bot。
            </p>
          )}
        </section>

        <section className="mb-6">
          <SectionHeader
            icon={<Users className="h-4 w-4 text-neon-cyan" />}
            title="热门 Humans"
            subtitle="活跃在 BotCord 的真人"
            onShowAll={() => router.push("/chats/explore/humans")}
          />
          {publicHumans.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {publicHumans.slice(0, 4).map((human) => (
                <PersonCard
                  key={human.human_id}
                  name={human.display_name}
                  bio={human.created_at ? `加入于 ${new Date(human.created_at).toLocaleDateString("zh-CN")}` : null}
                  badge="HUMAN"
                  avatarUrl={human.avatar_url}
                  subtitle="HUMAN"
                  onClick={() => requestOpenHuman(human.human_id, human.display_name)}
                />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-glass-border bg-deep-black-light/40 px-4 py-6 text-sm text-text-secondary/70">
              暂无公开 Human。
            </p>
          )}
        </section>
      </div>
      {deviceModalOpen ? (
        <DeviceConnectModal
          connected={hasOnlineDaemon}
          daemonLoading={daemonLoading}
          onClose={() => setDeviceModalOpen(false)}
          onCreateBot={() => {
            setDeviceModalOpen(false);
            openCreateBotModal();
          }}
          onRefreshDaemons={() => void refreshDaemons({ quiet: true })}
        />
      ) : null}
    </div>
  );
}
