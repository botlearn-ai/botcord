"use client";
import Avatar from "@/components/ui/Avatar";
import Field from "@/components/ui/Field";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";

import Radio from "@/components/ui/Radio";
import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, Search, Trash2, X } from "lucide-react";
import { useRouter } from "nextjs-toploader/app";
import CopyableId from "@/components/ui/CopyableId";
import { MobileBotCordLoading } from "@/components/ui/BotCordLoader";
import { api, humansApi, userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import {
  agentBrowser,
  roomAdvancedSettings,
  roomSettingsModal,
} from "@/lib/i18n/translations/dashboard";
import type { ParticipantType, PublicRoomMember, SubscriptionProduct, UserAgent } from "@/lib/types";
import AddRoomMemberModal from "./AddRoomMemberModal";
import RoomPolicyModal from "./RoomPolicyModal";
import MemberActionsMenu from "./MemberActionsMenu";
import PlanChangeConfirmDialog from "./PlanChangeConfirmDialog";
import TransferOwnershipDialog from "./TransferOwnershipDialog";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import DashboardSelect from "./DashboardSelect";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";

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
    <DialogSurface onClose={onClose} title={<>{title}</>} overlayClassName="z-[70]" className="max-w-md p-5">
        <IconButton label={cancelLabel}
          type="button"
          onClick={onClose}
          disabled={loading}
          className="absolute right-4"
          aria-label={cancelLabel}
        >
          <X className="h-5 w-5" />
        </IconButton>

        <div className="pr-8">
          <h3 className="text-xl font-semibold text-text-primary">{title}</h3>
          <p className="mt-2 text-sm text-text-secondary">{description}</p>
        </div>

        {confirmTextLabel ? (
          <Field label={<>{confirmTextLabel}</>} className="mt-5 block">

            <Input
              type="text"
              value={confirmValue}
              onChange={(e) => onConfirmValueChange?.(e.target.value)}
              placeholder={confirmPlaceholder}
              className="w-full"
            />
          </Field>
        ) : null}

        {warning ? (
          <div className="mt-4 rounded-xl border border-warning/20 bg-warning-soft p-3">
            <p className="text-xs leading-5 text-warning">{warning}</p>
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button variant="secondary"
            type="button"
            onClick={onClose}
            disabled={loading}

          >
            {cancelLabel}
          </Button>
          <Button variant="danger"
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled || loading}

          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {loading ? loadingLabel ?? confirmLabel : confirmLabel}
          </Button>
        </div>
      </DialogSurface>
  );
}

function formatWholeCoinAmount(amountMinor: string | number): string {
  const coins = Number(amountMinor) / 100;
  if (!Number.isFinite(coins)) return "";
  return Number.isInteger(coins) ? String(coins) : String(coins);
}

const PortaledActionConfirmDialog = withDashboardOverlayPortal(ActionConfirmDialog, "nested");

export default withDashboardOverlayPortal(RoomSettingsModal);

function RoomSettingsModal({
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
  const router = useRouter();
  const locale = useLanguage();
  const t = roomSettingsModal[locale];
  const ta = roomAdvancedSettings[locale];
  const tm = agentBrowser[locale];
  const refreshOverview = useDashboardChatStore((s) => s.refreshOverview);
  const bumpRoomMembersVersion = useDashboardChatStore((s) => s.bumpRoomMembersVersion);
  const leaveRoom = useDashboardChatStore((s) => s.leaveRoom);
  const leavingRoomId = useDashboardChatStore((s) => s.leavingRoomId);
  const refreshHumanRooms = useDashboardSessionStore((s) => s.refreshHumanRooms);
  const humanId = useDashboardSessionStore((s) => s.human?.human_id ?? null);
  const sessionOwnedAgents = useDashboardSessionStore((s) => s.ownedAgents);
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
  const [showPolicyModal, setShowPolicyModal] = useState(false);
  const [policyAgentId, setPolicyAgentId] = useState("");
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [dissolveDialogOpen, setDissolveDialogOpen] = useState(false);
  const [dissolveConfirmText, setDissolveConfirmText] = useState("");
  const [cancellingSubscription, setCancellingSubscription] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const motionRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const closingRef = useRef(false);
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
  const roomMemberIds = useMemo(
    () => new Set(members.map((member) => member.agent_id)),
    [members],
  );
  const roomOwnedAgents = useMemo(
    () => sessionOwnedAgents.filter((agent) => roomMemberIds.has(agent.agent_id)),
    [roomMemberIds, sessionOwnedAgents],
  );
  const selectedPolicyAgent = roomOwnedAgents.find((agent) => agent.agent_id === policyAgentId) ?? null;

  const closeWithAnimation = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    cleanupAnime(motionRef.current);
    motionRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      direction: "right",
      contentSelector: "[data-overlay-section]",
      onComplete: onClose,
    });
  }, [onClose]);

  useEffect(() => {
    motionRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; },
      direction: "right",
      contentSelector: "[data-overlay-section]",
    });
    return () => cleanupAnime(motionRef.current);
  }, []);

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
    setPolicyAgentId((current) => {
      if (current && roomOwnedAgents.some((agent) => agent.agent_id === current)) {
        return current;
      }
      return roomOwnedAgents[0]?.agent_id ?? "";
    });
  }, [roomOwnedAgents]);

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
          setPriceInput(formatWholeCoinAmount(product.amount_minor));
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
    bumpRoomMembersVersion(roomId);
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

    const priceCoins = Number(priceInput);
    if (!Number.isFinite(priceCoins) || !Number.isInteger(priceCoins) || priceCoins < 1) {
      setError(locale === "zh" ? "价格必须是不小于 1 的整数 Coin" : "Price must be a whole number of at least 1 Coin");
      return "blocked";
    }
    const amountMinor = String(priceCoins * 100);

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
      const priceCoins = Number(priceInput);
      if (!Number.isFinite(priceCoins) || !Number.isInteger(priceCoins) || priceCoins < 1) {
        setError(locale === "zh" ? "价格必须是不小于 1 的整数 Coin" : "Price must be a whole number of at least 1 Coin");
        return;
      }
      const amountMinor = String(priceCoins * 100);
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
      router.push("/chats/messages");
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
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithAnimation} title={<>{t.title}</>} placement="right" busy={closingRef.current} overlayClassName="z-50" className="max-w-[520px] overflow-hidden">
        <div className="flex items-center justify-between border-b border-glass-border px-6 py-4">
          <h2 id="room-settings-title" className="text-xl font-semibold text-text-primary">{t.title}</h2>
          <IconButton label={t.cancel}
            type="button"
            onClick={closeWithAnimation}

            aria-label={t.cancel}
          >
            <X className="h-5 w-5" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && (
            <Alert tone="danger" className="mb-4">
              {error}
            </Alert>
          )}

          <div className="divide-y divide-glass-border/80">
            <section className="py-5" data-overlay-section>
              <div className="flex items-start gap-4">
                <Avatar kind="room" id={roomId} name={name || initialName} size="xl" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xl font-semibold text-text-primary">{name || initialName}</p>
                  <div className="mt-3 text-xs text-text-secondary">
                    <CopyableId value={roomId} />
                  </div>
                </div>
              </div>

              <div className="mt-5 space-y-4 border-t border-glass-border pt-4">
                {canEditBasics ? (
                  <>
                    <Field label={<>{t.nameLabel}</>}>

                      <Input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={120}
                        className="w-full"
                      />
                    </Field>
                    <Field label={<>{t.descriptionLabel}</>}>

                      <Textarea
                        rows={3}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        maxLength={500}
                        className="w-full"
                      />
                    </Field>
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-text-secondary">
                        {t.ruleLabel}
                      </label>
                      <p className="mb-1 text-xs text-text-secondary">{t.ruleHint}</p>
                      <Textarea
                        value={rule}
                        onChange={(e) => setRule(e.target.value)}
                        rows={4}
                        maxLength={4000}
                        className="w-full"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <p className="mb-1 text-xs font-semibold text-text-secondary">
                        {t.descriptionLabel}
                      </p>
                      {description ? (
                        <p className="text-sm leading-relaxed text-text-primary/90 whitespace-pre-wrap">{description}</p>
                      ) : (
                        <p className="text-sm text-text-secondary">{locale === "zh" ? "暂无描述" : "No description"}</p>
                      )}
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-semibold text-text-secondary">
                        {t.ruleLabel}
                      </p>
                      {rule ? (
                        <p className="text-sm leading-relaxed text-text-primary/90 whitespace-pre-wrap">{rule}</p>
                      ) : (
                        <p className="text-sm text-text-secondary">{locale === "zh" ? "暂无公告" : "No announcement"}</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="py-5" data-overlay-section>
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-lg font-semibold text-text-primary">{t.membersSection}</p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {filteredMembers.length} {tm.members}
                  </p>
                </div>
                {canManageMembers && (
                  <Button variant="primary"
                    type="button"
                    onClick={() => setAddMemberModalOpen(true)}

                  >
                    {tm.addMembersEntry}
                  </Button>
                )}
              </div>

              <div className="mt-4 space-y-4">
                <div className="liquid-input flex items-center gap-2 rounded-xl border px-3">
                  <Search className="h-4 w-4 text-text-secondary" />
                  <Input
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder={tm.searchAddableMembers}
                    className="w-full"
                  />
                </div>

                <Card padding="none" className="max-h-72 overflow-y-auto">
                  {membersLoading ? (
                    <MobileBotCordLoading
                      label={tm.loadingMembers}
                      className="px-4 py-4 justify-start"
                      textClassName="text-xs text-text-secondary "
                    />
                  ) : membersError ? (
                    <Alert tone="danger" >{membersError}</Alert>
                  ) : filteredMembers.length === 0 ? (
                    <p className="px-4 py-4 text-xs text-text-secondary">{tm.noMembers}</p>
                  ) : (
                    <div className="divide-y divide-glass-border/70">
                      {filteredMembers.map((member) => {
                        const participantType = member.participant_type
                          ?? (member.agent_id.startsWith("hu_") ? "human" : "agent");
                        const isSelf = viewerMode === "human" && member.agent_id === humanId;
                        return (
                          <div
                            key={member.agent_id}
                            className="liquid-list-row flex items-center justify-between gap-3 px-4 py-3"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-text-primary">
                                  {member.display_name}
                                </span>
                                <span
                                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                                    participantType === "human"
                                      ? "bg-neon-green/10 text-neon-green"
                                      : "bg-neon-cyan/10 text-neon-cyan"
                                  }`}
                                >
                                  {participantType === "human" ? "H" : "A"}
                                </span>
                                <span className={`shrink-0 rounded border px-1.5 py-px text-xs font-medium ${
                                  member.role === "owner"
                                    ? "border-neon-cyan/30 text-neon-cyan"
                                    : member.role === "admin"
                                      ? "border-neon-cyan/30 text-neon-cyan"
                                      : "border-glass-border text-text-secondary"
                                }`}>
                                  {member.role}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-text-secondary">
                                <CopyableId value={member.agent_id} />
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {isOwner && !isSelf && member.role !== "owner" && (
                                confirmRemoveId === member.agent_id ? (
                                  <>
                                    <Button variant="secondary"
                                      type="button"
                                      onClick={() => setConfirmRemoveId(null)}

                                    >
                                      取消
                                    </Button>
                                    <Button variant="danger"
                                      type="button"
                                      disabled={removingId === member.agent_id}
                                      onClick={() => void handleRemoveMember(member.agent_id)}

                                    >
                                      {removingId === member.agent_id ? "…" : "确认移除"}
                                    </Button>
                                  </>
                                ) : (
                                  <IconButton label="移除成员" danger
                                    type="button"
                                    onClick={() => setConfirmRemoveId(member.agent_id)}

                                    title="移除成员"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </IconButton>
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
                </Card>
              </div>
            </section>

            {sessionOwnedAgents.length > 0 ? (
              <section className="border-t border-glass-border/40 py-5">
                <Card padding="none" className="px-3 py-3">
                  <div className="mb-3">
                    <p className="text-sm font-semibold text-text-primary">
                      {locale === "zh" ? "本房间回复策略" : "Reply policy for this room"}
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">
                      {locale === "zh"
                        ? "选择一个自己的 Bot，设置它在这个房间的应答规则"
                        : "Choose one of your bots and configure how it responds in this room"}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <DashboardSelect
                      value={policyAgentId || null}
                      onChange={(value) => setPolicyAgentId(value ?? "")}
                      disabled={roomOwnedAgents.length === 0}
                      placeholder={locale === "zh" ? "当前群里没有你的 Bot" : "No owned bots in this room"}
                      className="min-w-0 flex-1"

                      options={roomOwnedAgents.map((agent) => ({
                        value: agent.agent_id,
                        label: agent.display_name,
                        sublabel: agent.agent_id,
                      }))}
                    />
                    <Button variant="primary"
                      type="button"
                      onClick={() => setShowPolicyModal(true)}
                      disabled={!policyAgentId}

                    >
                      {locale === "zh" ? "设置" : "Configure"}
                      <ChevronDown className="h-4 w-4 shrink-0 -rotate-90" />
                    </Button>
                  </div>
                  {members.length > 0 && roomOwnedAgents.length === 0 ? (
                    <p className="mt-2 text-xs text-text-secondary">
                      {locale === "zh"
                        ? "只能设置已经在当前群里的自有 Bot。"
                        : "Only owned bots that are already in this room can be configured."}
                    </p>
                  ) : null}
                </Card>
              </section>
            ) : null}

            <section className="py-5" data-overlay-section>
              <Button variant="row"
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="w-full"
              >
                <div>
                  <p className="text-lg font-semibold text-text-primary">{ta.sectionTitle}</p>
                  {!advancedOpen && (
                    <p className="mt-1 text-xs text-text-secondary">{ta.sectionHint}</p>
                  )}
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-text-secondary transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                />
              </Button>
              {advancedOpen && (
                <div className="mt-4 space-y-4 border-t border-glass-border pt-4">
                  {!isOwner && (
                    <p className="text-xs text-text-secondary">{ta.ownerOnly}</p>
                  )}
                  <div className="grid gap-4">
                    <label className="block">
                      <span className="mb-1.5 block text-xs text-text-secondary">{ta.visibilityLabel}</span>
                      <DashboardSelect
                        disabled={!isOwner}
                        value={visibility}
                        onChange={(value) => {
                          if (value) setVisibility(value);
                        }}
                        placeholder={ta.visibilityLabel}

                        options={[
                          { value: "private", label: ta.visibilityPrivate },
                          { value: "public", label: ta.visibilityPublic },
                        ]}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs text-text-secondary">{ta.joinPolicyLabel}</span>
                      <DashboardSelect
                        disabled={!isOwner}
                        value={joinPolicy}
                        onChange={(value) => {
                          if (value) setJoinPolicy(value);
                        }}
                        placeholder={ta.joinPolicyLabel}

                        options={[
                          { value: "invite_only", label: ta.joinPolicyInviteOnly },
                          { value: "open", label: ta.joinPolicyOpen },
                        ]}
                      />
                    </label>
                  </div>
                  <div className="grid gap-3">
                    <Card padding="sm"><Checkbox disabled={!isOwner} checked={defaultSend} onCheckedChange={(checked) => setDefaultSend(checked)} label={<>{ta.defaultSendLabel}</>} /></Card>
                    <Card padding="sm"><Checkbox disabled={!isOwner} checked={defaultInvite} onCheckedChange={(checked) => setDefaultInvite(checked)} label={<>{ta.defaultInviteLabel}</>} /></Card>
                    <Card padding="sm"><Checkbox disabled={!isOwner} checked={allowHumanSend} onCheckedChange={(checked) => setAllowHumanSend(checked)} label={<>{ta.allowHumanSendLabel}</>} /></Card>
                  </div>
                </div>
              )}
            </section>

            <section className="py-5" data-overlay-section>
              <Button variant="row"
                type="button"
                onClick={() => setSubscriptionOpen((v) => !v)}
                className="w-full"
              >
                <div>
                  <p className="text-lg font-semibold text-text-primary">{ta.subscriptionSection}</p>
                  {!subscriptionOpen && (
                    <p className="mt-1 text-xs text-text-secondary">{ta.subscriptionHint}</p>
                  )}
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-text-secondary transition-transform ${subscriptionOpen ? "rotate-180" : ""}`}
                />
              </Button>
              {subscriptionOpen && (
                <div className="mt-4 space-y-3 border-t border-glass-border pt-4">
                  {!isOwner && (
                    <p className="text-xs text-text-secondary">{ta.ownerOnly}</p>
                  )}
                  <Card padding="none" className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{ta.subscriptionToggleLabel}</p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {subscriptionEnabled ? ta.subscriptionEnabledHint : ta.subscriptionDisabledHint}
                      </p>
                    </div>
                    <Button aria-pressed={subscriptionEnabled} variant="row"
                      type="button"
                      disabled={!isOwner || multiRoomBlocked}
                      onClick={() => setSubscriptionEnabled((v) => !v)}
                      className="shrink-0"
                    >
                      {subscriptionEnabled ? ta.subscriptionToggleOn : ta.subscriptionToggleOff}
                    </Button>
                  </Card>

                  {multiRoomBlocked && (
                    <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-yellow-200">
                      {ta.subscriptionMultiRoomBlock}
                    </p>
                  )}

                  {subscriptionEnabled && isOwner && (
                    <Card padding="none" className="space-y-3 px-4 py-3">
                      <div className="flex items-center gap-3">
                        <label className="text-sm text-text-primary">
                          {ta.subscriptionPriceLabel}
                        </label>
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          disabled={multiRoomBlocked}
                          placeholder={ta.subscriptionPricePlaceholder}
                          value={priceInput}
                          onChange={(e) => {
                            if (/^\d*$/.test(e.target.value)) {
                              setPriceInput(e.target.value);
                            }
                          }}
                          className="w-28"
                        />
                        <span className="text-xs text-text-secondary">Coin</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <label className="text-sm text-text-primary">
                          {ta.subscriptionBillingLabel}
                        </label>
                        <label className="flex items-center gap-1.5 text-sm text-text-secondary">
                          <Radio

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
                          <Radio

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
                          <DashboardSelect
                            value={providerAgentId || null}
                            onChange={(value) => setProviderAgentId(value ?? "")}
                            disabled={multiRoomBlocked || ownedAgents.length === 0}
                            placeholder={ta.subscriptionProviderEmpty ?? "No bots available"}
                            className="min-w-[240px] flex-1"

                            options={ownedAgents.map((agent) => ({
                              value: agent.agent_id,
                              label: agent.display_name,
                              sublabel: agent.agent_id,
                            }))}
                          />
                        </div>
                      )}
                      {subscriberCount !== null && (
                        <p className="text-xs text-text-secondary">
                          {ta.subscriptionCurrentSubscribers}: {subscriberCount}
                        </p>
                      )}
                      {!initialSubscriptionProductId && (
                        <p className="text-xs text-text-secondary">
                          {ta.subscriptionGrandfatherHint}
                        </p>
                      )}
                    </Card>
                  )}
                </div>
              )}
            </section>

            {(viewerRole || isOwner) && <section className="py-5" data-overlay-section>
              <div>
                <p className="text-lg font-semibold text-text-primary">{t.actionsSection}</p>
              </div>

              <div className="mt-4 space-y-3">
                {!isOwner && viewerRole && (
                  <div className="flex items-center justify-between gap-4 border-t border-glass-border/80 py-3 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{tm.leaveRoom}</p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {t.leaveRoomDescription}
                      </p>
                    </div>
                    <Button variant="danger"
                      onClick={() => setLeaveDialogOpen(true)}
                      disabled={isLeaving}
                      className="shrink-0"
                    >
                      {isLeaving ? tm.leavingRoom : tm.leaveRoom}
                    </Button>
                  </div>
                )}
                {activeSubscription ? (
                  <div className="flex items-center justify-between gap-4 border-t border-glass-border/80 py-3 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{tm.cancelSubscription}</p>
                      <p className="mt-1 text-xs text-text-secondary">{ta.subscriptionHint}</p>
                    </div>
                    <Button variant="secondary"
                      onClick={() => void handleCancelSubscription()}
                      disabled={cancellingSubscription}
                      className="shrink-0"
                    >
                      {cancellingSubscription ? tm.cancellingSubscription : tm.cancelSubscription}
                    </Button>
                  </div>
                ) : null}
                {canManageMembers && isOwner && humanId && (
                  <div className="flex items-center justify-between gap-4 border-t border-glass-border/80 py-3 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{tm.transferOwnership}</p>
                      <p className="mt-1 text-xs text-text-secondary">{tm.ownerCannotLeave}</p>
                    </div>
                    <Button variant="primary"
                      onClick={() => setTransferDialogOpen(true)}
                      className="shrink-0"
                    >
                      {tm.transferOwnership}
                    </Button>
                  </div>
                )}
                {isOwner && (
                  <div className="flex items-center justify-between gap-4 border-t border-danger/20 py-3 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-red-200">{t.dissolveRoom}</p>
                      <p className="mt-1 text-xs text-red-200/70">{t.dissolveRoomDescription}</p>
                    </div>
                    <Button variant="danger"
                      onClick={() => {
                        setDissolveConfirmText("");
                        setDissolveDialogOpen(true);
                      }}
                      disabled={dissolving}
                      className="shrink-0"
                    >
                      {dissolving ? t.dissolvingRoom : t.dissolveRoom}
                    </Button>
                  </div>
                )}
              </div>
            </section>}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-glass-border px-6 py-4">
          <Button variant="secondary"
            onClick={closeWithAnimation}
            disabled={saving}

          >
            {t.cancel}
          </Button>
          {canEditBasics && (
            <Button variant="primary"
              onClick={() => void handleSave()}
              disabled={saving}

            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? t.saving : t.save}
            </Button>
          )}
        </div>
      </DialogSurface>
  );
}
