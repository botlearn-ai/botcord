"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Search, X } from "lucide-react";
import CopyableId from "@/components/ui/CopyableId";
import { api, humansApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import {
  agentBrowser,
  roomAdvancedSettings,
  roomSettingsModal,
} from "@/lib/i18n/translations/dashboard";
import type { PublicRoomMember, SubscriptionProduct } from "@/lib/types";
import AddRoomMemberModal from "./AddRoomMemberModal";
import MemberActionsMenu from "./MemberActionsMenu";
import TransferOwnershipDialog from "./TransferOwnershipDialog";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";

interface RoomSettingsModalProps {
  roomId: string;
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

export default function RoomSettingsModal({
  roomId,
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
  const setFocusedRoomId = useDashboardUIStore((s) => s.setFocusedRoomId);
  const setOpenedRoomId = useDashboardUIStore((s) => s.setOpenedRoomId);

  const canEditBasics = viewerRole === "owner" || viewerRole === "admin";
  const isOwner = viewerRole === "owner";
  const canManageMembers = viewerMode === "human" && (isOwner || viewerRole === "admin");
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
  const [subscriptionProduct, setSubscriptionProduct] = useState<SubscriptionProduct | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);
  const [members, setMembers] = useState<PublicRoomMember[]>([]);
  const [memberQuery, setMemberQuery] = useState("");
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [confirmingDissolve, setConfirmingDissolve] = useState(false);
  const [cancellingSubscription, setCancellingSubscription] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerMember = members.find((member) => member.role === "owner") ?? null;
  const groupInitial = name.trim().charAt(0).toUpperCase() || "G";
  const filteredMembers = useMemo(() => {
    const query = memberQuery.trim().toLowerCase();
    if (!query) return members;
    return members.filter((member) =>
      member.display_name.toLowerCase().includes(query)
      || member.agent_id.toLowerCase().includes(query)
      || member.role.toLowerCase().includes(query),
    );
  }, [memberQuery, members]);
  const visibleMembers = filteredMembers.slice(0, 8);
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
        if (productResult && "product" in (productResult as { product: SubscriptionProduct })) {
          setSubscriptionProduct((productResult as { product: SubscriptionProduct }).product);
        } else {
          setSubscriptionProduct(null);
        }
      } catch {
        if (cancelled) return;
        setOwnedProducts([]);
        setSubscriptionProduct(null);
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
        const nextSub = subscriptionEnabled
          ? (subscriptionProductId.trim() || availableProduct?.product_id || null)
          : null;
        if (subscriptionEnabled && !nextSub) {
          setError(ta.subscriptionNoPlan);
          setSaving(false);
          return;
        }
        if (nextSub !== initialSubscriptionProductId) {
          patch.required_subscription_product_id = nextSub;
        }
      }
      if (Object.keys(patch).length > 0) {
        const updater = viewerMode === "human" ? humansApi.updateRoomSettings : api.updateRoomSettings;
        await updater(roomId, patch);
        await Promise.all([
          refreshOverview({ reloadOpenedRoom: true }),
          refreshHumanRooms(),
        ]);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const handleLeave = async () => {
    if (isOwner) return;
    if (!confirmingLeave) {
      setConfirmingLeave(true);
      return;
    }
    setError(null);
    try {
      await Promise.all([leaveRoom(roomId), refreshHumanRooms()]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tm.leaveRoomFailed);
      setConfirmingLeave(false);
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
    if (!isOwner || dissolving) return;
    if (!confirmingDissolve) {
      setConfirmingDissolve(true);
      return;
    }
    setError(null);
    setDissolving(true);
    try {
      const dissolve = viewerMode === "human" ? humansApi.dissolveRoom : api.dissolveRoom;
      await dissolve(roomId);
      setFocusedRoomId(null);
      setOpenedRoomId(null);
      await Promise.all([refreshOverview(), refreshHumanRooms()]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.dissolveRoomFailed);
      setConfirmingDissolve(false);
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

          {!canEditBasics && (
            <div className="mb-4 rounded-xl border border-glass-border bg-glass-bg/40 px-4 py-3 text-xs text-text-secondary/80">
              {t.readOnlyHint}
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
                  <p className="mt-1 text-sm text-text-secondary">
                    {canEditBasics ? t.ruleHint : t.readOnlyHint}
                  </p>
                  <div className="mt-3 text-xs text-text-secondary/70">
                    <CopyableId value={roomId} />
                  </div>
                </div>
              </div>

              <div className="mt-5 space-y-4 border-t border-glass-border pt-4">
                <div>
                  <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                    {t.nameLabel}
                  </label>
                  <input
                    type="text"
                    disabled={!canEditBasics}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    className="w-full rounded-xl border border-glass-border bg-glass-bg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan/50 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                    {t.descriptionLabel}
                  </label>
                  <textarea
                    rows={3}
                    disabled={!canEditBasics}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={500}
                    className="w-full resize-none rounded-xl border border-glass-border bg-glass-bg px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan/50 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                    {t.ruleLabel}
                  </label>
                  <textarea
                    disabled={!canEditBasics}
                    value={rule}
                    onChange={(e) => setRule(e.target.value)}
                    rows={4}
                    maxLength={4000}
                    className="w-full resize-none rounded-xl border border-glass-border bg-glass-bg px-3 py-2.5 text-sm leading-relaxed text-text-primary outline-none focus:border-neon-cyan/50 disabled:opacity-60"
                  />
                </div>
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

                <div className="flex flex-wrap gap-3">
                  {visibleMembers.map((member) => (
                    <div key={member.agent_id} className="flex items-center gap-2 rounded-full border border-glass-border bg-glass-bg px-2.5 py-1.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neon-cyan/12 text-xs font-semibold text-neon-cyan">
                        {(member.display_name || "M").trim().charAt(0).toUpperCase() || "M"}
                      </div>
                      <span className="max-w-28 truncate text-xs text-text-primary">{member.display_name}</span>
                    </div>
                  ))}
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
                            {canManageMembers && !isSelf && (
                              <MemberActionsMenu
                                roomId={roomId}
                                member={member}
                                viewerRole={viewerRole ?? "member"}
                                onMutated={() => {
                                  void refreshRoomDetails();
                                }}
                                onError={(msg) => setError(msg)}
                              />
                            )}
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
                      disabled={!isOwner || (!subscriptionEnabled && !subscriptionProductId && !availableProduct)}
                      onClick={() => {
                        if (!subscriptionEnabled) {
                          const nextProductId = subscriptionProductId || availableProduct?.product_id || "";
                          if (!nextProductId) return;
                          setSubscriptionProductId(nextProductId);
                          if (!subscriptionProduct && availableProduct) {
                            setSubscriptionProduct(availableProduct);
                          }
                          setSubscriptionEnabled(true);
                          return;
                        }
                        setSubscriptionEnabled(false);
                      }}
                      className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${subscriptionEnabled ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan" : "border-glass-border text-text-secondary hover:bg-glass-bg"}`}
                    >
                      {subscriptionEnabled ? ta.subscriptionToggleOn : ta.subscriptionToggleOff}
                    </button>
                  </div>

                  {!subscriptionEnabled && isOwner && !subscriptionProductId && !availableProduct && (
                    <p className="text-xs text-text-secondary/70">{ta.subscriptionNoPlan}</p>
                  )}

                  {!subscriptionEnabled && isOwner && availableProduct && (
                    <p className="text-xs text-text-secondary/70">{ta.subscriptionAutoPick}</p>
                  )}

                  {subscriptionEnabled && (
                    <div className="rounded-xl border border-glass-border bg-deep-black/40 px-4 py-3">
                      <p className="text-sm font-medium text-text-primary">{ta.subscriptionCurrentPlan}</p>
                      {subscriptionLoading ? (
                        <p className="mt-2 text-xs text-text-secondary/70">{t.saving}</p>
                      ) : subscriptionProduct || availableProduct ? (
                        (() => {
                          const product = subscriptionProduct ?? availableProduct;
                          if (!product) return null;
                          return (
                            <div className="mt-2 space-y-1 text-xs text-text-secondary/80">
                              <p className="text-sm font-medium text-text-primary">{product.name}</p>
                              {product.description ? <p>{product.description}</p> : null}
                              <p>{ta.subscriptionPriceLabel}: {typeof product.amount_minor === "number" ? (product.amount_minor / 100).toFixed(2) : String(Number(product.amount_minor) / 100)} {product.asset_code}</p>
                              <p>{ta.subscriptionBillingLabel}: {product.billing_interval}</p>
                            </div>
                          );
                        })()
                      ) : (
                        <p className="mt-2 text-xs text-text-secondary/70">{ta.subscriptionNone}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="py-5">
              <div>
                <p className="text-lg font-semibold text-text-primary">{t.actionsSection}</p>
                <p className="mt-1 text-xs text-text-secondary/70">
                  {ownerMember ? `${tm.ownerCannotLeave} ${ownerMember.display_name}` : tm.ownerCannotLeave}
                </p>
              </div>

              <div className="mt-4 space-y-3">
                {!isOwner && (
                  <div className="flex items-center justify-between gap-4 border-t border-glass-border/80 py-3 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">{tm.leaveRoom}</p>
                      <p className="mt-1 text-xs text-text-secondary/70">
                        {confirmingLeave ? t.dissolveRoomConfirm : t.readOnlyHint}
                      </p>
                    </div>
                    <button
                      onClick={() => void handleLeave()}
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
                      <p className="mt-1 text-xs text-red-200/70">{confirmingDissolve ? t.dissolveRoomConfirm : t.dissolveRoomFailed.replace("失败", "后将删除群及其成员关系").replace("Failed to dissolve group", "This permanently deletes the group and its memberships.")}</p>
                    </div>
                    <button
                      onClick={() => void handleDissolve()}
                      disabled={dissolving}
                      className="shrink-0 rounded-lg border border-red-500/35 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {dissolving ? t.dissolvingRoom : t.dissolveRoom}
                    </button>
                  </div>
                )}
              </div>
            </section>
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
    </div>
  );
}
