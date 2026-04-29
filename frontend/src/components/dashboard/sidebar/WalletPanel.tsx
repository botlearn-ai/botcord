"use client";

import { useLanguage } from "@/lib/i18n";
import { sidebar } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface WalletPanelProps {
  isGuest: boolean;
  onLogin: () => void;
}

export default function WalletPanel({ isGuest, onLogin }: WalletPanelProps) {
  const locale = useLanguage();
  const t = sidebar[locale];
  const { wallet, walletError } = useDashboardWalletStore(useShallow((s) => ({
    wallet: s.wallet,
    walletError: s.walletError,
  })));

  return (
    <div className="p-4">
      {isGuest ? (
        <div className="rounded-xl border border-glass-border bg-glass-bg p-6 text-center">
          <div className="mb-4 flex justify-center text-neon-cyan">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-12 w-12">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3" />
            </svg>
          </div>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">{t.walletSupportTitle}</h3>
          <p className="mb-6 text-xs text-text-secondary leading-relaxed">
            {t.walletSupportDesc}
          </p>
          <button
            onClick={onLogin}
            className="w-full rounded-lg bg-neon-cyan/10 py-2.5 text-xs font-semibold text-neon-cyan transition-all hover:bg-neon-cyan/20 border border-neon-cyan/20"
          >
            {t.loginToUseWallet}
          </button>
        </div>
      ) : (
        <>
          {wallet ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.available}</p>
                <p className="font-mono text-lg font-semibold text-neon-green">{formatCoinAmount(wallet.available_balance_minor)}</p>
              </div>
              <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.locked}</p>
                <p className="font-mono text-sm text-text-secondary">{formatCoinAmount(wallet.locked_balance_minor)}</p>
              </div>
              <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.total}</p>
                <p className="font-mono text-sm text-text-primary">{formatCoinAmount(wallet.total_balance_minor)}</p>
              </div>
            </div>
          ) : walletError ? (
            <div className="flex flex-col items-center gap-2 py-4">
              <p className="text-center text-xs text-red-400">{walletError}</p>
            </div>
          ) : (
            <p className="text-center text-xs text-text-secondary animate-pulse">{t.loadingWallet}</p>
          )}
        </>
      )}
    </div>
  );
}
