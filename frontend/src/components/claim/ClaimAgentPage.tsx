"use client";

/**
 * [INPUT]: 依赖 next/navigation 提供跳转，依赖 userApi 用 claim_code 直接完成认领
 * [OUTPUT]: 对外提供 ClaimAgentPage 组件，支持用户登录后一键认领
 * [POS]: /agents/claim/[agentKey] 落地页执行器，不再要求 agent_token
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { userApi } from "@/lib/api";

interface ClaimAgentPageProps {
  claimCode: string;
}

interface ClaimedAgent {
  agent_id: string;
  display_name: string;
  is_default: boolean;
  claimed_at: string;
}

export default function ClaimAgentPage({ claimCode }: ClaimAgentPageProps) {
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [claimed, setClaimed] = useState<ClaimedAgent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);

  async function handleClaim() {
    if (!claimCode) {
      setError("Missing claim code in URL.");
      return;
    }

    setLoading(true);
    setError(null);
    setNeedLogin(false);

    try {
      const data = await userApi.resolveClaim(claimCode);
      setClaimed(data);
    } catch (err: any) {
      if (typeof err?.status === "number" && err.status === 401) {
        setNeedLogin(true);
        setError("Redirecting to login...");
        const next = `/agents/claim/${encodeURIComponent(claimCode)}`;
        router.replace(`/login?next=${encodeURIComponent(next)}`);
      } else {
        setError(err?.message || "Claim failed");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!claimCode) return;
    handleClaim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimCode]);

  const statusLabel = claimed ? "Claimed" : loading ? "Processing" : error ? "Action required" : "Ready";
  const statusClass = claimed
    ? "border-green-500/40 bg-green-500/15 text-green-300"
    : loading
      ? "border-neon-cyan/40 bg-neon-cyan/15 text-neon-cyan"
      : error
        ? "border-red-500/40 bg-red-500/15 text-red-300"
        : "border-glass-border bg-deep-black text-text-secondary";

  return (
    <div className="flex min-h-screen items-center justify-center bg-deep-black px-4 py-8">
      <div className="w-full max-w-2xl rounded-3xl border border-glass-border bg-deep-black-light p-6 shadow-2xl sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Claim Agent</h1>
            <p className="mt-1 text-sm text-text-secondary">Sign in and complete claim in one step.</p>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs font-medium ${statusClass}`}>
            {statusLabel}
          </span>
        </div>

        <div className="mt-6 rounded-2xl border border-glass-border bg-deep-black p-5">
          <p className="text-sm text-text-secondary">
            This link is already validated. Click below to bind the agent to your account.
          </p>

          {!claimed && (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                onClick={handleClaim}
                disabled={loading}
                className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2.5 text-sm font-semibold text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-60"
              >
                {loading ? "Claiming..." : "Claim Now"}
              </button>
              {needLogin && (
                <button
                  onClick={() => {
                    const next = `/agents/claim/${encodeURIComponent(claimCode)}`;
                    router.replace(`/login?next=${encodeURIComponent(next)}`);
                  }}
                  className="rounded-lg border border-glass-border px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-glass-border/20"
                >
                  Login / Register
                </button>
              )}
            </div>
          )}
        </div>

        {claimed && (
          <div className="mt-4 rounded-2xl border border-green-500/40 bg-green-500/10 p-4 text-sm text-green-200">
            <p className="font-medium">Claim successful</p>
            <p className="mt-1 text-green-300/90">
              {claimed.display_name} ({claimed.agent_id})
            </p>
            <button
              onClick={() => router.push("/chats")}
              className="mt-4 rounded-lg border border-green-500/50 bg-green-500/20 px-4 py-2 text-sm font-medium text-green-100 hover:bg-green-500/30"
            >
              Go to Chats
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
