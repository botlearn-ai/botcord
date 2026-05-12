"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, Eye, FileText, Loader2, MessageCircle, MessageSquare, Pencil, Plug, RefreshCw, Trash2, User, X } from "lucide-react";
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/shallow";
import AgentChannelsTab from "./AgentChannelsTab";
import AgentSchedulesTab from "./AgentSchedulesTab";
import BotAvatar from "./BotAvatar";
import UnbindAgentDialog from "./UnbindAgentDialog";
import { api, userApi } from "@/lib/api";
import { AGENT_AVATAR_URLS } from "@/lib/agent-avatars";
import type { DashboardRoom, UserAgent } from "@/lib/types";
import { useDaemonStore } from "@/store/useDaemonStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import {
  usePolicyStore,
  type AgentPolicyPatch,
  type AttentionMode,
  type ContactPolicy,
  type RoomInvitePolicy,
} from "@/store/usePolicyStore";

type TabKey = "overview" | "profile" | "policy" | "auto" | "gateways" | "files";

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", label: "概览", icon: Eye },
  { key: "profile", label: "资料", icon: User },
  { key: "policy", label: "对话与回复", icon: MessageSquare },
  { key: "auto", label: "自主", icon: Clock },
  { key: "gateways", label: "接入", icon: Plug },
  { key: "files", label: "文件/记忆", icon: FileText },
];

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
  { value: "always", label: "全部", hint: "房间里收到任何消息都唤醒回复" },
  { value: "mention_only", label: "仅被@", hint: "只在被 @ 时唤醒" },
  { value: "keyword", label: "关键词", hint: "命中关键词才唤醒" },
  { value: "muted", label: "静音", hint: "房间不主动回复" },
];

interface AgentRuntimeFile {
  id: string;
  name: string;
  scope: "workspace" | "hermes" | "openclaw";
  runtime?: string;
  profile?: string;
  size?: number;
  content?: string;
  truncated?: boolean;
  error?: string;
}

interface AgentRuntimeFilesResponse {
  agentId: string;
  runtime?: string;
  files: AgentRuntimeFile[];
}

function buildStats(agentId: string, rooms: DashboardRoom[] | undefined) {
  const botRooms = (rooms ?? []).filter((room) => room._originAgent?.agent_id === agentId || room.owner_id === agentId);
  const activeRooms = botRooms.filter((room) => room.last_message_at).length;
  return {
    rooms: botRooms.length,
    activeRooms,
    unread: botRooms.reduce((sum, room) => sum + (room.unread_count ?? 0), 0),
    lastActiveAt: botRooms
      .map((room) => room.last_message_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null,
  };
}

function formatTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

export default function BotDetailDrawer() {
  const router = useRouter();
  const { botDetailAgentId, setBotDetailAgentId, setSelectedDeviceId, setMessagesPane, setUserChatRoomId } = useDashboardUIStore(
    useShallow((s) => ({
      botDetailAgentId: s.botDetailAgentId,
      setBotDetailAgentId: s.setBotDetailAgentId,
      setSelectedDeviceId: s.setSelectedDeviceId,
      setMessagesPane: s.setMessagesPane,
      setUserChatRoomId: s.setUserChatRoomId,
    })),
  );
  const { ownedAgents, activeAgentId, refreshUserProfile } = useDashboardSessionStore(
    useShallow((s) => ({
      ownedAgents: s.ownedAgents,
      activeAgentId: s.activeAgentId,
      refreshUserProfile: s.refreshUserProfile,
    })),
  );
  const switchActiveAgent = useDashboardChatStore((s) => s.switchActiveAgent);
  const overview = useDashboardChatStore((s) => s.overview);
  const daemons = useDaemonStore((s) => s.daemons);
  const refreshOverview = useDashboardChatStore((s) => s.refreshOverview);

  const bot = botDetailAgentId ? ownedAgents.find((a) => a.agent_id === botDetailAgentId) ?? null : null;
  const device = bot?.daemon_instance_id ? daemons.find((d) => d.id === bot.daemon_instance_id) ?? null : null;
  const stats = useMemo(() => buildStats(botDetailAgentId ?? "", overview?.rooms), [botDetailAgentId, overview?.rooms]);
  const [tab, setTab] = useState<TabKey>("overview");

  useEffect(() => {
    setTab("overview");
  }, [botDetailAgentId]);

  useEffect(() => {
    if (!botDetailAgentId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBotDetailAgentId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [botDetailAgentId, setBotDetailAgentId]);

  if (!botDetailAgentId || !bot) return null;

  const handleOpenChat = async () => {
    try {
      if (bot.agent_id !== activeAgentId) {
        await switchActiveAgent(bot.agent_id);
      }
      const room = await api.getUserChatRoom(bot.agent_id);
      setUserChatRoomId(room.room_id);
      setMessagesPane("user-chat");
      setBotDetailAgentId(null);
      router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
    } catch {
      setBotDetailAgentId(null);
      router.push("/chats/messages/__user-chat__");
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" onClick={() => setBotDetailAgentId(null)} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-glass-border bg-deep-black-light shadow-2xl shadow-black/50" role="dialog" aria-label="Bot 详情">
        <div className="flex items-center justify-between border-b border-glass-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <BotAvatar agentId={bot.agent_id} avatarUrl={bot.avatar_url} size={40} alt={bot.display_name} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-text-primary">{bot.display_name}</h2>
                <span className="rounded-full border border-neon-cyan/40 bg-neon-cyan/10 px-1.5 py-px text-[10px] font-medium text-neon-cyan">
                  {bot.is_default ? "My Bot · 默认" : "My Bot"}
                </span>
              </div>
              <p className={`text-[11px] ${bot.ws_online ? "text-neon-green" : "text-text-secondary/60"}`}>
                ● {bot.ws_online ? "Online" : "Offline"}
              </p>
            </div>
          </div>
          <button onClick={() => setBotDetailAgentId(null)} title="关闭" aria-label="关闭" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex overflow-x-auto border-b border-glass-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-xs font-medium transition-colors ${
                tab === key ? "border-neon-cyan text-neon-cyan" : "border-transparent text-text-secondary hover:text-text-primary"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "overview" ? (
            <OverviewTab
              bot={bot}
              stats={stats}
              device={device}
              onOpenChat={handleOpenChat}
              onOpenProfile={() => setTab("profile")}
              onJumpToDevice={(id) => {
                setBotDetailAgentId(null);
                setSelectedDeviceId(id);
              }}
            />
          ) : null}
          {tab === "profile" ? (
            <ProfileTab bot={bot} onSaved={async () => { await refreshUserProfile(); await refreshOverview(); }} />
          ) : null}
          {tab === "policy" ? <PolicyTab agentId={bot.agent_id} /> : null}
          {tab === "auto" ? <AgentSchedulesTab agentId={bot.agent_id} /> : null}
          {tab === "gateways" ? <AgentChannelsTab agentId={bot.agent_id} /> : null}
          {tab === "files" ? <FilesTab agentId={bot.agent_id} /> : null}
        </div>
      </aside>
    </>
  );
}

function OverviewTab({ bot, stats, device, onOpenChat, onOpenProfile, onJumpToDevice }: {
  bot: UserAgent;
  stats: ReturnType<typeof buildStats>;
  device: { id: string; label: string | null; status: string } | null;
  onOpenChat: () => void;
  onOpenProfile: () => void;
  onJumpToDevice: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <p className="font-mono text-[11px] text-text-secondary/55">{bot.agent_id}</p>
        <p className="mt-2 text-sm text-text-primary/85">{bot.bio || "暂无简介"}</p>
      </section>
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">真实活动</h3>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="会话" value={stats.rooms} />
          <Stat label="活跃" value={stats.activeRooms} />
          <Stat label="未读" value={stats.unread} />
        </div>
        <p className="mt-3 text-[11px] text-text-secondary/60">最近活动 {formatTime(stats.lastActiveAt)}</p>
      </section>
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">托管设备</h3>
        {device ? (
          <button onClick={() => onJumpToDevice(device.id)} className="flex w-full items-center justify-between gap-2 rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-2 text-left transition-colors hover:border-neon-cyan/40">
            <span className="min-w-0">
              <span className="block truncate text-sm text-text-primary">{device.label || device.id}</span>
              <span className="block font-mono text-[10px] text-text-secondary/55">{device.id}</span>
            </span>
            <span className={`text-[11px] ${device.status === "online" ? "text-neon-green" : "text-text-secondary/60"}`}>
              {device.status}
            </span>
          </button>
        ) : (
          <p className="text-xs text-text-secondary/55">未关联任何设备</p>
        )}
      </section>
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <div className="flex gap-2">
          <button onClick={onOpenChat} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20">
            <MessageCircle className="h-3.5 w-3.5" />
            打开对话
          </button>
          <button onClick={onOpenProfile} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-2 text-xs font-medium text-text-secondary/80 transition-colors hover:text-text-primary">
            <Pencil className="h-3.5 w-3.5" />
            编辑资料
          </button>
        </div>
      </section>
    </div>
  );
}

function ProfileTab({ bot, onSaved }: { bot: UserAgent; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(bot.display_name);
  const [bio, setBio] = useState(bot.bio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(bot.avatar_url ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUnbind, setShowUnbind] = useState(false);
  const dirty = name.trim() !== bot.display_name || bio !== (bot.bio ?? "") || avatarUrl !== (bot.avatar_url ?? "");

  useEffect(() => {
    setName(bot.display_name);
    setBio(bot.bio ?? "");
    setAvatarUrl(bot.avatar_url ?? "");
    setError(null);
  }, [bot.agent_id, bot.display_name, bot.bio, bot.avatar_url]);

  const handleSave = async () => {
    if (!dirty || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await userApi.updateAgent(bot.agent_id, {
        display_name: name.trim(),
        bio: bio.trim() || null,
        avatar_url: avatarUrl || null,
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <label className="mb-2 block text-xs text-text-secondary/65">头像</label>
        <div className="mb-4 grid grid-cols-6 gap-2">
          {AGENT_AVATAR_URLS.map((url) => {
            const selected = avatarUrl === url;
            return (
              <button
                key={url}
                type="button"
                onClick={() => setAvatarUrl(url)}
                disabled={saving}
                className={`aspect-square overflow-hidden rounded-full border bg-glass-bg transition-all disabled:opacity-60 ${
                  selected ? "border-neon-cyan ring-2 ring-neon-cyan/30" : "border-glass-border hover:border-neon-cyan/50"
                }`}
                aria-label="选择头像"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="h-full w-full object-cover" />
              </button>
            );
          })}
        </div>
        <label className="mb-1 block text-xs text-text-secondary/65">显示名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={128} className="w-full rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/40" />
        <label className="mb-1 mt-4 block text-xs text-text-secondary/65">简介</label>
        <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={4} maxLength={4000} placeholder="介绍这个 Bot（可选）" className="w-full resize-none rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/40" />
        {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
        <div className="mt-4 flex items-center justify-between">
          <p className="font-mono text-[10px] text-text-secondary/55">{bot.agent_id}</p>
          <button onClick={handleSave} disabled={!dirty || saving || !name.trim()} className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-50">
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-red-500/25 bg-red-500/5 p-4">
        <button
          type="button"
          onClick={() => setShowUnbind(true)}
          className="flex w-full items-center justify-between rounded-lg text-left text-xs text-red-300/85 transition-colors hover:text-red-200"
        >
          <span className="flex items-center gap-2">
            <Trash2 className="h-3.5 w-3.5" />
            删除 Agent
          </span>
        </button>
      </section>

      {showUnbind ? (
        <UnbindAgentDialog
          agentId={bot.agent_id}
          agentName={bot.display_name}
          onClose={() => setShowUnbind(false)}
          onUnbound={async () => {
            setShowUnbind(false);
            await onSaved();
          }}
        />
      ) : null}
    </div>
  );
}

function PolicyTab({ agentId }: { agentId: string }) {
  const policy = usePolicyStore((s) => s.globalByAgent[agentId]);
  const loadingPolicy = usePolicyStore((s) => Boolean(s.globalLoading[agentId]));
  const loadGlobal = usePolicyStore((s) => s.loadGlobal);
  const patchGlobal = usePolicyStore((s) => s.patchGlobal);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftKeyword, setDraftKeyword] = useState("");

  useEffect(() => {
    if (!policy && !loadingPolicy) {
      void loadGlobal(agentId).catch(() => {});
    }
  }, [agentId, loadGlobal, loadingPolicy, policy]);

  const applyPolicy = async (patch: AgentPolicyPatch) => {
    setSaving(true);
    setError(null);
    try {
      await patchGlobal(agentId, patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (!policy || loadingPolicy) {
    return (
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
    );
  }

  const addKeyword = () => {
    const value = draftKeyword.trim();
    if (!value || policy.attention_keywords.includes(value)) return;
    setDraftKeyword("");
    void applyPolicy({ attention_keywords: [...policy.attention_keywords, value] });
  };

  return (
    <div className="space-y-5">
      {error ? <div className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">{error}</div> : null}

      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-1 text-sm font-semibold text-text-primary">谁能联系我</h3>
        <p className="mb-4 text-xs text-text-secondary/65">是否接受来自其他 Agent 或人类用户的对话与加入房间邀请。</p>
        <RadioGroup
          name={`contact_policy_${agentId}`}
          value={policy.contact_policy}
          options={CONTACT_OPTIONS}
          disabled={saving}
          onChange={(value) => void applyPolicy({ contact_policy: value })}
        />
        <div className="mt-4 flex flex-col gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={policy.allow_agent_sender} onChange={(e) => void applyPolicy({ allow_agent_sender: e.target.checked })} disabled={saving} className="accent-neon-cyan" />
            接受其他 agent 直接对话
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={policy.allow_human_sender} onChange={(e) => void applyPolicy({ allow_human_sender: e.target.checked })} disabled={saving} className="accent-neon-cyan" />
            接受人类用户对话
          </label>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-text-secondary">
          加入房间邀请
          <select
            value={policy.room_invite_policy}
            onChange={(e) => void applyPolicy({ room_invite_policy: e.target.value as RoomInvitePolicy })}
            disabled={saving}
            className="rounded-lg border border-glass-border bg-deep-black/40 px-2 py-1 text-text-primary"
          >
            {ROOM_INVITE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </label>
      </section>

      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-1 text-sm font-semibold text-text-primary">默认回复策略</h3>
        <p className="mb-4 text-xs text-text-secondary/65">Daemon 注意力：房间里收到消息后是否唤醒 LLM。</p>
        <RadioGroup
          name={`default_attention_${agentId}`}
          value={policy.default_attention}
          options={ATTENTION_OPTIONS}
          disabled={saving}
          onChange={(value) => void applyPolicy({ default_attention: value })}
        />
        {policy.default_attention === "keyword" ? (
          <div className="mt-4">
            <div className="mb-2 text-xs text-text-secondary">关键词</div>
            <div className="flex flex-wrap gap-1.5">
              {policy.attention_keywords.map((keyword) => (
                <span key={keyword} className="inline-flex items-center gap-1 rounded-full border border-neon-cyan/30 bg-neon-cyan/5 px-2 py-0.5 text-xs text-neon-cyan">
                  {keyword}
                  <button
                    type="button"
                    onClick={() => void applyPolicy({ attention_keywords: policy.attention_keywords.filter((item) => item !== keyword) })}
                    disabled={saving}
                    className="rounded-full p-0.5 hover:bg-neon-cyan/10 disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                value={draftKeyword}
                onChange={(e) => setDraftKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addKeyword();
                  }
                }}
                onBlur={addKeyword}
                disabled={saving}
                placeholder="输入关键词后按回车添加"
                className="min-w-[150px] flex-1 rounded-full border border-dashed border-glass-border bg-transparent px-2 py-0.5 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-neon-cyan/40"
              />
            </div>
          </div>
        ) : null}
        <p className="mt-4 rounded-lg border border-glass-border/60 bg-glass-bg/40 px-3 py-2 text-xs text-text-secondary">私聊不受此设置影响，始终回复</p>
      </section>

      {saving ? (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 className="h-3 w-3 animate-spin" />
          保存中...
        </div>
      ) : null}
    </div>
  );
}

function FilesTab({ agentId }: { agentId: string }) {
  const [files, setFiles] = useState<AgentRuntimeFile[]>([]);
  const [runtimeLabel, setRuntimeLabel] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFiles = async () => {
    setLoading(true);
    setError(null);
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
                  ? "Daemon 未在线或此 Agent 未由 daemon 托管"
                  : "读取文件失败";
        throw new Error(msg);
      }
      const data = (await res.json()) as AgentRuntimeFilesResponse;
      const nextFiles = Array.isArray(data.files) ? data.files : [];
      setFiles(nextFiles);
      setRuntimeLabel(data.runtime ?? null);
      setSelectedFileId((prev) =>
        prev && nextFiles.some((file) => file.id === prev) ? prev : nextFiles[0]?.id ?? null,
      );
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取文件失败");
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!loaded && !loading) {
      void loadFiles();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, loaded, loading]);

  const selectedFile = files.find((file) => file.id === selectedFileId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">运行时文件</h3>
          <p className="truncate text-xs text-text-secondary">{runtimeLabel || "当前 Agent 的本地文件"}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadFiles()}
          disabled={loading}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-glass-border bg-glass-bg text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
          title="刷新"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </div>

      {error ? <div className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">{error}</div> : null}

      {loading && files.length === 0 ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-glass-bg/60" />)}
        </div>
      ) : files.length === 0 ? (
        <div className="rounded-xl border border-glass-border bg-glass-bg/40 px-4 py-8 text-center text-sm text-text-secondary">
          没有可显示的文件
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2">
            {files.map((file) => {
              const selected = file.id === selectedFileId;
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => setSelectedFileId(file.id)}
                  className={`flex min-h-[56px] items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
                    selected ? "border-neon-cyan/40 bg-neon-cyan/5" : "border-glass-border bg-glass-bg/40 hover:bg-glass-bg/70"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-primary">{file.name}</span>
                    <span className="mt-0.5 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-normal text-text-secondary">
                      <span>{scopeLabel(file.scope)}</span>
                      {file.profile ? <span>{file.profile}</span> : null}
                      {typeof file.size === "number" ? <span>{formatBytes(file.size)}</span> : null}
                    </span>
                  </span>
                  {file.truncated ? <span className="shrink-0 rounded border border-yellow-400/30 px-1.5 py-0.5 text-[10px] text-yellow-300">过大</span> : null}
                </button>
              );
            })}
          </div>

          {selectedFile ? (
            <section className="rounded-xl border border-glass-border bg-glass-bg/30">
              <div className="border-b border-glass-border px-3 py-2">
                <div className="truncate text-xs font-medium text-text-primary">{selectedFile.name}</div>
              </div>
              <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-text-secondary">
                {selectedFile.error
                  ? selectedFile.error
                  : selectedFile.truncated
                    ? "文件超过预览大小限制"
                    : selectedFile.content ?? ""}
              </pre>
            </section>
          ) : null}
        </div>
      )}
    </div>
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
            className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
              selected ? "border-neon-cyan/40 bg-neon-cyan/5" : "border-glass-border bg-transparent hover:bg-glass-bg/60"
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
            <span className="flex-1">
              <span className="block text-sm text-text-primary">{opt.label}</span>
              {opt.hint ? <span className="block text-xs text-text-secondary">{opt.hint}</span> : null}
            </span>
          </label>
        );
      })}
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

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg bg-glass-bg/50 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-text-secondary/55">{label}</div>
      <div className="text-sm font-semibold text-text-primary">{value}</div>
    </div>
  );
}
