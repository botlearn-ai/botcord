"use client";

/**
 * [INPUT]: 依赖 session store 的 human + ownedAgents 列举可选账户；i18n 提供 "我 (Human)" / "Bot ·" 前缀
 * [OUTPUT]: WalletAccountSelector — 钱包相关 dialog 顶部统一的账户选择器（受控）
 * [POS]: dashboard 钱包 dialog（Topup / Transfer / Withdraw）共享子组件
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import Card from "@/components/ui/Card";
import SingleSelect from "@/components/ui/SingleSelect";
import { useMemo } from "react";
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

  if (options.length <= 1) {
    // Single owner — nothing to switch between.
    return null;
  }

  return (
    <Card padding="sm" className="mb-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          {label ?? t.fromAccount}
        </span>
        <SingleSelect
          placeholder={label ?? t.fromAccount}
          aria-label={label ?? t.fromAccount}
          value={value ? `${value.type}:${value.id}` : null}
          onChange={(key) => {
            const selected = options.find((option) => `${option.identity.type}:${option.identity.id}` === key);
            if (selected) onChange(selected.identity);
          }}
          options={options.map((option) => ({ value: `${option.identity.type}:${option.identity.id}`, label: option.label, sublabel: option.identity.id }))}
        />
      </div>
    </Card>
  );
}
