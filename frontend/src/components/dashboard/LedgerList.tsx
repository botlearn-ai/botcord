import { useDashboard } from "./DashboardApp";

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function LedgerList() {
  const { state, loadWalletLedger } = useDashboard();
  const { walletLedger, walletLedgerHasMore, walletLoading, walletLedgerError } = state;

  if (walletLoading && walletLedger.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-neon-cyan animate-pulse text-sm">Loading ledger...</div>
      </div>
    );
  }

  if (walletLedgerError && walletLedger.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="text-sm text-red-400">{walletLedgerError}</div>
        <button
          onClick={() => loadWalletLedger()}
          className="rounded border border-glass-border px-4 py-2 text-xs text-text-secondary hover:text-text-primary"
        >
          Retry
        </button>
      </div>
    );
  }

  if (walletLedger.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="mb-2 text-2xl opacity-20">---</div>
        <p className="text-sm text-text-secondary">No transactions yet</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-2">
      {walletLedger.map((entry) => {
        const isCredit = entry.direction === "credit";
        return (
          <div
            key={entry.entry_id}
            className="flex items-center gap-3 rounded-xl border border-glass-border bg-glass-bg p-4 transition-colors hover:bg-glass-bg/80"
          >
            {/* Direction icon */}
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                isCredit ? "bg-neon-green/10 text-neon-green" : "bg-red-500/10 text-red-400"
              }`}
            >
              {isCredit ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              )}
            </div>

            {/* Details */}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-text-primary capitalize">
                  {isCredit ? "Credit" : "Debit"}
                </span>
                <span
                  className={`font-mono text-sm font-semibold ${
                    isCredit ? "text-neon-green" : "text-red-400"
                  }`}
                >
                  {isCredit ? "+" : "-"}{formatCoinAmount(entry.amount_minor)}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="truncate font-mono text-[10px] text-text-secondary/60">
                  {entry.tx_id}
                </span>
                <span className="ml-2 shrink-0 text-[10px] text-text-secondary/60">
                  Bal: {formatCoinAmount(entry.balance_after_minor)}
                </span>
              </div>
              <div className="mt-0.5 text-[10px] text-text-secondary/50">
                {formatTime(entry.created_at)}
              </div>
            </div>
          </div>
        );
      })}

      {/* Load more */}
      {walletLedgerHasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => loadWalletLedger(true)}
            disabled={walletLoading}
            className="rounded-lg border border-glass-border px-4 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-40"
          >
            {walletLoading ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
