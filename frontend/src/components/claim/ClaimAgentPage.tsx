"use client";

/**
 * [INPUT]: 依赖 next/navigation 提供 token 读取与跳转，依赖 userApi 完成链接解析与绑定提交
 * [OUTPUT]: 对外提供 ClaimAgentPage 组件，支持从激活认领链接完成 agent 绑定
 * [POS]: /agents/claim 落地页的执行器，复用 bind_proof + bind_ticket 链路
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { userApi } from "@/lib/api";

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

interface ResolvedClaimContext {
  agent_id: string;
  display_name: string;
  bind_ticket: string;
  nonce: string;
  expires_at: number;
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

export default function ClaimAgentPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";

  const [resolved, setResolved] = useState<ResolvedClaimContext | null>(null);
  const [loadingResolve, setLoadingResolve] = useState(false);
  const [resultText, setResultText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);

  const promptText = useMemo(() => {
    if (!resolved) return "";
    return [
      "You are my BotCord setup assistant.",
      "Task:",
      "1) Use my existing BotCord agent to produce linking proof.",
      "2) Do not create or switch to another agent.",
      "",
      "Target agent_id (must be exactly this):",
      resolved.agent_id,
      "",
      "Return JSON only (no markdown, no explanation):",
      '{"agent_id":"ag_xxx","display_name":"My Agent","bind_proof":{"key_id":"k_xxx","nonce":"<nonce_from_prompt>","sig":"<base64>"}}',
      "",
      "Rules:",
      "1) agent_id must equal target agent_id above",
      "2) Use this exact nonce (base64) when signing proof:",
      resolved.nonce,
      "3) Prefer bind_proof using key_id + nonce + sig",
      "4) If bind_proof is unavailable, provide agent_token as fallback",
    ].join("\n");
  }, [resolved]);

  async function handleResolve() {
    if (!token) {
      setError("Missing claim token in URL.");
      return;
    }
    setError(null);
    setNeedLogin(false);
    setLoadingResolve(true);
    try {
      const data = await userApi.resolveClaimLink(token);
      setResolved(data);
    } catch (err: any) {
      if (typeof err?.status === "number" && err.status === 401) {
        setNeedLogin(true);
        setError("Please login or register first to claim this agent.");
      } else {
        setError(err?.message || "Failed to resolve claim link");
      }
    } finally {
      setLoadingResolve(false);
    }
  }

  useEffect(() => {
    if (!token) return;
    handleResolve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function handleCopyPrompt() {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setError("Failed to copy prompt.");
    }
  }

  async function handleBind() {
    if (!resolved) {
      setError("Resolve claim link first.");
      return;
    }
    setError(null);
    setSuccess(null);

    const payload = parseBindPayload(resultText);
    if (!payload) {
      setError("Cannot parse AI result. Please include agent_id + bind_proof (or agent_token).");
      return;
    }
    if (payload.agentId !== resolved.agent_id) {
      setError(`agent_id mismatch. Expected ${resolved.agent_id}.`);
      return;
    }

    setSubmitting(true);
    try {
      await userApi.claimAgent(resolved.agent_id, payload.displayName || resolved.display_name, {
        bindProof: payload.bindProof,
        bindTicket: resolved.bind_ticket,
        agentToken: payload.agentToken,
      });
      setSuccess(`Agent ${resolved.agent_id} linked successfully.`);
    } catch (err: any) {
      setError(err?.message || "Link failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-deep-black px-4 py-8">
      <div className="w-full max-w-2xl rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <h1 className="text-lg font-semibold text-text-primary">Activate Agent Claim Link</h1>
        <p className="mt-1 text-xs text-text-secondary">
          Resolve this link, generate proof, then complete binding.
        </p>

        {!resolved && (
          <div className="mt-4 rounded-xl border border-glass-border bg-deep-black p-4">
            <p className="text-xs text-text-secondary break-all">
              token: {token || "(missing)"}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={handleResolve}
                disabled={loadingResolve}
                className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-sm font-medium text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-60"
              >
                {loadingResolve ? "Resolving..." : "Resolve Claim Link"}
              </button>
              {needLogin && (
                <button
                  onClick={() => {
                    const next = `/agents/claim?token=${encodeURIComponent(token)}`;
                    router.push(`/login?next=${encodeURIComponent(next)}`);
                  }}
                  className="rounded border border-glass-border px-3 py-1.5 text-sm text-text-primary hover:bg-glass-border/20"
                >
                  Login / Register
                </button>
              )}
            </div>
          </div>
        )}

        {resolved && (
          <>
            <div className="mt-4 rounded-xl border border-glass-border bg-deep-black p-3">
              <p className="text-xs text-text-secondary">agent_id: {resolved.agent_id}</p>
              <p className="text-xs text-text-secondary">display_name: {resolved.display_name}</p>
              <p className="text-xs text-text-secondary">
                expires_at: {new Date(resolved.expires_at * 1000).toLocaleString()}
              </p>
            </div>

            <div className="mt-4 rounded-xl border border-glass-border bg-deep-black p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Prompt</p>
                <button
                  onClick={handleCopyPrompt}
                  className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-2 py-1 text-[11px] font-medium text-neon-cyan hover:bg-neon-cyan/20"
                >
                  {copied ? "Copied" : "Copy Prompt"}
                </button>
              </div>
              <textarea
                readOnly
                value={promptText}
                rows={9}
                className="w-full resize-none rounded border border-glass-border bg-deep-black-light p-2 font-mono text-[11px] text-text-primary outline-none"
              />
            </div>

            <div className="mt-4 rounded-xl border border-glass-border bg-deep-black p-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                Paste AI Result
              </p>
              <textarea
                value={resultText}
                onChange={(e) => setResultText(e.target.value)}
                rows={7}
                placeholder='{"agent_id":"ag_xxx","display_name":"My Agent","bind_proof":{"key_id":"k_xxx","nonce":"...","sig":"..."}}'
                className="w-full rounded border border-glass-border bg-deep-black-light p-2 font-mono text-[11px] text-text-primary outline-none focus:border-neon-cyan/50"
              />
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={handleBind}
                disabled={submitting}
                className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-sm font-semibold text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-60"
              >
                {submitting ? "Linking..." : "Link Agent"}
              </button>
              <button
                onClick={() => router.push("/chats")}
                className="rounded border border-glass-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
              >
                Back to Chats
              </button>
            </div>
          </>
        )}

        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
        {success && <p className="mt-4 text-sm text-green-400">{success}</p>}
      </div>
    </div>
  );
}
