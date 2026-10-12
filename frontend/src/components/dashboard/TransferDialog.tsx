"use client";
import Field from "@/components/ui/Field";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import Button from "@/components/ui/Button";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
/**
 * [INPUT]: 依赖 wallet store 获取来源账户的可用余额，依赖 session/chat store 列举可选收款方
 * [OUTPUT]: 重设计后的转账 dialog — 模仿标准银行/支付场景：From 卡片(显示余额) + 可视化 To 选择器 + 大额金额输入 + 快速金额 + 校验后才能提交
 * [POS]: 钱包主面板及 Bot 钱包 tab 共用的转账入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { transferDialog, walletPanel } from "@/lib/i18n/translations/dashboard";
import { api, ApiError, type ActiveIdentity } from "@/lib/api";
import { animateIfMotion, animateOverlayPanelEnter, animateOverlayPanelExit, animatePop, cleanupAnime } from "@/lib/anime";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, Loader2, Pencil, X } from "lucide-react";
import BotAvatar from "./BotAvatar";

interface TransferDialogProps {
  /** Identity that owns the wallet sending the transfer. ``null`` defaults to "我". */
  viewer?: ActiveIdentity | null;
  onClose: () => void;
  onSuccess: () => void;
}

interface RecipientOption {
  /** Stable key (group + id). */
  key: string;
  /** Display label. */
  label: string;
  /** Group bucket — controls header. */
  group: "human-self" | "my-bot" | "contact";
  /** Backend id — `ag_*` or `hu_*`. */
  id: string;
  /** Optional avatar URL for bots. */
  avatarUrl?: string | null;
}

function formatCoin(minorStr: string | null | undefined): string {
  if (!minorStr) return "0.00";
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  return (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showAmount(minorStr: string | null | undefined, hidden: boolean): string {
  return hidden ? "••••••" : formatCoin(minorStr);
}

export default withDashboardOverlayPortal(TransferDialog, "nested");

function TransferDialog({ viewer, onClose, onSuccess }: TransferDialogProps) {
  const locale = useLanguage();
  const t = transferDialog[locale];
  const wt = walletPanel[locale];

  const sessionStore = useDashboardSessionStore(
    useShallow((s) => ({
      activeIdentity: s.activeIdentity,
      ownedAgents: s.ownedAgents,
      human: s.human,
      sessionMode: s.sessionMode,
    })),
  );
  const contacts = useDashboardChatStore((s) => s.overview?.contacts) ?? [];
  const { humanWallet, botWallets } = useDashboardWalletStore(
    useShallow((s) => ({ humanWallet: s.humanWallet, botWallets: s.botWallets })),
  );
  const walletAmountsHidden = useDashboardUIStore((s) => s.walletAmountsHidden);

  // --- Sender (From) ---
  const [selectedViewer, setSelectedViewer] = useState<ActiveIdentity | null>(() => {
    if (viewer) return viewer;
    return sessionStore.human?.human_id
      ? { type: "human", id: sessionStore.human.human_id }
      : sessionStore.activeIdentity;
  });
  const senderId = selectedViewer?.id ?? "";

  const senderOptions = useMemo(() => {
    const out: Array<{ identity: ActiveIdentity; label: string }> = [];
    if (sessionStore.human?.human_id) {
      out.push({ identity: { type: "human", id: sessionStore.human.human_id }, label: wt.youHuman });
    }
    for (const agent of sessionStore.ownedAgents) {
      out.push({
        identity: { type: "agent", id: agent.agent_id },
        label: `${wt.botPrefix} · ${agent.display_name}`,
      });
    }
    return out;
  }, [sessionStore.human, sessionStore.ownedAgents, wt.botPrefix, wt.youHuman]);

  const senderLabel = useMemo(() => {
    if (!selectedViewer) return "—";
    return (
      senderOptions.find((o) => o.identity.type === selectedViewer.type && o.identity.id === selectedViewer.id)
        ?.label ?? selectedViewer.id
    );
  }, [selectedViewer, senderOptions]);

  const senderAvailableMinor =
    selectedViewer?.type === "human"
      ? humanWallet?.available_balance_minor ?? "0"
      : selectedViewer
        ? botWallets[selectedViewer.id]?.available_balance_minor ?? "0"
        : "0";

  // --- Recipient (To) ---
  const recipientOptions: RecipientOption[] = useMemo(() => {
    const list: RecipientOption[] = [];
    if (sessionStore.human?.human_id && sessionStore.human.human_id !== senderId) {
      list.push({
        key: `human:${sessionStore.human.human_id}`,
        label: sessionStore.human.display_name || "Me",
        group: "human-self",
        id: sessionStore.human.human_id,
      });
    }
    for (const agent of sessionStore.ownedAgents) {
      if (agent.agent_id === senderId) continue;
      list.push({
        key: `bot:${agent.agent_id}`,
        label: agent.display_name,
        group: "my-bot",
        id: agent.agent_id,
        avatarUrl: agent.avatar_url ?? null,
      });
    }
    for (const c of contacts) {
      if (c.contact_agent_id === senderId) continue;
      list.push({
        key: `contact:${c.contact_agent_id}`,
        label: c.alias || c.display_name || c.contact_agent_id,
        group: "contact",
        id: c.contact_agent_id,
        avatarUrl: (c as { avatar_url?: string | null }).avatar_url ?? null,
      });
    }
    return list;
  }, [sessionStore.human, sessionStore.ownedAgents, contacts, senderId]);

  const [recipientMode, setRecipientMode] = useState<"none" | "picked" | "custom">("none");
  const [recipientPick, setRecipientPick] = useState<RecipientOption | null>(null);
  const [customRecipientId, setCustomRecipientId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  // If the sender changes and the previously-picked recipient is now the
  // sender, clear it to keep the form valid.
  useEffect(() => {
    if (recipientPick && recipientPick.id === senderId) {
      setRecipientPick(null);
      setRecipientMode("none");
    }
  }, [senderId, recipientPick]);

  const effectiveRecipientId =
    recipientMode === "custom"
      ? customRecipientId.trim()
      : recipientPick?.id ?? "";

  // --- Amount + memo ---
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const errorAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  const amountNumber = useMemo(() => {
    if (!/^[1-9]\d*$/.test(amount.trim())) return null;
    return Number.parseInt(amount.trim(), 10);
  }, [amount]);
  const amountMinor = amountNumber !== null ? amountNumber * 100 : 0;
  const availableMinor = parseInt(senderAvailableMinor, 10) || 0;
  const overBudget = amountNumber !== null && amountMinor > availableMinor;

  const isValid =
    !!effectiveRecipientId
    && effectiveRecipientId !== senderId
    && amountNumber !== null
    && amountNumber > 0
    && !overBudget;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!isValid) {
      if (!effectiveRecipientId) setError(t.recipientRequired);
      else if (effectiveRecipientId === senderId) setError(t.cannotTransferSelf);
      else if (amountNumber === null) setError(t.amountMustBePositive);
      else if (overBudget) setError(t.insufficient);
      return;
    }
    if (sessionStore.sessionMode === "guest") return;
    setSubmitting(true);
    try {
      await api.createTransfer(
        {
          to_agent_id: effectiveRecipientId,
          amount_minor: String(amountMinor),
          memo: memo.trim() || undefined,
          idempotency_key: crypto.randomUUID(),
        },
        selectedViewer,
      );
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(t.transferFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const handleMaxAmount = () => {
    if (availableMinor <= 0) return;
    setAmount(String(Math.floor(availableMinor / 100)));
  };

  // Quick-amount chips — capped by available balance.
  const quickAmounts = useMemo(() => {
    const base = [10, 50, 100, 500];
    return base.filter((n) => n * 100 <= availableMinor);
  }, [availableMinor]);

  const closeWithMotion = useCallback(() => {
    if (submitting || closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [closing, onClose, submitting]);

  useEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; } });
    return () => cleanupAnime(animationRef.current);
  }, []);

  useEffect(() => {
    if (!error || !errorRef.current) return;
    cleanupAnime(errorAnimationRef.current);
    errorAnimationRef.current = animatePop(errorRef.current);
    return () => cleanupAnime(errorAnimationRef.current);
  }, [error]);

  return (
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} title={<>{t.transfer}</>} busy={submitting} overlayClassName="z-50" className="max-w-md">
        <IconButton label="close"
          onClick={closeWithMotion}
          aria-label="close"
          className="absolute right-4 z-10"
        >
          <X className="h-4 w-4" />
        </IconButton>

        <div className="shrink-0 px-6 pt-6 pb-3">
          <h3 className="text-lg font-semibold text-text-primary">{t.transfer}</h3>
        </div>

        <form id="transferForm" onSubmit={handleSubmit} className="flex-1 space-y-4 overflow-y-auto px-6 pb-4">
          {/* From card */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              {t.fromLabel}
            </label>
            <FromCard
              label={senderLabel}
              availableMinor={senderAvailableMinor}
              hidden={walletAmountsHidden}
              availableHint={t.availableLabel}
              options={senderOptions}
              value={selectedViewer}
              onChange={setSelectedViewer}
              disabled={senderOptions.length <= 1}
            />
          </div>

          {/* To */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-secondary">
              {t.toLabel}
            </label>
            {recipientMode === "picked" && recipientPick ? (
              <RecipientChip
                option={recipientPick}
                changeLabel={t.changeRecipient}
                onChange={() => {
                  setRecipientPick(null);
                  setRecipientMode("none");
                }}
              />
            ) : recipientMode === "custom" ? (
              <div className="space-y-1.5">
                <Input
                  autoFocus
                  type="text"
                  value={customRecipientId}
                  onChange={(e) => setCustomRecipientId(e.target.value)}
                  placeholder={t.enterCustomIdHint}
                  className="w-full"
                />
                <Button variant="ghost"
                  type="button"
                  onClick={() => {
                    setRecipientMode("none");
                    setCustomRecipientId("");
                  }}

                >
                  ← {t.pickRecipientDefault}
                </Button>
              </div>
            ) : (
              <RecipientPicker
                open={pickerOpen}
                setOpen={setPickerOpen}
                options={recipientOptions}
                groups={{
                  "human-self": t.groupHumanSelf,
                  "my-bot": t.groupMyBots,
                  contact: t.groupContacts,
                }}
                placeholder={t.pickRecipientDefault}
                customLabel={t.enterCustomIdLabel}
                onPick={(opt) => {
                  setRecipientPick(opt);
                  setRecipientMode("picked");
                  setPickerOpen(false);
                }}
                onCustom={() => {
                  setRecipientMode("custom");
                  setPickerOpen(false);
                }}
              />
            )}
          </div>

          {/* Amount */}
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label className="text-xs font-medium text-text-secondary">
                {t.amountCoin}
              </label>
              <Button variant="ghost"
                type="button"
                onClick={handleMaxAmount}
                disabled={availableMinor <= 0}

              >
                {t.maxAmount} · {showAmount(senderAvailableMinor, walletAmountsHidden)}
              </Button>
            </div>
            <div className="relative">
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="0"
                className="w-full"
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs font-medium text-text-secondary">
                COIN
              </span>
            </div>
            {quickAmounts.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {quickAmounts.map((n) => (
                  <Button aria-pressed={amount === String(n)} variant="row"
                    key={n}
                    type="button"
                    onClick={() => setAmount(String(n))}

                  >
                    {n}
                  </Button>
                ))}
              </div>
            ) : null}
            {overBudget ? (
              <p className="mt-1.5 text-xs text-danger">{t.insufficient}</p>
            ) : null}
          </div>

          {/* Memo */}
          <Field label={<>{t.memoOptional}</>}>

            <Input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder={t.memoPlaceholder}
              className="w-full"
            />
          </Field>

          {error && <Alert tone="danger" ref={errorRef} >{error}</Alert>}
        </form>

        <div className="liquid-toolbar shrink-0 border-t px-6 py-4">
          <Button variant="primary"
            form="transferForm"
            type="submit"
            disabled={!isValid || submitting}
            className="w-full"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {submitting
              ? t.sending
              : amountNumber !== null && amountNumber > 0
                ? t.submitWithAmount.replace("{amount}", amountNumber.toLocaleString())
                : t.sendTransfer}
          </Button>
        </div>
      </DialogSurface>
  );
}

function FromCard({
  label,
  availableMinor,
  hidden,
  availableHint,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  availableMinor: string;
  hidden: boolean;
  availableHint: string;
  options: Array<{ identity: ActiveIdentity; label: string }>;
  value: ActiveIdentity | null;
  onChange: (next: ActiveIdentity) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);

  useEffect(() => {
    if (!open || disabled || !menuRef.current) return;
    cleanupAnime(menuAnimationRef.current);
    menuAnimationRef.current = animateIfMotion(menuRef.current, {
      opacity: [0, 1],
      translateY: [-4, 0],
      scale: [0.98, 1],
      duration: 160,
      ease: "out(3)",
    });
    return () => cleanupAnime(menuAnimationRef.current);
  }, [disabled, open]);

  return (
    <div className="relative">
      <Button variant="row"
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className="w-full"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">{label}</div>
          <div className="mt-0.5 truncate font-mono text-xs text-text-secondary">
            {availableHint} {showAmount(availableMinor, hidden)} COIN
          </div>
        </div>
        {!disabled ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-secondary" /> : null}
      </Button>
      {open && !disabled ? (
        <div ref={menuRef} className="liquid-menu absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg">
          {options.map((opt) => {
            const selected =
              value?.type === opt.identity.type && value.id === opt.identity.id;
            return (
              <Button aria-pressed={selected} variant="row"
                key={`${opt.identity.type}:${opt.identity.id}`}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(opt.identity);
                  setOpen(false);
                }}
                className="w-full"
              >
                <span className="truncate">{opt.label}</span>
                <span className="ml-2 truncate font-mono text-xs text-text-secondary">
                  {opt.identity.id}
                </span>
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function RecipientPicker({
  open,
  setOpen,
  options,
  groups,
  placeholder,
  customLabel,
  onPick,
  onCustom,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  options: RecipientOption[];
  groups: Record<"human-self" | "my-bot" | "contact", string>;
  placeholder: string;
  customLabel: string;
  onPick: (opt: RecipientOption) => void;
  onCustom: () => void;
}) {
  const grouped = useMemo(() => {
    const buckets: Record<"human-self" | "my-bot" | "contact", RecipientOption[]> = {
      "human-self": [],
      "my-bot": [],
      contact: [],
    };
    for (const opt of options) buckets[opt.group].push(opt);
    return buckets;
  }, [options]);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);

  useEffect(() => {
    if (!open || !pickerRef.current) return;
    cleanupAnime(pickerAnimationRef.current);
    pickerAnimationRef.current = animateIfMotion(pickerRef.current, {
      opacity: [0, 1],
      translateY: [-4, 0],
      scale: [0.98, 1],
      duration: 160,
      ease: "out(3)",
    });
    return () => cleanupAnime(pickerAnimationRef.current);
  }, [open]);

  return (
    <div className="relative">
      <Button variant="secondary"
        type="button"
        onClick={() => setOpen(!open)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full"
      >
        <span>{placeholder}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
      </Button>
      {open ? (
        <div ref={pickerRef} className="liquid-menu absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg">
          {(["human-self", "my-bot", "contact"] as const).map((group) => {
            const items = grouped[group];
            if (items.length === 0) return null;
            return (
              <div key={group} className="border-b border-glass-border/40 py-1 last:border-b-0">
                <div className="px-3 py-1 text-xs font-semibold text-text-secondary">
                  {groups[group]}
                </div>
                {items.map((opt) => (
                  <Button variant="ghost"
                    key={opt.key}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick(opt);
                    }}
                    className="w-full"
                  >
                    {opt.group === "human-self" ? (
                      <HumanInitial label={opt.label} />
                    ) : (
                      <BotAvatar agentId={opt.id} avatarUrl={opt.avatarUrl ?? null} size={24} alt={opt.label} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-text-primary">{opt.label}</span>
                      <span className="block truncate font-mono text-xs text-text-secondary">{opt.id}</span>
                    </span>
                  </Button>
                ))}
              </div>
            );
          })}
          <Button variant="ghost"
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onCustom();
            }}
            className="w-full"
          >
            <Pencil className="h-3.5 w-3.5" />
            {customLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RecipientChip({
  option,
  changeLabel,
  onChange,
}: {
  option: RecipientOption;
  changeLabel: string;
  onChange: () => void;
}) {
  return (
    <Card padding="none" className="flex items-center gap-3 px-3.5 py-2.5">
      {option.group === "human-self" ? (
        <HumanInitial label={option.label} />
      ) : (
        <BotAvatar agentId={option.id} avatarUrl={option.avatarUrl ?? null} size={32} alt={option.label} />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-primary">{option.label}</div>
        <div className="truncate font-mono text-xs text-text-secondary">{option.id}</div>
      </div>
      <Button variant="secondary"
        type="button"
        onClick={onChange}

      >
        {changeLabel}
      </Button>
    </Card>
  );
}

function HumanInitial({ label }: { label: string }) {
  const initial = (label || "?").trim().charAt(0).toUpperCase();
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neon-cyan/20 text-xs font-semibold text-neon-cyan">
      {initial}
    </div>
  );
}
