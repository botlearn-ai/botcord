"use client";

/**
 * [INPUT]: 依赖 react 的 useEffect/useMemo/useState，依赖 @/lib/api 的 userApi 进行票据签发与 agent 绑定
 * [OUTPUT]: 对外提供 AgentBindDialog 组件，支持 AI 自主判断绑定/创建的 Prompt 驱动流程
 * [POS]: dashboard 账户菜单的统一身份链接执行器，提供“复制 Prompt + 粘贴 AI 回执”入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useState, useRef } from "react";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { bindDialog } from "@/lib/i18n/translations/dashboard";
import { common } from "@/lib/i18n/translations/common";
import { X, Copy, Check, Loader2 } from "lucide-react";

interface AgentBindDialogProps {
  onClose: () => void;
  onSuccess: (agentId: string) => Promise<void> | void;
}

interface ParsedBindPayload {
  agentId: string;
  displayName: string;
  agentToken?: string;
  bindProof?: {
    key_id: string;
    nonce: string;
    sig: string;
  };
}

function normalizeDisplayName(name: string | undefined, agentId: string): string {
  const trimmed = (name || "").trim();
  if (trimmed) return trimmed;
  return `Agent ${agentId.slice(-6)}`;
}

function parseJsonBlock(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue fallback parsing.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!fenced) return null;

  try {
    return JSON.parse(fenced[1].trim());
  } catch {
    return null;
  }
}

function extractValueFromObject(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function parseBindPayload(raw: string): ParsedBindPayload | null {
  const parsed = parseJsonBlock(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const agentId = extractValueFromObject(obj, ["agent_id", "agentId", "id"]);
    const agentToken = extractValueFromObject(obj, ["agent_token", "agentToken", "token", "jwt"]);
    const bindProofObj =
      obj.bind_proof && typeof obj.bind_proof === "object" && !Array.isArray(obj.bind_proof)
        ? (obj.bind_proof as Record<string, unknown>)
        : null;
    const keyId = bindProofObj ? extractValueFromObject(bindProofObj, ["key_id", "keyId"]) : "";
    const nonce = bindProofObj ? extractValueFromObject(bindProofObj, ["nonce"]) : "";
    const sig = bindProofObj ? extractValueFromObject(bindProofObj, ["sig", "signature"]) : "";
    const displayName = normalizeDisplayName(
      extractValueFromObject(obj, ["display_name", "displayName", "name"]),
      agentId,
    );

    if (agentId && (agentToken || (keyId && nonce && sig))) {
      return {
        agentId,
        agentToken: agentToken || undefined,
        bindProof: keyId && nonce && sig ? { key_id: keyId, nonce, sig } : undefined,
        displayName,
      };
    }
  }

  const idMatch = raw.match(/agent[_\s-]?id\s*[:=]\s*(ag_[a-zA-Z0-9_]+)/i);
  const tokenMatch = raw.match(/agent[_\s-]?token\s*[:=]\s*([A-Za-z0-9\-_\.]+)/i);
  const keyIdMatch = raw.match(/key[_\s-]?id\s*[:=]\s*([A-Za-z0-9_\-]+)/i);
  const nonceMatch = raw.match(/nonce\s*[:=]\s*([A-Za-z0-9+/=]+)/i);
  const sigMatch = raw.match(/sig(?:nature)?\s*[:=]\s*([A-Za-z0-9+/=]+)/i);
  const nameMatch = raw.match(/display[_\s-]?name\s*[:=]\s*([^\n\r]+)/i);

  const agentId = idMatch?.[1]?.trim() || "";
  const agentToken = tokenMatch?.[1]?.trim() || "";
  const keyId = keyIdMatch?.[1]?.trim() || "";
  const nonce = nonceMatch?.[1]?.trim() || "";
  const sig = sigMatch?.[1]?.trim() || "";

  if (!agentId || (!agentToken && !(keyId && nonce && sig))) return null;

  return {
    agentId,
    agentToken: agentToken || undefined,
    bindProof: keyId && nonce && sig ? { key_id: keyId, nonce, sig } : undefined,
    displayName: normalizeDisplayName(nameMatch?.[1], agentId),
  };
}

export default function AgentBindDialog({ onClose, onSuccess }: AgentBindDialogProps) {
  const locale = useLanguage();
  const t = bindDialog[locale];
  const tc = common[locale];

  const [copied, setCopied] = useState(false);
  const [resultText, setResultText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bindTicket, setBindTicket] = useState("");
  const [nonce, setNonce] = useState("");
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
        setBindTicket(resp.bind_ticket);
        setNonce(resp.nonce);
        setExpiresAt(resp.expires_at);
        setLoadingTicket(false);
      })
      .catch((err: any) => {
        if (!mounted) return;
        setError(err?.message || "Failed to issue bind ticket");
        setLoadingTicket(false);
      });

    return () => {
      mounted = false;
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Polling for new agents (linked by agent itself using bind_ticket)
  useEffect(() => {
    if (!bindTicket || !isWaitingForAgent) {
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
  }, [bindTicket, isWaitingForAgent, onSuccess, onClose]);

  const promptText = useMemo(() => {
    if (!nonce || !bindTicket) return "";

    return [
      "You are my BotCord setup assistant.",
      "Task:",
      "1) Decide automatically: if I already have a usable BotCord agent, use it; otherwise create one.",
      "2) Prepare proof for linking this agent to my web account.",
      "",
      "Return JSON only (no markdown, no explanation):",
      '{"agent_id":"ag_xxx","display_name":"My Agent","bind_proof":{"key_id":"k_xxx","nonce":"' + nonce + '","sig":"<base64>"}}',
      "",
      "Rules:",
      "1) agent_id must start with ag_",
      "2) Use this exact nonce (base64) when signing proof:",
      nonce,
      "3) Prefer bind_proof using key_id + nonce + sig",
      "4) If bind_proof is unavailable, provide agent_token as fallback",
      "5) If display_name is unknown, still provide a reasonable name",
    ].join("\n");
  }, [nonce, bindTicket]);

  async function handleCopyPrompt() {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setIsWaitingForAgent(true); // Start polling after copy
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError("Failed to copy prompt. Please copy manually.");
    }
  }

  async function handleBind() {
    setError(null);
    if (!bindTicket) {
      setError("bind_ticket is missing. Please reopen this dialog.");
      return;
    }
    const payload = parseBindPayload(resultText);
    if (!payload) {
      setError("Cannot parse AI result. Please include agent_id + bind_proof (or agent_token).");
      return;
    }

    setSubmitting(true);
    try {
      const bound = await userApi.claimAgent(payload.agentId, payload.displayName, {
        bindProof: payload.bindProof,
        bindTicket,
        agentToken: payload.agentToken,
      });
      await onSuccess(bound.agent_id);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Bind failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-xl rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-6 pr-8">
          <h3 className="text-xl font-bold text-text-primary">
            {t.linkAgentWithAi}
          </h3>
          <p className="mt-1 text-sm text-text-secondary">
            {t.bindDesc}
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
                rows={8}
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

        <div className="mt-6">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-text-secondary opacity-60 hover:opacity-100 transition-opacity">
              <span className="group-open:rotate-90 transition-transform">▶</span>
              {t.orPasteManual}
            </summary>
            <div className="mt-3 rounded-xl border border-glass-border bg-deep-black p-4">
              <textarea
                value={resultText}
                onChange={(e) => setResultText(e.target.value)}
                rows={5}
                placeholder='{"agent_id":"ag_xxx","display_name":"My Agent",...}'
                className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-[11px] text-text-primary outline-none focus:border-neon-cyan/50"
              />
              <div className="mt-4 flex justify-end">
                <button
                  onClick={handleBind}
                  disabled={loadingTicket || submitting || !resultText.trim()}
                  className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-6 py-2 text-xs font-bold text-neon-cyan transition-all hover:bg-neon-cyan/20 disabled:opacity-40"
                >
                  {submitting ? t.linking : t.linkAgent}
                </button>
              </div>
            </div>
          </details>
        </div>

        {error && <p className="mt-4 text-xs text-red-400 bg-red-400/10 border border-red-400/20 p-2 rounded-lg">{error}</p>}

        <div className="mt-6 flex items-center justify-end">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            {tc.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
