"use client";

import { useState, useEffect } from "react";
import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { topupDialog } from '@/lib/i18n/translations/dashboard';
import { api, ApiError } from "@/lib/api";
import type { StripePackageItem } from "@/lib/types";

function formatCoin(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  return (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFiat(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface TopupDialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

export default function TopupDialog({ onClose, onSuccess }: TopupDialogProps) {
  const { state, isAuthedReady } = useDashboard();
  const locale = useLanguage();
  const t = topupDialog[locale];
  const [packages, setPackages] = useState<StripePackageItem[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [packagesError, setPackagesError] = useState("");
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getStripePackages()
      .then((res) => {
        setPackages(res.packages);
        setSelectedPackage((current) => current ?? res.packages[0]?.package_code ?? null);
        setPackagesLoading(false);
      })
      .catch((err) => {
        setPackagesError(err instanceof ApiError ? err.message : "Failed to load packages");
        setPackagesLoading(false);
      });
  }, []);

  const activePackage = packages.find((pkg) => pkg.package_code === selectedPackage) ?? packages[0] ?? null;
  const unitCoinMinor = parseInt(activePackage?.coin_amount_minor ?? "0", 10);
  const unitFiat = Number.parseFloat(activePackage?.fiat_amount ?? "0");
  const normalizedUnitFiat = Number.isFinite(unitFiat) ? unitFiat : 0;
  const totalCoinMinor = Number.isFinite(unitCoinMinor) ? unitCoinMinor * quantity : 0;
  const totalFiat = normalizedUnitFiat * quantity;

  const updateQuantity = (next: number) => {
    if (!Number.isFinite(next)) return;
    setQuantity(Math.max(1, Math.min(100, Math.trunc(next))));
  };

  const handleCheckout = async () => {
    if (!activePackage || !isAuthedReady) return;
    setError("");
    setSubmitting(true);

    try {
      const res = await api.createStripeCheckoutSession({
        package_code: activePackage.package_code,
        idempotency_key: crypto.randomUUID(),
        quantity,
      });
      window.location.assign(res.checkout_url);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t.rechargeFailed);
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
          <h3 className="text-lg font-semibold text-text-primary">{t.recharge}</h3>
          <p className="text-xs text-text-secondary">{t.description}</p>
        </div>

        {packagesLoading ? (
          <div className="py-8 text-center text-sm text-text-secondary animate-pulse">
            {t.loadingPackages}
          </div>
        ) : packagesError ? (
          <div className="py-8 text-center text-sm text-red-400">{packagesError}</div>
        ) : packages.length === 0 ? (
          <div className="py-8 text-center text-sm text-text-secondary">
            {t.noPackages}
          </div>
        ) : (
          <>
            {packages.length > 1 ? (
              <div className="space-y-3">
                {packages.map((pkg) => (
                  <button
                    key={pkg.package_code}
                    onClick={() => setSelectedPackage(pkg.package_code)}
                    className={`w-full rounded-xl border p-4 text-left transition-colors ${
                      activePackage?.package_code === pkg.package_code
                        ? "border-neon-green/50 bg-neon-green/5"
                        : "border-glass-border bg-deep-black-light hover:border-glass-border/80"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm font-semibold text-text-primary">
                        {formatCoin(pkg.coin_amount_minor)} COIN / ${pkg.fiat_amount || formatFiat(0)}
                      </span>
                      <span className="rounded bg-neon-cyan/10 px-2 py-0.5 text-xs font-medium text-neon-cyan">
                        {pkg.fiat_amount ? `$${pkg.fiat_amount}` : pkg.currency.toUpperCase()}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : activePackage ? (
              <div className="rounded-xl border border-neon-green/30 bg-neon-green/5 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-text-secondary">
                    {t.unitPrice}
                  </span>
                  <span className="rounded bg-neon-cyan/10 px-2 py-0.5 text-xs font-medium text-neon-cyan">
                    {activePackage.fiat_amount ? `$${activePackage.fiat_amount}` : activePackage.currency.toUpperCase()}
                  </span>
                </div>
                <div className="mt-2 font-mono text-lg font-semibold text-text-primary">
                  {formatCoin(activePackage.coin_amount_minor)} COIN / ${activePackage.fiat_amount || formatFiat(0)}
                </div>
              </div>
            ) : null}

            {activePackage ? (
              <>
                <div className="mt-4 rounded-xl border border-glass-border bg-deep-black-light p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">{t.quantity}</span>
                    <span className="text-xs text-text-secondary">{t.quantityRange}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => updateQuantity(quantity - 1)}
                      disabled={quantity <= 1 || submitting}
                      className="h-10 w-10 rounded-lg border border-glass-border text-lg text-text-primary transition-colors hover:border-neon-green/40 disabled:opacity-40"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={quantity}
                      onChange={(e) => updateQuantity(parseInt(e.target.value, 10))}
                      className="h-10 flex-1 rounded-lg border border-glass-border bg-deep-black px-3 text-center font-mono text-text-primary outline-none transition-colors focus:border-neon-green/40"
                    />
                    <button
                      type="button"
                      onClick={() => updateQuantity(quantity + 1)}
                      disabled={quantity >= 100 || submitting}
                      className="h-10 w-10 rounded-lg border border-glass-border text-lg text-text-primary transition-colors hover:border-neon-green/40 disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-glass-border bg-deep-black-light p-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-text-secondary">{t.perUnit}</span>
                    <span className="font-mono text-text-primary">
                      {formatCoin(activePackage.coin_amount_minor)} COIN / ${formatFiat(normalizedUnitFiat)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-sm">
                    <span className="text-text-secondary">{t.quantity}</span>
                    <span className="font-mono text-text-primary">{quantity}</span>
                  </div>
                  <div className="mt-3 border-t border-glass-border pt-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-text-primary">{t.total}</span>
                      <div className="text-right">
                        <div className="font-mono text-base font-semibold text-neon-green">
                          {formatCoin(String(totalCoinMinor))} COIN
                        </div>
                        <div className="text-xs text-text-secondary">
                          ${formatFiat(totalFiat)} {activePackage.currency.toUpperCase()}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

            <button
              onClick={handleCheckout}
              disabled={!activePackage || submitting}
              className="mt-4 w-full rounded-lg border border-neon-green/30 bg-neon-green/10 py-2.5 font-medium text-neon-green transition-colors hover:bg-neon-green/20 disabled:opacity-40"
            >
              {submitting ? t.redirectingToStripe : `${t.continueToPayment}${activePackage ? ` • $${formatFiat(totalFiat)}` : ""}`}
            </button>
          </>
        )}

        <p className="mt-3 text-center text-[10px] text-text-secondary/60">
          {t.securePayment}
        </p>
      </div>
    </div>
  );
}
