"use client";

/**
 * [INPUT]: 依赖 react 的 useEffect/useMemo/useState，依赖 @/lib/api 的 userApi 进行短码签发与 agent 轮询
 * [OUTPUT]: 对外提供 AgentBindDialog 组件，支持 auto/create/link 三种 Prompt 驱动流程
 * [POS]: dashboard 账户菜单与 agent 门禁的统一身份执行器，负责发放 bind_code、复制 Prompt，并等待 Agent 自动绑定完成
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { bindDialog } from "@/lib/i18n/translations/dashboard";
import { X, Copy, Check, Loader2 } from "lucide-react";
import { buildConnectBotPrompt, getBotcordInstallGuideUrl } from "@/lib/onboarding";

type AgentBindMode = "auto" | "create" | "link";

interface AgentBindDialogProps {
  onClose: () => void;
  onSuccess: (agentId: string) => Promise<void> | void;
  mode?: AgentBindMode;
}

export default function AgentBindDialog({
  onClose,
  onSuccess,
  mode = "auto",
}: AgentBindDialogProps) {
  const locale = useLanguage();
  const t = bindDialog[locale];

  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bindCode, setBindCode] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [loadingTicket, setLoadingTicket] = useState(true);
  const [isWaitingForAgent, setIsWaitingForAgent] = useState(false);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const initialAgentsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let mounted = true;

    // First, get current agents to know if a new one is added
    userApi.getMyAgents().then(resp => {
      if (!mounted) return;
      initialAgentsRef.current = new Set(resp.agents.map(a => a.agent_id));
    });

    userApi
      .issueBindTicket()
      .then((resp) => {
        if (!mounted) return;
        setBindCode(resp.bind_code);
        setExpiresAt(resp.expires_at);
        setLoadingTicket(false);
      })
      .catch((err: any) => {
        if (!mounted) return;
        setError(err?.message || t.issueBindTicketFailed);
        setLoadingTicket(false);
      });

    return () => {
      mounted = false;
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Polling for new agents (linked by agent itself using bind_code or bind_ticket)
  useEffect(() => {
    if (!bindCode || !isWaitingForAgent) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    pollIntervalRef.current = setInterval(async () => {
      try {
        const resp = await userApi.getMyAgents();
        const newAgent = resp.agents.find(a => !initialAgentsRef.current.has(a.agent_id));
        
        if (newAgent) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          onSuccess(newAgent.agent_id);
          onClose();
        }
      } catch (e) {
        // Ignore polling errors
      }
    }, 3000);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [bindCode, isWaitingForAgent, onSuccess, onClose]);

  const promptText = useMemo(() => {
    if (!bindCode) return "";

    return buildConnectBotPrompt({
      connectionCode: bindCode,
      mode,
      installGuideUrl: getBotcordInstallGuideUrl(),
      locale,
    });
  }, [bindCode, locale, mode]);

  const dialogTitle = mode === "create"
    ? t.createAgentWithAi
    : mode === "link"
      ? t.linkExistingAgentWithAi
      : t.linkAgentWithAi;

  const dialogDescription = mode === "create"
    ? t.createDesc
    : mode === "link"
      ? t.linkDesc
      : t.bindDesc;
  const confirmLabel = mode === "create"
    ? t.confirmCreated
    : mode === "link"
      ? t.confirmLinked
      : t.confirmCompleted;

  async function handleCopyPrompt() {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError(t.copyPromptFailed);
    }
  }

  function handleConfirmCompleted() {
    setError(null);
    setIsWaitingForAgent(true);
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-xl rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-6 pr-8">
          <h3 className="text-xl font-bold text-text-primary">
            {dialogTitle}
          </h3>
          <p className="mt-1 text-sm text-text-secondary">
            {dialogDescription}
          </p>
        </div>

        <div className="rounded-xl border border-glass-border bg-deep-black p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-widest text-text-secondary opacity-60">
              {t.prompt}
            </p>
            <button
              onClick={handleCopyPrompt}
              disabled={!promptText}
              className="flex items-center gap-2 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-semibold text-neon-cyan transition-all hover:bg-neon-cyan/20"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {t.copied}
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  {t.copyPrompt}
                </>
              )}
            </button>
          </div>
          {loadingTicket ? (
            <div className="w-full rounded-lg border border-glass-border bg-deep-black-light p-4">
              <div className="space-y-2 animate-pulse">
                <div className="h-3 w-[82%] rounded bg-glass-border/70" />
                <div className="h-3 w-[95%] rounded bg-glass-border/60" />
                <div className="h-3 w-[76%] rounded bg-glass-border/70" />
                <div className="h-3 w-[68%] rounded bg-glass-border/60" />
              </div>
            </div>
          ) : (
            <div className="relative">
              <textarea
                readOnly
                value={promptText}
                rows={9}
                className="w-full resize-none rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-[11px] leading-relaxed text-text-primary outline-none"
              />
              {isWaitingForAgent && (
                <div className="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-deep-black/60 backdrop-blur-[2px]">
                  <Loader2 className="h-8 w-8 animate-spin text-neon-cyan" />
                  <p className="mt-3 text-xs font-medium text-neon-cyan">
                    {t.waitingForAgent}
                  </p>
                </div>
              )}
            </div>
          )}
        {expiresAt && (
          <p className="mt-2 text-[10px] text-text-secondary/50">
            {t.ticketExpiresAt}{new Date(expiresAt * 1000).toLocaleString()}
          </p>
        )}
        </div>

        {error && <p className="mt-4 text-xs text-red-400 bg-red-400/10 border border-red-400/20 p-2 rounded-lg">{error}</p>}

        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
          >
            {t.back}
          </button>
          <button
            onClick={handleConfirmCompleted}
            disabled={loadingTicket || !promptText || isWaitingForAgent}
            className="min-h-11 rounded-xl border border-neon-cyan/60 bg-neon-cyan px-5 py-3 text-sm font-bold text-black transition-all hover:bg-neon-cyan/90 disabled:cursor-not-allowed disabled:border-neon-cyan/20 disabled:bg-neon-cyan/40 disabled:text-black/60"
          >
            {isWaitingForAgent ? t.waitingForAgent : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
