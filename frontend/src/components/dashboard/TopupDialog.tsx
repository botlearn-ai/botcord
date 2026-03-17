import { useState } from "react";
import { useDashboard } from "./DashboardApp";
import { api, ApiError } from "../../lib/api";
import type { TopupResponse } from "../../lib/types";

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface TopupDialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

export default function TopupDialog({ onClose, onSuccess }: TopupDialogProps) {
  const { state } = useDashboard();
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TopupResponse | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Amount must be greater than 0");
      return;
    }

    const amountMinor = Math.round(amountNum * 100);

    if (!state.token) return;
    setSubmitting(true);
    try {
      const res = await api.createTopup(state.token, {
        amount_minor: String(amountMinor),
        channel: "mock",
      });
      setResult(res);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Recharge request failed");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (result) {
      onSuccess();
    } else {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border border-glass-border bg-glass-bg p-6 backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleClose}
          className="absolute right-4 top-4 rounded p-1 text-text-secondary hover:text-text-primary"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        {result ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5 text-neon-green">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="text-lg font-semibold text-text-primary">Recharge Submitted</h3>
            </div>

            <div className="rounded-xl border border-glass-border bg-deep-black-light p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Amount</span>
                <span className="font-mono text-sm font-semibold text-text-primary">
                  {formatCoinAmount(result.amount_minor)} {result.asset_code}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Status</span>
                <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                  result.status === "completed"
                    ? "bg-neon-green/10 text-neon-green"
                    : "bg-yellow-500/10 text-yellow-400"
                }`}>
                  {result.status}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Channel</span>
                <span className="text-xs text-text-primary">{result.channel}</span>
              </div>
            </div>

            {result.status !== "completed" && (
              <p className="text-xs text-text-secondary">
                Your recharge request is being processed. The balance will update once it completes.
              </p>
            )}

            <button
              onClick={handleClose}
              className="w-full rounded-lg border border-glass-border py-2.5 font-medium text-text-primary transition-colors hover:bg-glass-bg"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="mb-5">
              <h3 className="text-lg font-semibold text-text-primary">Recharge</h3>
              <p className="text-xs text-text-secondary">Add coins to your wallet (mock channel)</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  Amount (COIN)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-green/50"
                />
              </div>

              <div className="rounded-lg border border-glass-border bg-deep-black-light p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">Channel</span>
                  <span className="rounded bg-neon-green/10 px-2 py-0.5 text-[10px] font-medium text-neon-green">
                    mock
                  </span>
                </div>
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg border border-neon-green/30 bg-neon-green/10 py-2.5 font-medium text-neon-green transition-colors hover:bg-neon-green/20 disabled:opacity-40"
              >
                {submitting ? "Submitting..." : "Submit Recharge"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
