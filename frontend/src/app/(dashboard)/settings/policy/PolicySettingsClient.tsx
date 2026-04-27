"use client";

/**
 * [INPUT]: userApi.getMyAgents for the agent picker; usePolicyStore for policy state
 * [OUTPUT]: PolicySettingsClient — global admission + default-attention policy form
 * [POS]: dashboard /settings/policy ("对话与回复") content
 * [PROTOCOL]: update header on changes
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, MessageSquare, X } from "lucide-react";
import { userApi } from "@/lib/api";
import type { UserAgent } from "@/lib/types";
import {
  usePolicyStore,
  type AgentPolicy,
  type AgentPolicyPatch,
  type AttentionMode,
  type ContactPolicy,
  type RoomInvitePolicy,
} from "@/store/usePolicyStore";

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

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 rounded-2xl border border-glass-border bg-glass-bg/40 p-6">
      <header className="mb-4">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs text-text-secondary">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
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
            className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 transition-colors ${
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
              className="mt-1 accent-neon-cyan"
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
      if (!trimmed) return;
      if (value.includes(trimmed)) return;
      onChange([...value, trimmed]);
      setDraft("");
    },
    [onChange, value],
  );

  const remove = useCallback(
    (kw: string) => {
      onChange(value.filter((v) => v !== kw));
    },
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
                aria-label={`移除关键词 ${kw}`}
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

export default function PolicySettingsClient() {
  const [agents, setAgents] = useState<UserAgent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const policy = usePolicyStore((s) =>
    selectedAgentId ? s.globalByAgent[selectedAgentId] : undefined,
  );
  const loadingPolicy = usePolicyStore((s) =>
    selectedAgentId ? Boolean(s.globalLoading[selectedAgentId]) : false,
  );
  const loadGlobal = usePolicyStore((s) => s.loadGlobal);
  const patchGlobal = usePolicyStore((s) => s.patchGlobal);

  const fetchAgents = useCallback(async () => {
    setAgentsError(null);
    try {
      const res = await userApi.getMyAgents();
      setAgents(res.agents);
      if (res.agents.length > 0 && !selectedAgentId) {
        const def =
          res.agents.find((a) => a.is_default) ?? res.agents[0];
        setSelectedAgentId(def.agent_id);
      }
    } catch (err) {
      setAgentsError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedAgentId]);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const reloadPolicy = useCallback(async () => {
    if (!selectedAgentId) return;
    setLoadError(null);
    try {
      await loadGlobal(selectedAgentId);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [loadGlobal, selectedAgentId]);

  useEffect(() => {
    void reloadPolicy();
  }, [reloadPolicy]);

  const apply = useCallback(
    async (patch: AgentPolicyPatch) => {
      if (!selectedAgentId) return;
      setSaving(true);
      setSaveError(null);
      try {
        await patchGlobal(selectedAgentId, patch);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [patchGlobal, selectedAgentId],
  );

  const headerNode = useMemo(() => {
    if (!agents) return null;
    if (agents.length <= 1) {
      const a = agents[0];
      return (
        <div className="text-sm text-text-secondary">
          当前 Agent：
          <span className="ml-1 text-text-primary">
            {a ? a.display_name : "—"}
          </span>
        </div>
      );
    }
    return (
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        Agent
        <select
          value={selectedAgentId ?? ""}
          onChange={(e) => setSelectedAgentId(e.target.value || null)}
          className="rounded-lg border border-glass-border bg-deep-black/40 px-2 py-1 text-text-primary"
        >
          {agents.map((a) => (
            <option key={a.agent_id} value={a.agent_id}>
              {a.display_name}
            </option>
          ))}
        </select>
      </label>
    );
  }, [agents, selectedAgentId]);

  if (agentsError) {
    return (
      <div className="max-w-3xl">
        <Header />
        <div className="rounded-2xl border border-red-400/20 bg-red-400/5 p-4 text-sm text-red-300">
          加载 Agent 列表失败：{agentsError}
          <button
            type="button"
            onClick={() => void fetchAgents()}
            className="ml-3 rounded border border-red-400/40 px-2 py-0.5 text-xs text-red-200 hover:bg-red-400/10"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!agents) {
    return (
      <div className="max-w-3xl">
        <Header />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="max-w-3xl">
        <Header />
        <div className="rounded-2xl border border-glass-border bg-glass-bg/40 p-6 text-sm text-text-secondary">
          你还没有任何 Agent，先去创建一个吧。
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <Header right={headerNode} />

      {loadError ? (
        <div className="mb-4 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          加载策略失败：{loadError}
          <button
            type="button"
            onClick={() => void reloadPolicy()}
            className="ml-3 rounded border border-red-400/40 px-2 py-0.5 text-xs text-red-200 hover:bg-red-400/10"
          >
            重试
          </button>
        </div>
      ) : null}

      {saveError ? (
        <div className="mb-4 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          保存失败：{saveError}
        </div>
      ) : null}

      {!policy || loadingPolicy ? (
        <>
          <SkeletonCard />
          <SkeletonCard />
        </>
      ) : (
        <PolicyForm policy={policy} saving={saving} onPatch={apply} />
      )}
    </div>
  );
}

function Header({ right }: { right?: React.ReactNode }) {
  return (
    <header className="mb-6 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5 text-neon-cyan" />
        <div>
          <h1 className="text-lg font-semibold text-text-primary">对话与回复</h1>
          <p className="text-xs text-text-secondary">
            控制谁能联系你的 Agent，以及 Agent 在群聊中的默认回复策略。
          </p>
        </div>
      </div>
      {right}
    </header>
  );
}

function SkeletonCard() {
  return (
    <section className="mb-6 animate-pulse rounded-2xl border border-glass-border bg-glass-bg/40 p-6">
      <div className="mb-4 h-4 w-32 rounded bg-glass-bg" />
      <div className="space-y-2">
        <div className="h-10 rounded bg-glass-bg/70" />
        <div className="h-10 rounded bg-glass-bg/70" />
        <div className="h-10 rounded bg-glass-bg/70" />
      </div>
    </section>
  );
}

function PolicyForm({
  policy,
  saving,
  onPatch,
}: {
  policy: AgentPolicy;
  saving: boolean;
  onPatch: (patch: AgentPolicyPatch) => void;
}) {
  return (
    <>
      <Card
        title="谁能联系我"
        description="Hub 准入：是否接受来自其他 Agent 或人类用户的对话与入群邀请。"
      >
        <RadioGroup
          name="contact_policy"
          value={policy.contact_policy}
          options={CONTACT_OPTIONS}
          onChange={(v) => onPatch({ contact_policy: v })}
          disabled={saving}
        />

        <div className="mt-4 flex flex-col gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={policy.allow_agent_sender}
              onChange={(e) => onPatch({ allow_agent_sender: e.target.checked })}
              disabled={saving}
              className="accent-neon-cyan"
            />
            接受其他 agent 直接对话
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={policy.allow_human_sender}
              onChange={(e) => onPatch({ allow_human_sender: e.target.checked })}
              disabled={saving}
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
                onPatch({ room_invite_policy: e.target.value as RoomInvitePolicy })
              }
              disabled={saving}
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
      </Card>

      <Card
        title="默认回复策略"
        description="Daemon 注意力：群聊里收到消息后是否唤醒 LLM。私聊不受此设置影响，始终回复。"
      >
        <RadioGroup
          name="default_attention"
          value={policy.default_attention}
          options={ATTENTION_OPTIONS}
          onChange={(v) => onPatch({ default_attention: v })}
          disabled={saving}
        />

        {policy.default_attention === "keyword" ? (
          <div className="mt-4">
            <div className="mb-2 text-xs text-text-secondary">关键词</div>
            <KeywordChips
              value={policy.attention_keywords}
              onChange={(next) => onPatch({ attention_keywords: next })}
              disabled={saving}
            />
          </div>
        ) : null}

        <p className="mt-4 inline-flex items-center gap-2 rounded-lg border border-glass-border/60 bg-glass-bg/40 px-3 py-2 text-xs text-text-secondary">
          ⓘ 私聊不受此设置影响，始终回复
        </p>
      </Card>

      {saving ? (
        <div className="mb-2 flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 className="h-3 w-3 animate-spin" />
          保存中…
        </div>
      ) : null}
    </>
  );
}
