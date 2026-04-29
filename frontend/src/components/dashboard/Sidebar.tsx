"use client";

/**
 * [INPUT]: 依赖 react 的 startTransition/useEffect/useMemo/useState 解耦导航切换、侧栏搜索与路由提交，依赖 session/ui/chat/unread/wallet store 提供导航状态、会话未读与业务动作，依赖 nextjs-toploader/app 的 useRouter 承载全局切换反馈，依赖 AccountMenu/CreateAgentDialog/SearchBar 提供账户出口、Bot 创建入口与消息列表搜索
 * [OUTPUT]: 对外提供 Sidebar 组件，渲染统一的一级/二级导航、会话列表、未读提示、Bot 创建入口与左下角账户菜单
 * [POS]: dashboard 左侧导航骨架，负责频道切换、未读入口提示与 My Bots 面板编排；无 agent 准入由 DashboardApp 顶层统一处理
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from '@/lib/i18n';
import { sidebar } from '@/lib/i18n/translations/dashboard';
import { common, nav } from '@/lib/i18n/translations/common';
import { useShallow } from "zustand/react/shallow";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import RoomList from "./RoomList";
import AccountMenu from "./AccountMenu";
import AddFriendModal from "./AddFriendModal";
import CreateRoomModal from "./CreateRoomModal";
import CreateAgentDialog from "./CreateAgentDialog";
import SettingsModal from "./SettingsModal";
import RoomZeroState from "./RoomZeroState";
import SearchBar from "./SearchBar";
import { UserPlus, Users, LogIn, Bot, Plus, RefreshCw, Settings2, Check, Loader2 } from "lucide-react";
import { messagesHeader } from "@/lib/i18n/translations/dashboard";
import { createClient } from "@/lib/supabase/client";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardRealtimeStore } from "@/store/useDashboardRealtimeStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import DaemonInstallCommand from "@/components/daemon/DaemonInstallCommand";

const USER_CHAT_ROUTE = "/chats/messages/__user-chat__";

function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const authNavItems = [
  {
    key: "messages" as const,
    label: "Messages",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
      </svg>
    ),
  },
  {
    key: "bots" as const,
    label: "My Bots",
    icon: (
      <Bot className="h-5 w-5" strokeWidth={1.5} />
    ),
  },
  {
    key: "contacts" as const,
    label: "Contacts",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
      </svg>
    ),
  },
  {
    key: "explore" as const,
    label: "Explore",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607Z" />
      </svg>
    ),
  },
  {
    key: "wallet" as const,
    label: "Wallet",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3" />
      </svg>
    ),
  },
  {
    key: "activity" as const,
    label: "Activity",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
      </svg>
    ),
  },
] as const;

interface PrimaryNavButtonProps {
  active: boolean;
  activeTone: "cyan" | "purple";
  badge?: ReactNode;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title: string;
}

function PrimaryNavButton({
  active,
  activeTone,
  badge,
  disabled = false,
  icon,
  label,
  onClick,
  title,
}: PrimaryNavButtonProps) {
  const activeClass = activeTone === "purple"
    ? "bg-neon-purple/15 text-neon-purple"
    : "bg-neon-cyan/15 text-neon-cyan";
  const indicatorClass = activeTone === "purple" ? "bg-neon-purple" : "bg-neon-cyan";

  return (
    <button
      onClick={onClick}
      className={`group relative flex h-12 w-12 flex-col items-center justify-center rounded-xl transition-all duration-200 ${
        disabled
          ? "text-text-secondary/45 hover:bg-neon-cyan/10 hover:text-neon-cyan"
          : active
          ? activeClass
          : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
      }`}
      title={title}
    >
      {active && !disabled && (
        <div className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full ${indicatorClass}`} />
      )}
      {badge}
      {icon}
      <span className="mt-0.5 text-[9px] font-medium leading-none">{label}</span>
    </button>
  );
}

interface SecondaryNavButtonProps {
  active: boolean;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
  onClick: () => void;
  tone: "cyan" | "purple";
}

function SecondaryNavButton({
  active,
  badge,
  children,
  className = "",
  onClick,
  tone,
}: SecondaryNavButtonProps) {
  const activeClass = tone === "purple"
    ? "border-neon-purple/60 bg-neon-purple/10 text-neon-purple"
    : "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan";

  return (
    <button
      onClick={onClick}
      className={`${className} w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
        active ? activeClass : "border-glass-border text-text-secondary hover:text-text-primary"
      }`}
    >
      {badge ? (
        <span className="flex items-center justify-between gap-3">
          <span>{children}</span>
          {badge}
        </span>
      ) : (
        children
      )}
    </button>
  );
}

function DeviceSettingsModal({
  daemonId,
  label,
  status,
  lastSeen,
  isRenaming,
  isRefreshing,
  locale,
  onClose,
  onRename,
  onRefreshDaemons,
}: {
  daemonId: string;
  label: string;
  status: "online" | "offline" | "revoked";
  lastSeen: string | null;
  isRenaming: boolean;
  isRefreshing: boolean;
  locale: string;
  onClose: () => void;
  onRename: (label: string) => Promise<void>;
  onRefreshDaemons: () => void;
}) {
  const [editingName, setEditingName] = useState(label);
  const [nameSaved, setNameSaved] = useState(false);
  const [showInstall, setShowInstall] = useState(false);

  async function handleRename() {
    if (editingName.trim() === label) return;
    await onRename(editingName.trim());
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  }

  const statusColor = status === "online" ? "text-neon-green" : status === "revoked" ? "text-red-400" : "text-text-secondary/50";
  const statusLabel = status === "online" ? (locale === "zh" ? "在线" : "Online") : status === "revoked" ? (locale === "zh" ? "已撤销" : "Revoked") : (locale === "zh" ? "离线" : "Offline");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-sm rounded-2xl border border-glass-border bg-deep-black-light shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-glass-border/50 px-5 py-4">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 flex-shrink-0 text-text-secondary/60">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0H3" />
          </svg>
          <span className="flex-1 text-sm font-semibold text-text-primary truncate">{label || daemonId.slice(0, 12)}</span>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary/60 transition-colors hover:bg-glass-bg hover:text-text-primary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Status row */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary/60">{locale === "zh" ? "连接状态" : "Status"}</span>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
              <button
                type="button"
                disabled={isRefreshing}
                onClick={onRefreshDaemons}
                title={locale === "zh" ? "检查连接" : "Check connection"}
                className="flex h-6 w-6 items-center justify-center rounded text-text-secondary/50 transition-colors hover:bg-glass-bg hover:text-text-secondary disabled:opacity-40"
              >
                <RefreshCw className={`h-3 w-3 ${isRefreshing ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Last seen */}
          {lastSeen && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary/60">{locale === "zh" ? "最后在线" : "Last seen"}</span>
              <span className="font-mono text-[11px] text-text-secondary/50">
                {new Date(lastSeen).toLocaleString()}
              </span>
            </div>
          )}

          {/* Rename */}
          <div className="space-y-1.5">
            <label className="text-xs text-text-secondary/60">{locale === "zh" ? "设备名称" : "Device name"}</label>
            <div className="flex gap-2">
              <input
                value={editingName}
                onChange={(e) => { setEditingName(e.target.value); setNameSaved(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); }}
                maxLength={64}
                placeholder={daemonId.slice(0, 12)}
                className="flex-1 rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-1.5 text-xs text-text-primary placeholder-text-secondary/40 outline-none focus:border-neon-cyan/40"
              />
              <button
                type="button"
                disabled={isRenaming || editingName.trim() === label}
                onClick={() => void handleRename()}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-glass-border bg-glass-bg/30 text-text-secondary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan disabled:opacity-40"
              >
                {isRenaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : nameSaved ? <Check className="h-3.5 w-3.5 text-neon-green" /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>}
              </button>
            </div>
          </div>

          {/* Restart command toggle */}
          <div>
            <button
              type="button"
              onClick={() => setShowInstall((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg border border-glass-border/50 px-3 py-2 text-xs text-text-secondary/70 transition-colors hover:border-glass-border hover:text-text-secondary"
            >
              <span>{locale === "zh" ? "重新启动命令" : "Restart command"}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3.5 w-3.5 transition-transform ${showInstall ? "rotate-180" : ""}`}><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
            </button>
            {showInstall && (
              <div className="mt-2">
                <DaemonInstallCommand
                  labels={{
                    title: locale === "zh" ? "重新启动 BotCord Daemon" : "Restart BotCord Daemon",
                    hint: locale === "zh" ? "在设备终端运行以下命令重新连接" : "Run this command in your device terminal to reconnect",
                    copy: locale === "zh" ? "复制" : "Copy",
                    copied: locale === "zh" ? "已复制" : "Copied",
                    refresh: locale === "zh" ? "刷新" : "Refresh",
                  }}
                  onRefresh={onRefreshDaemons}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const locale = useLanguage();
  const t = sidebar[locale];
  const tc = common[locale];
  const tNav = nav[locale];
  const sessionStore = useDashboardSessionStore(useShallow((state) => ({
    user: state.user,
    ownedAgents: state.ownedAgents,
    activeAgentId: state.activeAgentId,
    sessionMode: state.sessionMode,
    viewMode: state.viewMode,
    token: state.token,
    humanRooms: state.humanRooms,
    refreshUserProfile: state.refreshUserProfile,
    removeAgent: state.removeAgent,
    logout: state.logout,
  })));
  const uiStore = useDashboardUIStore(useShallow((state) => ({
    sidebarTab: state.sidebarTab,
    contactsView: state.contactsView,
    exploreView: state.exploreView,
    openedRoomId: state.openedRoomId,
    messagesPane: state.messagesPane,
    sidebarWidth: state.sidebarWidth,
    setSidebarTab: state.setSidebarTab,
    setMessagesPane: state.setMessagesPane,
    setExploreView: state.setExploreView,
    setContactsView: state.setContactsView,
    setSidebarWidth: state.setSidebarWidth,
    setOpenedRoomId: state.setOpenedRoomId,
    selectedBotAgentId: state.selectedBotAgentId,
    setSelectedBotAgentId: state.setSelectedBotAgentId,
    createBotModalOpen: state.createBotModalOpen,
    openCreateBotModal: state.openCreateBotModal,
    closeCreateBotModal: state.closeCreateBotModal,
  })));
  const chatStore = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    messages: state.messages,
    recentVisitedRooms: state.recentVisitedRooms,
    switchActiveAgent: state.switchActiveAgent,
  })));
  const unreadStore = useDashboardUnreadStore(useShallow((state) => ({
    optimisticUnreadRoomIds: state.optimisticUnreadRoomIds,
    isRoomUnread: state.isRoomUnread,
  })));
  const wallet = useDashboardWalletStore(useShallow((state) => ({
    wallet: state.wallet,
    walletError: state.walletError,
  })));
  const isGuest = sessionStore.sessionMode === "guest";
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const showCreateBot = uiStore.createBotModalOpen;
  const setShowCreateBot = (v: boolean) => v ? uiStore.openCreateBotModal() : uiStore.closeCreateBotModal();
  const [messageQuery, setMessageQuery] = useState("");
  const [refreshingBots, setRefreshingBots] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [createBotForDaemonId, setCreateBotForDaemonId] = useState<string | null>(null);
  const [deviceSettingsId, setDeviceSettingsId] = useState<string | null>(null);
  const daemons = useDaemonStore((s) => s.daemons);
  const daemonsLoaded = useDaemonStore((s) => s.loaded);
  const refreshDaemons = useDaemonStore((s) => s.refresh);
  const renameDaemon = useDaemonStore((s) => s.rename);
  const renamingId = useDaemonStore((s) => s.renamingId);
  const tMsgHeader = messagesHeader[locale];
  const showLoginModal = () => router.push("/login");

  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 480;
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(uiStore.sidebarWidth);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    startX.current = e.clientX;
    startWidth.current = uiStore.sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = ev.clientX - startX.current;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth.current + delta));
      uiStore.setSidebarWidth(next);
    };
    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [uiStore.sidebarWidth, uiStore.setSidebarWidth]);

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.warn("[Dashboard] Supabase signOut failed:", error.message);
    }
    sessionStore.logout();
    useDashboardUIStore.getState().logout();
    useDashboardChatStore.getState().logout();
    useDashboardRealtimeStore.getState().logout();
    useDashboardUnreadStore.getState().logout();
    useDashboardContactStore.getState().resetContactState();
    useDashboardWalletStore.getState().resetWalletState();
    router.push("/login");
  };

  // Load daemons whenever the bots tab is active.
  useEffect(() => {
    if (uiStore.sidebarTab === "bots" && !isGuest) {
      void refreshDaemons({ quiet: true });
    }
  }, [uiStore.sidebarTab, isGuest, refreshDaemons]);

  const tabTitles: Record<string, string> = {
    messages: t.messages,
    contacts: t.contacts,
    explore: t.discover,
    wallet: t.wallet,
    activity: t.activity,
    bots: t.myBots,
  };

  const navItems = sessionStore.viewMode === "human"
    ? authNavItems.filter((item) => item.key !== "activity")
    : authNavItems.filter((item) => item.key !== "bots");

  const visibleMessageRooms = useMemo(
    () => buildVisibleMessageRooms({
      overview: chatStore.overview,
      recentVisitedRooms: chatStore.recentVisitedRooms,
      token: sessionStore.token,
      humanRooms: sessionStore.humanRooms,
    }),
    [chatStore.overview, chatStore.recentVisitedRooms, sessionStore.token, sessionStore.humanRooms],
  );
  const normalizedMessageQuery = messageQuery.trim().toLowerCase();
  const filteredMessageRooms = useMemo(() => {
    if (!normalizedMessageQuery) {
      return visibleMessageRooms;
    }

    return visibleMessageRooms.filter((room) => {
      const cachedLatestMessage = chatStore.messages[room.room_id]?.findLast(
        (message) => message.type !== "ack" && message.type !== "result" && message.type !== "error",
      );
      const searchHaystack = [
        room.name,
        room.room_id,
        room.description,
        room.last_message_preview,
        room.last_sender_name,
        cachedLatestMessage?.text,
        cachedLatestMessage?.sender_name,
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();

      return searchHaystack.includes(normalizedMessageQuery);
    });
  }, [chatStore.messages, normalizedMessageQuery, visibleMessageRooms]);
  const showOverviewSkeleton =
    sessionStore.sessionMode === "authed-ready" && !chatStore.overview && uiStore.sidebarTab === "messages";
  const unreadMessageCount = useMemo(() => {
    const roomIds = new Set(visibleMessageRooms.map((room) => room.room_id));
    const persistedCount = visibleMessageRooms.reduce((total, room) => {
      if (!unreadStore.isRoomUnread(room.room_id, room.has_unread)) {
        return total;
      }
      return total + Math.max(1, room.unread_count ?? 1);
    }, 0);
    const optimisticOnlyCount = unreadStore.optimisticUnreadRoomIds.filter((roomId) => !roomIds.has(roomId)).length;
    return persistedCount + optimisticOnlyCount;
  }, [unreadStore, visibleMessageRooms]);
  const pendingContactRequests = chatStore.overview?.pending_requests || 0;

  useEffect(() => {
    const prefetch = (path: string) => {
      if (typeof router.prefetch !== "function") {
        return;
      }
      void router.prefetch(path);
    };

    prefetch("/chats/messages");
    prefetch(`/chats/contacts/${uiStore.contactsView}`);
    prefetch(`/chats/explore/${uiStore.exploreView}`);
    prefetch("/chats/wallet");
    prefetch("/chats/activity");
  }, [router, uiStore.contactsView, uiStore.exploreView]);

  const navigatePrimaryTab = (tab: "messages" | "contacts" | "explore" | "wallet" | "activity" | "bots") => {
    if (isGuest && (tab === "contacts" || tab === "activity" || tab === "bots")) {
      showLoginModal();
      return;
    }
    const openedRoomPath = uiStore.openedRoomId
      ? `/chats/messages/${encodeURIComponent(uiStore.openedRoomId)}`
      : uiStore.messagesPane === "user-chat"
        ? USER_CHAT_ROUTE
        : "/chats/messages";
    const pathByTab: Record<typeof tab, string> = {
      messages: openedRoomPath,
      contacts: `/chats/contacts/${uiStore.contactsView}`,
      explore: `/chats/explore/${uiStore.exploreView}`,
      wallet: "/chats/wallet",
      activity: "/chats/activity",
      bots: "/chats/bots",
    };
    uiStore.setSidebarTab(tab);
    if (tab === "messages" && !uiStore.openedRoomId && uiStore.messagesPane !== "user-chat") {
      uiStore.setMessagesPane("room");
    }
    startTransition(() => {
      router.push(pathByTab[tab]);
    });
  };

  return (
    <div className="flex h-full">
      {/* Primary rail */}
      <div className="flex h-full w-16 min-w-[64px] flex-col items-center border-r border-glass-border bg-deep-black py-3">
        <Link
          href="/"
          className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-glass-border bg-deep-black-light transition-colors hover:border-neon-cyan/50 hover:bg-glass-bg"
          title={tNav.home}
        >
          <img src="/logo.svg" alt="BotCord" className="h-6 w-6" />
        </Link>
        {/* Nav icons */}
        <div className="flex flex-1 flex-col items-center gap-1 pt-1">
          {navItems.map((item) => {
            const isActive = uiStore.sidebarTab === item.key;
            const isExplore = item.key === "explore";
            const requiresLogin = isGuest && (item.key === "contacts" || item.key === "activity");
            let badge: ReactNode = null;
            if (item.key === "messages" && unreadMessageCount > 0 && !requiresLogin) {
              badge = (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-neon-cyan px-1 text-[9px] font-bold leading-none text-black shadow-[0_0_12px_rgba(34,211,238,0.45)]">
                  {formatBadgeCount(unreadMessageCount)}
                </span>
              );
            }
            if (item.key === "contacts" && pendingContactRequests > 0 && !requiresLogin) {
              badge = (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-neon-cyan px-1 text-[9px] font-bold text-black shadow-[0_0_12px_rgba(34,211,238,0.45)]">
                  {pendingContactRequests > 9 ? "9+" : pendingContactRequests}
                </span>
              );
            }
            return (
              <PrimaryNavButton
                key={item.key}
                onClick={() => navigatePrimaryTab(item.key)}
                active={isActive}
                activeTone={isExplore ? "purple" : "cyan"}
                badge={badge}
                disabled={requiresLogin}
                icon={item.icon}
                label={tabTitles[item.key] || item.label}
                title={requiresLogin ? tc.login : tabTitles[item.key] || item.label}
              />
            );
          })}
        </div>

        {/* Bottom: invite + user avatar */}
        <div className="flex flex-col items-center gap-2 border-t border-glass-border pt-3">
          {isGuest ? (
            /* Guest: Login button */
            <button
              onClick={showLoginModal}
              className="flex h-10 w-12 flex-col items-center justify-center rounded-xl text-neon-cyan transition-all duration-200 hover:bg-neon-cyan/10"
              title={tc.login}
            >
              <LogIn className="h-5 w-5" strokeWidth={1.75} />
              <span className="mt-0.5 text-[9px] font-medium leading-none">{tc.login}</span>
            </button>
          ) : (
            <>
              <AccountMenu
                user={sessionStore.user}
                agents={sessionStore.ownedAgents}
                activeAgentId={sessionStore.activeAgentId}
                pendingRequests={chatStore.overview?.pending_requests || 0}
                onSwitchAgent={chatStore.switchActiveAgent}
                onOpenCreateBot={() => setShowCreateBot(true)}
                onOpenSettings={() => setShowSettings(true)}
                onLogout={handleLogout}
              />
              {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
            </>
          )}
        </div>
      </div>

      {showAddFriend && <AddFriendModal onClose={() => setShowAddFriend(false)} />}
      {showCreateRoom && (
        <CreateRoomModal
          onClose={() => setShowCreateRoom(false)}
          onCreated={(room) => {
            setShowCreateRoom(false);
            uiStore.setOpenedRoomId(room.room_id);
            router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
          }}
        />
      )}
      {(showCreateBot || createBotForDaemonId !== null) && (
        <CreateAgentDialog
          onClose={() => {
            setShowCreateBot(false);
            setCreateBotForDaemonId(null);
          }}
          preselectedDaemonId={createBotForDaemonId}
          onSuccess={async (agentId) => {
            setShowCreateBot(false);
            setCreateBotForDaemonId(null);
            await sessionStore.refreshUserProfile();
            uiStore.setSidebarTab("bots");
            uiStore.setSelectedBotAgentId(agentId);
            startTransition(() => {
              router.push(`/chats/bots/${encodeURIComponent(agentId)}`);
            });
          }}
        />
      )}

      {/* Secondary panel */}
      <div className="relative flex h-full flex-col border-r border-glass-border bg-deep-black-light" style={{ width: uiStore.sidebarWidth, minWidth: SIDEBAR_MIN }}>
        {/* Resize handle */}
        <div
          onMouseDown={handleResizeStart}
          className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-neon-cyan/30 active:bg-neon-cyan/50"
        />
        {/* Panel header */}
        <div className="flex min-h-14 items-center justify-between border-b border-glass-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              {tabTitles[uiStore.sidebarTab]}
            </h2>
            {isGuest && (
              <p className="truncate text-[10px] text-text-secondary/60">
                {t.browseAsGuest}
              </p>
            )}
          </div>
          {uiStore.sidebarTab === "messages" && !isGuest && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowAddFriend(true)}
                title={tMsgHeader.addFriend}
                aria-label={tMsgHeader.addFriend}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan"
              >
                <UserPlus className="h-4 w-4" />
              </button>
              <button
                onClick={() => setShowCreateRoom(true)}
                title={tMsgHeader.createRoom}
                aria-label={tMsgHeader.createRoom}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan"
              >
                <Users className="h-4 w-4" />
              </button>
            </div>
          )}
          {uiStore.sidebarTab === "bots" && !isGuest && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={refreshingBots}
                onClick={async () => {
                  if (refreshingBots) return;
                  setRefreshingBots(true);
                  try {
                    await Promise.all([
                      sessionStore.refreshUserProfile(),
                      refreshDaemons(),
                    ]);
                  } finally {
                    setRefreshingBots(false);
                  }
                }}
                title="Refresh status"
                aria-label="Refresh status"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${refreshingBots ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={() => setShowCreateBot(true)}
                title={t.createBot}
                aria-label={t.createBot}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Secondary navigation */}
        {uiStore.sidebarTab === "explore" && (
          <div className="border-b border-glass-border p-3">
            <SecondaryNavButton
              onClick={() => {
                uiStore.setExploreView("rooms");
                startTransition(() => {
                  router.push("/chats/explore/rooms");
                });
              }}
              active={uiStore.exploreView === "rooms"}
              tone="purple"
            >
              {t.publicRooms}
            </SecondaryNavButton>
            <SecondaryNavButton
              onClick={() => {
                uiStore.setExploreView("agents");
                startTransition(() => {
                  router.push("/chats/explore/agents");
                });
              }}
              active={uiStore.exploreView === "agents"}
              className="mt-2"
              tone="purple"
            >
              {t.agents}
            </SecondaryNavButton>
            <SecondaryNavButton
              onClick={() => {
                uiStore.setExploreView("humans");
                startTransition(() => {
                  router.push("/chats/explore/humans");
                });
              }}
              active={uiStore.exploreView === "humans"}
              className="mt-2"
              tone="purple"
            >
              {t.publicHumans}
            </SecondaryNavButton>
          </div>
        )}

        {uiStore.sidebarTab === "contacts" && (
          <div className="border-b border-glass-border p-3">
            <SecondaryNavButton
              onClick={() => {
                uiStore.setContactsView("requests");
                startTransition(() => {
                  router.push("/chats/contacts/requests");
                });
              }}
              active={uiStore.contactsView === "requests"}
              badge={pendingContactRequests > 0 ? (
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-neon-cyan px-1.5 text-[10px] font-bold text-black">
                  {pendingContactRequests > 99 ? "99+" : pendingContactRequests}
                </span>
              ) : undefined}
              tone="cyan"
            >
              {t.friendRequests}
            </SecondaryNavButton>
            <SecondaryNavButton
              onClick={() => {
                uiStore.setContactsView("agents");
                startTransition(() => {
                  router.push("/chats/contacts/agents");
                });
              }}
              active={uiStore.contactsView === "agents"}
              className="mt-2"
              tone="cyan"
            >
              {t.myFriends}
            </SecondaryNavButton>
            <SecondaryNavButton
              onClick={() => {
                uiStore.setContactsView("rooms");
                startTransition(() => {
                  router.push("/chats/contacts/rooms");
                });
              }}
              active={uiStore.contactsView === "rooms"}
              className="mt-2"
              tone="cyan"
            >
              {t.joinedRooms}
            </SecondaryNavButton>
            <SecondaryNavButton
              onClick={() => {
                uiStore.setContactsView("created");
                startTransition(() => {
                  router.push("/chats/contacts/created");
                });
              }}
              active={uiStore.contactsView === "created"}
              className="mt-2"
              tone="cyan"
            >
              {t.createdRooms}
            </SecondaryNavButton>
          </div>
        )}

        {/* Panel content */}
        <div className="flex-1 overflow-y-auto">
          {uiStore.sidebarTab === "messages" && (
            <div className="flex min-h-full flex-col py-1">
              <div className="border-b border-glass-border px-3 pb-3">
                <SearchBar onSearch={setMessageQuery} placeholder={t.searchMessages} />
              </div>
              {visibleMessageRooms.length === 0 && !sessionStore.activeAgentId ? (
                <RoomZeroState compact />
              ) : !showOverviewSkeleton && filteredMessageRooms.length === 0 && !sessionStore.activeAgentId ? (
                <div className="px-4 py-6 text-center text-xs text-text-secondary">
                  {t.noMessages}
                </div>
              ) : (
                <>
                  <RoomList rooms={filteredMessageRooms} loading={showOverviewSkeleton} searchQuery={messageQuery} />
                  {!showOverviewSkeleton && !normalizedMessageQuery && filteredMessageRooms.length < 5 && (
                    <div className="mx-3 mb-3 mt-auto rounded-2xl border border-dashed border-glass-border/60 bg-glass-bg/20 p-4">
                      <p className="text-[11px] font-semibold text-text-secondary/80">
                        {locale === "zh" ? "发现更多社区" : "Discover communities"}
                      </p>
                      <p className="mt-1 text-[11px] leading-4 text-text-secondary/55">
                        {locale === "zh" ? "加入公开房间，或创建你自己的社区" : "Join a public room or create your own."}
                      </p>
                      <div className="mt-3 flex flex-col gap-2">
                        {!isGuest && (
                          <button
                            type="button"
                            onClick={() => setShowCreateRoom(true)}
                            className="rounded-xl border border-neon-purple/35 bg-neon-purple/10 px-3 py-1.5 text-[11px] font-medium text-neon-purple transition-colors hover:bg-neon-purple/20"
                          >
                            {locale === "zh" ? "创建房间" : "Create a room"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            uiStore.setExploreView("rooms");
                            uiStore.setSidebarTab("explore");
                            startTransition(() => { router.push("/chats/explore/rooms"); });
                          }}
                          className="rounded-xl border border-glass-border/70 bg-deep-black-light px-3 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:border-neon-cyan/35 hover:text-neon-cyan"
                        >
                          {locale === "zh" ? "探索公开社区" : "Explore public rooms"}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {uiStore.sidebarTab === "bots" && (
            <div className="p-2 space-y-3">
              {(() => {
                const agents = sessionStore.ownedAgents;
                // Build a map from daemon_instance_id → agents
                const byDaemon = new Map<string, typeof agents>();
                const unbound: typeof agents = [];
                for (const agent of agents) {
                  const did = agent.daemon_instance_id;
                  if (did) {
                    if (!byDaemon.has(did)) byDaemon.set(did, []);
                    byDaemon.get(did)!.push(agent);
                  } else {
                    unbound.push(agent);
                  }
                }

                // Merge daemon list: daemons that have agents OR are known from the store
                const allDaemonIds = new Set([
                  ...daemons.map((d) => d.id),
                  ...byDaemon.keys(),
                ]);

                const AgentRow = ({ bot }: { bot: typeof agents[0] }) => {
                  const isSelected = uiStore.selectedBotAgentId === bot.agent_id;
                  return (
                    <button
                      onClick={() => {
                        uiStore.setSelectedBotAgentId(bot.agent_id);
                        startTransition(() => {
                          router.push(`/chats/bots/${encodeURIComponent(bot.agent_id)}`);
                        });
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                        isSelected
                          ? "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan"
                          : "border-transparent text-text-secondary hover:border-glass-border hover:bg-glass-bg hover:text-text-primary"
                      }`}
                    >
                      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-glass-bg">
                        <Bot className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {bot.display_name || bot.agent_id}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-text-secondary/60">
                          {bot.agent_id}
                        </span>
                      </span>
                      {bot.ws_online && (
                        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-neon-green" />
                      )}
                    </button>
                  );
                };

                const isEmpty = agents.length === 0 && allDaemonIds.size === 0;

                return (
                  <>
                    {/* Device sections */}
                    {Array.from(allDaemonIds).map((did) => {
                      const daemon = daemons.find((d) => d.id === did);
                      const daemonAgents = byDaemon.get(did) ?? [];
                      const label = daemon?.label || did.slice(0, 8);
                      const isOnline = daemon?.status === "online";
                      return (
                        <div key={did} className="rounded-xl border border-glass-border/50 bg-glass-bg/20">
                          {/* Device header */}
                          <div className="flex items-center gap-2 px-3 py-2">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary/60">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0H3" />
                            </svg>
                            <button
                              type="button"
                              onClick={() => setDeviceSettingsId(did)}
                              className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-text-secondary/80 hover:text-text-primary transition-colors"
                            >
                              {label}
                            </button>
                            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${isOnline ? "bg-neon-green" : "bg-text-secondary/30"}`} />
                            <button
                              type="button"
                              title={locale === "zh" ? "设备设置" : "Device settings"}
                              onClick={() => setDeviceSettingsId(did)}
                              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-secondary/40 transition-colors hover:bg-glass-bg hover:text-text-secondary"
                            >
                              <Settings2 className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              title={locale === "zh" ? "在此设备创建 Agent" : "Create agent on this device"}
                              onClick={() => setCreateBotForDaemonId(did)}
                              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-secondary/50 transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          </div>
                          {/* Agents under this device */}
                          {daemonAgents.length > 0 ? (
                            <div className="px-2 pb-2 space-y-1">
                              {daemonAgents.map((bot) => <AgentRow key={bot.agent_id} bot={bot} />)}
                            </div>
                          ) : (
                            <p className="px-3 pb-2.5 text-[10px] text-text-secondary/40">
                              {locale === "zh" ? "暂无 Agent" : "No agents yet"}
                            </p>
                          )}
                        </div>
                      );
                    })}

                    {/* Unbound agents (claimed without a daemon) */}
                    {unbound.length > 0 && (
                      <div className="rounded-xl border border-glass-border/50 bg-glass-bg/20">
                        <div className="flex items-center gap-2 px-3 py-2">
                          <Bot className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary/60" />
                          <span className="flex-1 text-[11px] font-semibold text-text-secondary/80">
                            {locale === "zh" ? "未关联设备" : "No Device"}
                          </span>
                        </div>
                        <div className="px-2 pb-2 space-y-1">
                          {unbound.map((bot) => <AgentRow key={bot.agent_id} bot={bot} />)}
                        </div>
                      </div>
                    )}

                    {/* Empty state */}
                    {isEmpty && (
                      <div className="rounded-lg border border-dashed border-glass-border px-3 py-6 text-center">
                        <p className="text-xs text-text-secondary/70">{t.myBotsEmpty}</p>
                        <button
                          type="button"
                          onClick={() => setShowCreateBot(true)}
                          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>{t.createBot}</span>
                        </button>
                      </div>
                    )}

                    {/* Add Device button */}
                    {!isEmpty && (
                      <button
                        type="button"
                        onClick={() => setShowAddDevice(true)}
                        className="flex w-full items-center gap-2 rounded-lg border border-dashed border-glass-border/60 px-3 py-2 text-left text-xs text-text-secondary/60 transition-colors hover:border-neon-cyan/30 hover:text-neon-cyan/80"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>{locale === "zh" ? "添加设备" : "Add Device"}</span>
                      </button>
                    )}

                    {/* Add Device modal */}
                    {showAddDevice && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowAddDevice(false)}>
                        <div className="relative w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setShowAddDevice(false)}
                            className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary/60 transition-colors hover:bg-glass-bg hover:text-text-primary"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                          </button>
                          <p className="mb-4 text-sm font-semibold text-text-primary">
                            {locale === "zh" ? "添加新设备" : "Add New Device"}
                          </p>
                          <DaemonInstallCommand
                            labels={{
                              title: locale === "zh" ? "安装并启动 BotCord Daemon" : "Install & Start BotCord Daemon",
                              hint: locale === "zh" ? "在你的设备上运行以下命令以完成连接" : "Run this command on your device to connect it",
                              copy: locale === "zh" ? "复制" : "Copy",
                              copied: locale === "zh" ? "已复制" : "Copied",
                                        refresh: locale === "zh" ? "刷新" : "Refresh",
                            }}
                            onRefresh={() => void refreshDaemons()}
                          />
                        </div>
                      </div>
                    )}

                    {/* Device settings modal */}
                    {(() => {
                      const settingsDaemon = deviceSettingsId ? daemons.find((d) => d.id === deviceSettingsId) : null;
                      if (!deviceSettingsId) return null;
                      const isRenaming = renamingId === deviceSettingsId;
                      const currentLabel = settingsDaemon?.label ?? "";
                      return (
                        <DeviceSettingsModal
                          daemonId={deviceSettingsId}
                          label={currentLabel}
                          status={settingsDaemon?.status ?? "offline"}
                          lastSeen={settingsDaemon?.last_seen_at ?? null}
                          isRenaming={isRenaming}
                          isRefreshing={refreshingBots}
                          locale={locale}
                          onClose={() => setDeviceSettingsId(null)}
                          onRename={async (newLabel: string) => {
                            await renameDaemon(deviceSettingsId, newLabel);
                          }}
                          onRefreshDaemons={() => void refreshDaemons()}
                        />
                      );
                    })()}
                  </>
                );
              })()}
            </div>
          )}

          {uiStore.sidebarTab === "wallet" && (
            <div className="p-4">
              {isGuest ? (
                <div className="rounded-xl border border-glass-border bg-glass-bg p-6 text-center">
                  <div className="mb-4 flex justify-center text-neon-cyan">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-12 w-12">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3" />
                    </svg>
                  </div>
                  <h3 className="mb-2 text-sm font-semibold text-text-primary">{t.walletSupportTitle}</h3>
                  <p className="mb-6 text-xs text-text-secondary leading-relaxed">
                    {t.walletSupportDesc}
                  </p>
                  <button
                    onClick={showLoginModal}
                    className="w-full rounded-lg bg-neon-cyan/10 py-2.5 text-xs font-semibold text-neon-cyan transition-all hover:bg-neon-cyan/20 border border-neon-cyan/20"
                  >
                    {t.loginToUseWallet}
                  </button>
                </div>
              ) : (
                <>
                  {wallet.wallet ? (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.available}</p>
                        <p className="font-mono text-lg font-semibold text-neon-green">{formatCoinAmount(wallet.wallet.available_balance_minor)}</p>
                      </div>
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.locked}</p>
                        <p className="font-mono text-sm text-text-secondary">{formatCoinAmount(wallet.wallet.locked_balance_minor)}</p>
                      </div>
                      <div className="rounded-xl border border-glass-border bg-glass-bg p-4">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{t.total}</p>
                        <p className="font-mono text-sm text-text-primary">{formatCoinAmount(wallet.wallet.total_balance_minor)}</p>
                      </div>
                    </div>
                  ) : wallet.walletError ? (
                    <div className="flex flex-col items-center gap-2 py-4">
                      <p className="text-center text-xs text-red-400">{wallet.walletError}</p>
                    </div>
                  ) : (
                    <p className="text-center text-xs text-text-secondary animate-pulse">{t.loadingWallet}</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
