"use client";

import { useState, useEffect } from "react";
import { useDashboard } from "./DashboardApp";
import { api, ApiError } from "@/lib/api";
import type { StripePackageItem } from "@/lib/types";

function formatCoin(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  return (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface TopupDialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

export default function TopupDialog({ onClose, onSuccess }: TopupDialogProps) {
  const { state } = useDashboard();
  const [packages, setPackages] = useState<StripePackageItem[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [packagesError, setPackagesError] = useState("");
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getStripePackages()
      .then((res) => {
        setPackages(res.packages);
        setPackagesLoading(false);
      })
      .catch((err) => {
        setPackagesError(err instanceof ApiError ? err.message : "Failed to load packages");
        setPackagesLoading(false);
      });
  }, []);

  const handleCheckout = async () => {
    if (!selectedPackage || !state.token) return;
    setError("");
    setSubmitting(true);

    try {
      const res = await api.createStripeCheckoutSession(state.token, {
        package_code: selectedPackage,
        idempotency_key: crypto.randomUUID(),
      });
      window.location.assign(res.checkout_url);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to start checkout");
      }
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border border-glass-border bg-glass-bg p-6 backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded p-1 text-text-secondary hover:text-text-primary"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        <div className="mb-5">
          <h3 className="text-lg font-semibold text-text-primary">Recharge</h3>
          <p className="text-xs text-text-secondary">Select a package to add coins to your wallet</p>
        </div>

        {packagesLoading ? (
          <div className="py-8 text-center text-sm text-text-secondary animate-pulse">
            Loading packages...
          </div>
        ) : packagesError ? (
          <div className="py-8 text-center text-sm text-red-400">{packagesError}</div>
        ) : packages.length === 0 ? (
          <div className="py-8 text-center text-sm text-text-secondary">
            No packages available at this time.
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {packages.map((pkg) => (
                <button
                  key={pkg.package_code}
                  onClick={() => setSelectedPackage(pkg.package_code)}
                  className={`w-full rounded-xl border p-4 text-left transition-colors ${
                    selectedPackage === pkg.package_code
                      ? "border-neon-green/50 bg-neon-green/5"
                      : "border-glass-border bg-deep-black-light hover:border-glass-border/80"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-semibold text-text-primary">
                      {formatCoin(pkg.coin_amount_minor)} COIN
                    </span>
                    <span className="rounded bg-neon-cyan/10 px-2 py-0.5 text-xs font-medium text-neon-cyan">
                      {pkg.fiat_amount ? `$${pkg.fiat_amount}` : pkg.currency.toUpperCase()}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

            <button
              onClick={handleCheckout}
              disabled={!selectedPackage || submitting}
              className="mt-4 w-full rounded-lg border border-neon-green/30 bg-neon-green/10 py-2.5 font-medium text-neon-green transition-colors hover:bg-neon-green/20 disabled:opacity-40"
            >
              {submitting ? "Redirecting to Stripe..." : "Continue to Payment"}
            </button>
          </>
        )}

        <p className="mt-3 text-center text-[10px] text-text-secondary/60">
          Secure payment powered by Stripe
        </p>
      </div>
    </div>
  );
}
