"use client";

/**
 * [INPUT]: session/ui/chat/unread/wallet/daemon stores + supabase client
 * [OUTPUT]: Sidebar — primary rail + resizable secondary panel + global modals
 * [POS]: dashboard left-side navigation skeleton
 * [PROTOCOL]: update header on changes
 */

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { sidebar, messagesHeader } from "@/lib/i18n/translations/dashboard";
import { common, nav } from "@/lib/i18n/translations/common";
import { useShallow } from "zustand/react/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardRealtimeStore } from "@/store/useDashboardRealtimeStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import { createClient } from "@/lib/supabase/client";

import AccountMenu from "../AccountMenu";
import AddFriendModal from "../AddFriendModal";
import CreateRoomModal from "../CreateRoomModal";
import CreateAgentDialog from "../CreateAgentDialog";
import { PrimaryNavButton, SecondaryNavButton } from "./NavButtons";
import ContactsPanel from "./ContactsPanel";
import MessagesGroupingSidebar from "./MessagesGroupingSidebar";
import BotsPanel from "./BotsPanel";
import MessagesPanel from "./MessagesPanel";
import { SidebarListSkeleton, SkeletonBlock } from "../DashboardTabSkeleton";

import { api } from "@/lib/api";
import { UserPlus, LogIn, Bot, Plus, RefreshCw, MessageSquarePlus, Search, X } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";

const USER_CHAT_ROUTE = "/chats/messages/__user-chat__";

function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

const authNavItems = [
  {
    key: "home" as const,
    label: "Home",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
      </svg>
    ),
  },
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
    icon: <Bot className="h-5 w-5" strokeWidth={1.5} />,
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

interface SidebarProps {
  mobileHideSecondary?: boolean;
  mobileSecondaryOpen?: boolean;
  onMobileSecondaryClose?: () => void;
}

export default function Sidebar({
  mobileHideSecondary = false,
  mobileSecondaryOpen = false,
  onMobileSecondaryClose,
}: SidebarProps) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const locale = useLanguage();
  const t = sidebar[locale];
  const tc = common[locale];
  const tNav = nav[locale];
  const tMsgHeader = messagesHeader[locale];
  const setLanguage = useAppStore((s) => s.setLanguage);

  const sessionStore = useDashboardSessionStore(useShallow((s) => ({
    user: s.user,
    ownedAgents: s.ownedAgents,
    activeAgentId: s.activeAgentId,
    sessionMode: s.sessionMode,
    viewMode: s.viewMode,
    token: s.token,
    humanRooms: s.humanRooms,
    refreshUserProfile: s.refreshUserProfile,
    removeAgent: s.removeAgent,
    logout: s.logout,
  })));
  const uiStore = useDashboardUIStore(useShallow((s) => ({
    sidebarTab: s.sidebarTab,
    pendingPrimaryNavigation: s.pendingPrimaryNavigation,
    contactsView: s.contactsView,
    exploreView: s.exploreView,
    openedRoomId: s.openedRoomId,
    messagesPane: s.messagesPane,
    messagesGroupingOpen: s.messagesGroupingOpen,
    setMessagesGroupingOpen: s.setMessagesGroupingOpen,
    messagesSearchOpen: s.messagesSearchOpen,
    sidebarWidth: s.sidebarWidth,
    setSidebarTab: s.setSidebarTab,
    startPrimaryNavigation: s.startPrimaryNavigation,
    setMessagesPane: s.setMessagesPane,
    setMessagesFilter: s.setMessagesFilter,
    setUserChatRoomId: s.setUserChatRoomId,
    setUserChatAgentId: s.setUserChatAgentId,
    setExploreView: s.setExploreView,
    setContactsView: s.setContactsView,
    setSidebarWidth: s.setSidebarWidth,
    setFocusedRoomId: s.setFocusedRoomId,
    setOpenedRoomId: s.setOpenedRoomId,
    createBotModalOpen: s.createBotModalOpen,
    openCreateBotModal: s.openCreateBotModal,
    closeCreateBotModal: s.closeCreateBotModal,
  })));
  const chatStore = useDashboardChatStore(useShallow((s) => ({
    overview: s.overview,
    recentVisitedRooms: s.recentVisitedRooms,
  })));
  const unreadStore = useDashboardUnreadStore(useShallow((s) => ({
    optimisticUnreadRoomIds: s.optimisticUnreadRoomIds,
    isRoomUnread: s.isRoomUnread,
  })));

  const isGuest = sessionStore.sessionMode === "guest";
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [refreshingBots, setRefreshingBots] = useState(false);
  const [createBotForDaemonId, setCreateBotForDaemonId] = useState<string | null>(null);

  const showCreateBot = uiStore.createBotModalOpen;
  const setShowCreateBot = (v: boolean) => v ? uiStore.openCreateBotModal() : uiStore.closeCreateBotModal();

  const refreshDaemons = useDaemonStore((s) => s.refresh);

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
    if (error) console.warn("[Dashboard] Supabase signOut failed:", error.message);
    sessionStore.logout();
    useDashboardUIStore.getState().logout();
    useDashboardChatStore.getState().logout();
    useDashboardRealtimeStore.getState().logout();
    useDashboardUnreadStore.getState().logout();
    useDashboardContactStore.getState().resetContactState();
    useDashboardWalletStore.getState().resetWalletState();
    router.push("/login");
  };

  useEffect(() => {
    if (uiStore.sidebarTab === "bots" && !isGuest) {
      void refreshDaemons({ quiet: true });
    }
  }, [uiStore.sidebarTab, isGuest, refreshDaemons]);

  const tabTitles: Record<string, string> = {
    home: t.home,
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

  const unreadMessageCount = useMemo(() => {
    const roomIds = new Set(visibleMessageRooms.map((r) => r.room_id));
    const persistedCount = visibleMessageRooms.reduce((total, room) => {
      if (!unreadStore.isRoomUnread(room.room_id, room.has_unread)) return total;
      return total + Math.max(1, room.unread_count ?? 1);
    }, 0);
    const optimisticOnlyCount = unreadStore.optimisticUnreadRoomIds.filter((id) => !roomIds.has(id)).length;
    return persistedCount + optimisticOnlyCount;
  }, [unreadStore, visibleMessageRooms]);

  const pendingContactRequests = chatStore.overview?.pending_requests || 0;
  const secondaryPanelLoading = Boolean(
    uiStore.pendingPrimaryNavigation && uiStore.pendingPrimaryNavigation.tab === uiStore.sidebarTab,
  );
  const showMessagesGrouping = uiStore.sidebarTab === "messages" && !isGuest && uiStore.messagesGroupingOpen;

  useEffect(() => {
    const prefetch = (path: string) => {
      if (typeof router.prefetch !== "function") return;
      void router.prefetch(path);
    };
    prefetch("/chats/messages");
    prefetch(`/chats/contacts/${uiStore.contactsView}`);
    prefetch(`/chats/explore/${uiStore.exploreView}`);
    prefetch("/chats/wallet");
    prefetch("/chats/activity");
  }, [router, uiStore.contactsView, uiStore.exploreView]);

  const showLoginModal = () => router.push("/login");

  const navigatePrimaryTab = (tab: "home" | "messages" | "contacts" | "explore" | "wallet" | "activity" | "bots") => {
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
      home: "/chats/home",
      messages: openedRoomPath,
      contacts: `/chats/contacts/${uiStore.contactsView}`,
      explore: `/chats/explore/${uiStore.exploreView}`,
      wallet: "/chats/wallet",
      activity: "/chats/activity",
      bots: "/chats/bots",
    };
    uiStore.startPrimaryNavigation(tab, pathByTab[tab]);
    if (tab === "messages" && !uiStore.openedRoomId && uiStore.messagesPane !== "user-chat") {
      uiStore.setMessagesPane("room");
    }
    onMobileSecondaryClose?.();
    startTransition(() => { router.push(pathByTab[tab]); });
  };

  const handleBotsRefresh = async () => {
    if (refreshingBots) return;
    setRefreshingBots(true);
    try {
      await Promise.all([sessionStore.refreshUserProfile(), refreshDaemons()]);
    } finally {
      setRefreshingBots(false);
    }
  };

  return (
    <div className={`flex h-full max-md:w-full max-md:flex-col-reverse ${mobileHideSecondary ? "max-md:h-16" : "max-md:h-full"}`}>
      {/* Primary rail */}
      <div className="flex h-full w-16 min-w-[64px] flex-col items-center border-r border-glass-border bg-deep-black py-3 max-md:h-16 max-md:w-full max-md:min-w-0 max-md:shrink-0 max-md:flex-row max-md:border-r-0 max-md:border-t max-md:px-2 max-md:py-2">
        <Link
          href="/"
          className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-glass-border bg-deep-black-light transition-colors hover:border-neon-cyan/50 hover:bg-glass-bg max-md:mb-0 max-md:mr-2 max-md:hidden"
          title={tNav.home}
        >
          <img src="/logo.svg" alt="BotCord" className="h-6 w-6" />
        </Link>
        <div className="flex flex-1 flex-col items-center gap-1 pt-1 max-md:min-w-0 max-md:flex-row max-md:justify-around max-md:pt-0">
          {navItems.map((item) => {
            const isActive = uiStore.sidebarTab === item.key;
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
                activeTone="cyan"
                badge={badge}
                disabled={requiresLogin}
                icon={item.icon}
                label={tabTitles[item.key] || item.label}
                title={requiresLogin ? tc.login : tabTitles[item.key] || item.label}
              />
            );
          })}
        </div>

        <div className="flex flex-col items-center gap-2 border-t border-glass-border pt-3 max-md:ml-2 max-md:border-l max-md:border-t-0 max-md:pl-2 max-md:pt-0">
          <button
            onClick={() => setLanguage(locale === "zh" ? "en" : "zh")}
            aria-label="Toggle language"
            className="flex h-10 w-12 items-center justify-center gap-0.5 rounded-xl text-[10px] font-medium leading-none transition-all duration-200 hover:bg-glass-bg max-md:w-10"
          >
            <span className={locale === "en" ? "text-text-primary" : "text-text-secondary/50"}>EN</span>
            <span className="text-text-secondary/30">/</span>
            <span className={locale === "zh" ? "text-text-primary" : "text-text-secondary/50"}>中</span>
          </button>

          {isGuest ? (
            <button
              onClick={showLoginModal}
              className="flex h-10 w-12 flex-col items-center justify-center rounded-xl text-neon-cyan transition-all duration-200 hover:bg-neon-cyan/10 max-md:w-10"
              title={tc.login}
            >
              <LogIn className="h-5 w-5" strokeWidth={1.75} />
              <span className="mt-0.5 text-[9px] font-medium leading-none">{tc.login}</span>
            </button>
          ) : (
            <>
              <AccountMenu
                user={sessionStore.user}
                pendingRequests={chatStore.overview?.pending_requests || 0}
                onLogout={handleLogout}
              />
            </>
          )}
        </div>
      </div>

      {/* Global modals */}
      {showAddFriend && <AddFriendModal onClose={() => setShowAddFriend(false)} />}
      {showCreateRoom && (
        <CreateRoomModal
          onClose={() => setShowCreateRoom(false)}
          onCreated={(room) => {
            setShowCreateRoom(false);
            uiStore.setMessagesPane("room");
            uiStore.setMessagesFilter("self-all");
            const path = `/chats/messages/${encodeURIComponent(room.room_id)}`;
            uiStore.startPrimaryNavigation("messages", path);
            onMobileSecondaryClose?.();
            startTransition(() => { router.push(path); });
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
            uiStore.setSidebarTab("messages");
            uiStore.setMessagesPane("user-chat");
            uiStore.setUserChatAgentId(agentId);
            uiStore.setFocusedRoomId(null);
            uiStore.setOpenedRoomId(null);
            onMobileSecondaryClose?.();
            try {
              const room = await api.getUserChatRoom(agentId);
              uiStore.setUserChatRoomId(room.room_id);
              startTransition(() => {
                router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
              });
            } catch (error) {
              console.error("[Sidebar] getUserChatRoom after create failed:", error);
              startTransition(() => { router.push(USER_CHAT_ROUTE); });
            }
          }}
        />
      )}

      {mobileHideSecondary && mobileSecondaryOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-x-0 bottom-16 top-0 z-30 hidden bg-black/45 backdrop-blur-sm max-md:block"
          onClick={onMobileSecondaryClose}
        />
      )}

      {/* Secondary panel — hidden on Home, My Bots, Explore, Wallet (those pages get full width). */}
      {uiStore.sidebarTab !== "home" && uiStore.sidebarTab !== "bots" && uiStore.sidebarTab !== "explore" && uiStore.sidebarTab !== "wallet" && (
      <div
        className={`relative flex h-full flex-col border-r border-glass-border bg-deep-black-light max-md:min-h-0 max-md:flex-1 max-md:!min-w-0 max-md:border-r-0 ${
          mobileHideSecondary
            ? mobileSecondaryOpen
              ? "max-md:fixed max-md:inset-x-3 max-md:bottom-20 max-md:top-4 max-md:z-40 max-md:!w-auto max-md:rounded-xl max-md:border max-md:border-glass-border max-md:shadow-2xl max-md:shadow-black/50"
              : "max-md:hidden"
            : "max-md:!w-full"
        }`}
        style={{
          width: showMessagesGrouping
            ? uiStore.sidebarWidth + 200
            : uiStore.sidebarWidth,
          minWidth: SIDEBAR_MIN,
        }}
      >
        {/* Resize handle */}
        <div
          onMouseDown={handleResizeStart}
          className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-neon-cyan/30 active:bg-neon-cyan/50 max-md:hidden"
        />
        {/* Outer panel header — hidden on messages tab; MessagesPanel owns its own column header (Feishu-style). */}
        {uiStore.sidebarTab !== "messages" && (
        <div className="flex min-h-14 items-center justify-between border-b border-glass-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">{tabTitles[uiStore.sidebarTab]}</h2>
            {isGuest && (
              <p className="truncate text-[10px] text-text-secondary/60">{t.browseAsGuest}</p>
            )}
          </div>
          {mobileHideSecondary && (
            <button
              type="button"
              onClick={onMobileSecondaryClose}
              className="mr-1 hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary max-md:inline-flex"
              aria-label="Close sidebar"
              title="Close sidebar"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {uiStore.sidebarTab === "contacts" && !isGuest && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowAddFriend(true)}
                title="邀请新好友"
                aria-label="邀请新好友"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-neon-cyan/10 hover:text-neon-cyan"
              >
                <UserPlus className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
        )}

        {/* Contacts: legacy 4-subtab nav replaced by single-column ContactsPanel below. */}

        {/* Panel content */}
        <div className="flex flex-1 min-h-0">
          {!secondaryPanelLoading && showMessagesGrouping && (
            <MessagesGroupingSidebar />
          )}
          <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          {secondaryPanelLoading ? (
            <>
              {uiStore.sidebarTab === "messages" ? (
                <div className="flex min-h-14 items-center justify-between border-b border-glass-border px-3 py-2.5">
                  <SkeletonBlock className="h-4 w-28" />
                  <div className="flex gap-1">
                    <SkeletonBlock className="h-8 w-8 rounded-lg" />
                    <SkeletonBlock className="h-8 w-8 rounded-lg" />
                  </div>
                </div>
              ) : null}
              <SidebarListSkeleton rows={uiStore.sidebarTab === "contacts" ? 9 : 7} />
            </>
          ) : uiStore.sidebarTab === "messages" && (
            <MessagesPanel
              isGuest={isGuest}
              onCreateRoom={() => setShowCreateRoom(true)}
              onAddFriend={() => setShowAddFriend(true)}
            />
          )}
          {!secondaryPanelLoading && uiStore.sidebarTab === "contacts" && (
            <ContactsPanel onOpenAddFriend={() => setShowAddFriend(true)} />
          )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
