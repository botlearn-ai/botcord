"use client";

import { useEffect, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import {
  Bot,
  Eye,
  FileText,
  MessageCircle,
  MessageSquare,
  Pencil,
  Plug,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { api, userApi } from "@/lib/api";
import type { ActivityStats, HumanAgentRoomSummary } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import AgentSchedulesTab from "./AgentSchedulesTab";
import BotAvatar from "./BotAvatar";

type TabKey = "overview" | "profile" | "policy" | "auto" | "gateways" | "files";

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", label: "概览", icon: Eye },
  { key: "profile", label: "资料", icon: User },
  { key: "policy", label: "对话与回复", icon: MessageSquare },
  { key: "auto", label: "自主", icon: Bot },
  { key: "gateways", label: "接入", icon: Plug },
  { key: "files", label: "文件/记忆", icon: FileText },
];

/**
 * Right-side drawer for a single owned bot.
 * 6 tabs: 概览 / 资料 / 对话与回复 / 自主 / 接入 / 文件/记忆.
 */
export default function BotDetailDrawer() {
  const router = useRouter();
  const {
    botDetailAgentId,
    setBotDetailAgentId,
    setSelectedDeviceId,
    setSidebarTab,
    setOpenedRoomId,
    setMessagesFilter,
    setMessagesBotScope,
  } = useDashboardUIStore(
    useShallow((s) => ({
      botDetailAgentId: s.botDetailAgentId,
      setBotDetailAgentId: s.setBotDetailAgentId,
      setSelectedDeviceId: s.setSelectedDeviceId,
      setSidebarTab: s.setSidebarTab,
      setOpenedRoomId: s.setOpenedRoomId,
      setMessagesFilter: s.setMessagesFilter,
      setMessagesBotScope: s.setMessagesBotScope,
    })),
  );
  const { ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents })),
  );
  const daemons = useDaemonStore((s) => s.daemons);
  const { overview, ownedAgentRooms } = useDashboardChatStore(
    useShallow((s) => ({
      overview: s.overview,
      ownedAgentRooms: s.ownedAgentRooms,
    })),
  );

  const open = botDetailAgentId !== null;
  const bot = botDetailAgentId ? ownedAgents.find((a) => a.agent_id === botDetailAgentId) ?? null : null;
  const device = bot?.daemon_instance_id
    ? daemons.find((d) => d.id === bot.daemon_instance_id) ?? null
    : null;

  const [tab, setTab] = useState<TabKey>("overview");
  const [stats, setStats] = useState<ActivityStats | null>(null);

  // Reset state when opening on a different bot.
  useEffect(() => {
    setTab("overview");
  }, [botDetailAgentId]);

  useEffect(() => {
    if (!botDetailAgentId) {
      setStats(null);
      return;
    }
    let cancelled = false;
    api.getActivityStatsBatch([botDetailAgentId], "7d")
      .then((result) => {
        if (!cancelled) setStats(result.stats?.[botDetailAgentId] ?? null);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [botDetailAgentId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBotDetailAgentId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setBotDetailAgentId]);

  if (!open || !bot) return null;

  const online = bot.ws_online;
  const botRooms = ownedAgentRooms.filter((room) => room.bots.some((item) => item.agent_id === bot.agent_id));

  // Jump to a conversation visible from THIS bot's perspective. Sets BOT 监控
  // scope so the Messages list narrows to this bot's rooms, then opens the room.
  const jumpToBotConversation = (roomId: string | null) => {
    setBotDetailAgentId(null);
    setSidebarTab("messages");
    setMessagesFilter("bots-all");
    setMessagesBotScope(bot.agent_id);
    if (roomId) {
      setOpenedRoomId(roomId);
      router.push(`/chats/messages/${encodeURIComponent(roomId)}`);
    } else {
      router.push("/chats/messages");
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
        onClick={() => setBotDetailAgentId(null)}
        aria-hidden
      />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-glass-border bg-deep-black-light shadow-2xl shadow-black/50"
        role="dialog"
        aria-label="Bot 详情"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-glass-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <BotAvatar agentId={bot.agent_id} avatarUrl={bot.avatar_url} size={40} alt={bot.display_name} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-text-primary">
                  {bot.display_name}
                </h2>
                <span className="rounded-full border border-neon-cyan/40 bg-neon-cyan/10 px-1.5 py-px text-[10px] font-medium text-neon-cyan">
                  {bot.is_default ? "My Bot · 默认" : "My Bot"}
                </span>
              </div>
              <p className={`text-[11px] ${online ? "text-neon-green" : "text-text-secondary/60"}`}>
                ● {online ? "Online" : "Offline"}
              </p>
            </div>
          </div>
          <button
            onClick={() => setBotDetailAgentId(null)}
            title="关闭"
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab strip */}
        <div className="flex border-b border-glass-border overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex shrink-0 items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium transition-colors ${
                  active
                    ? "border-b-2 border-neon-cyan text-neon-cyan"
                    : "border-b-2 border-transparent text-text-secondary hover:text-text-primary"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "overview" && (
            <OverviewTab
              bot={bot}
              stats={stats}
              device={device}
              rooms={botRooms}
              onJumpToDevice={(id) => {
                setBotDetailAgentId(null);
                setSelectedDeviceId(id);
              }}
              onJumpToRoom={(room) => jumpToBotConversation(room.room_id)}
              onOpenChat={() => {
                const dm = overview?.rooms.find(
                  (r) => r.owner_id === bot.agent_id && (r.peer_type ?? r.owner_type) === "agent",
                );
                setBotDetailAgentId(null);
                setSidebarTab("messages");
                if (dm) {
                  setOpenedRoomId(dm.room_id);
                  router.push(`/chats/messages/${encodeURIComponent(dm.room_id)}`);
                } else {
                  router.push("/chats/messages");
                }
              }}
              onOpenSettings={() => setTab("profile")}
            />
          )}
          {tab === "profile" && <ProfileTab agentId={bot.agent_id} initialName={bot.display_name} initialBio={bot.bio ?? ""} />}
          {tab === "policy" && <PlaceholderTab title="对话与回复" desc="真实策略配置请使用 Bot 设置页；这里不展示本地假配置。" />}
          {tab === "auto" && <AgentSchedulesTab agentId={bot.agent_id} />}
          {tab === "gateways" && <PlaceholderTab title="接入" desc="管理 daemon runtime 与 gateway profile（Claude Code / Codex / OpenClaw / Hermes）。" />}
          {tab === "files" && <PlaceholderTab title="文件 / 记忆" desc="查看和编辑 Agent 的运行时文件（workspace / hermes / openclaw scope）。" />}
        </div>
      </aside>
    </>
  );
}

/* --------------------------- Overview --------------------------- */

function OverviewTab({
  bot,
  stats,
  device,
  rooms,
  onJumpToDevice,
  onJumpToRoom,
  onOpenChat,
  onOpenSettings,
}: {
  bot: { agent_id: string; display_name: string; bio?: string | null };
  stats: ActivityStats | null;
  device: { id: string; label: string | null; status: string } | null;
  rooms: HumanAgentRoomSummary[];
  onJumpToDevice: (id: string) => void;
  onJumpToRoom: (room: HumanAgentRoomSummary) => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <p className="font-mono text-[11px] text-text-secondary/55">{bot.agent_id}</p>
        {bot.bio ? (
          <p className="mt-2 text-sm text-text-primary/85">{bot.bio}</p>
        ) : (
          <p className="mt-2 text-xs text-text-secondary/55">暂无简介</p>
        )}
      </section>

      {stats ? (
        <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
            7 天活跃
          </h3>
          <div className="grid grid-cols-4 gap-2 text-center">
            <Stat label="消息" value={stats.messages_sent + stats.messages_received} />
            <Stat label="房间" value={stats.active_rooms} />
            <Stat label="打开" value={stats.topics_open} />
            <Stat label="完成" value={stats.topics_completed} />
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
          托管设备
        </h3>
        {device ? (
          <button
            onClick={() => onJumpToDevice(device.id)}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-2 text-left transition-colors hover:border-neon-cyan/40"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-text-primary">
                  {device.label || device.id}
                </span>
                <span
                  className={`flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] ${
                    device.status === "online"
                      ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                      : "border-glass-border bg-glass-bg text-text-secondary/70"
                  }`}
                >
                  <span className={`h-1 w-1 rounded-full ${device.status === "online" ? "bg-neon-green" : "bg-text-secondary/40"}`} />
                  {device.status === "online" ? "Online" : "Offline"}
                </span>
              </div>
              <p className="mt-0.5 font-mono text-[10px] text-text-secondary/55">{device.id}</p>
            </div>
            <span className="shrink-0 text-[11px] text-text-secondary/65">查看 →</span>
          </button>
        ) : (
          <p className="text-xs text-text-secondary/55">未关联任何设备</p>
        )}
      </section>

      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-3 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
          <span>Bot 参与的对话 · {rooms.length}</span>
        </h3>
        {rooms.length > 0 ? (
          <ul className="space-y-1">
            {rooms.slice(0, 8).map((room) => (
              <li key={room.room_id}>
                <button
                  onClick={() => onJumpToRoom(room)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg/60"
                >
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-neon-cyan/25 bg-neon-cyan/10 text-[11px] font-semibold text-neon-cyan">
                    #
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-text-primary">{room.name}</p>
                    <p className="text-[10px] text-text-secondary/55">{room.member_count} 成员</p>
                  </div>
                  <span className="shrink-0 rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-[9px] font-medium text-text-secondary/70">
                    {room.member_count > 2 ? "GROUP" : "DM"}
                  </span>
                </button>
              </li>
            ))}
            {rooms.length > 8 ? (
              <li className="px-2 pt-1 text-[11px] text-text-secondary/55">
                还有 {rooms.length - 8} 个对话
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="text-xs text-text-secondary/55">暂无这个 Bot 参与的对话</p>
        )}
      </section>

      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <div className="flex gap-2">
          <button
            onClick={onOpenChat}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            打开对话
          </button>
          <button
            onClick={onOpenSettings}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-2 text-xs font-medium text-text-secondary/80 transition-colors hover:text-text-primary"
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑资料
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-red-500/25 bg-red-500/5 p-4">
        <button
          onClick={() => {
            if (window.confirm("确定要删除此 Bot 吗？")) {
              void userApi.unbindAgent(bot.agent_id).then(() => window.location.reload());
            }
          }}
          className="flex w-full items-center justify-between rounded-lg text-left text-xs text-red-300/85 transition-colors hover:text-red-200"
        >
          <span className="flex items-center gap-2">
            <Trash2 className="h-3.5 w-3.5" />
            删除此 Bot
          </span>
        </button>
      </section>
    </div>
  );
}

/* --------------------------- Profile --------------------------- */

function ProfileTab({
  agentId,
  initialName,
  initialBio,
}: {
  agentId: string;
  initialName: string;
  initialBio: string;
}) {
  const [name, setName] = useState(initialName);
  const [bio, setBio] = useState(initialBio);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = name !== initialName || bio !== initialBio;

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await userApi.updateAgent(agentId, {
        display_name: name.trim(),
        bio: bio.trim() || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <label className="mb-1 block text-xs text-text-secondary/65">显示名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={128}
          className="w-full rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/40"
        />
        <label className="mb-1 mt-4 block text-xs text-text-secondary/65">简介</label>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={4}
          maxLength={4000}
          placeholder="介绍这个 Bot（可选）"
          className="w-full resize-none rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/40"
        />
        <div className="mt-4 flex items-center justify-between">
          <p className="font-mono text-[10px] text-text-secondary/55">{agentId}</p>
          <button
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {saving ? "保存中..." : saved ? "已保存 ✓" : "保存"}
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
      </section>

      <section className="rounded-2xl border border-red-500/25 bg-red-500/5 p-4">
        <button
          onClick={() => {
            if (window.confirm("确定要删除此 Bot 吗？")) {
              void userApi.unbindAgent(agentId).then(() => window.location.reload());
            }
          }}
          className="flex w-full items-center justify-between rounded-lg text-left text-xs text-red-300/85 transition-colors hover:text-red-200"
        >
          <span className="flex items-center gap-2">
            <Trash2 className="h-3.5 w-3.5" />
            删除此 Bot
          </span>
        </button>
      </section>
    </div>
  );
}

/* --------------------------- Placeholder --------------------------- */

function PlaceholderTab({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-glass-border bg-glass-bg/40 text-text-secondary/70">
        <Plug className="h-6 w-6" />
      </div>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mt-2 max-w-xs text-xs text-text-secondary/65">{desc}</p>
      <p className="mt-4 rounded-full border border-dashed border-glass-border bg-glass-bg/20 px-3 py-1 text-[10px] text-text-secondary/50">
        待接通真实 daemon API
      </p>
    </div>
  );
}

/* --------------------------- Helpers --------------------------- */

function Stat({ label, value, delta }: { label: string; value: number | string; delta?: string }) {
  return (
    <div className="rounded-lg bg-glass-bg/50 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-text-secondary/55">{label}</div>
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-sm font-semibold text-text-primary">{value}</span>
        {delta ? <span className="text-[9px] font-medium text-neon-green">{delta}</span> : null}
      </div>
    </div>
  );
}
