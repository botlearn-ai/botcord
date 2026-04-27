"use client";

/**
 * [INPUT]: ticket {bindCode, installCommand, expiresAt}; status polling via useOpenclawHostStore
 * [OUTPUT]: InstallCommandPanel — copy-able install command, TTL countdown, claim status polling
 * [POS]: rendered inside CreateAgentDialog after the user picks "+ Add OpenClaw host"
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { useOpenclawHostStore, type OpenclawInstallTicket } from "@/store/useOpenclawHostStore";

interface Props {
  ticket: OpenclawInstallTicket;
  onClaimed: (agentId: string) => void | Promise<void>;
  onCancel: () => void;
}

const POLL_INTERVAL_MS = 3_000;

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function InstallCommandPanel({ ticket, onClaimed, onCancel }: Props) {
  const pollBindCode = useOpenclawHostStore((s) => s.pollBindCode);
  const revokeBindCode = useOpenclawHostStore((s) => s.revokeBindCode);

  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, ticket.expiresAt - Math.floor(Date.now() / 1000)),
  );
  const [statusMessage, setStatusMessage] = useState<string>("Waiting for host to register…");
  const claimedRef = useRef(false);

  // Countdown ticker.
  useEffect(() => {
    const id = window.setInterval(() => {
      setSecondsLeft((prev) => {
        const next = ticket.expiresAt - Math.floor(Date.now() / 1000);
        return Math.max(0, next);
      });
    }, 1_000);
    return () => window.clearInterval(id);
  }, [ticket.expiresAt]);

  // Claim polling.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (cancelled || claimedRef.current) return;
      try {
        const status = await pollBindCode(ticket.bindCode);
        if (cancelled) return;
        if (status.status === "claimed" && status.agentId) {
          claimedRef.current = true;
          setStatusMessage("Host registered — finalizing…");
          await onClaimed(status.agentId);
        } else if (status.status === "expired") {
          setStatusMessage("Bind code expired. Cancel and request a new one.");
        } else if (status.status === "revoked") {
          setStatusMessage("Bind code revoked.");
        }
      } catch {
        /* ignore — next tick will retry */
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ticket.bindCode, pollBindCode, onClaimed]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(ticket.installCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function handleCancel() {
    if (!claimedRef.current) {
      await revokeBindCode(ticket.bindCode);
    }
    onCancel();
  }

  const expired = secondsLeft <= 0;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-glass-border bg-glass-bg/40 p-3">
        <p className="mb-2 text-xs text-text-secondary">
          Run this on your OpenClaw host (one-line install + bind):
        </p>
        <div className="flex items-stretch gap-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-glass-border bg-deep-black px-3 py-2 font-mono text-xs text-text-primary">
            {ticket.installCommand}
          </code>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-2 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-neon-green" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </>
            )}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-xs">
        <span className="flex items-center gap-2 text-text-secondary">
          {!expired && <Loader2 className="h-3.5 w-3.5 animate-spin text-neon-cyan" />}
          {statusMessage}
        </span>
        <span className={`font-mono ${expired ? "text-red-400" : "text-text-primary"}`}>
          {formatRemaining(secondsLeft)}
        </span>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleCancel()}
          className="rounded-xl border border-glass-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
