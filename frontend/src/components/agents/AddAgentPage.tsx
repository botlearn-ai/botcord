"use client";

/**
 * [INPUT]: 依赖 userApi 的 issueBindTicket / getBindTicketStatus / revokeBindTicket，依赖 next 路由跳转新 agent
 * [OUTPUT]: 对外提供 AddAgentPage，承接 dashboard "Add Agent to OpenClaw" 入口
 * [POS]: /agents/add 落地页，展示一次性 install 命令并轮询 install-claim 完成态
 * [PROTOCOL]: 变更时更新此头部
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, RefreshCw, Trash2 } from "lucide-react";
import { setActiveAgentId, userApi, ApiError } from "@/lib/api";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import type {
  BindTicketResponse,
  BindTicketStatusResponse,
  BindTicketStatusValue,
} from "@/lib/types";

const POLL_INTERVAL_MS = 3000;

function formatRemaining(secondsLeft: number): string {
  if (secondsLeft <= 0) return "expired";
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function AddAgentPage() {
  const router = useRouter();
  const setSessionActiveAgentId = useDashboardSessionStore(
    (state) => state.setActiveAgentId,
  );

  const [intendedName, setIntendedName] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<BindTicketResponse | null>(null);
  const [status, setStatus] = useState<BindTicketStatusValue | "issued">("issued");
  const [claimedAgentId, setClaimedAgentId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const pollTimerRef = useRef<number | null>(null);
  const tickTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearTickTimer = useCallback(() => {
    if (tickTimerRef.current !== null) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearPollTimer();
      clearTickTimer();
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, [clearPollTimer, clearTickTimer]);

  const issue = useCallback(async () => {
    setError(null);
    setIssuing(true);
    setStatus("issued");
    setClaimedAgentId(null);
    try {
      const data = await userApi.issueBindTicket({
        intendedName: intendedName.trim() || null,
      });
      setTicket(data);
      setNow(Math.floor(Date.now() / 1000));
      setStatus("pending");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to generate install command";
      setError(msg);
    } finally {
      setIssuing(false);
    }
  }, [intendedName]);

  const revoke = useCallback(async () => {
    if (!ticket) return;
    setRevoking(true);
    setError(null);
    try {
      await userApi.revokeBindTicket(ticket.bind_code);
      clearPollTimer();
      clearTickTimer();
      setTicket(null);
      setStatus("issued");
    } catch (err) {
      // 404 from a stale code is fine — surface but allow retry.
      const msg = err instanceof Error ? err.message : "Failed to revoke";
      setError(msg);
    } finally {
      setRevoking(false);
    }
  }, [ticket, clearPollTimer, clearTickTimer]);

  // Tick the countdown once per second.
  useEffect(() => {
    if (!ticket) {
      clearTickTimer();
      return;
    }
    setNow(Math.floor(Date.now() / 1000));
    tickTimerRef.current = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return clearTickTimer;
  }, [ticket, clearTickTimer]);

  // Poll status every 3s.
  useEffect(() => {
    if (!ticket || status !== "pending") {
      clearPollTimer();
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res: BindTicketStatusResponse = await userApi.getBindTicketStatus(ticket.bind_code);
        if (cancelled) return;
        if (res.status === "claimed" && res.agent_id) {
          setStatus("claimed");
          setClaimedAgentId(res.agent_id);
          clearPollTimer();
          clearTickTimer();
        } else if (res.status === "expired") {
          setStatus("expired");
          clearPollTimer();
          clearTickTimer();
        }
      } catch (err) {
        if (cancelled) return;
        // Stop polling if the code was revoked / 404'd; otherwise keep trying.
        if (err instanceof ApiError && err.status === 404) {
          setStatus("expired");
          clearPollTimer();
        }
      }
    };
    pollTimerRef.current = window.setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearPollTimer();
    };
  }, [ticket, status, clearPollTimer, clearTickTimer]);

  // Auto-jump to the new agent once it is claimed.
  useEffect(() => {
    if (status !== "claimed" || !claimedAgentId) return;
    setActiveAgentId(claimedAgentId);
    setSessionActiveAgentId(claimedAgentId);
    const timeout = window.setTimeout(() => {
      router.replace("/chats/messages/__user-chat__");
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, [status, claimedAgentId, router, setSessionActiveAgentId]);

  const copy = useCallback(async () => {
    if (!ticket?.install_command) return;
    try {
      await navigator.clipboard.writeText(ticket.install_command);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore — fall back to manual select.
    }
  }, [ticket]);

  const remaining = ticket ? Math.max(0, ticket.expires_at - now) : 0;
  const showPending = ticket && status === "pending";
  const showExpired = ticket && status === "expired";
  const showClaimed = status === "claimed";

  return (
    <div className="flex min-h-screen items-start justify-center bg-deep-black px-4 py-10">
      <div className="w-full max-w-2xl rounded-3xl border border-glass-border bg-deep-black-light p-6 shadow-2xl sm:p-8">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              Add Agent to OpenClaw
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Generate a one-time install command, paste it on the machine where OpenClaw runs.
              The plugin is downloaded, an Ed25519 keypair is generated locally, and the agent
              registers itself — your private key never leaves the device.
            </p>
          </div>
        </header>

        {!ticket && !showClaimed && (
          <section className="mt-6 space-y-4">
            <label className="block">
              <span className="block text-sm font-medium text-text-primary">
                Display name (optional)
              </span>
              <input
                type="text"
                value={intendedName}
                onChange={(e) => setIntendedName(e.target.value)}
                placeholder="e.g. laptop-bot"
                maxLength={128}
                className="mt-2 w-full rounded-lg border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 focus:border-neon-cyan/60 focus:outline-none"
              />
              <span className="mt-1 block text-xs text-text-secondary/80">
                Used as the agent name if you don&apos;t pass <code>--name</code> to the installer.
              </span>
            </label>
            <button
              onClick={issue}
              disabled={issuing}
              className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2.5 text-sm font-semibold text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-60"
            >
              {issuing ? "Generating…" : "Generate install command"}
            </button>
          </section>
        )}

        {ticket && (
          <section className="mt-6 space-y-4">
            <div className="rounded-2xl border border-glass-border bg-deep-black p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-text-secondary">
                  Install command
                </span>
                <button
                  onClick={copy}
                  className="inline-flex items-center gap-1.5 rounded-md border border-glass-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-glass-border/30"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-black/60 px-3 py-2 font-mono text-xs leading-relaxed text-neon-cyan">
                {ticket.install_command || "(install command unavailable — please regenerate)"}
              </pre>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                <span>
                  Bind code: <span className="font-mono text-text-primary">{ticket.bind_code}</span>
                </span>
                <span>•</span>
                <span>
                  Expires in{" "}
                  <span className={remaining <= 60 ? "font-semibold text-amber-300" : "text-text-primary"}>
                    {formatRemaining(remaining)}
                  </span>
                </span>
              </div>
            </div>

            {showPending && (
              <div className="rounded-2xl border border-neon-cyan/30 bg-neon-cyan/5 p-4 text-sm text-neon-cyan">
                Waiting for the install client to redeem this code…
                <span className="ml-1 text-text-secondary">
                  (we poll every {Math.round(POLL_INTERVAL_MS / 1000)}s)
                </span>
              </div>
            )}

            {showExpired && (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
                This bind code has expired or was revoked. Generate a new one below.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => {
                  setTicket(null);
                  setStatus("issued");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-2 text-sm font-medium text-text-primary hover:bg-glass-border/30"
                disabled={issuing || revoking}
              >
                <RefreshCw className="h-4 w-4" />
                Generate another
              </button>
              {!showExpired && (
                <button
                  onClick={revoke}
                  disabled={revoking}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm font-medium text-red-200 hover:bg-red-500/15 disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" />
                  {revoking ? "Revoking…" : "Revoke this code"}
                </button>
              )}
            </div>
          </section>
        )}

        {showClaimed && claimedAgentId && (
          <div className="mt-6 rounded-2xl border border-green-500/40 bg-green-500/10 p-4 text-sm text-green-200">
            <p className="font-medium">Agent claimed</p>
            <p className="mt-1 text-green-300/90">
              {claimedAgentId} is now bound to your account. Redirecting…
            </p>
          </div>
        )}

        {error && (
          <div className="mt-6 rounded-2xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
