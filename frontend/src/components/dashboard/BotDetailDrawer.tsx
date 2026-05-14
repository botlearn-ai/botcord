"use client";

import { useEffect, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import {
  Eye,
  FileText,
  Loader2,
  MessageCircle,
  Pencil,
  RefreshCw,
  Settings2,
  Trash2,
  Wallet as WalletIcon,
  X,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { api, userApi } from "@/lib/api";
import type { ActivityStats, HumanAgentRoomSummary } from "@/lib/types";
import { dmPeerId } from "@/components/dashboard/dmRoom";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { isOwnerChatRoom } from "@/store/dashboard-shared";
import { useDaemonStore } from "@/store/useDaemonStore";
import {
  usePolicyStore,
  type AgentPolicyPatch,
  type AttentionMode,
  type ContactPolicy,
  type RoomInvitePolicy,
} from "@/store/usePolicyStore";
import AgentChannelsTab from "./AgentChannelsTab";
import AgentSchedulesTab from "./AgentSchedulesTab";
import BotAvatar from "./BotAvatar";
import { CompositeAvatar } from "./CompositeAvatar";
import BotWalletTab from "./BotWalletTab";

type TabKey = "overview" | "wallet" | "settings" | "files";

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", label: "概览", icon: Eye },
  { key: "wallet", label: "钱包", icon: WalletIcon },
  { key: "settings", label: "设置", icon: Settings2 },
  { key: "files", label: "文件", icon: FileText },
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

interface BotFriendRoom {
  id: string;
  type: "agent" | "human";
  display_name: string;
  online?: boolean;
  room: HumanAgentRoomSummary;
}

/**
 * Right-side drawer for a single owned bot.
 * Top-level tabs keep the drawer compact: 概览 / 钱包 / 设置 / 文件.
 */
export default function BotDetailDrawer() {
  const router = useRouter();
  const {
    botDetailAgentId,
    botDetailInitialTab,
    setBotDetailAgentId,
    setSelectedDeviceId,
    setSidebarTab,
    setFocusedRoomId,
    setOpenedRoomId,
    setUserChatAgentId,
    setUserChatRoomId,
    setMessagesPane,
    setMessagesFilter,
    setMessagesBotScope,
    startPrimaryNavigation,
  } = useDashboardUIStore(
    useShallow((s) => ({
      botDetailAgentId: s.botDetailAgentId,
      botDetailInitialTab: s.botDetailInitialTab,
      setBotDetailAgentId: s.setBotDetailAgentId,
      setSelectedDeviceId: s.setSelectedDeviceId,
      setSidebarTab: s.setSidebarTab,
      setFocusedRoomId: s.setFocusedRoomId,
      setOpenedRoomId: s.setOpenedRoomId,
      setUserChatAgentId: s.setUserChatAgentId,
      setUserChatRoomId: s.setUserChatRoomId,
      setMessagesPane: s.setMessagesPane,
      setMessagesFilter: s.setMessagesFilter,
      setMessagesBotScope: s.setMessagesBotScope,
      startPrimaryNavigation: s.startPrimaryNavigation,
    })),
  );
  const { activeAgentId, ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({ activeAgentId: s.activeAgentId, ownedAgents: s.ownedAgents })),
  );
  const daemons = useDaemonStore((s) => s.daemons);
  const { ownedAgentRooms, switchActiveAgent } = useDashboardChatStore(
    useShallow((s) => ({
      ownedAgentRooms: s.ownedAgentRooms,
      switchActiveAgent: s.switchActiveAgent,
    })),
  );

  const open = botDetailAgentId !== null;
  const bot = botDetailAgentId ? ownedAgents.find((a) => a.agent_id === botDetailAgentId) ?? null : null;
  const device = bot?.daemon_instance_id
    ? daemons.find((d) => d.id === bot.daemon_instance_id) ?? null
    : null;

  const [tab, setTab] = useState<TabKey>("overview");
  const [stats, setStats] = useState<ActivityStats | null>(null);

  // Reset state when opening on a different bot. Honour an optional
  // initial-tab hint when the drawer is opened via openBotDetail() (e.g.
  // from the wallet overview's bot row).
  useEffect(() => {
    const legacySettingsTabs = new Set(["policy", "auto", "gateways"]);
    if (botDetailInitialTab && TABS.some((t) => t.key === botDetailInitialTab)) {
      setTab(botDetailInitialTab as TabKey);
    } else if (botDetailInitialTab === "profile") {
      setTab("overview");
    } else if (botDetailInitialTab && legacySettingsTabs.has(botDetailInitialTab)) {
      setTab("settings");
    } else {
      setTab("overview");
    }
  }, [botDetailAgentId, botDetailInitialTab]);

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
  const friends = deriveBotFriends(bot.agent_id, botRooms);
  const groups = botRooms.filter((room) => !isOwnerChatRoom(room.room_id) && !dmPeerId(room.room_id, bot.agent_id));

  const openOwnerChat = async () => {
    const agentId = bot.agent_id;
    setBotDetailAgentId(null);
    setSidebarTab("messages");
    setMessagesPane("user-chat");
    setUserChatAgentId(agentId);
    setUserChatRoomId(null);
    setFocusedRoomId(null);
    setOpenedRoomId(null);
    if (agentId !== activeAgentId) {
      await switchActiveAgent(agentId);
    }
    try {
      const room = await api.getUserChatRoom(agentId);
      setUserChatRoomId(room.room_id);
    } catch (error) {
      console.error("[BotDetailDrawer] getUserChatRoom failed:", error);
    }
    router.push("/chats/messages/__user-chat__");
  };

  // Jump to a conversation visible from THIS bot's perspective. Sets BOT 监控
  // scope so the Messages list narrows to this bot's rooms, then opens the room.
  const jumpToBotConversation = (roomId: string | null) => {
    setBotDetailAgentId(null);
    setMessagesFilter("bots-all");
    setMessagesBotScope(bot.agent_id);
    const path = roomId ? `/chats/messages/${encodeURIComponent(roomId)}` : "/chats/messages";
    startPrimaryNavigation("messages", path);
    router.push(path);
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
        <div className="grid grid-cols-4 border-b border-glass-border">
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex min-w-0 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors ${
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
              friends={friends}
              groups={groups}
              onJumpToDevice={(id) => {
                setBotDetailAgentId(null);
                setSelectedDeviceId(id);
              }}
              onJumpToFriend={(friend) => jumpToBotConversation(friend.room.room_id)}
              onJumpToGroup={(group) => jumpToBotConversation(group.room_id)}
              onOpenChat={() => void openOwnerChat()}
            />
          )}
          {tab === "settings" && <SettingsTab agentId={bot.agent_id} />}
          {tab === "files" && <FilesTab agentId={bot.agent_id} />}
          {tab === "wallet" && <BotWalletTab agentId={bot.agent_id} displayName={bot.display_name} />}
        </div>
      </aside>
    </>
  );
}

function deriveBotFriends(agentId: string, rooms: HumanAgentRoomSummary[]): BotFriendRoom[] {
  const seen = new Set<string>();
  const friends: BotFriendRoom[] = [];

  for (const room of rooms) {
    if (isOwnerChatRoom(room.room_id)) continue;
    const peerId = dmPeerId(room.room_id, agentId);
    if (!peerId || seen.has(peerId)) continue;

    seen.add(peerId);
    const peerBot = room.bots.find((item) => item.agent_id === peerId);
    const type = peerId.startsWith("hu_") ? "human" : "agent";
    friends.push({
      id: peerId,
      type,
      display_name: peerBot?.display_name || room.name || peerId,
      room,
    });
  }

  return friends;
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
}: {
  bot: { agent_id: string; display_name: string; bio?: string | null };
  stats: ActivityStats | null;
  device: { id: string; label: string | null; status: string } | null;
  friends: BotFriendRoom[];
  groups: HumanAgentRoomSummary[];
  onJumpToDevice: (id: string) => void;
  onJumpToFriend: (friend: BotFriendRoom) => void;
  onJumpToGroup: (group: HumanAgentRoomSummary) => void;
  onOpenChat: () => void;
}) {
  return (
    <div className="space-y-4">
      <ProfileEditor agentId={bot.agent_id} initialName={bot.display_name} initialBio={bot.bio ?? ""} />

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
          <span>好友 · {friends.length}</span>
        </h3>
        {friends.length > 0 ? (
          <ul className="space-y-1">
            {friends.slice(0, 6).map((friend) => (
              <li key={`${friend.type}-${friend.id}`}>
                <button
                  onClick={() => onJumpToFriend(friend)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg/60"
                >
                  {friend.type === "agent" ? (
                    <BotAvatar agentId={friend.id} size={28} alt={friend.display_name} />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full border border-neon-purple/25 bg-neon-purple/10 text-[11px] font-semibold text-neon-purple">
                      {friend.display_name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-text-primary">{friend.display_name}</span>
                      {friend.online ? <span className="h-1.5 w-1.5 rounded-full bg-neon-green" /> : null}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-[9px] font-medium text-text-secondary/70">
                    {friend.type === "agent" ? "BOT" : "HUMAN"}
                  </span>
                </button>
              </li>
            ))}
            {friends.length > 6 ? (
              <li className="px-2 pt-1 text-[11px] text-text-secondary/55">
                还有 {friends.length - 6} 位
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
            {groups.slice(0, 8).map((group) => (
              <li key={group.room_id}>
                <button
                  onClick={() => onJumpToGroup(group)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg/60"
                >
                  {group.bots.length >= 2 ? (
                    <CompositeAvatar
                      members={group.bots.map((member) => ({
                        display_name: member.display_name,
                        agent_id: member.agent_id,
                      }))}
                      totalMembers={group.member_count}
                      size={28}
                    />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-neon-cyan/25 bg-neon-cyan/10 text-[11px] font-semibold text-neon-cyan">
                      #
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-text-primary">{group.name}</p>
                    <p className="text-[10px] text-text-secondary/55">{group.member_count} 成员</p>
                  </div>
                </button>
              </li>
            ))}
            {groups.length > 8 ? (
              <li className="px-2 pt-1 text-[11px] text-text-secondary/55">
                还有 {groups.length - 8} 个群
              </li>
            ) : null}
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

function ProfileEditor({
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
    <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
      <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
        <Pencil className="h-3.5 w-3.5" />
        资料
      </div>
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
  );
}

/* --------------------------- Settings --------------------------- */

function SettingsTab({ agentId }: { agentId: string }) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
          对话与回复
        </h3>
        <PolicyTab agentId={agentId} />
      </section>

      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
          自主
        </h3>
        <AgentSchedulesTab agentId={agentId} />
      </section>

      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary/70">
          接入
        </h3>
        <AgentChannelsTab agentId={agentId} />
      </section>
    </div>
  );
}

/* --------------------------- Policy --------------------------- */

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

/* --------------------------- Files --------------------------- */

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

/* --------------------------- Helpers --------------------------- */

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
