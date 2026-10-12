"use client";
import Skeleton from "@/components/ui/Skeleton";
import Tabs from "@/components/ui/Tabs";
import Field from "@/components/ui/Field";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";

import Radio from "@/components/ui/Radio";
import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Bot, Clock, FileText, Loader2, MessageSquare, Plug, RefreshCw, Shield, Sparkles, Trash2, User, UserRound, X } from "lucide-react";
import { apiFetch, userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { botDetailDrawer } from "@/lib/i18n/translations/dashboard";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDaemonStore } from "@/store/useDaemonStore";
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
import AgentAvatarPicker from "./AgentAvatarPicker";
import BotRuntimeCapabilitiesPanel from "./BotRuntimeCapabilitiesPanel";
import AgentSkillsTab from "./AgentSkillsTab";
import AgentDefaultPermission from "./AgentDefaultPermission";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";
import { mergeRuntimeFileContentResult, runtimeFileNeedsContentLoad } from "@/lib/runtime-files";

interface AgentSettingsDrawerProps {
  agentId: string;
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  hostingKind?: string | null;
  daemonInstanceId?: string | null;
  runtime?: string | null;
  runtimeModel?: string | null;
  reasoningEffort?: string | null;
  thinking?: boolean | null;
  onClose: () => void;
  onSaved?: () => void;
}

type Tab = "profile" | "policy" | "schedules" | "gateways" | "skills" | "files";
type BotDetailDrawerCopy = typeof botDetailDrawer["en"];

interface AgentRuntimeFile {
  id: string;
  name: string;
  scope: "workspace" | "memory" | "hermes" | "openclaw";
  relativePath?: string;
  runtime?: string;
  profile?: string;
  size?: number;
  mtimeMs?: number;
  content?: string | null;
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
            <Radio

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
          <span className="text-xs text-text-secondary">{emptyLabel}</span>
        ) : (
          value.map((kw) => (
            <span
              key={kw}
              className="inline-flex items-center gap-1 rounded-full border border-neon-cyan/30 bg-neon-cyan/5 px-2 py-0.5 text-xs text-neon-cyan"
            >
              {kw}
              <IconButton label="Close"
                type="button"
                onClick={() => remove(kw)}
                disabled={disabled}

              >
                <X className="h-3 w-3" />
              </IconButton>
            </span>
          ))
        )}
      </div>
      <Input
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

function scopeLabel(scope: AgentRuntimeFile["scope"], zh: boolean): string {
  if (scope === "memory") return zh ? "记忆" : "Memory";
  if (scope === "hermes") return "Hermes";
  if (scope === "openclaw") return "OpenClaw";
  return zh ? "工作目录" : "Workspace";
}

function runtimeFilesErrorMessage(data: any, status: number, t: BotDetailDrawerCopy): string {
  const detail = data?.detail;
  const code =
    typeof detail === "string"
      ? detail
      : typeof detail?.code === "string"
        ? detail.code
        : typeof data?.error === "string"
          ? data.error
          : null;
  if (status === 409 || code === "daemon_offline" || code === "agent_not_daemon_hosted") {
    return t.files.daemonUnavailable;
  }
  if (typeof data?.error === "string") return data.error;
  if (typeof detail === "string") return detail;
  if (typeof detail?.code === "string") return detail.code;
  return t.files.loadFailed;
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
        ? "border-warning/30 bg-warning-soft text-warning"
        : tone === "red"
          ? "border-danger/30 bg-danger-soft text-danger"
          : "border-neon-cyan/30 bg-neon-cyan/5 text-neon-cyan";
  return (
    <div className={`rounded-xl border px-3 py-3 ${toneClass}`}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium opacity-80">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold leading-snug">{value}</div>
    </div>
  );
}

export default withDashboardOverlayPortal(AgentSettingsDrawer);

function AgentSettingsDrawer({
  agentId,
  displayName,
  bio,
  avatarUrl,
  hostingKind,
  daemonInstanceId,
  runtime,
  runtimeModel,
  reasoningEffort,
  thinking,
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
    deleteAgent: hostingKind === "cloud"
      ? (locale === "zh" ? "删除" : "Delete")
      : (locale === "zh" ? "解除绑定" : "Unbind"),
    policyTab: locale === "zh" ? "使用规则" : "Permissions",
    filesTab: locale === "zh" ? "文件记忆" : "Files / Memory",
    skillsTab: locale === "zh" ? "技能" : "Skills",
    directContact: locale === "zh" ? "私聊权限" : "Direct contact",
    allowedSources: locale === "zh" ? "消息来源" : "Allowed sources",
    allOff: locale === "zh" ? "全部拒绝" : "All off",
    contactMe: locale === "zh" ? "私聊权限" : "Contact me directly",
    contactMeDesc: locale === "zh"
      ? "设置谁能发来私聊消息。黑名单中的用户始终无法联系。"
      : "Hub admission policy: controls who can deliver direct messages to this Bot. Blocklist still has the highest priority.",
    senderTypes: locale === "zh" ? "消息来源" : "Allowed sender types",
    agentSenderHint: locale === "zh" ? "其他 Agent" : "other bots / agents",
    humanSenderHint: locale === "zh" ? "真人用户" : "human users / dashboard",
    inviteMe: locale === "zh" ? "房间邀请" : "Who can invite me to rooms",
    keywordEmpty: locale === "zh" ? "尚未添加关键词" : "No keywords configured",
    dmReplyNote: locale === "zh"
      ? "私聊消息始终触发处理。房间有单独设置时，以房间设置为准。否则使用此处设置。"
      : "DMs always wake the Bot. Room messages use room-level overrides first, then inherit this default policy.",
  };
  const refreshUserProfile = useDashboardSessionStore((s) => s.refreshUserProfile);
  const daemons = useDaemonStore((s) => s.daemons);
  const daemon = daemonInstanceId
    ? daemons.find((entry) => entry.id === daemonInstanceId) ?? null
    : null;

  const [tab, setTab] = useState<Tab>("profile");
  const [showUnbind, setShowUnbind] = useState(false);
  const [runtimeFiles, setRuntimeFiles] = useState<AgentRuntimeFile[]>([]);
  const [runtimeLabel, setRuntimeLabel] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedFileLoading, setSelectedFileLoading] = useState<string | null>(null);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

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
  const loadGlobal = usePolicyStore((s) => s.loadGlobal);
  const patchGlobal = usePolicyStore((s) => s.patchGlobal);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policySaving, setPolicySaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPolicyError(null);
    if (!usePolicyStore.getState().globalByAgent[agentId]) {
      void loadGlobal(agentId).catch((err) => {
        if (!cancelled) setPolicyError(err instanceof Error ? err.message : String(err));
      });
    }
    return () => { cancelled = true; };
  }, [agentId, loadGlobal]);

  const loadRuntimeFileContent = useCallback(
    async (fileId: string) => {
      setSelectedFileLoading(fileId);
      try {
        const res = await apiFetch(
          `/api/agents/${encodeURIComponent(agentId)}/runtime-files?file_id=${encodeURIComponent(fileId)}`,
          {
            method: "GET",
            cache: "no-store",
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(runtimeFilesErrorMessage(data, res.status, t));
        }
        const data = (await res.json()) as AgentRuntimeFilesResponse;
        const file = Array.isArray(data.files) ? data.files[0] : null;
        setRuntimeFiles((prev) =>
          mergeRuntimeFileContentResult(prev, fileId, file, t.files.loadFailed),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : t.files.loadFailed;
        setRuntimeFiles((prev) =>
          prev.map((entry) => (entry.id === fileId ? { ...entry, error: message } : entry)),
        );
      } finally {
        setSelectedFileLoading((current) => (current === fileId ? null : current));
      }
    },
    [agentId, t],
  );

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
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/runtime-files`, {
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(runtimeFilesErrorMessage(data, res.status, t));
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

  useEffect(() => {
    if (
      tab !== "files" ||
      !runtimeFileNeedsContentLoad(selectedFile, selectedFileLoading)
    ) {
      return;
    }
    void loadRuntimeFileContent(selectedFile.id);
  }, [loadRuntimeFileContent, selectedFile, selectedFileLoading, tab]);

  const closeWithMotion = useCallback(() => {
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, drawerRef.current, {
      direction: "right",
      onComplete: onClose,
    });
  }, [onClose]);

  useEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, drawerRef.current, { onComplete: () => { if (drawerRef.current) drawerRef.current.style.transform = "none"; },
      direction: "right",
    });

    return () => {

      cleanupAnime(animationRef.current);
    };
  }, [closeWithMotion]);

  return (
    <DialogSurface overlayRef={overlayRef} panelRef={drawerRef} onClose={closeWithMotion} title={<>{displayName}</>} placement="right" overlayClassName="z-50" className="max-w-[480px] overflow-hidden">
        {/* Header */}
        <div className="liquid-toolbar flex items-center justify-between border-b border-glass-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-text-primary">
              {displayName}
            </h2>
            <p className="font-mono text-xs text-text-secondary">{agentId}</p>
          </div>
          <IconButton label="Close"
            type="button"
            onClick={closeWithMotion}
            className="ml-4"
          >
            <X className="h-5 w-5" />
          </IconButton>
        </div>

        {/* Tabs */}
        <div className="px-6">
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} variant="underline" size="sm" ariaLabel={displayName}
            items={([
              ["profile", botDetailDrawer[locale].profile.title, User],
              ["policy", labels.policyTab, MessageSquare],
              ["schedules", botDetailDrawer[locale].settings.autonomy, Clock],
              ["gateways", botDetailDrawer[locale].settings.channels, Plug],
              ["skills", labels.skillsTab, Sparkles],
              ["files", labels.filesTab, FileText],
            ] as const).map(([value, label, Icon]) => ({ value, label, icon: <Icon className="h-4 w-4" /> }))} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === "profile" && (
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-medium text-text-secondary">
                  {labels.avatar}
                </label>
                <AgentAvatarPicker
                  value={avatarVal}
                  onChange={setAvatarVal}
                  disabled={profileSaving}
                  colorLabel={locale === "zh" ? "头像颜色" : "Avatar colour"}
                  avatarLabel={labels.chooseAvatar}
                />
              </div>

              <Field label={<>{t.profile.displayName}</>}>

                <Input
                  type="text"
                  value={nameVal}
                  onChange={(e) => setNameVal(e.target.value)}
                  disabled={profileSaving}
                  maxLength={128}
                  className="w-full"
                />
              </Field>

              <Field label={<>{t.profile.bio}</>}>

                <Textarea
                  value={bioVal}
                  onChange={(e) => setBioVal(e.target.value)}
                  disabled={profileSaving}
                  rows={4}
                  maxLength={4000}
                  placeholder={t.profile.bioPlaceholder}
                  className="w-full"
                />
              </Field>

              <BotRuntimeCapabilitiesPanel
                agentId={agentId}
                daemon={daemon}
                runtimeId={runtime}
                runtimeModel={runtimeModel}
                reasoningEffort={reasoningEffort}
                thinking={thinking}
                onSaved={refreshUserProfile}
              />

              {profileError && (
                <Alert tone="danger" >
                  {profileError}
                </Alert>
              )}

              <Button variant="primary"
                type="button"
                onClick={handleSaveProfile}
                disabled={!canSaveProfile}

              >
                {profileSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t.profile.saving}
                  </>
                ) : (
                  labels.saveProfile
                )}
              </Button>

              <div className="border-t border-glass-border pt-4">
                <Button variant="danger"
                  type="button"
                  onClick={() => setShowUnbind(true)}
                  disabled={profileSaving}
                  className="w-full"
                >
                  <Trash2 className="h-4 w-4" />
                  {labels.deleteAgent}
                </Button>
              </div>
            </div>
          )}

          {tab === "policy" && (
            <div className="space-y-6">
              {policyError && (
                <Alert tone="danger" >
                  {policyError}
                  {!policy && (
                    <Button variant="ghost" type="button" className="ml-3" onClick={() => {
                      setPolicyError(null);
                      void loadGlobal(agentId).catch((err) => setPolicyError(err instanceof Error ? err.message : String(err)));
                    }}>{t.files.refresh}</Button>
                  )}
                </Alert>
              )}

              {!policy ? (
                <div className={policyError ? "hidden" : "space-y-4"}>
                  {[1, 2].map((i) => (
                    <div key={i} className="animate-pulse rounded-2xl border border-glass-border bg-glass-bg/40 p-5">
                      <Skeleton shape="block" height={16} width={112} className="mb-3" />
                      <div className="space-y-2">
                        <Skeleton shape="block" height={36} />
                        <Skeleton shape="block" height={36} />
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
                        policy.allow_human_sender ? (locale === "zh" ? "真人用户" : "Human") : null,
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
                      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-text-secondary">
                        <Bot className="h-3.5 w-3.5" />
                        {labels.senderTypes}
                      </div>
                      <Checkbox checked={policy.allow_agent_sender} onCheckedChange={(checked) => void applyPolicy({ allow_agent_sender: checked })} disabled={policySaving} label={<><span>
                          Agent
                          <span className="ml-2 text-xs text-text-secondary">{labels.agentSenderHint}</span>
                        </span></>} />
                      <Checkbox checked={policy.allow_human_sender} onCheckedChange={(checked) => void applyPolicy({ allow_human_sender: checked })} disabled={policySaving} label={<><span>
                          {locale === "zh" ? "真人用户" : "Human"}
                          <span className="ml-2 text-xs text-text-secondary">{labels.humanSenderHint}</span>
                        </span></>} />
                    </div>

                    <div className="mt-5">
                      <div className="mb-2 text-xs font-medium text-text-secondary">
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

                  <AgentDefaultPermission agentId={agentId} />

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

          {tab === "gateways" && (
            <AgentChannelsTab agentId={agentId} hostingKind={hostingKind} />
          )}

          {tab === "schedules" && <AgentSchedulesTab agentId={agentId} />}

          {tab === "skills" && <AgentSkillsTab agentId={agentId} />}

          {tab === "files" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary">{t.files.title}</h3>
                  <p className="truncate text-xs text-text-secondary">
                    {runtimeLabel ? runtimeLabel : t.files.subtitle}
                  </p>
                </div>
                <Button variant="secondary"
                  type="button"
                  onClick={() => void loadRuntimeFiles()}
                  disabled={filesLoading}
                  className="w-9 shrink-0"
                  title={t.files.refresh}
                >
                  {filesLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {filesError && (
                <Alert tone="danger" >
                  {filesError}
                </Alert>
              )}

              {filesLoading && runtimeFiles.length === 0 ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton shape="block" height={56} key={i} />
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
                        <Button aria-pressed={selected} variant="row"
                          key={file.id}
                          type="button"
                          onClick={() => setSelectedFileId(file.id)}

                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm text-text-primary">{file.name}</div>
                            <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-text-secondary">
                              <span>{scopeLabel(file.scope, locale === "zh")}</span>
                              {file.profile ? <span>{file.profile}</span> : null}
                              {size ? <span>{size}</span> : null}
                            </div>
                          </div>
                          {file.truncated ? (
                            <span className="shrink-0 rounded border border-warning/30 px-1.5 py-0.5 text-xs text-warning">
                              {t.files.tooLarge}
                            </span>
                          ) : null}
                        </Button>
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
                        {selectedFileLoading === selectedFile.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : selectedFile.error
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
      </DialogSurface>
  );
}
