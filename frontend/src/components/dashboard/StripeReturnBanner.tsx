"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import type { StripeSessionStatusResponse } from "@/lib/types";
import { useShallow } from "zustand/react/shallow";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";

type BannerMode = "success_polling" | "cancelled";

export default function StripeReturnBanner() {
  const isAuthedReady = useDashboardSessionStore((state) => state.sessionMode === "authed-ready");
  const token = useDashboardSessionStore((state) => state.token);
  const { loadWallet, loadWalletLedger } = useDashboardWalletStore(useShallow((state) => ({
    loadWallet: state.loadWallet,
    loadWalletLedger: state.loadWalletLedger,
  })));
  const [status, setStatus] = useState<StripeSessionStatusResponse | null>(null);
  const [mode, setMode] = useState<BannerMode | null>(null);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    if (!isAuthedReady) return;

    const params = new URLSearchParams(window.location.search);
    const walletTopup = params.get("wallet_topup");
    const sessionId = params.get("session_id");

    if (!walletTopup) return;

    // Clean up URL
    const url = new URL(window.location.href);
    url.searchParams.delete("wallet_topup");
    url.searchParams.delete("session_id");
    window.history.replaceState({}, "", url.pathname + url.search);

    if (walletTopup === "cancelled") {
      setMode("cancelled");
      return;
    }

    if (walletTopup === "success" && sessionId) {
      setMode("success_polling");
      setPolling(true);

      const poll = async () => {
        for (let i = 0; i < 10; i++) {
          try {
            const res = await api.getStripeSessionStatus(sessionId);
            setStatus(res);
            if (res.wallet_credited) {
              setPolling(false);
              loadWallet();
              loadWalletLedger();
              return;
            }
          } catch {
            // Ignore errors during polling
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        setPolling(false);
      };
      poll();
    }
  }, [isAuthedReady, token, loadWallet, loadWalletLedger]);

  if (!mode) return null;

  const dismiss = () => setMode(null);

  // Cancelled
  if (mode === "cancelled") {
    return (
      <div className="fixed bottom-4 right-4 z-40 max-w-sm rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <span className="text-yellow-400 text-lg">!</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-yellow-400">Payment cancelled</p>
            <p className="mt-1 text-xs text-text-secondary">
              Your payment was not processed. You can try again anytime.
            </p>
          </div>
          <button onClick={dismiss} className="text-text-secondary hover:text-text-primary">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // Success polling / completed
  const credited = status?.wallet_credited ?? false;

  return (
    <div className={`fixed bottom-4 right-4 z-40 max-w-sm rounded-xl border p-4 backdrop-blur-xl ${
      credited
        ? "border-neon-green/30 bg-neon-green/10"
        : "border-neon-cyan/30 bg-neon-cyan/10"
    }`}>
      <div className="flex items-start gap-3">
        {credited ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5 text-neon-green flex-shrink-0">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : (
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-neon-cyan/30 border-t-neon-cyan flex-shrink-0" />
        )}
        <div className="flex-1">
          <p className={`text-sm font-medium ${credited ? "text-neon-green" : "text-neon-cyan"}`}>
            {credited ? "Recharge successful!" : "Processing payment..."}
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            {credited
              ? `${(parseInt(status!.amount_minor) / 100).toFixed(2)} ${status!.asset_code} added to your wallet`
              : polling
                ? "Waiting for payment confirmation..."
                : "Payment is being processed. Your balance will update shortly."
            }
          </p>
        </div>
        <button onClick={dismiss} className="text-text-secondary hover:text-text-primary">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  );
}
