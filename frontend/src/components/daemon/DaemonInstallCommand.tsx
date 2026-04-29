"use client";

/**
 * [INPUT]: install-ticket BFF (`/api/daemon/auth/install-ticket`); env URLs
 * [OUTPUT]: DaemonInstallCommand — copy-paste curl|sh panel that installs/starts
 *   the BotCord daemon and (when an install token is granted) auto-authorizes it
 * [POS]: shared between CreateAgentDialog (no-daemon state) and DaemonsSettingsPage
 *   (install/reconnect banner)
 * [PROTOCOL]: update header on changes
 */

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Loader2,
  RefreshCcw,
  Server,
} from "lucide-react";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "https://api.botcord.chat");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildDaemonStartCommand(installToken?: string): string {
  const args = [`--hub ${shellQuote(HUB_BASE_URL)}`];
  if (installToken) args.push(`--install-token ${shellQuote(installToken)}`);
  return `curl -fsSL ${HUB_BASE_URL.replace(/\/$/, "")}/daemon/install.sh | sh -s -- ${args.join(" ")}`;
}

export interface DaemonInstallCommandLabels {
  title: string;
  hint: string;
  copy: string;
  copied: string;
  refresh: string;
  installTokenError?: string;
}

interface DaemonInstallCommandProps {
  labels: DaemonInstallCommandLabels;
  /** Optional outer-state spinner — combined with internal token-loading state. */
  busy?: boolean;
  /** Optional callback fired in addition to refreshing the install token. */
  onRefresh?: () => void;
}

export default function DaemonInstallCommand({
  labels,
  busy,
  onRefresh,
}: DaemonInstallCommandProps) {
  const [command, setCommand] = useState(() => buildDaemonStartCommand());
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void refreshInstallCommand();
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
    // Run once on mount — manual refresh handles retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshInstallCommand(): Promise<void> {
    setTokenLoading(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/daemon/auth/install-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = (await res.json()) as { install_token?: string };
      if (!data.install_token) throw new Error("install_token missing");
      setCommand(buildDaemonStartCommand(data.install_token));
    } catch (err) {
      setCommand(buildDaemonStartCommand());
      setTokenError(
        err instanceof Error ? err.message : "Failed to generate install token",
      );
    } finally {
      setTokenLoading(false);
    }
  }

  async function handleCopy(): Promise<void> {
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
      // ignore — user can select-and-copy manually
    }
  }

  function handleRefresh() {
    void refreshInstallCommand();
    onRefresh?.();
  }

  const loading = !!busy || tokenLoading;
  const fallbackErrorMsg =
    labels.installTokenError ??
    "Install token unavailable; command will fall back to interactive auth.";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-dashed border-glass-border bg-glass-bg/40 p-4">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-text-primary">
          <Server className="h-4 w-4 text-text-secondary" />
          {labels.title}
        </div>
        <p className="text-xs text-text-secondary">{labels.hint}</p>
      </div>

      <div>
        <div className="flex items-stretch gap-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-xl border border-glass-border bg-deep-black px-3 py-2 font-mono text-xs text-text-primary">
            {command}
          </code>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-glass-border px-3 py-2 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-neon-green" />
                {labels.copied}
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                {labels.copy}
              </>
            )}
          </button>
        </div>
        {tokenError && (
          <p className="mt-2 text-xs text-red-400">{fallbackErrorMsg}</p>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          {labels.refresh}
        </button>
      </div>
    </div>
  );
}
