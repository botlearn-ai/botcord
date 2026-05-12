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
  Plus,
  RefreshCw,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import {
  devBotActivities,
  devBotContactsByAgent,
  devBotGroupsByAgent,
  devBotRoomsByAgent,
  devSchedulesByAgent,
  type AutoSchedule,
  type BotContact,
  type BotGroupRef,
} from "@/lib/dev-bypass";
import BotAvatar from "./BotAvatar";
import { CompositeAvatar } from "./CompositeAvatar";

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
 * All edit operations are local-state-only in dev bypass.
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
  const overview = useDashboardChatStore((s) => s.overview);

  const open = botDetailAgentId !== null;
  const bot = botDetailAgentId ? ownedAgents.find((a) => a.agent_id === botDetailAgentId) ?? null : null;
  const stats = botDetailAgentId ? devBotActivities.find((s) => s.agent_id === botDetailAgentId) : null;
  const device = bot?.daemon_instance_id
    ? daemons.find((d) => d.id === bot.daemon_instance_id) ?? null
    : null;

  const [tab, setTab] = useState<TabKey>("overview");

  // Reset state when opening on a different bot.
  useEffect(() => {
    setTab("overview");
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

  const online = stats?.online ?? bot.ws_online;

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

  const findFriendRoomId = (friendId: string): string | null => {
    const rooms = devBotRoomsByAgent[bot.agent_id] ?? [];
    return rooms.find((r) => r.owner_id === friendId)?.room_id ?? null;
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
            <BotAvatar agentId={bot.agent_id} size={40} alt={bot.display_name} />
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
              friends={devBotContactsByAgent[bot.agent_id] ?? []}
              groups={devBotGroupsByAgent[bot.agent_id] ?? []}
              onJumpToDevice={(id) => {
                setBotDetailAgentId(null);
                setSelectedDeviceId(id);
              }}
              onJumpToFriend={(friend) => jumpToBotConversation(findFriendRoomId(friend.id))}
              onJumpToGroup={(group) => jumpToBotConversation(group.room_id)}
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
          {tab === "policy" && <PolicyTab />}
          {tab === "auto" && <AutonomousTab agentId={bot.agent_id} />}
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
  friends,
  groups,
  onJumpToDevice,
  onJumpToFriend,
  onJumpToGroup,
  onOpenChat,
  onOpenSettings,
}: {
  bot: { agent_id: string; display_name: string; bio?: string | null };
  stats: typeof devBotActivities[number] | null | undefined;
  device: { id: string; label: string | null; status: string } | null;
  friends: BotContact[];
  groups: BotGroupRef[];
  onJumpToDevice: (id: string) => void;
  onJumpToFriend: (friend: BotContact) => void;
  onJumpToGroup: (group: BotGroupRef) => void;
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
            <Stat label="消息" value={stats.messages_7d} />
            <Stat label="房间" value={stats.rooms_active} />
            <Stat label="话题" value={stats.topics_completed} />
            <Stat label="关注" value={stats.followers} delta={`+${stats.followers_delta_7d}`} />
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
          <span>好友 · {friends.length}</span>
        </h3>
        {friends.length > 0 ? (
          <ul className="space-y-1">
            {friends.slice(0, 6).map((f) => (
              <li key={`${f.type}-${f.id}`}>
                <button
                  onClick={() => onJumpToFriend(f)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg/60"
                >
                  {f.type === "agent" ? (
                    <BotAvatar agentId={f.id} size={28} alt={f.display_name} />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full border border-neon-purple/25 bg-neon-purple/10 text-[11px] font-semibold text-neon-purple">
                      {f.display_name.charAt(0)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-text-primary">{f.display_name}</span>
                      {f.online ? <span className="h-1.5 w-1.5 rounded-full bg-neon-green" /> : null}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-[9px] font-medium text-text-secondary/70">
                    {f.type === "agent" ? "BOT" : "HUMAN"}
                  </span>
                </button>
              </li>
            ))}
            {friends.length > 6 ? (
              <li className="px-2 pt-1 text-[11px] text-text-secondary/55">
                还有 {friends.length - 6} 位 · 点击查看全部 →
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="text-xs text-text-secondary/55">还没有好友</p>
        )}
      </section>

      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="mb-3 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
          <span>加入的群 · {groups.length}</span>
        </h3>
        {groups.length > 0 ? (
          <ul className="space-y-1">
            {groups.map((g) => (
              <li key={g.room_id}>
                <button
                  onClick={() => onJumpToGroup(g)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg/60"
                >
                  {g.members_preview && g.members_preview.length >= 2 ? (
                    <CompositeAvatar
                      members={g.members_preview}
                      totalMembers={g.member_count}
                      size={28}
                    />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-neon-cyan/25 bg-neon-cyan/10 text-[11px] font-semibold text-neon-cyan">
                      #
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-text-primary">{g.name}</p>
                    <p className="text-[10px] text-text-secondary/55">{g.member_count} 成员</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-text-secondary/55">还没加入任何群</p>
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
          onClick={() => alert("Delete bot (TODO)")}
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
  const dirty = name !== initialName || bio !== initialBio;

  const handleSave = () => {
    // Real impl: PATCH /api/users/me/agents/{id}; mock just marks saved.
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
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
            onClick={handleSave}
            disabled={!dirty}
            className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {saved ? "已保存 ✓" : "保存"}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-red-500/25 bg-red-500/5 p-4">
        <button
          onClick={() => alert("Delete bot (TODO)")}
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

/* --------------------------- Policy --------------------------- */

const CONTACT_OPTS = [
  { value: "open", label: "开放", hint: "任何人都可联系" },
  { value: "contacts_only", label: "仅联系人", hint: "只接收联系人的消息" },
  { value: "closed", label: "关闭", hint: "不接收新对话" },
];
const ATTENTION_OPTS = [
  { value: "always", label: "全部", hint: "群聊里收到任何消息都唤醒回复" },
  { value: "mention_only", label: "仅被 @", hint: "只在被 @ 时唤醒" },
  { value: "keyword", label: "关键词", hint: "命中关键词才唤醒" },
  { value: "muted", label: "静音", hint: "群聊不主动回复" },
];

function PolicyTab() {
  const [contact, setContact] = useState("open");
  const [allowAgent, setAllowAgent] = useState(true);
  const [allowHuman, setAllowHuman] = useState(true);
  const [attention, setAttention] = useState("mention_only");
  const [keywords, setKeywords] = useState<string[]>(["报价", "summary"]);
  const [draftKw, setDraftKw] = useState("");

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="text-sm font-semibold text-text-primary">谁能联系我</h3>
        <p className="mb-3 mt-1 text-xs text-text-secondary/65">
          是否接受来自其他 Agent 或人类用户的对话与入群邀请。
        </p>
        <div className="flex flex-col gap-1.5">
          {CONTACT_OPTS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                contact === opt.value
                  ? "border-neon-cyan/40 bg-neon-cyan/5"
                  : "border-glass-border hover:bg-glass-bg/40"
              }`}
            >
              <input
                type="radio"
                checked={contact === opt.value}
                onChange={() => setContact(opt.value)}
                className="mt-0.5 accent-neon-cyan"
              />
              <div>
                <div className="text-sm text-text-primary">{opt.label}</div>
                <div className="text-[11px] text-text-secondary/65">{opt.hint}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-text-primary/85">
            <input
              type="checkbox"
              checked={allowAgent}
              onChange={(e) => setAllowAgent(e.target.checked)}
              className="accent-neon-cyan"
            />
            接受其他 Agent 直接对话
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-text-primary/85">
            <input
              type="checkbox"
              checked={allowHuman}
              onChange={(e) => setAllowHuman(e.target.checked)}
              className="accent-neon-cyan"
            />
            接受真人用户对话
          </label>
        </div>
      </section>

      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <h3 className="text-sm font-semibold text-text-primary">默认回复策略</h3>
        <p className="mb-3 mt-1 text-xs text-text-secondary/65">
          群聊收到消息后是否唤醒 LLM。
        </p>
        <div className="flex flex-col gap-1.5">
          {ATTENTION_OPTS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                attention === opt.value
                  ? "border-neon-cyan/40 bg-neon-cyan/5"
                  : "border-glass-border hover:bg-glass-bg/40"
              }`}
            >
              <input
                type="radio"
                checked={attention === opt.value}
                onChange={() => setAttention(opt.value)}
                className="mt-0.5 accent-neon-cyan"
              />
              <div>
                <div className="text-sm text-text-primary">{opt.label}</div>
                <div className="text-[11px] text-text-secondary/65">{opt.hint}</div>
              </div>
            </label>
          ))}
        </div>
        {attention === "keyword" ? (
          <div className="mt-3">
            <p className="mb-1.5 text-xs text-text-secondary/65">关键词</p>
            <div className="flex flex-wrap gap-1.5">
              {keywords.map((kw) => (
                <span
                  key={kw}
                  className="inline-flex items-center gap-1 rounded-full border border-glass-border bg-glass-bg/40 px-2 py-0.5 text-[11px] text-text-primary"
                >
                  {kw}
                  <button
                    onClick={() => setKeywords(keywords.filter((k) => k !== kw))}
                    className="text-text-secondary/65 hover:text-red-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                value={draftKw}
                onChange={(e) => setDraftKw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && draftKw.trim()) {
                    setKeywords([...keywords, draftKw.trim()]);
                    setDraftKw("");
                  }
                }}
                placeholder="+ 添加关键词"
                className="min-w-[100px] flex-1 rounded-full border border-dashed border-glass-border bg-transparent px-2 py-0.5 text-[11px] text-text-primary placeholder-text-secondary/45 outline-none focus:border-neon-cyan/40"
              />
            </div>
          </div>
        ) : null}
        <p className="mt-3 rounded-lg border border-glass-border/50 bg-glass-bg/30 px-2.5 py-1.5 text-[11px] text-text-secondary/65">
          ⓘ 私聊不受此设置影响，始终回复
        </p>
      </section>
    </div>
  );
}

/* --------------------------- Autonomous --------------------------- */

function AutonomousTab({ agentId }: { agentId: string }) {
  const [schedules, setSchedules] = useState<AutoSchedule[]>(() => devSchedulesByAgent[agentId] ?? []);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("botcord-auto");
  const [mode, setMode] = useState<"interval" | "daily" | "weekly">("interval");
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [time, setTime] = useState("09:00");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [prompt, setPrompt] = useState("【BotCord 自主任务】执行本轮工作目标。");

  const create = () => {
    if (!name.trim() || !prompt.trim()) return;
    const item: AutoSchedule = {
      id: `sch_local_${Date.now()}`,
      name: name.trim(),
      mode,
      intervalMinutes: mode === "interval" ? intervalMinutes : undefined,
      time: mode !== "interval" ? time : undefined,
      dayOfWeek: mode === "weekly" ? dayOfWeek : undefined,
      prompt: prompt.trim(),
      enabled: true,
      last_run_at: null,
    };
    setSchedules([item, ...schedules]);
    setShowForm(false);
    setName("botcord-auto");
    setMode("interval");
    setIntervalMinutes(30);
    setPrompt("【BotCord 自主任务】执行本轮工作目标。");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">自主执行</h3>
          <p className="mt-1 text-xs text-text-secondary/65">配置 Agent 定期主动推进目标。</p>
        </div>
        <button
          onClick={() => alert("Refresh (TODO)")}
          title="刷新"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-glass-border text-text-secondary/70 transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Create new schedule */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-2 text-sm font-medium text-text-primary"
        >
          <Plus className="h-4 w-4" />
          新建 schedule
        </button>
        {showForm ? (
          <div className="mt-3 space-y-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="schedule 名称"
              className="w-full rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/40"
            />
            <div className="grid grid-cols-3 gap-2">
              {(["interval", "daily", "weekly"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                    mode === m
                      ? "border-neon-cyan/50 bg-neon-cyan/10 text-neon-cyan"
                      : "border-glass-border bg-glass-bg/30 text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {m === "interval" ? "间隔" : m === "daily" ? "每天" : "每周"}
                </button>
              ))}
            </div>

            {mode === "interval" ? (
              <div>
                <label className="mb-1 block text-[11px] text-text-secondary/65">间隔分钟</label>
                <input
                  type="number"
                  min={1}
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(Number(e.target.value) || 1)}
                  className="w-full rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/40"
                />
              </div>
            ) : (
              <div className="flex gap-2">
                {mode === "weekly" ? (
                  <div className="flex-1">
                    <label className="mb-1 block text-[11px] text-text-secondary/65">星期</label>
                    <select
                      value={dayOfWeek}
                      onChange={(e) => setDayOfWeek(Number(e.target.value))}
                      className="w-full rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/40"
                    >
                      {["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((d, i) => (
                        <option key={i} value={i}>{d}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div className="flex-1">
                  <label className="mb-1 block text-[11px] text-text-secondary/65">时间</label>
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="w-full rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/40"
                  />
                </div>
              </div>
            )}

            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="发给 Agent 的 prompt"
              className="w-full resize-none rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/40"
            />

            <button
              onClick={create}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              <Plus className="h-3.5 w-3.5" />
              创建
            </button>
          </div>
        ) : null}
      </section>

      {/* Existing schedule list */}
      {schedules.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-glass-border bg-glass-bg/20 px-4 py-8 text-center text-xs text-text-secondary/60">
          暂无 schedule
        </section>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <section key={s.id} className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm text-text-primary">{s.name}</span>
                    <span
                      className={`rounded-full border px-1.5 py-px text-[10px] ${
                        s.enabled
                          ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                          : "border-glass-border bg-glass-bg text-text-secondary/70"
                      }`}
                    >
                      {s.enabled ? "Enabled" : "Paused"}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-text-secondary/65">
                    {s.mode === "interval"
                      ? `每 ${s.intervalMinutes} 分钟`
                      : s.mode === "daily"
                        ? `每天 ${s.time}`
                        : `每${["日", "一", "二", "三", "四", "五", "六"][s.dayOfWeek ?? 0]} ${s.time}`}
                    {s.last_run_at ? ` · 上次运行 ${new Date(s.last_run_at).toLocaleString()}` : ""}
                  </p>
                  <p className="mt-2 line-clamp-2 text-xs text-text-secondary/85">{s.prompt}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    onClick={() =>
                      setSchedules(schedules.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))
                    }
                    className="text-[11px] text-text-secondary/65 hover:text-neon-cyan"
                  >
                    {s.enabled ? "暂停" : "启用"}
                  </button>
                  <button
                    onClick={() => setSchedules(schedules.filter((x) => x.id !== s.id))}
                    className="text-[11px] text-red-300/75 hover:text-red-300"
                  >
                    删除
                  </button>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
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
