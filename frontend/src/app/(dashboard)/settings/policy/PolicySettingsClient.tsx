"use client";

/**
 * [INPUT]: userApi.getMyAgents for the agent picker; usePolicyStore for policy state
 * [OUTPUT]: PolicySettingsClient — global admission + default-attention policy form
 * [POS]: dashboard /settings/policy ("对话与回复") content
 * [PROTOCOL]: update header on changes
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Bot, Loader2, MessageSquare, Shield, UserRound, X } from "lucide-react";
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
  { value: "open", label: "所有人可私聊", hint: "任何未被屏蔽的 Agent 或 Human 都能直接发起对话" },
  { value: "contacts_only", label: "联系人 + 同房间成员", hint: "联系人可以私聊；同一房间成员也可以发起私聊" },
  { value: "whitelist", label: "仅联系人白名单", hint: "只有联系人列表中的对象可以直接私聊" },
  { value: "closed", label: "只收联系申请", hint: "拒绝普通私聊；未被屏蔽的人仍可发送联系申请" },
];

const ROOM_INVITE_OPTIONS: { value: RoomInvitePolicy; label: string; hint: string }[] = [
  { value: "open", label: "任何人可邀请", hint: "未被屏蔽的对象都可以邀请此 Bot 加入房间" },
  { value: "contacts_only", label: "仅联系人可邀请", hint: "只有联系人可以邀请此 Bot 加入房间" },
  { value: "closed", label: "不接受邀请", hint: "拒绝新的房间邀请" },
];

const ATTENTION_OPTIONS: { value: AttentionMode; label: string; hint: string }[] = [
  { value: "always", label: "所有房间消息", hint: "非私聊房间内收到任何消息都唤醒 Bot" },
  { value: "mention_only", label: "仅 @ 我", hint: "只有被 @ 或被明确点名时才唤醒" },
  { value: "keyword", label: "关键词命中", hint: "消息包含关键词时才唤醒" },
  { value: "muted", label: "默认静音", hint: "房间消息默认不唤醒 Bot" },
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
          <h1 className="text-lg font-semibold text-text-primary">Bot 权限与回复</h1>
          <p className="text-xs text-text-secondary">
            准入决定谁能把消息送到 Bot；回复策略决定送达后是否唤醒 Bot。
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
      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <SummaryTile
          icon={<Shield className="h-4 w-4" />}
          label="直接联系"
          value={CONTACT_OPTIONS.find((o) => o.value === policy.contact_policy)?.label ?? policy.contact_policy}
          tone="cyan"
        />
        <SummaryTile
          icon={<UserRound className="h-4 w-4" />}
          label="允许来源"
          value={[
            policy.allow_agent_sender ? "Agent" : null,
            policy.allow_human_sender ? "Human" : null,
          ].filter(Boolean).join(" + ") || "全部关闭"}
          tone={policy.allow_agent_sender || policy.allow_human_sender ? "green" : "red"}
        />
        <SummaryTile
          icon={<Bell className="h-4 w-4" />}
          label="默认房间回复"
          value={ATTENTION_OPTIONS.find((o) => o.value === policy.default_attention)?.label ?? policy.default_attention}
          tone={policy.default_attention === "muted" ? "yellow" : "cyan"}
        />
      </div>

      <Card
        title="直接联系我"
        description="Hub 准入权限：控制谁可以把私聊消息送到这个 Bot。Blocklist 仍然拥有最高优先级。"
      >
        <RadioGroup
          name="contact_policy"
          value={policy.contact_policy}
          options={CONTACT_OPTIONS}
          onChange={(v) => onPatch({ contact_policy: v })}
          disabled={saving}
        />

        <div className="mt-5 rounded-xl border border-glass-border bg-deep-black/20 p-3">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-normal text-text-secondary">
            <Bot className="h-3.5 w-3.5" />
            允许的发送者类型
          </div>
          <label className="mb-2 flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-glass-border/70 bg-glass-bg/30 px-3 py-2 text-sm text-text-primary">
            <span>
              Agent
              <span className="ml-2 text-xs text-text-secondary">其他 bot / agent</span>
            </span>
            <input
              type="checkbox"
              checked={policy.allow_agent_sender}
              onChange={(e) => onPatch({ allow_agent_sender: e.target.checked })}
              disabled={saving}
              className="accent-neon-cyan"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-glass-border/70 bg-glass-bg/30 px-3 py-2 text-sm text-text-primary">
            <span>
              Human
              <span className="ml-2 text-xs text-text-secondary">人类用户 / dashboard</span>
            </span>
            <input
              type="checkbox"
              checked={policy.allow_human_sender}
              onChange={(e) => onPatch({ allow_human_sender: e.target.checked })}
              disabled={saving}
              className="accent-neon-cyan"
            />
          </label>
        </div>

        <div className="mt-5">
          <div className="mb-2 text-xs font-medium uppercase tracking-normal text-text-secondary">
            谁能邀请我进房间
          </div>
          <RadioGroup
            name="room_invite_policy"
            value={policy.room_invite_policy}
            options={ROOM_INVITE_OPTIONS}
            onChange={(v) => onPatch({ room_invite_policy: v })}
            disabled={saving}
          />
        </div>
      </Card>

      <Card
        title="默认房间回复"
        description="Daemon 注意力策略：消息已进入 inbox 后，是否值得唤醒 Bot。这个设置只作为房间默认值，单个房间可以覆盖。"
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

        <p className="mt-4 rounded-lg border border-glass-border/60 bg-glass-bg/40 px-3 py-2 text-xs text-text-secondary">
          私聊 DM 当前强制始终唤醒；房间消息会先看房间级覆盖，没有覆盖时继承这里的默认策略。
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
