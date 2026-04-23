"use client";

import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { roomSettingsModal, roomAdvancedSettings } from "@/lib/i18n/translations/dashboard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";

interface RoomSettingsModalProps {
  roomId: string;
  initialName: string;
  initialDescription: string;
  initialRule: string;
  initialVisibility?: string;
  initialJoinPolicy?: string;
  initialDefaultSend?: boolean;
  initialDefaultInvite?: boolean;
  initialMaxMembers?: number | null;
  initialSlowModeSeconds?: number | null;
  initialSubscriptionProductId?: string | null;
  isOwner?: boolean;
  onClose: () => void;
}

export default function RoomSettingsModal({
  roomId,
  initialName,
  initialDescription,
  initialRule,
  initialVisibility = "private",
  initialJoinPolicy = "invite_only",
  initialDefaultSend = true,
  initialDefaultInvite = false,
  initialMaxMembers = null,
  initialSlowModeSeconds = null,
  initialSubscriptionProductId = null,
  isOwner = false,
  onClose,
}: RoomSettingsModalProps) {
  const locale = useLanguage();
  const t = roomSettingsModal[locale];
  const ta = roomAdvancedSettings[locale];
  const refreshOverview = useDashboardChatStore((s) => s.refreshOverview);

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [rule, setRule] = useState(initialRule);
  const [visibility, setVisibility] = useState(initialVisibility);
  const [joinPolicy, setJoinPolicy] = useState(initialJoinPolicy);
  const [defaultSend, setDefaultSend] = useState(initialDefaultSend);
  const [defaultInvite, setDefaultInvite] = useState(initialDefaultInvite);
  const [maxMembers, setMaxMembers] = useState(
    initialMaxMembers == null ? "" : String(initialMaxMembers),
  );
  const [slowMode, setSlowMode] = useState(
    initialSlowModeSeconds == null ? "" : String(initialSlowModeSeconds),
  );
  const [subscriptionProductId, setSubscriptionProductId] = useState(
    initialSubscriptionProductId ?? "",
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
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
        const nextMax = maxMembers ? Number(maxMembers) : null;
        if (nextMax !== initialMaxMembers) patch.max_members = nextMax;
        const nextSlow = slowMode ? Number(slowMode) : null;
        if (nextSlow !== initialSlowModeSeconds) patch.slow_mode_seconds = nextSlow;
        const nextSub = subscriptionProductId.trim() || null;
        if (nextSub !== initialSubscriptionProductId) {
          patch.required_subscription_product_id = nextSub;
        }
      }
      if (Object.keys(patch).length > 0) {
        await api.updateRoomSettings(roomId, patch);
        await refreshOverview({ reloadOpenedRoom: true });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-glass-border bg-deep-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-glass-border px-6 py-4">
          <h2 className="text-lg font-semibold text-text-primary">{t.title}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.nameLabel}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.descriptionLabel}
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.ruleLabel}
            </label>
            <textarea
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              rows={4}
              maxLength={4000}
              className="w-full resize-none rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm leading-relaxed text-text-primary outline-none focus:border-neon-cyan/50"
            />
            <p className="mt-1 text-[10px] text-text-secondary/60">{t.ruleHint}</p>
          </div>

          {/* Advanced */}
          <section className="rounded border border-glass-border">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                  {ta.sectionTitle}
                </p>
                {!advancedOpen && (
                  <p className="mt-1 text-[11px] text-text-secondary/60">{ta.sectionHint}</p>
                )}
              </div>
              <ChevronDown
                className={`h-4 w-4 text-text-secondary transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              />
            </button>
            {advancedOpen && (
              <div className="space-y-3 border-t border-glass-border px-4 py-3">
                {!isOwner && (
                  <p className="text-[11px] text-text-secondary/70">{ta.ownerOnly}</p>
                )}
                <label className="block">
                  <span className="mb-1 block text-xs text-text-secondary">{ta.visibilityLabel}</span>
                  <select
                    disabled={!isOwner}
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value)}
                    className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/60 disabled:opacity-60"
                  >
                    <option value="private">{ta.visibilityPrivate}</option>
                    <option value="public">{ta.visibilityPublic}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-text-secondary">{ta.joinPolicyLabel}</span>
                  <select
                    disabled={!isOwner}
                    value={joinPolicy}
                    onChange={(e) => setJoinPolicy(e.target.value)}
                    className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/60 disabled:opacity-60"
                  >
                    <option value="invite_only">{ta.joinPolicyInviteOnly}</option>
                    <option value="open">{ta.joinPolicyOpen}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    disabled={!isOwner}
                    checked={defaultSend}
                    onChange={(e) => setDefaultSend(e.target.checked)}
                    className="accent-neon-cyan"
                  />
                  {ta.defaultSendLabel}
                </label>
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    disabled={!isOwner}
                    checked={defaultInvite}
                    onChange={(e) => setDefaultInvite(e.target.checked)}
                    className="accent-neon-cyan"
                  />
                  {ta.defaultInviteLabel}
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs text-text-secondary">{ta.maxMembersLabel}</span>
                    <input
                      type="number"
                      min={1}
                      disabled={!isOwner}
                      value={maxMembers}
                      onChange={(e) => setMaxMembers(e.target.value)}
                      className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/60 disabled:opacity-60"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-text-secondary">{ta.slowModeLabel}</span>
                    <input
                      type="number"
                      min={0}
                      disabled={!isOwner}
                      value={slowMode}
                      onChange={(e) => setSlowMode(e.target.value)}
                      className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/60 disabled:opacity-60"
                    />
                  </label>
                </div>
              </div>
            )}
          </section>

          {/* Subscription */}
          <section className="rounded border border-glass-border">
            <button
              type="button"
              onClick={() => setSubscriptionOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                  {ta.subscriptionSection}
                </p>
                {!subscriptionOpen && (
                  <p className="mt-1 text-[11px] text-text-secondary/60">{ta.subscriptionHint}</p>
                )}
              </div>
              <ChevronDown
                className={`h-4 w-4 text-text-secondary transition-transform ${subscriptionOpen ? "rotate-180" : ""}`}
              />
            </button>
            {subscriptionOpen && (
              <div className="space-y-2 border-t border-glass-border px-4 py-3">
                {!isOwner && (
                  <p className="text-[11px] text-text-secondary/70">{ta.ownerOnly}</p>
                )}
                <label className="block">
                  <span className="mb-1 block text-xs text-text-secondary">
                    {ta.subscriptionProductLabel}
                  </span>
                  <input
                    type="text"
                    disabled={!isOwner}
                    value={subscriptionProductId}
                    onChange={(e) => setSubscriptionProductId(e.target.value)}
                    placeholder={ta.subscriptionNone}
                    className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 font-mono text-xs text-text-primary outline-none focus:border-neon-cyan/60 disabled:opacity-60"
                  />
                </label>
              </div>
            )}
          </section>
        </div>

        <div className="flex justify-end gap-2 border-t border-glass-border px-6 py-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            {t.cancel}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? t.saving : t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
