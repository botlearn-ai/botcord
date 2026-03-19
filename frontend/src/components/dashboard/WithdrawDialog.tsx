"use client";

import { useState } from "react";
import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { withdrawDialog } from '@/lib/i18n/translations/dashboard';
import { api, ApiError } from "@/lib/api";

interface WithdrawDialogProps {
  onClose: () => void;
  onSuccess: () => void;
  availableBalance: string;
}

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function WithdrawDialog({ onClose, onSuccess, availableBalance }: WithdrawDialogProps) {
  const { state } = useDashboard();
  const locale = useLanguage();
  const t = withdrawDialog[locale];
  const [amount, setAmount] = useState("");
  const [destinationType, setDestinationType] = useState<"bank" | "usdt_trc20" | "paypal">("bank");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [paypalEmail, setPaypalEmail] = useState("");
  const [contactNote, setContactNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const availableMinor = parseInt(availableBalance, 10) || 0;
  const availableMajor = availableMinor / 100;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError(t.amountMustBePositive);
      return;
    }

    const amountMinor = Math.round(amountNum * 100);
    if (amountMinor > availableMinor) {
      setError(`${t.amountExceedsBalance} (${formatCoinAmount(availableBalance)})`);
      return;
    }

    const destination = buildDestinationPayload({
      destinationType,
      accountName,
      accountNumber,
      bankName,
      walletAddress,
      paypalEmail,
      contactNote,
    });

    if (!destination || !confirmed) {
      setError(!confirmed ? t.confirmReview : t.requiredField);
      return;
    }

    if (!state.token) return;
    setSubmitting(true);
    try {
      await api.createWithdrawal({
        amount_minor: amountMinor,
        destination_type: destinationType,
        destination,
        idempotency_key: crypto.randomUUID(),
      });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t.withdrawFailed);
      }
    } finally {
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
          <h3 className="text-lg font-semibold text-text-primary">{t.withdraw}</h3>
          <p className="text-xs text-text-secondary">{t.requestWithdraw}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-lg border border-glass-border bg-deep-black-light p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">{t.availableBalance}</span>
              <span className="font-mono text-sm font-semibold text-neon-green">
                {formatCoinAmount(availableBalance)}
              </span>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              {t.amountCoin}
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={availableMajor}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-purple/50"
            />
            <button
              type="button"
              onClick={() => setAmount(String(availableMajor))}
              className="mt-1 text-[10px] text-neon-purple hover:underline"
            >
              {t.withdrawAll}
            </button>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              {t.destinationType}
            </label>
            <select
              value={destinationType}
              onChange={(e) => setDestinationType(e.target.value as "bank" | "usdt_trc20" | "paypal")}
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 text-sm text-text-primary outline-none focus:border-neon-purple/50"
            >
              <option value="bank">{t.destinationTypeBank}</option>
              <option value="usdt_trc20">{t.destinationTypeUsdt}</option>
              <option value="paypal">{t.destinationTypePaypal}</option>
            </select>
          </div>

          {destinationType === "bank" && (
            <>
              <FormField
                label={t.accountName}
                value={accountName}
                onChange={setAccountName}
                placeholder="Jane Doe"
              />
              <FormField
                label={t.bankName}
                value={bankName}
                onChange={setBankName}
                placeholder="Bank of China"
              />
              <FormField
                label={t.accountNumber}
                value={accountNumber}
                onChange={setAccountNumber}
                placeholder="6222 8888 1234"
              />
            </>
          )}

          {destinationType === "usdt_trc20" && (
            <>
              <FormField
                label={t.accountName}
                value={accountName}
                onChange={setAccountName}
                placeholder="Jane Doe"
              />
              <FormField
                label={t.walletAddress}
                value={walletAddress}
                onChange={setWalletAddress}
                placeholder="TR..."
              />
              <FormField
                label={t.network}
                value="TRC20"
                onChange={() => {}}
                placeholder="TRC20"
                disabled
              />
            </>
          )}

          {destinationType === "paypal" && (
            <>
              <FormField
                label={t.accountName}
                value={accountName}
                onChange={setAccountName}
                placeholder="Jane Doe"
              />
              <FormField
                label={t.paypalEmail}
                value={paypalEmail}
                onChange={setPaypalEmail}
                placeholder="name@example.com"
              />
            </>
          )}

          <FormField
            label={t.contactNote}
            value={contactNote}
            onChange={setContactNote}
            placeholder="Telegram / email / memo"
          />

          <div className="rounded-lg border border-glass-border bg-deep-black-light p-3">
            <p className="text-xs text-text-secondary">{t.reviewNotice}</p>
            <label className="mt-3 flex items-start gap-2 text-xs text-text-primary">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>{t.confirmReview}</span>
            </label>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg border border-neon-purple/30 bg-neon-purple/10 py-2.5 font-medium text-neon-purple transition-colors hover:bg-neon-purple/20 disabled:opacity-40"
          >
            {submitting ? t.submitting : t.submitWithdraw}
          </button>
        </form>
      </div>
    </div>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-text-secondary">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-purple/50 disabled:opacity-60"
      />
    </div>
  );
}

function buildDestinationPayload({
  destinationType,
  accountName,
  accountNumber,
  bankName,
  walletAddress,
  paypalEmail,
  contactNote,
}: {
  destinationType: "bank" | "usdt_trc20" | "paypal";
  accountName: string;
  accountNumber: string;
  bankName: string;
  walletAddress: string;
  paypalEmail: string;
  contactNote: string;
}): Record<string, string> | null {
  const note = contactNote.trim();

  if (destinationType === "bank") {
    if (!accountName.trim() || !bankName.trim() || !accountNumber.trim()) {
      return null;
    }
    const payload: Record<string, string> = {
      account_name: accountName.trim(),
      bank_name: bankName.trim(),
      account_no: accountNumber.trim(),
      contact_note: note,
    };
    return payload;
  }

  if (destinationType === "usdt_trc20") {
    if (!accountName.trim() || !walletAddress.trim()) {
      return null;
    }
    const payload: Record<string, string> = {
      account_name: accountName.trim(),
      wallet_address: walletAddress.trim(),
      network: "TRC20",
      contact_note: note,
    };
    return payload;
  }

  if (!accountName.trim() || !paypalEmail.trim()) {
    return null;
  }

  const payload: Record<string, string> = {
    account_name: accountName.trim(),
    paypal_email: paypalEmail.trim(),
    contact_note: note,
  };
  return payload;
}
