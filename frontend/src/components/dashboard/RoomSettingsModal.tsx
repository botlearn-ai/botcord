"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Search, Trash2, X } from "lucide-react";
import CopyableId from "@/components/ui/CopyableId";
import { api, humansApi, userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import {
  agentBrowser,
  roomAdvancedSettings,
  roomSettingsModal,
} from "@/lib/i18n/translations/dashboard";
import type { ParticipantType, PublicRoomMember, SubscriptionProduct, UserAgent } from "@/lib/types";
import AddRoomMemberModal from "./AddRoomMemberModal";
import MemberActionsMenu from "./MemberActionsMenu";
import PlanChangeConfirmDialog from "./PlanChangeConfirmDialog";
import TransferOwnershipDialog from "./TransferOwnershipDialog";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";

interface RoomSettingsModalProps {
  roomId: string;
  // Polymorphic owner type — drives whether the subscription section
  // shows a "receiving bot" dropdown (human-owned) or hard-binds the
  // provider to the owner agent (agent-owned).
  roomOwnerType: ParticipantType;
  viewerMode: "human" | "agent";
  viewerRole?: string | null;
  initialName: string;
  initialDescription: string;
  initialRule: string;
  initialVisibility?: string;
  initialJoinPolicy?: string;
  initialDefaultSend?: boolean;
  initialDefaultInvite?: boolean;
  initialAllowHumanSend?: boolean;
  initialMaxMembers?: number | null;
  initialSlowModeSeconds?: number | null;
  initialSubscriptionProductId?: string | null;
  onClose: () => void;
}

interface ActionConfirmDialogProps {
  title: string;
  description: string;
  warning?: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmTextLabel?: string;
  confirmPlaceholder?: string;
  confirmValue?: string;
  onConfirmValueChange?: (value: string) => void;
  confirmDisabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
}

function ActionConfirmDialog({
  title,
  description,
  warning,
  confirmLabel,
  cancelLabel,
  confirmTextLabel,
  confirmPlaceholder,
  confirmValue = "",
  onConfirmValueChange,
  confirmDisabled = false,
  loading = false,
  loadingLabel,
  onClose,
  onConfirm,
}: ActionConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={loading}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
          aria-label={cancelLabel}
        >
          <X className="h-5 w-5" />
        </button>

        <div className="pr-8">
          <h3 className="text-xl font-bold text-text-primary">{title}</h3>
          <p className="mt-2 text-sm text-text-secondary">{description}</p>
        </div>

        {confirmTextLabel ? (
          <label className="mt-5 block">
            <span className="mb-1.5 block text-xs text-text-secondary">{confirmTextLabel}</span>
            <input
              type="text"
              value={confirmValue}
              onChange={(e) => onConfirmValueChange?.(e.target.value)}
              placeholder={confirmPlaceholder}
              className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2.5 text-sm text-text-primary outline-none focus:border-red-400/50 placeholder:text-text-secondary/40"
            />
          </label>
        ) : null}

        {warning ? (
          <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3">
            <p className="text-xs leading-5 text-amber-300">{warning}</p>
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-xl border border-glass-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled || loading}
            className="inline-flex items-center gap-2 rounded-xl border border-red-400/50 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-300 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {loading ? loadingLabel ?? confirmLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RoomSettingsModal({
  roomId,
  roomOwnerType,
  viewerMode,
  viewerRole,
  initialName,
  initialDescription,
  initialRule,
  initialVisibility = "private",
  initialJoinPolicy = "invite_only",
  initialDefaultSend = true,
  initialDefaultInvite = false,
  initialAllowHumanSend = true,
  initialMaxMembers = null,
  initialSlowModeSeconds = null,
  initialSubscriptionProductId = null,
  onClose,
}: RoomSettingsModalProps) {
  const locale = useLanguage();
  const t = roomSettingsModal[locale];
  const ta = roomAdvancedSettings[locale];
  const tm = agentBrowser[locale];
  const refreshOverview = useDashboardChatStore((s) => s.refreshOverview);
  const leaveRoom = useDashboardChatStore((s) => s.leaveRoom);
  const leavingRoomId = useDashboardChatStore((s) => s.leavingRoomId);
  const refreshHumanRooms = useDashboardSessionStore((s) => s.refreshHumanRooms);
  const humanId = useDashboardSessionStore((s) => s.human?.human_id ?? null);
  const getActiveSubscription = useDashboardSubscriptionStore((s) => s.getActiveSubscription);
  const ensureSubscriptions = useDashboardSubscriptionStore((s) => s.ensureSubscriptions);
  const cancelSubscription = useDashboardSubscriptionStore((s) => s.cancelSubscription);
  const upsertRoomPlan = useDashboardSubscriptionStore((s) => s.upsertRoomPlan);
  const setFocusedRoomId = useDashboardUIStore((s) => s.setFocusedRoomId);
  const setOpenedRoomId = useDashboardUIStore((s) => s.setOpenedRoomId);

  const canEditBasics = viewerRole === "owner" || viewerRole === "admin";
  const isOwner = viewerRole === "owner";
  const isLeaving = leavingRoomId === roomId;
  const activeSubscription = initialSubscriptionProductId
    ? getActiveSubscription(initialSubscriptionProductId)
    : null;

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [rule, setRule] = useState(initialRule);
  const [visibility, setVisibility] = useState(initialVisibility);
  const [joinPolicy, setJoinPolicy] = useState(initialJoinPolicy);
  const [defaultSend, setDefaultSend] = useState(initialDefaultSend);
  const [defaultInvite, setDefaultInvite] = useState(initialDefaultInvite);
  const canManageMembers =
    isOwner || viewerRole === "admin" || (Boolean(viewerRole) && defaultInvite);
  const [allowHumanSend, setAllowHumanSend] = useState(initialAllowHumanSend);
  const [maxMembers, setMaxMembers] = useState(
    initialMaxMembers == null ? "" : String(initialMaxMembers),
  );
  const [slowMode, setSlowMode] = useState(
    initialSlowModeSeconds == null ? "" : String(initialSlowModeSeconds),
  );
  const [subscriptionProductId, setSubscriptionProductId] = useState(
    initialSubscriptionProductId ?? "",
  );
  const [subscriptionEnabled, setSubscriptionEnabled] = useState(Boolean(initialSubscriptionProductId));
  const [ownedProducts, setOwnedProducts] = useState<SubscriptionProduct[]>([]);
  // Provider agent for human-owned rooms. Required when (re)creating the
  // room's subscription product because the room owner is a Human and the
  // wallet receiver must be one of the user's active bots.
  const isHumanOwnedRoom = roomOwnerType === "human";
  const [providerAgentId, setProviderAgentId] = useState<string>("");
  const [ownedAgents, setOwnedAgents] = useState<UserAgent[]>([]);
  const [subscriptionProduct, setSubscriptionProduct] = useState<SubscriptionProduct | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);
  const [priceInput, setPriceInput] = useState("");
  const [billingInterval, setBillingInterval] = useState<"week" | "month">("month");
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const [multiRoomBlocked, setMultiRoomBlocked] = useState(false);
  const [planChangeDialogOpen, setPlanChangeDialogOpen] = useState(false);
  const [planChangeAffected, setPlanChangeAffected] = useState(0);
  const [planChangeBusy, setPlanChangeBusy] = useState(false);
  const [members, setMembers] = useState<PublicRoomMember[]>([]);
  const [memberQuery, setMemberQuery] = useState("");
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [dissolveDialogOpen, setDissolveDialogOpen] = useState(false);
  const [dissolveConfirmText, setDissolveConfirmText] = useState("");
  const [cancellingSubscription, setCancellingSubscription] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupInitial = name.trim().charAt(0).toUpperCase() || "G";
  const persistedRoomName = initialName.trim();
  const dissolveConfirmArmed = dissolveConfirmText.trim() === persistedRoomName;
  const filteredMembers = useMemo(() => {
    const query = memberQuery.trim().toLowerCase();
    if (!query) return members;
    return members.filter((member) =>
      member.display_name.toLowerCase().includes(query)
      || member.agent_id.toLowerCase().includes(query)
      || member.role.toLowerCase().includes(query),
    );
  }, [memberQuery, members]);
  const availableProduct = ownedProducts.find((product) => product.status === "active") ?? ownedProducts[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    async function loadMembers() {
      setMembersLoading(true);
      setMembersError(null);
      try {
        const result = await api.getRoomMembers(roomId).catch(() => api.getPublicRoomMembers(roomId));
        if (cancelled) return;
        setMembers(result.members);
      } catch {
        if (cancelled) return;
        setMembers([]);
        setMembersError(tm.loadMembersFailed);
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    }
    void loadMembers();
    return () => {
      cancelled = true;
    };
  }, [roomId, tm.loadMembersFailed]);

  useEffect(() => {
    if (!initialSubscriptionProductId) return;
    void ensureSubscriptions().catch(() => {});
  }, [ensureSubscriptions, initialSubscriptionProductId]);

  // Human-owned rooms need an explicit provider agent for migrate-plan.
  // Load the user's bots once when the modal opens and seed the dropdown.
  useEffect(() => {
    if (!isHumanOwnedRoom || !isOwner) return;
    let cancelled = false;
    void userApi.getMyAgents().then(({ agents }) => {
      if (cancelled) return;
      setOwnedAgents(agents);
      // Default to the current product's provider if known, else first agent.
      setProviderAgentId((prev) => {
        if (prev && agents.some((a) => a.agent_id === prev)) return prev;
        return agents[0]?.agent_id ?? "";
      });
    }).catch(() => {
      if (!cancelled) setOwnedAgents([]);
    });
    return () => {
      cancelled = true;
    };
  }, [isHumanOwnedRoom, isOwner]);

  // When the subscription product loads, prefer its provider as the default.
  useEffect(() => {
    if (!isHumanOwnedRoom) return;
    if (!subscriptionProduct?.provider_agent_id) return;
    setProviderAgentId(subscriptionProduct.provider_agent_id);
  }, [isHumanOwnedRoom, subscriptionProduct?.provider_agent_id]);

  useEffect(() => {
    let cancelled = false;
    async function loadSubscriptionContext() {
      setSubscriptionLoading(true);
      try {
        const tasks: Array<Promise<unknown>> = [];
        if (isOwner) {
          tasks.push(api.getMySubscriptionProducts());
        } else {
          tasks.push(Promise.resolve({ products: [] }));
        }
        if (subscriptionProductId) {
          tasks.push(api.getSubscriptionProduct(subscriptionProductId));
        } else {
          tasks.push(Promise.resolve(null));
        }
        const [productsResult, productResult] = await Promise.all(tasks);
        if (cancelled) return;
        const myProducts = "products" in (productsResult as { products: SubscriptionProduct[] })
          ? (productsResult as { products: SubscriptionProduct[] }).products
          : [];
        setOwnedProducts(myProducts);
        let product: SubscriptionProduct | null = null;
        if (productResult && "product" in (productResult as { product: SubscriptionProduct })) {
          product = (productResult as { product: SubscriptionProduct }).product;
        }
        setSubscriptionProduct(product);
        if (product) {
          const major = Number(product.amount_minor) / 100;
          setPriceInput(Number.isFinite(major) ? major.toFixed(2) : "");
          if (product.billing_interval === "week" || product.billing_interval === "month") {
            setBillingInterval(product.billing_interval);
          }
        }
        // Multi-room reuse detection: count rooms whose
        // `required_subscription_product_id` matches the current product.
        if (product && isOwner) {
          try {
            const overview = await api.getOverview();
            const refCount = (overview.rooms ?? []).filter(
              (r) => r.required_subscription_product_id === product.product_id,
            ).length;
            if (!cancelled) setMultiRoomBlocked(refCount > 1);
          } catch {
            if (!cancelled) setMultiRoomBlocked(false);
          }
        } else if (!cancelled) {
          setMultiRoomBlocked(false);
        }
        // Subscriber count for confirm dialog and current display.
        if (product && isOwner) {
          try {
            const subs = await api.listProductSubscribers(product.product_id, {
              status: "active,past_due",
            });
            if (!cancelled) setSubscriberCount(subs.subscribers.length);
          } catch {
            if (!cancelled) setSubscriberCount(null);
          }
        } else if (!cancelled) {
          setSubscriberCount(null);
        }
      } catch {
        if (cancelled) return;
        setOwnedProducts([]);
        setSubscriptionProduct(null);
        setSubscriberCount(null);
        setMultiRoomBlocked(false);
      } finally {
        if (!cancelled) setSubscriptionLoading(false);
      }
    }
    void loadSubscriptionContext();
    return () => {
      cancelled = true;
    };
  }, [isOwner, subscriptionProductId]);

  async function refreshRoomDetails() {
    const result = await api.getRoomMembers(roomId).catch(() => api.getPublicRoomMembers(roomId));
    setMembers(result.members);
    await Promise.all([
      refreshOverview({ reloadOpenedRoom: true }),
      refreshHumanRooms(),
    ]);
  }

  const handleRemoveMember = useCallback(async (agentId: string) => {
    setRemovingId(agentId);
    try {
      await humansApi.removeRoomMember(roomId, agentId);
      await refreshRoomDetails();
    } catch (e: any) {
      setError(e?.message || "Failed to remove member");
    } finally {
      setRemovingId(null);
      setConfirmRemoveId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const handleSave = async () => {
    if (!canEditBasics) {
      onClose();
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t.nameRequired);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const patch: Parameters<typeof api.updateRoomSettings>[1] = {};
      if (trimmedName !== initialName) patch.name = trimmedName;
      if (description !== initialDescription) patch.description = description;
      if (rule !== initialRule) patch.rule = rule.trim() ? rule : null;
      if (isOwner) {
        if (visibility !== initialVisibility) patch.visibility = visibility as "public" | "private";
        if (joinPolicy !== initialJoinPolicy) patch.join_policy = joinPolicy as "open" | "invite_only";
        if (defaultSend !== initialDefaultSend) patch.default_send = defaultSend;
        if (defaultInvite !== initialDefaultInvite) patch.default_invite = defaultInvite;
        if (allowHumanSend !== initialAllowHumanSend) patch.allow_human_send = allowHumanSend;
        const nextMax = maxMembers ? Number(maxMembers) : null;
        if (nextMax !== initialMaxMembers) patch.max_members = nextMax;
        const nextSlow = slowMode ? Number(slowMode) : null;
        if (nextSlow !== initialSlowModeSeconds) patch.slow_mode_seconds = nextSlow;
        // Subscription handling is split into a separate write below, so the
        // PATCH only carries non-subscription fields here.
      }
      if (Object.keys(patch).length > 0) {
        const updater = viewerMode === "human" ? humansApi.updateRoomSettings : api.updateRoomSettings;
        await updater(roomId, patch);
        await Promise.all([
          refreshOverview({ reloadOpenedRoom: true }),
          refreshHumanRooms(),
        ]);
      }

      if (isOwner) {
        const subscriptionResult = await applySubscriptionChange();
        if (subscriptionResult === "deferred") {
          // Plan change confirm dialog is open; keep modal mounted.
          setSaving(false);
          return;
        }
        if (subscriptionResult === "blocked") {
          setSaving(false);
          return;
        }
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  // Returns one of:
  //   "noop"     — nothing changed
  //   "applied"  — wrote the change immediately
  //   "deferred" — opened the plan-change confirm dialog
  //   "blocked"  — user-visible error already set
  async function applySubscriptionChange(): Promise<
    "noop" | "applied" | "deferred" | "blocked"
  > {
    if (!isOwner) return "noop";

    // Toggle off → unbind product on the room (mismatch will cancel old subs).
    if (!subscriptionEnabled) {
      if (!initialSubscriptionProductId) return "noop";
      await api.updateRoomSettings(roomId, {
        required_subscription_product_id: null,
      });
      await refreshOverview({ reloadOpenedRoom: true });
      return "applied";
    }

    if (multiRoomBlocked) {
      setError(ta.subscriptionMultiRoomBlock);
      return "blocked";
    }

    const priceMajor = Number(priceInput);
    if (!Number.isFinite(priceMajor) || priceMajor <= 0) {
      setError(ta.subscriptionPriceLabel);
      return "blocked";
    }
    const amountMinor = String(Math.round(priceMajor * 100));

    // Human-owned rooms must specify a provider bot; the dashboard human
    // path doesn't send X-Active-Agent so the backend has no implicit fallback.
    if (isHumanOwnedRoom && !providerAgentId) {
      setError(ta.subscriptionProviderRequired ?? "Select a receiving bot");
      return "blocked";
    }

    // Same product, identical price + interval (and provider, when human-owned)
    // → noop. We only short-circuit when a current product exists.
    if (initialSubscriptionProductId && subscriptionProduct) {
      const currentMinor = Number(subscriptionProduct.amount_minor);
      const sameAmount =
        Number.isFinite(currentMinor) && Number(amountMinor) === currentMinor;
      const sameInterval =
        subscriptionProduct.billing_interval === billingInterval;
      const sameProvider =
        !isHumanOwnedRoom || providerAgentId === subscriptionProduct.provider_agent_id;
      if (sameAmount && sameInterval && sameProvider) return "noop";
    }

    // First-time enable: drop the legacy two-step (createProduct + PATCH room)
    // — a single migrate-plan call is atomic and works in both human and
    // agent identity modes.
    if (!initialSubscriptionProductId) {
      await upsertRoomPlan(roomId, {
        amount_minor: amountMinor,
        billing_interval: billingInterval,
        currentProductId: undefined,
        providerAgentId: isHumanOwnedRoom ? providerAgentId : undefined,
      });
      await refreshOverview({ reloadOpenedRoom: true });
      return "applied";
    }

    // Plan change → defer to confirm dialog.
    setPlanChangeAffected(subscriberCount ?? 0);
    setPlanChangeDialogOpen(true);
    return "deferred";
  }

  async function confirmPlanChange() {
    setPlanChangeBusy(true);
    setError(null);
    try {
      const priceMajor = Number(priceInput);
      const amountMinor = String(Math.round(priceMajor * 100));
      await upsertRoomPlan(roomId, {
        amount_minor: amountMinor,
        billing_interval: billingInterval,
        currentProductId: initialSubscriptionProductId ?? undefined,
        providerAgentId: isHumanOwnedRoom ? providerAgentId : undefined,
      });
      await refreshOverview({ reloadOpenedRoom: true });
      setPlanChangeDialogOpen(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveFailed);
    } finally {
      setPlanChangeBusy(false);
    }
  }

  const handleLeave = async () => {
    if (isOwner) return;
    setError(null);
    try {
      await Promise.all([leaveRoom(roomId), refreshHumanRooms()]);
      setLeaveDialogOpen(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tm.leaveRoomFailed);
    }
  };

  const handleCancelSubscription = async () => {
    if (!activeSubscription?.subscription_id) return;
    setError(null);
    setCancellingSubscription(true);
    try {
      await cancelSubscription(activeSubscription.subscription_id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tm.cancelSubscriptionFailed);
    } finally {
      setCancellingSubscription(false);
    }
  };

  const handleDissolve = async () => {
    if (!isOwner || dissolving || !dissolveConfirmArmed) return;
    setError(null);
    setDissolving(true);
    try {
      const dissolve = viewerMode === "human" ? humansApi.dissolveRoom : api.dissolveRoom;
      await dissolve(roomId);
      setDissolveDialogOpen(false);
      setDissolveConfirmText("");
      setFocusedRoomId(null);
      setOpenedRoomId(null);
      await Promise.all([refreshOverview(), refreshHumanRooms()]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.dissolveRoomFailed);
    } finally {
      setDissolving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60" onClick={onClose}>
      <div
        className="ml-auto flex h-full w-full max-w-[520px] flex-col overflow-hidden border-l border-glass-border bg-deep-black shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-glass-border px-6 py-4">
          <h2 className="text-xl font-semibold text-text-primary">{t.title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
            aria-label={t.cancel}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && (
            <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="divide-y divide-glass-border/80">
            <section className="py-5">
              <div className="flex items-start gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-neon-cyan/30 bg-neon-cyan/10 text-2xl font-semibold text-neon-cyan">
                  {groupInitial}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xl font-semibold text-text-primary">{name || initialName}</p>
                  <div className="mt-3 text-xs text-text-secondary/70">
                    <CopyableId value={roomId} />
                  </div>
                </div>
              </div>

              <div className="mt-5 space-y-4 border-t border-glass-border pt-4">
                {canEditBasics ? (
                  <>
                    <div>
                      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                        {t.nameLabel}
                      </label>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={120}
                        className="w-full rounded-xl border border-glass-border bg-glass-bg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                        {t.descriptionLabel}
                      </label>
                      <textarea
                        rows={3}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        maxLength={500}
                        className="w-full resize-none rounded-xl border border-glass-border bg-glass-bg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                        {t.ruleLabel}
                      </label>
                      <p className="mb-1 text-[11px] text-text-secondary/60">{t.ruleHint}</p>
                      <textarea
                        value={rule}
                        onChange={(e) => setRule(e.target.value)}
                        rows={4}
                        maxLength={4000}
                        className="w-full resize-none rounded-xl border border-glass-border bg-glass-bg px-3 py-2.5 text-sm leading-relaxed text-text-primary outline-none focus:border-neon-cyan/50"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                        {t.descriptionLabel}
                      </p>
                      {description ? (
                        <p className="text-sm leading-relaxed text-text-primary/90 whitespace-pre-wrap">{description}</p>
                      ) : (
                        <p className="text-sm text-text-secondary/40">{locale === "zh" ? "暂无描述" : "No description"}</p>
                      )}
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                        {t.ruleLabel}
                      </p>
                      {rule ? (
                        <p className="text-sm leading-relaxed text-text-primary/90 whitespace-pre-wrap">{rule}</p>
                      ) : (
                        <p className="text-sm text-text-secondary/40">{locale === "zh" ? "暂无公告" : "No announcement"}</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="py-5">
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-lg font-semibold text-text-primary">{t.membersSection}</p>
                  <p className="mt-1 text-xs text-text-secondary/70">
                    {filteredMembers.length} {tm.members}
                  </p>
                </div>
                {canManageMembers && (
                  <button
                    type="button"
                    onClick={() => setAddMemberModalOpen(true)}
                    className="rounded-xl border border-neon-cyan/30 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/15"
                  >
                    {tm.addMembersEntry}
                  </button>
                )}
              </div>

              <div className="mt-4 space-y-4">
                <div className="flex items-center gap-2 rounded-xl border border-glass-border bg-glass-bg px-3">
                  <Search className="h-4 w-4 text-text-secondary/70" />
                  <input
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder={tm.searchAddableMembers}
                    className="w-full bg-transparent py-2.5 text-sm text-text-primary outline-none"
                  />
                </div>

                <div className="max-h-72 overflow-y-auto rounded-xl border border-glass-border bg-deep-black/40">
                  {membersLoading ? (
                    <p className="px-4 py-4 text-xs text-text-secondary animate-pulse">{tm.loadingMembers}</p>
                  ) : membersError ? (
                    <p className="px-4 py-4 text-xs text-red-400">{membersError}</p>
                  ) : filteredMembers.length === 0 ? (
                    <p className="px-4 py-4 text-xs text-text-secondary/60">{tm.noMembers}</p>
                  ) : (
                    <div className="divide-y divide-glass-border/70">
                      {filteredMembers.map((member) => {
                        const participantType = member.participant_type
                          ?? (member.agent_id.startsWith("hu_") ? "human" : "agent");
                        const isSelf = viewerMode === "human" && member.agent_id === humanId;
                        return (
                          <div
                            key={member.agent_id}
                            className="flex items-center justify-between gap-3 px-4 py-3"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-text-primary">
                                  {member.display_name}
                                </span>
                                <span
                                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                    participantType === "human"
                                      ? "bg-neon-green/10 text-neon-green"
                                      : "bg-neon-cyan/10 text-neon-cyan"
                                  }`}
                                >
                                  {participantType === "human" ? "H" : "A"}
                                </span>
                                <span className={`shrink-0 rounded border px-1.5 py-px text-[9px] font-medium ${
                                  member.role === "owner"
                                    ? "border-neon-cyan/30 text-neon-cyan"
                                    : member.role === "admin"
                                      ? "border-neon-purple/30 text-neon-purple"
                                      : "border-glass-border text-text-secondary"
                                }`}>
                                  {member.role}
                                </span>
                              </div>
                              <div className="mt-1 text-[11px] text-text-secondary/70">
                                <CopyableId value={member.agent_id} />
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {canManageMembers && !isSelf && member.role !== "owner" && (
                                confirmRemoveId === member.agent_id ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmRemoveId(null)}
                                      className="rounded px-2 py-1 text-[11px] text-text-secondary hover:bg-glass-bg transition-colors"
                                    >
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      disabled={removingId === member.agent_id}
                                      onClick={() => void handleRemoveMember(member.agent_id)}
                                      className="rounded bg-red-500/15 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/25 disabled:opacity-50 transition-colors"
                                    >
                                      {removingId === member.agent_id ? "…" : "确认移除"}
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmRemoveId(member.agent_id)}
                                    className="rounded p-1.5 text-text-secondary/50 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                                    title="移除成员"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )
                              )}
                              {canManageMembers && !isSelf && (
                                <MemberActionsMenu
                                  roomId={roomId}
                                  member={member}
                                  viewerRole={viewerRole ?? "member"}
                                  onMutated={() => { void refreshRoomDetails(); }}
                                  onError={(msg) => setError(msg)}
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="py-5">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="flex w-full items-center justify-between py-1 text-left"
              >
                <div>
                  <p className="text-lg font-semibold text-text-primary">{ta.sectionTitle}</p>
                  {!advancedOpen && (
                    <p className="mt-1 text-xs text-text-secondary/70">{ta.sectionHint}</p>
                  )}
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-text-secondary transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                />
              </button>
              {advancedOpen && (
                <div className="mt-4 space-y-4 border-t border-glass-border pt-4">
                  {!isOwner && (
                    <p className="text-[11px] text-text-secondary/70">{ta.ownerOnly}</p>
                  )}
                  <div className="grid gap-4">
                    <label className="block">
                      <span className="mb-1.5 block text-xs text-text-secondary">{ta.visibilityLabel}</span>
                      <select
                        disabled={!isOwner}
                        value={visibility}
                        onChange={(e) => setVisibility(e.target.value)}
                        className="w-full rounded-xl border border-glass-border bg-glass-bg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan/60 disabled:opacity-60"
                      >
                        <option value="private">{ta.visibilityPrivate}</option>
                        <option value="public">{ta.visibilityPublic}</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs text-text-secondary">{ta.joinPolicyLabel}</span>
                      <select
                        disabled={!isOwner}
                        value={joinPolicy}
                        onChange={(e) => setJoinPolicy(e.target.value)}
                        className="w-full rounded-xl border border-glass-border bg-glass-bg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan/60 disabled:opacity-60"
                      >
                        <option value="invite_only">{ta.joinPolicyInviteOnly}</option>
                        <option value="open">{ta.joinPolicyOpen}</option>
                      </select>
                    </label>
                  </div>
                  <div className="grid gap-3">
                    <label className="flex items-center gap-2 rounded-xl border border-glass-border bg-glass-bg px-3 py-3 text-xs text-text-secondary">
                      <input
                        type="checkbox"
                        disabled={!isOwner}
                        checked={defaultSend}
                        onChange={(e) => setDefaultSend(e.target.checked)}
                        className="accent-neon-cyan"
                      />
                      {ta.defaultSendLabel}
                    </label>
                    <label className="flex items-center gap-2 rounded-xl border border-glass-border bg-glass-bg px-3 py-3 text-xs text-text-secondary">
                      <input
                        type="checkbox"
                        disabled={!isOwner}
                        checked={defaultInvite}
                        onChange={(e) => setDefaultInvite(e.target.checked)}
                        className="accent-neon-cyan"
                      />
                      {ta.defaultInviteLabel}
                    </label>
                    <label className="flex items-center gap-2 rounded-xl border border-glass-border bg-glass-bg px-3 py-3 text-xs text-text-secondary">
                      <input
                        type="checkbox"
                        disabled={!isOwner}
                        checked={allowHumanSend}
                        onChange={(e) => setAllowHumanSend(e.target.checked)}
                        className="accent-neon-cyan"
                      />
                      {ta.allowHumanSendLabel}
                    </label>
                  </div>
                </div>
              )}
            </section>

            <section className="py-5">
              <button
                type="button"
                onClick={() => setSubscriptionOpen((v) => !v)}
                className="flex w-full items-center justify-between py-1 text-left"
              >
                <div>
                  <p className="text-lg font-semibold text-text-primary">{ta.subscriptionSection}</p>
                  {!subscriptionOpen && (
                    <p className="mt-1 text-xs text-text-secondary/70">{ta.subscriptionHint}</p>
                  )}
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-text-secondary transition-transform ${subscriptionOpen ? "rotate-180" : ""}`}
                />
              </button>
              {subscriptionOpen && (
                <div className="mt-4 space-y-3 border-t border-glass-border pt-4">
                  {!isOwner && (
                    <p className="text-[11px] text-text-secondary/70">{ta.ownerOnly}</p>
                  )}
                  <div className="flex items-center justify-between gap-4 rounded-xl border border-glass-border bg-glass-bg px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{ta.subscriptionToggleLabel}</p>
                      <p className="mt-1 text-xs text-text-secondary/70">
                        {subscriptionEnabled ? ta.subscriptionEnabledHint : ta.subscriptionDisabledHint}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!isOwner || multiRoomBlocked}
                      onClick={() => setSubscriptionEnabled((v) => !v)}
                      className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${subscriptionEnabled ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan" : "border-glass-border text-text-secondary hover:bg-glass-bg"}`}
                    >
                      {subscriptionEnabled ? ta.subscriptionToggleOn : ta.subscriptionToggleOff}
                    </button>
                  </div>

                  {multiRoomBlocked && (
                    <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
                      {ta.subscriptionMultiRoomBlock}
                    </p>
                  )}

                  {subscriptionEnabled && isOwner && (
                    <div className="space-y-3 rounded-xl border border-glass-border bg-deep-black/40 px-4 py-3">
                      <div className="flex items-center gap-3">
                        <label className="text-sm text-text-primary">
                          {ta.subscriptionPriceLabel}
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          disabled={multiRoomBlocked}
                          placeholder={ta.subscriptionPricePlaceholder}
                          value={priceInput}
                          onChange={(e) => setPriceInput(e.target.value)}
                          className="w-28 rounded-lg border border-glass-border bg-deep-black px-2 py-1 text-sm text-text-primary"
                        />
                        <span className="text-xs text-text-secondary/80">USDC</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <label className="text-sm text-text-primary">
                          {ta.subscriptionBillingLabel}
                        </label>
                        <label className="flex items-center gap-1.5 text-sm text-text-secondary">
                          <input
                            type="radio"
                            name="billing-interval"
                            value="week"
                            checked={billingInterval === "week"}
                            onChange={() => setBillingInterval("week")}
                            disabled={multiRoomBlocked}
                            className="accent-neon-cyan"
                          />
                          {ta.subscriptionWeekly}
                        </label>
                        <label className="flex items-center gap-1.5 text-sm text-text-secondary">
                          <input
                            type="radio"
                            name="billing-interval"
                            value="month"
                            checked={billingInterval === "month"}
                            onChange={() => setBillingInterval("month")}
                            disabled={multiRoomBlocked}
                            className="accent-neon-cyan"
                          />
                          {ta.subscriptionMonthly}
                        </label>
                      </div>
                      {isHumanOwnedRoom && (
                        <div className="flex items-center gap-3">
                          <label className="text-sm text-text-primary">
                            {ta.subscriptionProviderLabel ?? "Receiving bot"}
                          </label>
                          <select
                            value={providerAgentId}
                            onChange={(e) => setProviderAgentId(e.target.value)}
                            disabled={multiRoomBlocked || ownedAgents.length === 0}
                            className="rounded-lg border border-glass-border bg-deep-black px-2 py-1 text-sm text-text-primary"
                          >
                            {ownedAgents.length === 0 && (
                              <option value="">
                                {ta.subscriptionProviderEmpty ?? "No bots available"}
                              </option>
                            )}
                            {ownedAgents.map((agent) => (
                              <option key={agent.agent_id} value={agent.agent_id}>
                                {agent.display_name} ({agent.agent_id})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      {subscriberCount !== null && (
                        <p className="text-xs text-text-secondary/80">
                          {ta.subscriptionCurrentSubscribers}: {subscriberCount}
                        </p>
                      )}
                      {!initialSubscriptionProductId && (
                        <p className="text-xs text-text-secondary/70">
                          {ta.subscriptionGrandfatherHint}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            {(viewerRole || isOwner) && <section className="py-5">
              <div>
                <p className="text-lg font-semibold text-text-primary">{t.actionsSection}</p>
              </div>

              <div className="mt-4 space-y-3">
                {!isOwner && viewerRole && (
                  <div className="flex items-center justify-between gap-4 border-t border-glass-border/80 py-3 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{tm.leaveRoom}</p>
                      <p className="mt-1 text-xs text-text-secondary/70">
                        {t.leaveRoomDescription}
                      </p>
                    </div>
                    <button
                      onClick={() => setLeaveDialogOpen(true)}
                      disabled={isLeaving}
                      className="shrink-0 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {isLeaving ? tm.leavingRoom : tm.leaveRoom}
                    </button>
                  </div>
                )}
                {activeSubscription ? (
                  <div className="flex items-center justify-between gap-4 border-t border-glass-border/80 py-3 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{tm.cancelSubscription}</p>
                      <p className="mt-1 text-xs text-text-secondary/70">{ta.subscriptionHint}</p>
                    </div>
                    <button
                      onClick={() => void handleCancelSubscription()}
                      disabled={cancellingSubscription}
                      className="shrink-0 rounded-lg border border-yellow-500/30 px-3 py-1.5 text-xs font-medium text-yellow-300 transition-colors hover:bg-yellow-500/10 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {cancellingSubscription ? tm.cancellingSubscription : tm.cancelSubscription}
                    </button>
                  </div>
                ) : null}
                {canManageMembers && isOwner && humanId && (
                  <div className="flex items-center justify-between gap-4 border-t border-glass-border/80 py-3 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{tm.transferOwnership}</p>
                      <p className="mt-1 text-xs text-text-secondary/70">{tm.ownerCannotLeave}</p>
                    </div>
                    <button
                      onClick={() => setTransferDialogOpen(true)}
                      className="shrink-0 rounded-lg border border-neon-purple/30 px-3 py-1.5 text-xs font-medium text-neon-purple transition-colors hover:bg-neon-purple/10"
                    >
                      {tm.transferOwnership}
                    </button>
                  </div>
                )}
                {isOwner && (
                  <div className="flex items-center justify-between gap-4 border-t border-red-500/20 py-3 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-red-200">{t.dissolveRoom}</p>
                      <p className="mt-1 text-xs text-red-200/70">{t.dissolveRoomDescription}</p>
                    </div>
                    <button
                      onClick={() => {
                        setDissolveConfirmText("");
                        setDissolveDialogOpen(true);
                      }}
                      disabled={dissolving}
                      className="shrink-0 rounded-lg border border-red-500/35 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {dissolving ? t.dissolvingRoom : t.dissolveRoom}
                    </button>
                  </div>
                )}
              </div>
            </section>}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-glass-border px-6 py-4">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-glass-border px-4 py-2.5 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            {t.cancel}
          </button>
          {canEditBasics && (
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2.5 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? t.saving : t.save}
            </button>
          )}
        </div>
      </div>

      {addMemberModalOpen && canManageMembers && (
        <AddRoomMemberModal
          roomId={roomId}
          existingMemberIds={members.map((member) => member.agent_id)}
          onClose={() => setAddMemberModalOpen(false)}
          onAdded={refreshRoomDetails}
        />
      )}

      {transferDialogOpen && canManageMembers && isOwner && humanId && (
        <TransferOwnershipDialog
          roomId={roomId}
          roomName={initialName}
          viewerHumanId={humanId}
          members={members}
          onClose={() => setTransferDialogOpen(false)}
          onSuccess={() => {
            void refreshRoomDetails();
          }}
          onError={(msg) => setError(msg)}
        />
      )}

      {leaveDialogOpen && !isOwner && (
        <ActionConfirmDialog
          title={t.leaveRoomConfirmTitle}
          description={t.leaveRoomConfirmDescription}
          warning={t.leaveRoomWarning}
          confirmLabel={tm.leaveRoom}
          cancelLabel={t.cancel}
          confirmDisabled={isLeaving}
          loading={isLeaving}
          loadingLabel={tm.leavingRoom}
          onClose={() => setLeaveDialogOpen(false)}
          onConfirm={() => {
            void handleLeave();
          }}
        />
      )}

      {planChangeDialogOpen && isOwner && (
        <PlanChangeConfirmDialog
          fromLabel={
            subscriptionProduct
              ? `${(Number(subscriptionProduct.amount_minor) / 100).toFixed(2)} USDC / ${subscriptionProduct.billing_interval}`
              : "—"
          }
          toLabel={`${Number(priceInput).toFixed(2)} USDC / ${billingInterval}`}
          affectedCount={planChangeAffected}
          loading={planChangeBusy}
          onClose={() => {
            if (planChangeBusy) return;
            setPlanChangeDialogOpen(false);
          }}
          onConfirm={() => {
            void confirmPlanChange();
          }}
        />
      )}

      {dissolveDialogOpen && isOwner && (
        <ActionConfirmDialog
          title={t.dissolveRoomConfirmTitle}
          description={t.dissolveRoomConfirmDescription}
          warning={t.dissolveRoomWarning}
          confirmLabel={t.dissolveRoom}
          cancelLabel={t.cancel}
          confirmTextLabel={t.confirmRoomNameLabel.replace("{room}", persistedRoomName)}
          confirmPlaceholder={persistedRoomName}
          confirmValue={dissolveConfirmText}
          onConfirmValueChange={setDissolveConfirmText}
          confirmDisabled={!dissolveConfirmArmed || dissolving}
          loading={dissolving}
          loadingLabel={t.dissolvingRoom}
          onClose={() => {
            if (dissolving) return;
            setDissolveDialogOpen(false);
            setDissolveConfirmText("");
          }}
          onConfirm={() => {
            void handleDissolve();
          }}
        />
      )}
    </div>
  );
}
