"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, Bot, Clock, FileText, Loader2, MessageSquare, Plug, RefreshCw, Shield, Trash2, User, UserRound, X } from "lucide-react";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { botDetailDrawer } from "@/lib/i18n/translations/dashboard";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import {
  usePolicyStore,
  type AgentPolicy,
  type AgentPolicyPatch,
  type AttentionMode,
  type ContactPolicy,
  type RoomInvitePolicy,
} from "@/store/usePolicyStore";
import UnbindAgentDialog from "./UnbindAgentDialog";
import AgentChannelsTab from "./AgentChannelsTab";
import AgentSchedulesTab from "./AgentSchedulesTab";
import { AGENT_AVATAR_URLS } from "@/lib/agent-avatars";

interface AgentSettingsDrawerProps {
  agentId: string;
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

type Tab = "profile" | "policy" | "schedules" | "gateways" | "files";
type BotDetailDrawerCopy = typeof botDetailDrawer["en"];

interface AgentRuntimeFile {
  id: string;
  name: string;
  scope: "workspace" | "hermes" | "openclaw";
  runtime?: string;
  profile?: string;
  size?: number;
  mtimeMs?: number;
  content?: string;
  truncated?: boolean;
  error?: string;
}

interface AgentRuntimeFilesResponse {
  agentId: string;
  runtime?: string;
  files: AgentRuntimeFile[];
}

function RadioGroup<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  name: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
              selected
                ? "border-neon-cyan/40 bg-neon-cyan/5"
                : "border-glass-border bg-transparent hover:bg-glass-bg/60"
            } ${disabled ? "pointer-events-none opacity-50" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={selected}
              onChange={() => onChange(opt.value)}
              className="mt-0.5 accent-neon-cyan"
              disabled={disabled}
            />
            <div className="flex-1">
              <div className="text-sm text-text-primary">{opt.label}</div>
              {opt.hint ? (
                <div className="text-xs text-text-secondary">{opt.hint}</div>
              ) : null}
            </div>
          </label>
        );
      })}
    </div>
  );
}

function KeywordChips({
  value,
  onChange,
  disabled,
  emptyLabel,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  emptyLabel: string;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");

  const add = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || value.includes(trimmed)) return;
      onChange([...value, trimmed]);
      setDraft("");
    },
    [onChange, value],
  );

  const remove = useCallback(
    (kw: string) => onChange(value.filter((v) => v !== kw)),
    [onChange, value],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 ? (
          <span className="text-xs text-text-tertiary">{emptyLabel}</span>
        ) : (
          value.map((kw) => (
            <span
              key={kw}
              className="inline-flex items-center gap-1 rounded-full border border-neon-cyan/30 bg-neon-cyan/5 px-2 py-0.5 text-xs text-neon-cyan"
            >
              {kw}
              <button
                type="button"
                onClick={() => remove(kw)}
                disabled={disabled}
                className="rounded-full p-0.5 hover:bg-neon-cyan/10 disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}
      </div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => add(draft)}
        disabled={disabled}
        placeholder={placeholder}
        className="rounded-xl border border-glass-border bg-deep-black/40 px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-neon-cyan/40 focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}

function formatBytes(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function scopeLabel(scope: AgentRuntimeFile["scope"]): string {
  if (scope === "hermes") return "Hermes";
  if (scope === "openclaw") return "OpenClaw";
  return "Workspace";
}

function contactOptions(t: BotDetailDrawerCopy): { value: ContactPolicy; label: string; hint: string }[] {
  return [
    { value: "open", ...t.settings.contactOptions.open },
    { value: "contacts_only", ...t.settings.contactOptions.contacts_only },
    { value: "whitelist", ...t.settings.contactOptions.whitelist },
    { value: "closed", ...t.settings.contactOptions.closed },
  ];
}

function roomInviteOptions(t: BotDetailDrawerCopy): { value: RoomInvitePolicy; label: string; hint?: string }[] {
  return [
    { value: "open", ...t.settings.roomInviteOptions.open },
    { value: "contacts_only", ...t.settings.roomInviteOptions.contacts_only },
    { value: "closed", ...t.settings.roomInviteOptions.closed },
  ];
}

function attentionOptions(t: BotDetailDrawerCopy): { value: AttentionMode; label: string; hint: string }[] {
  return [
    { value: "always", ...t.settings.attentionOptions.always },
    { value: "mention_only", ...t.settings.attentionOptions.mention_only },
    { value: "muted", ...t.settings.attentionOptions.muted },
    { value: "keyword", ...t.settings.attentionOptions.keyword },
  ];
}

function SummaryTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "cyan" | "green" | "yellow" | "red";
}) {
  const toneClass =
    tone === "green"
      ? "border-neon-green/30 bg-neon-green/5 text-neon-green"
      : tone === "yellow"
        ? "border-yellow-400/30 bg-yellow-400/5 text-yellow-300"
        : tone === "red"
          ? "border-red-400/30 bg-red-400/5 text-red-300"
          : "border-neon-cyan/30 bg-neon-cyan/5 text-neon-cyan";
  return (
    <div className={`rounded-xl border px-3 py-3 ${toneClass}`}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-normal opacity-80">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold leading-snug">{value}</div>
    </div>
  );
}

export default function AgentSettingsDrawer({
  agentId,
  displayName,
  bio,
  avatarUrl,
  onClose,
  onSaved,
}: AgentSettingsDrawerProps) {
  const locale = useLanguage();
  const t = botDetailDrawer[locale];
  const contactPolicyOptions = contactOptions(t);
  const roomInvitePolicyOptions = roomInviteOptions(t);
  const attentionPolicyOptions = attentionOptions(t);
  const labels = {
    avatar: locale === "zh" ? "头像" : "Avatar",
    chooseAvatar: locale === "zh" ? "选择头像" : "Choose avatar",
    saveProfile: locale === "zh" ? "保存资料" : "Save profile",
    deleteAgent: locale === "zh" ? "删除 Agent" : "Delete Agent",
    policyTab: locale === "zh" ? "权限与回复" : "Permissions",
    filesTab: locale === "zh" ? "文件/记忆" : "Files / Memory",
    directContact: locale === "zh" ? "直接联系" : "Direct contact",
    allowedSources: locale === "zh" ? "允许来源" : "Allowed sources",
    allOff: locale === "zh" ? "全部关闭" : "All off",
    contactMe: locale === "zh" ? "直接联系我" : "Contact me directly",
    contactMeDesc: locale === "zh"
      ? "Hub 准入权限：控制谁可以把私聊消息送到这个 Bot。Blocklist 仍然拥有最高优先级。"
      : "Hub admission policy: controls who can deliver direct messages to this Bot. Blocklist still has the highest priority.",
    senderTypes: locale === "zh" ? "允许的发送者类型" : "Allowed sender types",
    agentSenderHint: locale === "zh" ? "其他 bot / agent" : "other bots / agents",
    humanSenderHint: locale === "zh" ? "人类用户 / dashboard" : "human users / dashboard",
    inviteMe: locale === "zh" ? "谁能邀请我进房间" : "Who can invite me to rooms",
    keywordEmpty: locale === "zh" ? "尚未配置关键词" : "No keywords configured",
    dmReplyNote: locale === "zh"
      ? "私聊 DM 当前强制始终唤醒；房间消息会先看房间级覆盖，没有覆盖时继承这里的默认策略。"
      : "DMs always wake the Bot. Room messages use room-level overrides first, then inherit this default policy.",
  };
  const refreshUserProfile = useDashboardSessionStore((s) => s.refreshUserProfile);

  const [tab, setTab] = useState<Tab>("profile");
  const [showUnbind, setShowUnbind] = useState(false);
  const [runtimeFiles, setRuntimeFiles] = useState<AgentRuntimeFile[]>([]);
  const [runtimeLabel, setRuntimeLabel] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  // --- Profile state ---
  const [nameVal, setNameVal] = useState(displayName);
  const [bioVal, setBioVal] = useState(bio ?? "");
  const [avatarVal, setAvatarVal] = useState(avatarUrl ?? "");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const trimmedName = nameVal.trim();
  const nameChanged = trimmedName !== displayName.trim();
  const bioChanged = bioVal.trim() !== (bio ?? "").trim();
  const avatarChanged = avatarVal !== (avatarUrl ?? "");
  const canSaveProfile = !profileSaving && trimmedName.length > 0 && (nameChanged || bioChanged || avatarChanged);

  async function handleSaveProfile() {
    if (!canSaveProfile) return;
    setProfileSaving(true);
    setProfileError(null);
    try {
      const patch: { display_name?: string; bio?: string | null; avatar_url?: string | null } = {};
      if (nameChanged) patch.display_name = trimmedName;
      if (bioChanged) patch.bio = bioVal.trim() || null;
      if (avatarChanged) patch.avatar_url = avatarVal || null;
      await userApi.updateAgent(agentId, patch);
      await refreshUserProfile();
      onSaved?.();
    } catch (err: any) {
      setProfileError(err?.message || t.profile.saveFailed);
    } finally {
      setProfileSaving(false);
    }
  }

  // --- Policy state ---
  const policy = usePolicyStore((s) => s.globalByAgent[agentId]);
  const loadingPolicy = usePolicyStore((s) => Boolean(s.globalLoading[agentId]));
  const loadGlobal = usePolicyStore((s) => s.loadGlobal);
  const patchGlobal = usePolicyStore((s) => s.patchGlobal);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policySaving, setPolicySaving] = useState(false);

  useEffect(() => {
    if (!policy && !loadingPolicy) {
      void loadGlobal(agentId).catch(() => {});
    }
  }, [agentId, loadGlobal, loadingPolicy, policy]);

  const applyPolicy = useCallback(
    async (patch: AgentPolicyPatch) => {
      setPolicySaving(true);
      setPolicyError(null);
      try {
        await patchGlobal(agentId, patch);
      } catch (err) {
        setPolicyError(err instanceof Error ? err.message : String(err));
      } finally {
        setPolicySaving(false);
      }
    },
    [agentId, patchGlobal],
  );

  const loadRuntimeFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/runtime-files`, {
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const detail = data?.detail;
        const msg =
          typeof data?.error === "string"
            ? data.error
            : typeof detail === "string"
              ? detail
              : typeof detail?.code === "string"
                  ? detail.code
                : res.status === 409
                  ? t.files.daemonUnavailable
                  : t.files.loadFailed;
        throw new Error(msg);
      }
      const data = (await res.json()) as AgentRuntimeFilesResponse;
      const files = Array.isArray(data.files) ? data.files : [];
      setRuntimeFiles(files);
      setRuntimeLabel(data.runtime ?? null);
      setSelectedFileId((prev) =>
        prev && files.some((file) => file.id === prev) ? prev : files[0]?.id ?? null,
      );
      setFilesLoaded(true);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : t.files.loadFailed);
      setFilesLoaded(true);
    } finally {
      setFilesLoading(false);
    }
  }, [agentId, t.files.daemonUnavailable, t.files.loadFailed]);

  useEffect(() => {
    if (tab === "files" && !filesLoaded && !filesLoading) {
      void loadRuntimeFiles();
    }
  }, [filesLoaded, filesLoading, loadRuntimeFiles, tab]);

  const selectedFile = runtimeFiles.find((file) => file.id === selectedFileId) ?? null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60" onClick={onClose}>
      <div
        className="ml-auto flex h-full w-full max-w-[480px] flex-col overflow-hidden border-l border-glass-border bg-deep-black shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-glass-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-text-primary">
              {displayName}
            </h2>
            <p className="font-mono text-[10px] text-text-secondary/50">{agentId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-4 rounded-full p-2 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex flex-nowrap overflow-x-auto border-b border-glass-border/60 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(["profile", "policy", "schedules", "gateways", "files"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-3 text-xs font-medium transition-colors ${
                tab === t
                  ? "border-b-2 border-neon-cyan text-neon-cyan"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t === "profile" ? (
                <User className="h-3.5 w-3.5" />
              ) : t === "policy" ? (
                <MessageSquare className="h-3.5 w-3.5" />
              ) : t === "gateways" ? (
                <Plug className="h-3.5 w-3.5" />
              ) : t === "schedules" ? (
                <Clock className="h-3.5 w-3.5" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
              {t === "profile"
                  ? botDetailDrawer[locale].profile.title
                : t === "policy"
                  ? labels.policyTab
                : t === "schedules"
                    ? botDetailDrawer[locale].settings.autonomy
                    : t === "gateways"
                      ? botDetailDrawer[locale].settings.channels
                      : labels.filesTab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === "profile" && (
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-medium text-text-secondary">
                  {labels.avatar}
                </label>
                <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
                  {AGENT_AVATAR_URLS.map((url) => {
                    const selected = avatarVal === url;
                    return (
                      <button
                        key={url}
                        type="button"
                        onClick={() => setAvatarVal(url)}
                        disabled={profileSaving}
                        className={`aspect-square overflow-hidden rounded-full border bg-glass-bg transition-all disabled:opacity-60 ${
                          selected
                            ? "border-neon-cyan ring-2 ring-neon-cyan/30"
                            : "border-glass-border hover:border-neon-cyan/50"
                        }`}
                        aria-label={labels.chooseAvatar}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="" className="h-full w-full object-cover" />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  {t.profile.displayName}
                </label>
                <input
                  type="text"
                  value={nameVal}
                  onChange={(e) => setNameVal(e.target.value)}
                  disabled={profileSaving}
                  maxLength={128}
                  className="w-full rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-neon-cyan/50 disabled:opacity-60"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  {t.profile.bio}
                </label>
                <textarea
                  value={bioVal}
                  onChange={(e) => setBioVal(e.target.value)}
                  disabled={profileSaving}
                  rows={4}
                  maxLength={4000}
                  placeholder={t.profile.bioPlaceholder}
                  className="w-full resize-none rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-neon-cyan/50 disabled:opacity-60"
                />
              </div>

              {profileError && (
                <p className="rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-400">
                  {profileError}
                </p>
              )}

              <button
                type="button"
                onClick={handleSaveProfile}
                disabled={!canSaveProfile}
                className="flex items-center gap-2 rounded-xl border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2.5 text-sm font-bold text-neon-cyan transition-all hover:bg-neon-cyan/20 disabled:opacity-60"
              >
                {profileSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t.profile.saving}
                  </>
                ) : (
                  labels.saveProfile
                )}
              </button>

              <div className="border-t border-glass-border pt-4">
                <button
                  type="button"
                  onClick={() => setShowUnbind(true)}
                  disabled={profileSaving}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-400 transition-all hover:bg-red-500/20 disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" />
                  {labels.deleteAgent}
                </button>
              </div>
            </div>
          )}

          {tab === "policy" && (
            <div className="space-y-6">
              {policyError && (
                <div className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
                  {policyError}
                </div>
              )}

              {!policy || loadingPolicy ? (
                <div className="space-y-4">
                  {[1, 2].map((i) => (
                    <div key={i} className="animate-pulse rounded-2xl border border-glass-border bg-glass-bg/40 p-5">
                      <div className="mb-3 h-4 w-28 rounded bg-glass-bg" />
                      <div className="space-y-2">
                        <div className="h-9 rounded bg-glass-bg/70" />
                        <div className="h-9 rounded bg-glass-bg/70" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="grid gap-3">
                    <SummaryTile
                      icon={<Shield className="h-4 w-4" />}
                      label={labels.directContact}
                      value={contactPolicyOptions.find((o) => o.value === policy.contact_policy)?.label ?? policy.contact_policy}
                      tone="cyan"
                    />
                    <SummaryTile
                      icon={<UserRound className="h-4 w-4" />}
                      label={labels.allowedSources}
                      value={[
                        policy.allow_agent_sender ? "Agent" : null,
                        policy.allow_human_sender ? "Human" : null,
                      ].filter(Boolean).join(" + ") || labels.allOff}
                      tone={policy.allow_agent_sender || policy.allow_human_sender ? "green" : "red"}
                    />
                    <SummaryTile
                      icon={<Bell className="h-4 w-4" />}
                      label={t.settings.defaultReplyTitle}
                      value={attentionPolicyOptions.find((o) => o.value === policy.default_attention)?.label ?? policy.default_attention}
                      tone={policy.default_attention === "muted" ? "yellow" : "cyan"}
                    />
                  </div>

                  <section className="rounded-2xl border border-glass-border bg-glass-bg/40 p-5">
                    <h3 className="mb-1 text-sm font-semibold text-text-primary">{labels.contactMe}</h3>
                    <p className="mb-4 text-xs text-text-secondary">
                      {labels.contactMeDesc}
                    </p>
                    <RadioGroup
                      name={`contact_policy_${agentId}`}
                      value={policy.contact_policy}
                      options={contactPolicyOptions}
                      onChange={(v) => void applyPolicy({ contact_policy: v })}
                      disabled={policySaving}
                    />

                    <div className="mt-5 rounded-xl border border-glass-border bg-deep-black/20 p-3">
                      <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-text-secondary">
                        <Bot className="h-3.5 w-3.5" />
                        {labels.senderTypes}
                      </div>
                      <label className="mb-2 flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-glass-border/70 bg-glass-bg/30 px-3 py-2 text-sm text-text-primary">
                        <span>
                          Agent
                          <span className="ml-2 text-xs text-text-secondary">{labels.agentSenderHint}</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={policy.allow_agent_sender}
                          onChange={(e) => void applyPolicy({ allow_agent_sender: e.target.checked })}
                          disabled={policySaving}
                          className="accent-neon-cyan"
                        />
                      </label>
                      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-glass-border/70 bg-glass-bg/30 px-3 py-2 text-sm text-text-primary">
                        <span>
                          Human
                          <span className="ml-2 text-xs text-text-secondary">{labels.humanSenderHint}</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={policy.allow_human_sender}
                          onChange={(e) => void applyPolicy({ allow_human_sender: e.target.checked })}
                          disabled={policySaving}
                          className="accent-neon-cyan"
                        />
                      </label>
                    </div>

                    <div className="mt-5">
                      <div className="mb-2 text-xs font-medium uppercase tracking-normal text-text-secondary">
                        {labels.inviteMe}
                      </div>
                      <RadioGroup
                        name={`room_invite_policy_${agentId}`}
                        value={policy.room_invite_policy}
                        options={roomInvitePolicyOptions}
                        onChange={(v) => void applyPolicy({ room_invite_policy: v })}
                        disabled={policySaving}
                      />
                    </div>
                  </section>

                  <section className="rounded-2xl border border-glass-border bg-glass-bg/40 p-5">
                    <h3 className="mb-1 text-sm font-semibold text-text-primary">{t.settings.defaultReplyTitle}</h3>
                    <p className="mb-4 text-xs text-text-secondary">
                      {t.settings.defaultReplyDescription}
                    </p>
                    <RadioGroup
                      name={`default_attention_${agentId}`}
                      value={policy.default_attention}
                      options={attentionPolicyOptions}
                      onChange={(v) => void applyPolicy({ default_attention: v })}
                      disabled={policySaving}
                    />
                    {policy.default_attention === "keyword" && (
                      <div className="mt-4">
                        <div className="mb-2 text-xs text-text-secondary">{t.settings.keywords}</div>
                        <KeywordChips
                          value={policy.attention_keywords}
                          onChange={(next) => void applyPolicy({ attention_keywords: next })}
                          disabled={policySaving}
                          emptyLabel={labels.keywordEmpty}
                          placeholder={t.settings.keywordPlaceholder}
                        />
                      </div>
                    )}
                    <p className="mt-4 rounded-lg border border-glass-border/60 bg-glass-bg/40 px-3 py-2 text-xs text-text-secondary">
                      {labels.dmReplyNote}
                    </p>
                  </section>

                  {policySaving && (
                    <div className="flex items-center gap-2 text-xs text-text-secondary">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {t.settings.saving}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "gateways" && <AgentChannelsTab agentId={agentId} />}

          {tab === "schedules" && <AgentSchedulesTab agentId={agentId} />}

          {tab === "files" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary">{t.files.title}</h3>
                  <p className="truncate text-xs text-text-secondary">
                    {runtimeLabel ? runtimeLabel : t.files.subtitle}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadRuntimeFiles()}
                  disabled={filesLoading}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-glass-border bg-glass-bg text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
                  title={t.files.refresh}
                >
                  {filesLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </button>
              </div>

              {filesError && (
                <div className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
                  {filesError}
                </div>
              )}

              {filesLoading && runtimeFiles.length === 0 ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-14 animate-pulse rounded-xl bg-glass-bg/60" />
                  ))}
                </div>
              ) : runtimeFiles.length === 0 ? (
                <div className="rounded-xl border border-glass-border bg-glass-bg/40 px-4 py-8 text-center text-sm text-text-secondary">
                  {t.files.empty}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-2">
                    {runtimeFiles.map((file) => {
                      const selected = file.id === selectedFileId;
                      const size = formatBytes(file.size);
                      return (
                        <button
                          key={file.id}
                          type="button"
                          onClick={() => setSelectedFileId(file.id)}
                          className={`flex min-h-[56px] items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
                            selected
                              ? "border-neon-cyan/40 bg-neon-cyan/5"
                              : "border-glass-border bg-glass-bg/40 hover:bg-glass-bg/70"
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm text-text-primary">{file.name}</div>
                            <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-normal text-text-secondary">
                              <span>{scopeLabel(file.scope)}</span>
                              {file.profile ? <span>{file.profile}</span> : null}
                              {size ? <span>{size}</span> : null}
                            </div>
                          </div>
                          {file.truncated ? (
                            <span className="shrink-0 rounded border border-yellow-400/30 px-1.5 py-0.5 text-[10px] text-yellow-300">
                              {t.files.tooLarge}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>

                  {selectedFile && (
                    <section className="rounded-xl border border-glass-border bg-glass-bg/30">
                      <div className="border-b border-glass-border px-3 py-2">
                        <div className="truncate text-xs font-medium text-text-primary">
                          {selectedFile.name}
                        </div>
                      </div>
                      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-text-secondary">
                        {selectedFile.error
                          ? selectedFile.error
                          : selectedFile.truncated
                            ? t.files.previewTooLarge
                            : selectedFile.content ?? ""}
                      </pre>
                    </section>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showUnbind && (
        <UnbindAgentDialog
          agentId={agentId}
          agentName={displayName}
          onClose={() => setShowUnbind(false)}
          onUnbound={async () => {
            await refreshUserProfile();
            onSaved?.();
            onClose();
          }}
        />
      )}
    </div>
  );
}
