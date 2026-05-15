"use client";

import CopyableId from "@/components/ui/CopyableId";

interface TransferInfo {
  status: string;
  tx_id: string;
  amount: string;
  asset: string;
  from: string;
  to: string;
  from_label?: string;
  to_label?: string;
  memo?: string;
  created_at?: string;
}

/**
 * Parse a "[BotCord Transfer]" plain-text message into structured fields.
 * Returns null if the text is not a transfer record.
 */
export function parseTransferText(text: string): TransferInfo | null {
  if (!text.startsWith("[BotCord Transfer]")) return null;

  const get = (label: string): string => {
    const re = new RegExp(`^${label}:\\s*(.+)`, "m");
    return re.exec(text)?.[1]?.trim() ?? "";
  };

  const amount = get("Amount");
  const asset = get("Asset");
  if (!amount) return null;

  return {
    status: get("Status"),
    tx_id: get("Transaction"),
    amount,
    asset,
    from: get("From"),
    to: get("To"),
    memo: get("Memo") || undefined,
    created_at: get("Created") || undefined,
  };
}

/**
 * Parse a "[BotCord Notice]" system message into structured fields.
 * Also accepts payload with structured event data.
 */
export function parseTransferNotice(
  text: string,
  payload?: Record<string, unknown>,
): TransferInfo | null {
  // Prefer structured payload
  if (payload?.event === "wallet_transfer_notice") {
    const amountMinor = parseInt(String(payload.amount_minor ?? "0"), 10);
    const major = isNaN(amountMinor) ? "0.00" : (amountMinor / 100).toFixed(2);
    return {
      status: "completed",
      tx_id: String(payload.tx_id ?? ""),
      amount: `${major} ${payload.asset_code ?? "COIN"}`,
      asset: String(payload.asset_code ?? "COIN"),
      from: String(payload.from_agent_id ?? ""),
      to: String(payload.to_agent_id ?? ""),
      from_label: typeof payload.from_display_name === "string" ? payload.from_display_name : undefined,
      to_label: typeof payload.to_display_name === "string" ? payload.to_display_name : undefined,
    };
  }

  if (!text.startsWith("[BotCord Notice]")) return null;

  // "[BotCord Notice] Transfer sent: 10.00 COIN to ag_xxx (tx: tx_xxx)"
  // "[BotCord Notice] Payment received: 10.00 COIN from ag_xxx (tx: tx_xxx)"
  const sent = /Transfer sent:\s*([\d.]+\s*\w+)\s+to\s+(ag_\w+)\s*\(tx:\s*(\w+)\)/.exec(text);
  if (sent) {
    return {
      status: "completed",
      tx_id: sent[3],
      amount: sent[1],
      asset: sent[1].split(/\s+/)[1] ?? "COIN",
      from: "",
      to: sent[2],
    };
  }

  const received = /Payment received:\s*([\d.]+\s*\w+)\s+from\s+(ag_\w+)\s*\(tx:\s*(\w+)\)/.exec(text);
  if (received) {
    return {
      status: "completed",
      tx_id: received[3],
      amount: received[1],
      asset: received[1].split(/\s+/)[1] ?? "COIN",
      from: received[2],
      to: "",
    };
  }

  return null;
}

const statusStyles: Record<string, string> = {
  completed: "text-neon-green bg-neon-green/10 border-neon-green/30",
  pending: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30",
  failed: "text-red-400 bg-red-400/10 border-red-400/30",
};

function TransferParty({ id, label }: { id: string; label?: string }) {
  if (label && label !== id) {
    return (
      <span className="min-w-0 text-right">
        <span className="block truncate text-text-primary/85">{label}</span>
        <CopyableId value={id} />
      </span>
    );
  }
  return <CopyableId value={id} />;
}

export default function TransferCard({ info, isNotice }: { info: TransferInfo; isNotice?: boolean }) {
  const amountNum = parseFloat(info.amount);
  const amountDisplay = isNaN(amountNum) ? info.amount : `${amountNum.toFixed(2)} ${info.asset}`;
  const sc = statusStyles[info.status] ?? statusStyles.completed;

  return (
    <div className="w-full min-w-[220px]">
      {/* Header */}
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-neon-cyan">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
          <span className="text-[11px] font-medium text-neon-cyan">
            {isNotice ? "Transfer Notice" : "Transfer Record"}
          </span>
        </div>
        <span className={`rounded-full border px-1.5 py-px text-[10px] font-medium ${sc}`}>
          {info.status}
        </span>
      </div>

      {/* Amount */}
      <div className="mb-2 text-center">
        <span className="font-mono text-lg font-bold text-text-primary">{amountDisplay}</span>
      </div>

      {/* Details */}
      <div className="space-y-1 text-xs">
        {info.from && (
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-text-secondary/60">From</span>
            <TransferParty id={info.from} label={info.from_label} />
          </div>
        )}
        {info.to && (
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-text-secondary/60">To</span>
            <TransferParty id={info.to} label={info.to_label} />
          </div>
        )}
        {info.memo && (
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-text-secondary/60">Memo</span>
            <span className="truncate text-text-primary/80">{info.memo}</span>
          </div>
        )}
        {info.tx_id && (
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-text-secondary/60">Tx</span>
            <CopyableId value={info.tx_id} />
          </div>
        )}
      </div>
    </div>
  );
}
