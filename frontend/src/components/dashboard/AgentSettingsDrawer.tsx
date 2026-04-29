"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Settings, Trash2, User, X } from "lucide-react";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
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

interface AgentSettingsDrawerProps {
  agentId: string;
  displayName: string;
  bio?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

const CONTACT_OPTIONS: { value: ContactPolicy; label: string; hint: string }[] = [
  { value: "open", label: "公开", hint: "任何人都可以联系我" },
  { value: "contacts_only", label: "仅联系人", hint: "联系人或同房间成员" },
  { value: "whitelist", label: "白名单", hint: "仅联系人（严格）" },
  { value: "closed", label: "关闭", hint: "拒绝所有新对话（联系人申请仍可发起）" },
];

const ROOM_INVITE_OPTIONS: { value: RoomInvitePolicy; label: string }[] = [
  { value: "open", label: "公开" },
  { value: "contacts_only", label: "仅联系人" },
  { value: "closed", label: "关闭" },
];

const ATTENTION_OPTIONS: { value: AttentionMode; label: string; hint: string }[] = [
  { value: "always", label: "全部", hint: "群聊里收到任何消息都唤醒回复" },
  { value: "mention_only", label: "仅被@", hint: "只在被 @ 时唤醒" },
  { value: "keyword", label: "关键词", hint: "命中关键词才唤醒" },
  { value: "muted", label: "静音", hint: "群聊不主动回复" },
];

type Tab = "profile" | "policy";

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
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
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
          <span className="text-xs text-text-tertiary">尚未配置关键词</span>
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
        placeholder="输入关键词后按回车添加"
        className="rounded-xl border border-glass-border bg-deep-black/40 px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-neon-cyan/40 focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}

export default function AgentSettingsDrawer({
  agentId,
  displayName,
  bio,
  onClose,
  onSaved,
}: AgentSettingsDrawerProps) {
  const locale = useLanguage();
  const refreshUserProfile = useDashboardSessionStore((s) => s.refreshUserProfile);

  const [tab, setTab] = useState<Tab>("profile");
  const [showUnbind, setShowUnbind] = useState(false);

  // --- Profile state ---
  const [nameVal, setNameVal] = useState(displayName);
  const [bioVal, setBioVal] = useState(bio ?? "");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const trimmedName = nameVal.trim();
  const nameChanged = trimmedName !== displayName.trim();
  const bioChanged = bioVal.trim() !== (bio ?? "").trim();
  const canSaveProfile = !profileSaving && trimmedName.length > 0 && (nameChanged || bioChanged);

  async function handleSaveProfile() {
    if (!canSaveProfile) return;
    setProfileSaving(true);
    setProfileError(null);
    try {
      const patch: { display_name?: string; bio?: string | null } = {};
      if (nameChanged) patch.display_name = trimmedName;
      if (bioChanged) patch.bio = bioVal.trim() || null;
      await userApi.updateAgent(agentId, patch);
      await refreshUserProfile();
      onSaved?.();
    } catch (err: any) {
      setProfileError(err?.message || "保存失败");
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
        <div className="flex border-b border-glass-border/60 px-4">
          {(["profile", "policy"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex items-center gap-1.5 px-3 py-3 text-xs font-medium transition-colors ${
                tab === t
                  ? "border-b-2 border-neon-cyan text-neon-cyan"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t === "profile" ? <User className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
              {t === "profile" ? "资料" : "对话与回复"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === "profile" && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">
                  显示名称
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
                  简介
                </label>
                <textarea
                  value={bioVal}
                  onChange={(e) => setBioVal(e.target.value)}
                  disabled={profileSaving}
                  rows={4}
                  maxLength={4000}
                  placeholder="介绍这个 Agent（可选）"
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
                    保存中...
                  </>
                ) : (
                  "保存资料"
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
                  删除 Agent
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
                  <section className="rounded-2xl border border-glass-border bg-glass-bg/40 p-5">
                    <h3 className="mb-1 text-sm font-semibold text-text-primary">谁能联系我</h3>
                    <p className="mb-4 text-xs text-text-secondary">
                      是否接受来自其他 Agent 或人类用户的对话与入群邀请。
                    </p>
                    <RadioGroup
                      name={`contact_policy_${agentId}`}
                      value={policy.contact_policy}
                      options={CONTACT_OPTIONS}
                      onChange={(v) => void applyPolicy({ contact_policy: v })}
                      disabled={policySaving}
                    />
                    <div className="mt-4 flex flex-col gap-2">
                      <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                        <input
                          type="checkbox"
                          checked={policy.allow_agent_sender}
                          onChange={(e) => void applyPolicy({ allow_agent_sender: e.target.checked })}
                          disabled={policySaving}
                          className="accent-neon-cyan"
                        />
                        接受其他 agent 直接对话
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                        <input
                          type="checkbox"
                          checked={policy.allow_human_sender}
                          onChange={(e) => void applyPolicy({ allow_human_sender: e.target.checked })}
                          disabled={policySaving}
                          className="accent-neon-cyan"
                        />
                        接受人类用户对话
                      </label>
                    </div>
                    <div className="mt-4">
                      <label className="flex items-center gap-2 text-sm text-text-secondary">
                        入群邀请
                        <select
                          value={policy.room_invite_policy}
                          onChange={(e) =>
                            void applyPolicy({ room_invite_policy: e.target.value as RoomInvitePolicy })
                          }
                          disabled={policySaving}
                          className="rounded-lg border border-glass-border bg-deep-black/40 px-2 py-1 text-text-primary"
                        >
                          {ROOM_INVITE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </section>

                  <section className="rounded-2xl border border-glass-border bg-glass-bg/40 p-5">
                    <h3 className="mb-1 text-sm font-semibold text-text-primary">默认回复策略</h3>
                    <p className="mb-4 text-xs text-text-secondary">
                      Daemon 注意力：群聊里收到消息后是否唤醒 LLM。
                    </p>
                    <RadioGroup
                      name={`default_attention_${agentId}`}
                      value={policy.default_attention}
                      options={ATTENTION_OPTIONS}
                      onChange={(v) => void applyPolicy({ default_attention: v })}
                      disabled={policySaving}
                    />
                    {policy.default_attention === "keyword" && (
                      <div className="mt-4">
                        <div className="mb-2 text-xs text-text-secondary">关键词</div>
                        <KeywordChips
                          value={policy.attention_keywords}
                          onChange={(next) => void applyPolicy({ attention_keywords: next })}
                          disabled={policySaving}
                        />
                      </div>
                    )}
                    <p className="mt-4 inline-flex items-center gap-2 rounded-lg border border-glass-border/60 bg-glass-bg/40 px-3 py-2 text-xs text-text-secondary">
                      ⓘ 私聊不受此设置影响，始终回复
                    </p>
                  </section>

                  {policySaving && (
                    <div className="flex items-center gap-2 text-xs text-text-secondary">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      保存中…
                    </div>
                  )}
                </>
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
