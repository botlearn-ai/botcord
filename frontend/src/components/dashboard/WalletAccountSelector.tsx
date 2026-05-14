"use client";

/**
 * [INPUT]: 依赖 session store 的 human + ownedAgents 列举可选账户；i18n 提供 "我 (Human)" / "Bot ·" 前缀
 * [OUTPUT]: WalletAccountSelector — 钱包相关 dialog 顶部统一的账户选择器（受控）
 * [POS]: dashboard 钱包 dialog（Topup / Transfer / Withdraw）共享子组件
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useLanguage } from "@/lib/i18n";
import { walletPanel } from "@/lib/i18n/translations/dashboard";
import type { ActiveIdentity } from "@/lib/api";

interface Props {
  value: ActiveIdentity | null;
  onChange: (next: ActiveIdentity) => void;
  /** Optional override for the label. Defaults to the translated "账户". */
  label?: string;
}

export function useWalletAccountOptions(): Array<{ identity: ActiveIdentity; label: string }> {
  const locale = useLanguage();
  const t = walletPanel[locale];
  const { human, ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({ human: s.human, ownedAgents: s.ownedAgents })),
  );
  return useMemo(() => {
    const options: Array<{ identity: ActiveIdentity; label: string }> = [];
    if (human?.human_id) {
      options.push({ identity: { type: "human", id: human.human_id }, label: t.youHuman });
    }
    for (const agent of ownedAgents) {
      options.push({
        identity: { type: "agent", id: agent.agent_id },
        label: `${t.botPrefix} · ${agent.display_name}`,
      });
    }
    return options;
  }, [human, ownedAgents, t.youHuman, t.botPrefix]);
}

export default function WalletAccountSelector({ value, onChange, label }: Props) {
  const locale = useLanguage();
  const t = walletPanel[locale];
  const options = useWalletAccountOptions();
  const [open, setOpen] = useState(false);

  const current = value
    ? options.find((o) => o.identity.type === value.type && o.identity.id === value.id) ?? null
    : null;

  if (options.length <= 1) {
    // Single owner — nothing to switch between.
    return null;
  }

  return (
    <div className="mb-4 rounded-xl border border-glass-border bg-deep-black-light px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
          {label ?? t.fromAccount}
        </span>
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg px-2.5 py-1 text-xs text-text-primary hover:border-neon-cyan/30"
          >
            <span className="font-medium">{current?.label ?? "—"}</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {open ? (
            <div className="absolute right-0 top-full z-30 mt-1 min-w-[220px] overflow-hidden rounded-lg border border-glass-border bg-deep-black-light shadow-lg">
              {options.map((opt) => {
                const selected = value?.type === opt.identity.type && value.id === opt.identity.id;
                return (
                  <button
                    key={`${opt.identity.type}:${opt.identity.id}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChange(opt.identity);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-glass-bg ${
                      selected ? "bg-neon-cyan/10 text-neon-cyan" : "text-text-primary"
                    }`}
                  >
                    <span className="truncate">{opt.label}</span>
                    <span className="ml-2 truncate font-mono text-[10px] text-text-secondary/60">
                      {opt.identity.id}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
