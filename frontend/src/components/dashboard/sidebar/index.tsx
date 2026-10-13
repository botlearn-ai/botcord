"use client";

/**
 * [INPUT]: session/ui/chat/unread/wallet/daemon stores + supabase client
 * [OUTPUT]: Sidebar — desktop rail / compact mobile navigation + secondary panels with preserved list scroll + global modals
 * [POS]: dashboard left-side navigation skeleton
 * [PROTOCOL]: update header on changes
 */

import DismissLayer from "@/components/ui/DismissLayer";
import Button from "@/components/ui/Button";
import IconButton from "@/components/ui/IconButton";
import BrandMark from "@/components/ui/BrandMark";
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from "@/lib/i18n";
import { sidebar, messagesHeader } from "@/lib/i18n/translations/dashboard";
import { common, nav } from "@/lib/i18n/translations/common";
import { useShallow } from "zustand/react/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore, type DashboardUIState } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardRealtimeStore } from "@/store/useDashboardRealtimeStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import { useDaemonStore } from "@/store/useDaemonStore";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import { createClient } from "@/lib/supabase/client";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";

import AccountMenu from "../AccountMenu";
import ThemeToggle from "../ThemeToggle";
import AddFriendModal from "../AddFriendModal";
import CreateRoomModal from "../CreateRoomModal";
import CreateAgentDialog from "../CreateAgentDialog";
import { PrimaryNavButton, SecondaryNavButton } from "./NavButtons";
import ContactsPanel from "./ContactsPanel";
import MessagesGroupingSidebar from "./MessagesGroupingSidebar";
import BotsPanel from "./BotsPanel";
import MessagesPanel from "./MessagesPanel";

import { UserPlus, LogIn, Bot, Plus, RefreshCw, MessageSquarePlus, Search, X, House, MessageCircle, UsersRound, Compass, Wallet, ChartColumn } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";


function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

const navIconProps = { className: "h-5 w-5", strokeWidth: 1.75, "aria-hidden": true } as const;

const authNavItems = [
  { key: "home" as const, label: "Home", icon: <House {...navIconProps} /> },
  { key: "messages" as const, label: "Messages", icon: <MessageCircle {...navIconProps} /> },
  { key: "bots" as const, label: "My Bots", icon: <Bot {...navIconProps} /> },
  { key: "contacts" as const, label: "Contacts", icon: <UsersRound {...navIconProps} /> },
  { key: "explore" as const, label: "Explore", icon: <Compass {...navIconProps} /> },
  { key: "wallet" as const, label: "Wallet", icon: <Wallet {...navIconProps} /> },
  { key: "activity" as const, label: "Activity", icon: <ChartColumn {...navIconProps} /> },
] as const;

interface SidebarProps {
  mobileHideSecondary?: boolean;
  mobileSecondaryOpen?: boolean;
  onMobileSecondaryClose?: () => void;
  sidebarTabOverride?: DashboardUIState["sidebarTab"];
}

export default memo(Sidebar);

function Sidebar({
  mobileHideSecondary = false,
  mobileSecondaryOpen = false,
  onMobileSecondaryClose,
  sidebarTabOverride,
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
  const contactStore = useDashboardContactStore(useShallow((s) => ({
    contactRequestsBotApprovalCount: s.contactRequestsBotApprovalCount,
    loadContactRequests: s.loadContactRequests,
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
  const [mobileSecondaryRendered, setMobileSecondaryRendered] = useState(mobileSecondaryOpen);
  const mobileSecondaryOverlayRef = useRef<HTMLButtonElement | null>(null);
  const mobileSecondaryPanelRef = useRef<HTMLDivElement | null>(null);
  const mobileSecondaryAnimationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

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

  const pendingContactRequests = (chatStore.overview?.pending_requests || 0) + contactStore.contactRequestsBotApprovalCount;
  const visibleSidebarTab = sidebarTabOverride ?? uiStore.sidebarTab;
  const messageListScrollRef = useRef<HTMLDivElement>(null);
  const messageListScrollTop = useRef(0);
  useLayoutEffect(() => {
    if (visibleSidebarTab === "messages" && !mobileHideSecondary && messageListScrollRef.current) {
      messageListScrollRef.current.scrollTop = messageListScrollTop.current;
    }
  }, [visibleSidebarTab, mobileHideSecondary]);
  const showMessagesGrouping = visibleSidebarTab === "messages" && !isGuest && uiStore.messagesGroupingOpen;

  useEffect(() => {
    if (!isGuest) void contactStore.loadContactRequests();
  }, [contactStore.loadContactRequests, isGuest]);

  useEffect(() => {
    if (!mobileHideSecondary) {
      setMobileSecondaryRendered(false);
      cleanupAnime(mobileSecondaryAnimationRef.current);
      mobileSecondaryAnimationRef.current = null;
      return;
    }

    if (mobileSecondaryOpen) {
      setMobileSecondaryRendered(true);
      return;
    }

    if (!mobileSecondaryRendered) return;

    cleanupAnime(mobileSecondaryAnimationRef.current);
    if (mobileSecondaryOverlayRef.current) {
      mobileSecondaryOverlayRef.current.style.opacity = "1";
    }
    if (mobileSecondaryPanelRef.current) {
      mobileSecondaryPanelRef.current.style.opacity = "1";
      mobileSecondaryPanelRef.current.style.transform = "translate3d(0, 0, 0) scale(1)";
      mobileSecondaryPanelRef.current
        .querySelectorAll<HTMLElement>("[data-mobile-secondary-motion]")
        .forEach((part) => {
          part.style.opacity = "1";
          part.style.transform = "translateY(0)";
        });
    }
    mobileSecondaryAnimationRef.current = animateOverlayPanelExit(
      mobileSecondaryOverlayRef.current,
      mobileSecondaryPanelRef.current,
      {
        direction: "bottom",
        contentSelector: "[data-mobile-secondary-motion]",
        onComplete: () => {
          setMobileSecondaryRendered(false);
          mobileSecondaryAnimationRef.current = null;
        },
      },
    );
  }, [mobileHideSecondary, mobileSecondaryOpen, mobileSecondaryRendered]);

  useEffect(() => {
    if (!mobileHideSecondary || !mobileSecondaryOpen || !mobileSecondaryRendered) return;

    const frameId = window.requestAnimationFrame(() => {
      cleanupAnime(mobileSecondaryAnimationRef.current);
      mobileSecondaryAnimationRef.current = animateOverlayPanelEnter(
        mobileSecondaryOverlayRef.current,
        mobileSecondaryPanelRef.current,
        {
          direction: "bottom",
          contentSelector: "[data-mobile-secondary-motion]",
        },
      );
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [mobileHideSecondary, mobileSecondaryOpen, mobileSecondaryRendered, visibleSidebarTab]);

  useEffect(() => () => cleanupAnime(mobileSecondaryAnimationRef.current), []);

  const showLoginModal = () => router.push("/login");

  const navigatePrimaryTab = (tab: "home" | "messages" | "contacts" | "explore" | "wallet" | "activity" | "bots") => {
    if (isGuest && (tab === "contacts" || tab === "activity" || tab === "bots")) {
      showLoginModal();
      return;
    }
    const pathByTab: Record<typeof tab, string> = {
      home: "/chats/home",
      messages: "/chats/messages",
      contacts: `/chats/contacts/${uiStore.contactsView}`,
      explore: `/chats/explore/${uiStore.exploreView}`,
      wallet: "/chats/wallet",
      activity: "/chats/activity",
      bots: "/chats/bots",
    };
    if (tab === "messages" && window.matchMedia("(max-width: 767px)").matches) {
      useDashboardUIStore.getState().returnToMessageList();
    } else {
      uiStore.startPrimaryNavigation(tab, pathByTab[tab]);
    }
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
    <div data-dashboard-sidebar className={`flex h-full shrink-0 max-md:w-full max-md:flex-col-reverse ${mobileHideSecondary ? "max-md:h-[calc(4rem+env(safe-area-inset-bottom))]" : "max-md:h-full"}`}>
      {/* Primary rail */}
      <div className="liquid-rail flex h-full w-16 min-w-[64px] flex-col items-center border-r border-glass-border bg-deep-black py-3 max-md:h-[calc(4rem+env(safe-area-inset-bottom))] max-md:w-full max-md:min-w-0 max-md:shrink-0 max-md:flex-row max-md:border-r-0 max-md:border-t max-md:px-2 max-md:pb-[env(safe-area-inset-bottom)] max-md:pt-2">
        <Link
          href="/"
          className="dashboard-brand-link mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-glass-border bg-deep-black-light transition-colors hover:border-neon-cyan/50 hover:bg-glass-bg max-md:mb-0 max-md:mr-2 max-md:hidden"
          title={tNav.home}
        >
          <BrandMark className="h-6 w-6 text-text-primary" />
          <span className="sr-only">BotCord</span>
        </Link>
        <div className="flex flex-1 flex-col items-center gap-1 pt-1 md:w-full md:px-0.5 max-md:min-w-0 max-md:flex-row max-md:justify-around max-md:pt-0">
          {navItems.map((item) => {
            const isActive = visibleSidebarTab === item.key;
            const requiresLogin = isGuest && (item.key === "contacts" || item.key === "activity");
            let badge: ReactNode = null;
            if (item.key === "messages" && unreadMessageCount > 0 && !requiresLogin) {
              badge = (
                <span
                  data-primary-nav-badge
                  className="pointer-events-none absolute -right-2.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-neon-cyan px-1 text-xs font-semibold leading-none text-[var(--color-on-accent)] "
                >
                  {formatBadgeCount(unreadMessageCount)}
                </span>
              );
            }
            if (item.key === "contacts" && pendingContactRequests > 0 && !requiresLogin) {
              badge = (
                <span
                  data-primary-nav-badge
                  className="pointer-events-none absolute -right-2.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-neon-cyan px-1 text-xs font-semibold text-[var(--color-on-accent)] "
                >
                  {formatBadgeCount(pendingContactRequests)}
                </span>
              );
            }
            return (
              <PrimaryNavButton
                key={item.key}
                mobileHidden={item.key === "explore" || item.key === "wallet"}
                mobileLabel={item.key === "bots" ? "Bots" : undefined}
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

        <div className="flex flex-col items-center gap-2 border-t border-glass-border pt-3 max-md:ml-1 max-md:shrink-0 max-md:gap-1 max-md:border-l max-md:border-t-0 max-md:pl-1 max-md:pt-0">
          <div className="flex flex-col items-center gap-2 max-md:hidden">
          <ThemeToggle />
          <Button variant="ghost" size="sm"
            onClick={() => setLanguage(locale === "zh" ? "en" : "zh")}
            aria-label="Toggle language"
            className="flex w-12 items-center justify-center gap-0.5 max-md:w-10"
          >
            <span className={locale === "en" ? "text-text-primary" : "text-text-secondary"}>EN</span>
            <span className="text-text-secondary">/</span>
            <span className={locale === "zh" ? "text-text-primary" : "text-text-secondary"}>中</span>
          </Button>

          </div>
          {isGuest ? (
            <Button variant="ghost" size="sm"
              onClick={showLoginModal}
              className="flex w-12 flex-col items-center justify-center max-md:hidden"
              title={tc.login}
            >
              <LogIn className="h-5 w-5" strokeWidth={1.75} />
              <span className="mt-0.5 text-xs font-medium leading-none">{tc.login}</span>
            </Button>
          ) : null}
          <div className={isGuest ? "md:hidden" : ""}>
              <AccountMenu
                user={sessionStore.user}
                pendingRequests={pendingContactRequests}
                onLogout={handleLogout}
                onLogin={isGuest ? showLoginModal : undefined}
              />
          </div>
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
            uiStore.setFocusedRoomId(room.room_id);
            uiStore.setOpenedRoomId(room.room_id);
            const path = "/chats/messages";
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
            uiStore.setUserChatAgentId(agentId);
            onMobileSecondaryClose?.();
          }}
        />
      )}

      {mobileHideSecondary && mobileSecondaryRendered && (
        <DismissLayer
          ref={mobileSecondaryOverlayRef}

          label="Close sidebar"
          className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] top-0 z-30 hidden   max-md:block"
          onClick={onMobileSecondaryClose}
        />
      )}

      {/* Secondary panel — hidden on Home, My Bots, Explore, Wallet (those pages get full width). */}
      {visibleSidebarTab !== "home" && visibleSidebarTab !== "bots" && visibleSidebarTab !== "explore" && visibleSidebarTab !== "wallet" && (
      <div
        className={`liquid-panel relative flex h-full flex-col border-r border-glass-border bg-deep-black-light max-md:min-h-0 max-md:flex-1 max-md:!min-w-0 max-md:border-r-0 ${
          mobileHideSecondary
            ? mobileSecondaryRendered
              ? "max-md:fixed max-md:inset-x-3 max-md:bottom-[calc(5rem+env(safe-area-inset-bottom))] max-md:top-4 max-md:z-40 max-md:!w-auto max-md:rounded-xl max-md:border max-md:border-glass-border max-md:shadow-2xl max-md:shadow-black/50"
              : "max-md:hidden"
            : "max-md:!w-full"
        }`}
        style={{
          width: showMessagesGrouping
            ? uiStore.sidebarWidth + 200
            : uiStore.sidebarWidth,
          minWidth: SIDEBAR_MIN,
        }}
        ref={mobileSecondaryPanelRef}
      >
        {/* Resize handle */}
        <div
          onMouseDown={handleResizeStart}
          className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-accent-soft active:bg-accent-soft max-md:hidden"
        />
        {/* Outer panel header — hidden on messages tab; MessagesPanel owns its own column header (Feishu-style). */}
        {visibleSidebarTab !== "messages" && (
        <div className="flex min-h-14 items-center justify-between border-b border-glass-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">{tabTitles[visibleSidebarTab]}</h2>
            {isGuest && (
              <p className="truncate text-xs text-text-secondary">{t.browseAsGuest}</p>
            )}
          </div>
          {mobileHideSecondary && (
            <IconButton size="sm" label="Close sidebar"
              type="button"
              onClick={onMobileSecondaryClose}
              className="mr-1 hidden shrink-0 items-center justify-center max-md:inline-flex"
              aria-label="Close sidebar"
              title="Close sidebar"
            >
              <X className="h-4 w-4" />
            </IconButton>
          )}
          {visibleSidebarTab === "contacts" && !isGuest && (
            <div className="flex items-center gap-1">
              <IconButton size="sm" label="邀请新好友"
                onClick={() => setShowAddFriend(true)}
                title="邀请新好友"
                aria-label="邀请新好友"
                className="flex items-center justify-center"
              >
                <UserPlus className="h-4 w-4" />
              </IconButton>
            </div>
          )}
        </div>
        )}

        {/* Contacts: legacy 4-subtab nav replaced by single-column ContactsPanel below. */}

        {/* Panel content */}
        <div className="flex flex-1 min-h-0" data-mobile-secondary-motion>
          {showMessagesGrouping && (
            <div className="max-md:hidden">
              <MessagesGroupingSidebar />
            </div>
          )}
          <div
            ref={messageListScrollRef}
            data-message-list-scroll
            onScroll={(event) => {
              // Hidden panels may emit a zero-offset scroll event. Keep the last visible position.
              if (visibleSidebarTab === "messages" && event.currentTarget.clientHeight > 0) {
                messageListScrollTop.current = event.currentTarget.scrollTop;
              }
            }}
            className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
          >
          {visibleSidebarTab === "messages" && (
            <MessagesPanel
              isGuest={isGuest}
              onCreateRoom={() => setShowCreateRoom(true)}
              onAddFriend={() => setShowAddFriend(true)}
            />
          )}
          {visibleSidebarTab === "contacts" && (
            <ContactsPanel onOpenAddFriend={() => setShowAddFriend(true)} />
          )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
