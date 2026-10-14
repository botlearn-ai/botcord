"use client";
import EmptyState from "@/components/ui/EmptyState";
import Skeleton from "@/components/ui/Skeleton";
import Tabs from "@/components/ui/Tabs";
import Alert from "@/components/ui/Alert";
import Avatar from "@/components/ui/Avatar";
import CopyableId from "@/components/ui/CopyableId";
import Field from "@/components/ui/Field";
import { toast } from "@/store/useToastStore";
import { BotCordLoader } from "@/components/ui/BotCordLoader";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";

import Radio from "@/components/ui/Radio";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { openOwnerChat } from "@/lib/owner-chat-navigation";
import {
  Bot,
  Eye,
  FileText,
  Loader2,
  MessageCircle,
  Pencil,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Wallet as WalletIcon,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { api, apiFetch, userApi } from "@/lib/api";
import type { ActivityStats, HumanAgentRoomSummary, UserAgent } from "@/lib/types";
import { dmPeerId } from "@/components/dashboard/dmRoom";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { isOwnerChatRoom } from "@/store/dashboard-shared";
import { useDaemonStore, type DaemonInstance } from "@/store/useDaemonStore";
import { useConfirm } from "@/store/useConfirmStore";
import { useLanguage } from "@/lib/i18n";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";
import { botDetailDrawer } from "@/lib/i18n/translations/dashboard";
import {
  usePolicyStore,
  type AgentPolicyPatch,
  type AttentionMode,
  type ContactPolicy,
  type RoomInvitePolicy,
} from "@/store/usePolicyStore";
import AgentCapabilityCard from "./AgentCapabilityCard";
import AgentChannelsTab from "./AgentChannelsTab";
import AgentSchedulesTab from "./AgentSchedulesTab";
import BotRuntimeCapabilitiesPanel from "./BotRuntimeCapabilitiesPanel";
import BotAvatar from "./BotAvatar";
import { CompositeAvatar } from "./CompositeAvatar";
import BotWalletTab from "./BotWalletTab";
import DashboardSelect from "./DashboardSelect";
import AgentSkillsTab from "./AgentSkillsTab";
import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import AgentDefaultPermission from "./AgentDefaultPermission";
import { mergeRuntimeFileContentResult, runtimeFileNeedsContentLoad } from "@/lib/runtime-files";

type TabKey = "overview" | "wallet" | "settings" | "skills" | "files";
type BotDetailDrawerCopy = typeof botDetailDrawer["en"];

const TABS: { key: TabKey; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", icon: Eye },
  { key: "wallet", icon: WalletIcon },
  { key: "settings", icon: Settings2 },
  { key: "skills", icon: Sparkles },
  { key: "files", icon: FileText },
];

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
export default memo(withDashboardOverlayPortal(BotDetailDrawer));

function BotDetailDrawer() {
  const router = useRouter();
  const locale = useLanguage();
  const t = botDetailDrawer[locale];
  const {
    botDetailAgentId,
    botDetailInitialTab,
    setBotDetailAgentId,
    setSelectedDeviceId,
    setFocusedRoomId,
    setOpenedRoomId,
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
      setFocusedRoomId: s.setFocusedRoomId,
      setOpenedRoomId: s.setOpenedRoomId,
      setMessagesPane: s.setMessagesPane,
      setMessagesFilter: s.setMessagesFilter,
      setMessagesBotScope: s.setMessagesBotScope,
      startPrimaryNavigation: s.startPrimaryNavigation,
    })),
  );
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const refreshUserProfile = useDashboardSessionStore((s) => s.refreshUserProfile);
  const daemons = useDaemonStore((s) => s.daemons);
  const ownedAgentRooms = useDashboardChatStore((s) => s.ownedAgentRooms);

  const open = botDetailAgentId !== null;
  const bot = botDetailAgentId ? ownedAgents.find((a) => a.agent_id === botDetailAgentId) ?? null : null;
  const device = bot?.daemon_instance_id
    ? daemons.find((d) => d.id === bot.daemon_instance_id) ?? null
    : null;

  const [tab, setTab] = useState<TabKey>("overview");
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const motionRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const closingRef = useRef(false);

  const closeDrawer = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    cleanupAnime(motionRef.current);
    motionRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      direction: "right",
      contentSelector: "[data-overlay-section]",
      onComplete: () => setBotDetailAgentId(null),
    });
  }, [setBotDetailAgentId]);

  // Reset state when opening on a different bot. Honour an optional
  // initial-tab hint when the drawer is opened via openBotDetail() (e.g.
  // from the wallet overview's bot row).
  useEffect(() => {
    closingRef.current = false;
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
    if (!open || !bot) return;
    motionRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; },
      direction: "right",
      contentSelector: "[data-overlay-section]",
    });
    return () => cleanupAnime(motionRef.current);
  }, [bot?.agent_id, open]);

  if (!open || !bot) return null;

  const online = bot.ws_online;
  const botRooms = ownedAgentRooms.filter((room) => room.bots.some((item) => item.agent_id === bot.agent_id));
  const friends = deriveBotFriends(bot.agent_id, botRooms);
  const groups = botRooms.filter((room) => !isOwnerChatRoom(room.room_id) && !dmPeerId(room.room_id, bot.agent_id));

  const handleOpenOwnerChat = () => {
    setBotDetailAgentId(null);
    openOwnerChat(bot, (path) => router.push(path));
  };

  // Jump to a conversation visible from THIS bot's perspective. Sets BOT 监控
  // scope so the Messages list narrows to this bot's rooms, then opens the room.
  const jumpToBotConversation = (roomId: string | null) => {
    setBotDetailAgentId(null);
    setMessagesFilter("bots-all");
    setMessagesBotScope(bot.agent_id);
    const path = "/chats/messages";
    if (roomId) {
      setMessagesPane("room");
      setFocusedRoomId(roomId);
      setOpenedRoomId(roomId);
    }
    startPrimaryNavigation("messages", path);
    router.push(path);
  };

  return (
    <>
      <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeDrawer} ariaLabel={t.ariaLabel} placement="right" overlayClassName="z-40" className="max-w-md">
        {/* Header */}
        <div className="liquid-toolbar flex items-center justify-between border-b border-glass-border px-5 py-4" data-overlay-section>
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <Avatar kind="agent" id={bot.agent_id} src={bot.avatar_url} name={bot.display_name} size="lg" status={online ? "online" : "offline"} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-text-primary">{bot.display_name}</h2>
                {bot.is_default ? <Badge tone="neutral">{t.defaultBadge}</Badge> : null}
              </div>
              <CopyableId value={bot.agent_id} copyLabel={t.profile.copy} copiedLabel={t.profile.copied} copyFailedLabel={t.profile.copyFailed} />
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                <span>{online ? t.online : t.offline}</span>
                <Badge variant="outline" icon={<RuntimeLogo runtimeId={getBotRuntimeId(bot, device)} />}>
                  {getBotRuntimeId(bot, device) || t.overview.unknownRuntime}
                </Badge>
              </div>
            </div>
          </div>
          <IconButton label={t.close}
            onClick={closeDrawer}
            title={t.close}
            aria-label={t.close}
            className="w-8 shrink-0"
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        {/* Tab strip */}
        <div data-overlay-section className="px-5">
          <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)} variant="underline" size="sm" ariaLabel={t.ariaLabel}
            items={TABS.map(({ key, icon: Icon }) => ({ value: key, label: t.tabs[key], icon: <Icon className="h-4 w-4" /> }))} />
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-5 py-4" data-overlay-section>
          {tab === "overview" && (
            <OverviewTab
              key={bot.agent_id}
              t={t}
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
              onOpenChat={handleOpenOwnerChat}
            />
          )}
          {tab === "settings" && (
            <SettingsTab
              agentId={bot.agent_id}
              hostingKind={bot.hosting_kind ?? null}
              daemon={device}
              runtimeId={getBotRuntimeId(bot, device)}
              runtimeModel={bot.runtime_model ?? null}
              reasoningEffort={bot.reasoning_effort ?? null}
              thinking={bot.thinking ?? null}
              onRuntimeSaved={refreshUserProfile}
              t={t}
            />
          )}
          {tab === "skills" && <AgentSkillsTab agentId={bot.agent_id} />}
          {tab === "files" && <FilesTab agentId={bot.agent_id} t={t} />}
          {tab === "wallet" && <BotWalletTab agentId={bot.agent_id} displayName={bot.display_name} />}
        </div>
      </DialogSurface>
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
  t,
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
  t: BotDetailDrawerCopy;
  bot: UserAgent;
  stats: ActivityStats | null;
  device: DaemonInstance | null;
  friends: BotFriendRoom[];
  groups: HumanAgentRoomSummary[];
  onJumpToDevice: (id: string) => void;
  onJumpToFriend: (friend: BotFriendRoom) => void;
  onJumpToGroup: (group: HumanAgentRoomSummary) => void;
  onOpenChat: () => void;
}) {
  const [editingProfile, setEditingProfile] = useState(false);
  const confirm = useConfirm();
  return (
    <div className="space-y-4">
      <ProfileEditor
        key={bot.agent_id}
        t={t}
        agentId={bot.agent_id}
        initialName={bot.display_name}
        initialBio={bot.bio ?? ""}
        onEditingChange={setEditingProfile}
      />

      {stats ? (
        <Card as="section" padding="none" className="p-4">
          <h3 className="mb-3 text-xs font-semibold text-text-secondary">
            {t.overview.activity7d}
          </h3>
          <div className="grid grid-cols-4 gap-2 text-center">
            <Stat label={t.overview.messages} value={stats.messages_sent + stats.messages_received} />
            <Stat label={t.overview.rooms} value={stats.active_rooms} />
            <Stat label={t.overview.openTopics} value={stats.topics_open} />
            <Stat label={t.overview.completedTopics} value={stats.topics_completed} />
          </div>
        </Card>
      ) : null}

      <AgentCapabilityCard agentId={bot.agent_id} />

      <Card as="section" padding="none" className="p-4">
        <h3 className="mb-3 text-xs font-semibold text-text-secondary">
          {t.overview.hostedDevice}
        </h3>
        {device ? (
          <Button variant="row"
            onClick={() => onJumpToDevice(device.id)}
            className="w-full"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-text-primary">
                  {device.label || device.id}
                </span>
                <span
                  className={`flex items-center gap-1 rounded-full border px-1.5 py-px text-xs ${
                    device.status === "online"
                      ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                      : "border-glass-border bg-glass-bg text-text-secondary"
                  }`}
                >
                  <span className={`h-1 w-1 rounded-full ${device.status === "online" ? "bg-neon-green" : "bg-text-secondary/40"}`} />
                  {device.status === "online" ? t.online : t.offline}
                </span>
              </div>
            </div>
            <span className="shrink-0 text-xs text-text-secondary">{t.overview.view} -&gt;</span>
          </Button>
        ) : (
          <p className="text-xs text-text-secondary">{t.overview.noDevice}</p>
        )}
      </Card>

      <Card as="section" padding="none" className="p-4">
        <h3 className="mb-3 flex items-center justify-between text-xs font-semibold text-text-secondary">
          <span>{t.overview.friends(friends.length)}</span>
        </h3>
        {friends.length > 0 ? (
          <ul className="space-y-1">
            {friends.slice(0, 6).map((friend) => (
              <li key={`${friend.type}-${friend.id}`}>
                <Button variant="row"
                  onClick={() => onJumpToFriend(friend)}
                  className="w-full"
                >
                  {friend.type === "agent" ? (
                    <BotAvatar agentId={friend.id} size={28} alt={friend.display_name} />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full border border-neon-cyan/25 bg-neon-cyan/10 text-xs font-semibold text-neon-cyan">
                      {friend.display_name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-text-primary">{friend.display_name}</span>
                      {friend.online ? <span className="h-1.5 w-1.5 rounded-full bg-neon-green" /> : null}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-xs font-medium text-text-secondary">
                    {friend.type === "agent" ? "BOT" : "HUMAN"}
                  </span>
                </Button>
              </li>
            ))}
            {friends.length > 6 ? (
              <li className="px-2 pt-1 text-xs text-text-secondary">
                {t.overview.moreFriends(friends.length - 6)}
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="text-xs text-text-secondary">{t.overview.noFriends}</p>
        )}
      </Card>

      <Card as="section" padding="none" className="p-4">
        <h3 className="mb-3 flex items-center justify-between text-xs font-semibold text-text-secondary">
          <span>{t.overview.groups(groups.length)}</span>
        </h3>
        {groups.length > 0 ? (
          <ul className="space-y-1">
            {groups.slice(0, 8).map((group) => (
              <li key={group.room_id}>
                <Button variant="row"
                  onClick={() => onJumpToGroup(group)}
                  className="w-full"
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
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-neon-cyan/25 bg-neon-cyan/10 text-xs font-semibold text-neon-cyan">
                      #
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-text-primary">{group.name}</p>
                    <p className="text-xs text-text-secondary">{t.overview.members(group.member_count)}</p>
                  </div>
                </Button>
              </li>
            ))}
            {groups.length > 8 ? (
              <li className="px-2 pt-1 text-xs text-text-secondary">
                {t.overview.moreGroups(groups.length - 8)}
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="text-xs text-text-secondary">{t.overview.noGroups}</p>
        )}
      </Card>

      <Card as="section" padding="none" className="p-4">
        <div className="flex gap-2">
          <Button variant={editingProfile ? "secondary" : "primary"}
            onClick={onOpenChat}
            className="flex-1"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            {t.overview.openChat}
          </Button>
        </div>
      </Card>

      <section className="rounded-2xl border border-danger/25 bg-danger-soft p-4">
        <Button variant="danger"
          onClick={async () => {
            if (await confirm({ title: t.overview.deleteConfirm, tone: "danger" })) {
              void userApi.unbindAgent(bot.agent_id).then(() => window.location.reload());
            }
          }}
          className="w-full"
        >
          <span className="flex items-center gap-2">
            <Trash2 className="h-3.5 w-3.5" />
            {t.overview.deleteBot}
          </span>
        </Button>
      </section>
    </div>
  );
}

type RuntimeLogoEntry =
  | { kind: "img"; src: string; classes: string }
  | { kind: "icon"; Icon: LucideIcon; classes: string };

const RUNTIME_LOGO: Record<string, RuntimeLogoEntry> = {
  "claude-code": { kind: "img", src: "/runtime-logos/Claude.png", classes: "border-glass-border bg-glass-bg/40" },
  codex: { kind: "img", src: "/runtime-logos/Codex.png", classes: "border-glass-border bg-glass-bg/40" },
  "deepseek-tui": { kind: "img", src: "/runtime-logos/Deepseek.png", classes: "border-glass-border bg-glass-bg/40" },
  gemini: { kind: "img", src: "/runtime-logos/Gemini.png", classes: "border-glass-border bg-glass-bg/40" },
  "kimi-cli": { kind: "img", src: "/runtime-logos/Kimi.png", classes: "border-glass-border bg-glass-bg/40" },
  "openclaw-acp": { kind: "img", src: "/runtime-logos/Openclaw.png", classes: "border-glass-border bg-glass-bg/40" },
  qclaw: { kind: "img", src: "/runtime-logos/Qclaw.png", classes: "border-glass-border bg-glass-bg/40" },
  "hermes-agent": { kind: "img", src: "/runtime-logos/Hermes.png", classes: "border-glass-border bg-glass-bg/40" },
};

function RuntimeLogo({ runtimeId }: { runtimeId: string | null }) {
  const entry: RuntimeLogoEntry | null = runtimeId
    ? RUNTIME_LOGO[runtimeId] ?? {
        kind: "icon",
        Icon: Bot,
        classes: "border-glass-border bg-glass-bg/40 text-text-secondary",
      }
    : null;
  if (!entry) {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-glass-border bg-glass-bg/40 text-text-secondary">
        <Bot className="h-3 w-3" />
      </span>
    );
  }
  if (entry.kind === "img") {
    return (
      <span className="relative block h-5 w-5 shrink-0 overflow-hidden rounded-md">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={entry.src} alt="" className="h-full w-full object-cover" />
      </span>
    );
  }
  return (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${entry.classes}`}>
      <entry.Icon className="h-3 w-3" />
    </span>
  );
}

function getBotRuntimeId(bot: UserAgent, device: DaemonInstance | null): string | null {
  if (bot.runtime) return bot.runtime;
  for (const runtime of device?.runtimes ?? []) {
    if (runtime.profiles?.some((profile) => profile.occupiedBy === bot.agent_id)) {
      return runtime.id;
    }
    if (
      runtime.endpoints?.some((endpoint) =>
        endpoint.agents?.some((profile) => profile.botcordBinding?.agentId === bot.agent_id),
      )
    ) {
      return runtime.id;
    }
  }
  return null;
}

/* --------------------------- Profile --------------------------- */

export function ProfileEditor({
  t,
  agentId,
  initialName,
  initialBio,
  onEditingChange,
}: {
  t: BotDetailDrawerCopy;
  agentId: string;
  initialName: string;
  initialBio: string;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [profile, setProfile] = useState({ name: initialName, bio: initialBio });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [bio, setBio] = useState(initialBio);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== profile.name || bio.trim() !== profile.bio;

  useEffect(() => {
    setProfile({ name: initialName, bio: initialBio });
  }, [initialName, initialBio]);

  const startEditing = () => {
    setName(profile.name);
    setBio(profile.bio);
    setError(null);
    setEditing(true);
    onEditingChange?.(true);
  };

  const handleSave = async () => {
    if (!name.trim() || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await userApi.updateAgent(agentId, {
        display_name: name.trim(),
        bio: bio.trim() || null,
      });
      // Keep the drawer header and other Bot lists in sync with the saved values.
      const patch = { display_name: result.display_name, bio: result.bio };
      useDashboardSessionStore.setState((state) => ({
        ownedAgents: state.ownedAgents.map((agent) => agent.agent_id === agentId ? { ...agent, ...patch } : agent),
        user: state.user ? {
          ...state.user,
          agents: state.user.agents.map((agent) => agent.agent_id === agentId ? { ...agent, ...patch } : agent),
        } : null,
      }));
      setProfile({ name: result.display_name, bio: result.bio ?? "" });
      setEditing(false);
      onEditingChange?.(false);
      toast({ title: t.profile.saved, tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : t.profile.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card as="section" padding="md">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{editing ? t.profile.edit : t.profile.title}</h3>
        {!editing ? <Button variant="ghost" size="sm" onClick={startEditing}>
          <Pencil className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {t.profile.edit}
        </Button> : null}
      </div>
      {editing ? (
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void handleSave(); }}>
          <Field label={t.profile.displayName} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} required disabled={saving} autoFocus />
          </Field>
          <Field label={t.profile.bio} hint={t.profile.bioPlaceholder}>
            <Textarea value={bio} onChange={(event) => setBio(event.target.value)} rows={4} maxLength={4000} disabled={saving} />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={saving} onClick={() => { setEditing(false); onEditingChange?.(false); setError(null); }}>{t.profile.cancel}</Button>
            <Button variant="primary" type="submit" loading={saving} disabled={!name.trim() || !dirty}>
              {saving ? t.profile.saving : t.profile.save}
            </Button>
          </div>
        </form>
      ) : profile.bio ? (
        <p className="whitespace-pre-wrap break-words text-sm text-text-secondary">{profile.bio}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 text-sm text-text-secondary">
          <span>{t.profile.emptyBio}</span>
          <Button variant="inline" onClick={startEditing}>{t.profile.addBio}</Button>
        </div>
      )}
    </Card>
  );
}

/* --------------------------- Settings --------------------------- */

function SettingsTab({
  agentId,
  hostingKind,
  daemon,
  runtimeId,
  runtimeModel,
  reasoningEffort,
  thinking,
  onRuntimeSaved,
  t,
}: {
  agentId: string;
  hostingKind?: string | null;
  daemon: DaemonInstance | null;
  runtimeId: string | null;
  runtimeModel?: string | null;
  reasoningEffort?: string | null;
  thinking?: boolean | null;
  onRuntimeSaved: () => Promise<void>;
  t: BotDetailDrawerCopy;
}) {
  return (
    <div className="space-y-6">
      <BotRuntimeCapabilitiesPanel
        agentId={agentId}
        daemon={daemon}
        runtimeId={runtimeId}
        runtimeModel={runtimeModel}
        reasoningEffort={reasoningEffort}
        thinking={thinking}
        onSaved={onRuntimeSaved}
      />

      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-text-secondary">
          {t.settings.conversation}
        </h3>
        <PolicyTab agentId={agentId} t={t} />
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-text-secondary">
          {t.settings.autonomy}
        </h3>
        <AgentSchedulesTab agentId={agentId} />
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-text-secondary">
          {t.settings.channels}
        </h3>
        <AgentChannelsTab agentId={agentId} hostingKind={hostingKind} />
      </section>
    </div>
  );
}

/* --------------------------- Policy --------------------------- */

export function PolicyTab({ agentId, t }: { agentId: string; t: BotDetailDrawerCopy }) {
  const policy = usePolicyStore((s) => s.globalByAgent[agentId]);
  const loadGlobal = usePolicyStore((s) => s.loadGlobal);
  const patchGlobal = usePolicyStore((s) => s.patchGlobal);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftKeyword, setDraftKeyword] = useState("");
  const contactOptions: { value: ContactPolicy; label: string; hint: string }[] = [
    { value: "open", ...t.settings.contactOptions.open },
    { value: "contacts_only", ...t.settings.contactOptions.contacts_only },
    { value: "whitelist", ...t.settings.contactOptions.whitelist },
    { value: "closed", ...t.settings.contactOptions.closed },
  ];
  const roomInviteOptions: { value: RoomInvitePolicy; label: string }[] = [
    { value: "open", ...t.settings.roomInviteOptions.open },
    { value: "contacts_only", ...t.settings.roomInviteOptions.contacts_only },
    { value: "closed", ...t.settings.roomInviteOptions.closed },
  ];
  const attentionOptions: { value: AttentionMode; label: string; hint: string }[] = [
    { value: "always", ...t.settings.attentionOptions.always },
    { value: "mention_only", ...t.settings.attentionOptions.mention_only },
    { value: "keyword", ...t.settings.attentionOptions.keyword },
    { value: "muted", ...t.settings.attentionOptions.muted },
  ];

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!usePolicyStore.getState().globalByAgent[agentId]) {
      void loadGlobal(agentId).catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    }
    return () => { cancelled = true; };
  }, [agentId, loadGlobal]);

  const applyPolicy = async (patch: AgentPolicyPatch) => {
    setSaving(true);
    setError(null);
    try {
      await patchGlobal(agentId, patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.settings.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  if (!policy && error) {
    return (
      <Alert tone="danger" role="alert" >
        {error}
        <Button variant="ghost" type="button" className="ml-3" onClick={() => {
          setError(null);
          void loadGlobal(agentId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}>{t.files.refresh}</Button>
      </Alert>
    );
  }

  if (!policy) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card padding="none" key={i} className="p-5">
            <Skeleton shape="block" height={16} width={112} className="mb-3" />
            <div className="space-y-2">
              <Skeleton shape="block" height={36} />
              <Skeleton shape="block" height={36} />
            </div>
          </Card>
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
      {error ? <Alert tone="danger" >{error}</Alert> : null}

      <Card as="section" padding="none" className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-text-primary">{t.settings.contactTitle}</h3>
        <p className="mb-4 text-xs text-text-secondary">{t.settings.contactDescription}</p>
        <RadioGroup
          name={`contact_policy_${agentId}`}
          value={policy.contact_policy}
          options={contactOptions}
          disabled={saving}
          onChange={(value) => void applyPolicy({ contact_policy: value })}
        />
        <div className="mt-4 flex flex-col gap-2">
          <Checkbox checked={policy.allow_agent_sender} onCheckedChange={(checked) => void applyPolicy({ allow_agent_sender: checked })} disabled={saving} label={<>{t.settings.allowAgentSender}</>} />
          <Checkbox checked={policy.allow_human_sender} onCheckedChange={(checked) => void applyPolicy({ allow_human_sender: checked })} disabled={saving} label={<>{t.settings.allowHumanSender}</>} />
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-text-secondary">
          <span className="shrink-0">{t.settings.roomInvite}</span>
          <DashboardSelect
            value={policy.room_invite_policy}
            onChange={(value) => {
              if (value) void applyPolicy({ room_invite_policy: value as RoomInvitePolicy });
            }}
            disabled={saving}
            placeholder={t.settings.roomInvite}
            className="min-w-40"

            options={roomInviteOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
          />
        </label>
      </Card>

      <Card><AgentDefaultPermission agentId={agentId} /></Card>

      <Card as="section" padding="none" className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-text-primary">{t.settings.defaultReplyTitle}</h3>
        <p className="mb-4 text-xs text-text-secondary">{t.settings.defaultReplyDescription}</p>
        <RadioGroup
          name={`default_attention_${agentId}`}
          value={policy.default_attention}
          options={attentionOptions}
          disabled={saving}
          onChange={(value) => void applyPolicy({ default_attention: value })}
        />
        {policy.default_attention === "keyword" ? (
          <div className="mt-4">
            <div className="mb-2 text-xs text-text-secondary">{t.settings.keywords}</div>
            <div className="flex flex-wrap gap-1.5">
              {policy.attention_keywords.map((keyword) => (
                <span key={keyword} className="inline-flex items-center gap-1 rounded-full border border-neon-cyan/30 bg-neon-cyan/5 px-2 py-0.5 text-xs text-neon-cyan">
                  {keyword}
                  <IconButton label="Close"
                    type="button"
                    onClick={() => void applyPolicy({ attention_keywords: policy.attention_keywords.filter((item) => item !== keyword) })}
                    disabled={saving}

                  >
                    <X className="h-3 w-3" />
                  </IconButton>
                </span>
              ))}
              <Input
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
                placeholder={t.settings.keywordPlaceholder}
                className="min-w-[150px] flex-1"
              />
            </div>
          </div>
        ) : null}
        <p className="mt-4 rounded-lg border border-glass-border/60 bg-glass-bg/40 px-3 py-2 text-xs text-text-secondary">{t.settings.dmAlwaysReply}</p>
      </Card>

      {saving ? (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t.settings.saving}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------- Files --------------------------- */

function FilesTab({ agentId, t }: { agentId: string; t: BotDetailDrawerCopy }) {
  const [files, setFiles] = useState<AgentRuntimeFile[]>([]);
  const [runtimeLabel, setRuntimeLabel] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFileLoading, setSelectedFileLoading] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFileContent = useCallback(
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
        setFiles((prev) =>
          mergeRuntimeFileContentResult(prev, fileId, file, t.files.loadFailed),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : t.files.loadFailed;
        setFiles((prev) =>
          prev.map((entry) => (entry.id === fileId ? { ...entry, error: message } : entry)),
        );
      } finally {
        setSelectedFileLoading((current) => (current === fileId ? null : current));
      }
    },
    [agentId, t],
  );

  const loadFiles = async () => {
    setLoading(true);
    setError(null);
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
      const nextFiles = Array.isArray(data.files) ? data.files : [];
      setFiles(nextFiles);
      setRuntimeLabel(data.runtime ?? null);
      setSelectedFileId((prev) =>
        prev && nextFiles.some((file) => file.id === prev) ? prev : nextFiles[0]?.id ?? null,
      );
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.files.loadFailed);
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

  useEffect(() => {
    if (!runtimeFileNeedsContentLoad(selectedFile, selectedFileLoading)) {
      return;
    }
    void loadFileContent(selectedFile.id);
  }, [loadFileContent, selectedFile, selectedFileLoading]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{t.files.title}</h3>
          <p className="truncate text-xs text-text-secondary">{runtimeLabel || t.files.subtitle}</p>
        </div>
        <Button variant="secondary"
          type="button"
          onClick={() => void loadFiles()}
          disabled={loading}
          className="w-9 shrink-0"
          title={t.files.refresh}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      {error ? <Alert tone="danger" >{error}</Alert> : null}

      {loading && files.length === 0 ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton shape="block" height={56} key={i} />)}
        </div>
      ) : files.length === 0 ? (
        <EmptyState compact bordered title={<>{t.files.empty}</>} />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2">
            {files.map((file) => {
              const selected = file.id === selectedFileId;
              return (
                <Button aria-pressed={selected} variant="row"
                  key={file.id}
                  type="button"
                  onClick={() => setSelectedFileId(file.id)}

                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-primary">{file.name}</span>
                    <span className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-text-secondary">
                      <span>{scopeLabel(file.scope)}</span>
                      {file.profile ? <span>{file.profile}</span> : null}
                      {typeof file.size === "number" ? <span>{formatBytes(file.size)}</span> : null}
                    </span>
                  </span>
                  {file.truncated ? <span className="shrink-0 rounded border border-warning/30 px-1.5 py-0.5 text-xs text-warning">{t.files.tooLarge}</span> : null}
                </Button>
              );
            })}
          </div>

          {selectedFile ? (
            <section className="liquid-tool-surface rounded-xl border border-glass-border">
              <div className="border-b border-glass-border px-3 py-2">
                <div className="truncate text-xs font-medium text-text-primary">{selectedFile.name}</div>
              </div>
              <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-text-secondary">
                {selectedFileLoading === selectedFile.id ? (
                  <BotCordLoader size="xs" label={t.files.loading} className="w-full py-6" />
                ) : selectedFile.error
                  ? selectedFile.error
                  : selectedFile.truncated
                    ? t.files.previewTooLarge
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
            className={`liquid-list-row flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
              selected ? "border-neon-cyan/40 bg-neon-cyan/5" : "border-glass-border bg-transparent hover:bg-glass-bg/60"
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
    <div className="liquid-tool-surface rounded-lg px-2 py-1.5">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-sm font-semibold text-text-primary">{value}</span>
        {delta ? <span className="text-xs font-medium text-neon-green">{delta}</span> : null}
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
  if (scope === "memory") return "Memory";
  if (scope === "hermes") return "Hermes";
  if (scope === "openclaw") return "OpenClaw";
  return "Workspace";
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
