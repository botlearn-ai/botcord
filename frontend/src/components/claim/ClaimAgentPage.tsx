"use client";

/**
 * [INPUT]: 依赖 next/navigation 提供跳转，依赖 userApi 用 claim_code 直接完成认领
 * [OUTPUT]: 对外提供 ClaimAgentPage 组件，支持用户登录后一键认领
 * [POS]: /agents/claim/[agentKey] 落地页执行器，不再要求 agent_token
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  const searchParams = useSearchParams();
  const continuePath = searchParams.get("next") || "/chats/messages/__user-chat__";

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
        const next = `/agents/claim/${encodeURIComponent(claimCode)}?next=${encodeURIComponent(continuePath)}`;
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


  return (
    <div className="flex min-h-screen items-center justify-center bg-deep-black px-4 py-8">
      <Card padding="lg" className="w-full max-w-2xl ">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Connect your Bot</h1>
            <p className="mt-1 text-sm text-text-secondary">Sign in and connect this Bot to your BotCord account in one step.</p>
          </div>
          <Badge tone={claimed ? "success" : loading ? "accent" : error ? "danger" : "neutral"}>{statusLabel}</Badge>
        </div>

        <Card padding="md" className="mt-6">
          <p className="text-sm text-text-secondary">
            This link is already ready. Continue to connect this Bot to your account.
          </p>

          {!claimed && (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Button variant="primary"
                onClick={handleClaim}
                disabled={loading} >
                {loading ? "Connecting..." : "Connect now"}
              </Button>
              {needLogin && (
                <Button variant="secondary"
                  onClick={() => {
                    const next = `/agents/claim/${encodeURIComponent(claimCode)}?next=${encodeURIComponent(continuePath)}`;
                    router.replace(`/login?next=${encodeURIComponent(next)}`);
                  }} >
                  Login / Register
                </Button>
              )}
            </div>
          )}
        </Card>

        {claimed && (
          <Alert tone="success" className="mt-4">
            <p className="font-medium">Bot connected</p>
            <div  className="mt-1">
              {claimed.display_name} ({claimed.agent_id})
            </div>
            <Button variant="secondary"
              onClick={() => {
                const separator = continuePath.includes("?") ? "&" : "?";
                window.location.replace(`${continuePath}${separator}agent_id=${encodeURIComponent(claimed.agent_id)}`);
              }}
              className="mt-4" >
              Continue
            </Button>
          </Alert>
        )}

        {error && (
          <Alert tone="danger" className="mt-4">
            {error}
          </Alert>
        )}
      </Card>
    </div>
  );
}
