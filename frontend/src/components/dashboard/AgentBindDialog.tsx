"use client";

/**
 * [INPUT]: 依赖 react 的 useEffect/useMemo/useState，依赖 @/lib/api 的 userApi 进行票据签发与 agent 绑定
 * [OUTPUT]: 对外提供 AgentBindDialog 组件，支持 AI 自主判断绑定/创建的 Prompt 驱动流程
 * [POS]: dashboard 账户菜单的统一身份链接执行器，提供“复制 Prompt + 粘贴 AI 回执”入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useState } from "react";
import { userApi } from "@/lib/api";

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
  const [copied, setCopied] = useState(false);
  const [resultText, setResultText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bindTicket, setBindTicket] = useState("");
  const [nonce, setNonce] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [loadingTicket, setLoadingTicket] = useState(true);

  useEffect(() => {
    let mounted = true;
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
    };
  }, []);

  const promptText = useMemo(() => {
    if (!nonce) return "";

    return [
      "You are my BotCord setup assistant.",
      "Task:",
      "1) Decide automatically: if I already have a usable BotCord agent, use it; otherwise create one.",
      "2) Prepare proof for linking this agent to my web account.",
      "",
      "Return JSON only (no markdown, no explanation):",
      '{"agent_id":"ag_xxx","display_name":"My Agent","bind_proof":{"key_id":"k_xxx","nonce":"<nonce_from_prompt>","sig":"<base64>"}}',
      "",
      "Rules:",
      "1) agent_id must start with ag_",
      "2) Use this exact nonce (base64) when signing proof:",
      nonce,
      "3) Prefer bind_proof using key_id + nonce + sig",
      "4) If bind_proof is unavailable, provide agent_token as fallback",
      "5) If display_name is unknown, still provide a reasonable name",
    ].join("\n");
  }, [nonce]);

  async function handleCopyPrompt() {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
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
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              Link Agent with AI
            </h3>
            <p className="mt-1 text-xs text-text-secondary">
              One flow for both bind/create. AI decides automatically and returns proof.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded border border-glass-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
          >
            Close
          </button>
        </div>

        <div className="rounded-xl border border-glass-border bg-deep-black p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Prompt</p>
            <button
              onClick={handleCopyPrompt}
              disabled={!promptText}
              className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-2 py-1 text-[11px] font-medium text-neon-cyan hover:bg-neon-cyan/20"
            >
              {copied ? "Copied" : "Copy Prompt"}
            </button>
          </div>
          {loadingTicket ? (
            <div className="w-full rounded border border-glass-border bg-deep-black-light p-2">
              <div className="space-y-1.5 animate-pulse">
                <div className="h-3 w-[82%] rounded bg-glass-border/70" />
                <div className="h-3 w-[95%] rounded bg-glass-border/60" />
                <div className="h-3 w-[76%] rounded bg-glass-border/70" />
                <div className="h-3 w-[90%] rounded bg-glass-border/60" />
                <div className="h-3 w-[68%] rounded bg-glass-border/70" />
                <div className="h-3 w-[88%] rounded bg-glass-border/60" />
                <div className="h-3 w-[72%] rounded bg-glass-border/70" />
                <div className="h-3 w-[85%] rounded bg-glass-border/60" />
              </div>
            </div>
          ) : (
            <textarea
              readOnly
              value={promptText}
              rows={10}
              className="w-full resize-none rounded border border-glass-border bg-deep-black-light p-2 font-mono text-[11px] text-text-primary outline-none"
            />
          )}
          {expiresAt && (
            <p className="mt-2 text-[10px] text-text-secondary">
              Ticket expires at: {new Date(expiresAt * 1000).toLocaleString()}
            </p>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-glass-border bg-deep-black p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Paste AI Result
          </p>
          <textarea
            value={resultText}
            onChange={(e) => setResultText(e.target.value)}
            rows={8}
            placeholder='{"agent_id":"ag_xxx","display_name":"My Agent","bind_proof":{"key_id":"k_xxx","nonce":"...","sig":"..."}}'
            className="w-full rounded border border-glass-border bg-deep-black-light p-2 font-mono text-[11px] text-text-primary outline-none focus:border-neon-cyan/50"
          />
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-glass-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={handleBind}
            disabled={loadingTicket || submitting || !resultText.trim()}
            className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-semibold text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-40"
          >
            {loadingTicket ? "Preparing..." : submitting ? "Linking..." : "Link Agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
